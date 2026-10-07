from __future__ import annotations

import threading
import time


# Which window is editing which files, as reported on the heartbeat.
#
# The point of collecting this centrally: the same folder is routinely open in
# two live windows at once — on 2026-09-18 one folder was open both in a terminal
# claude and inside Zed's external agent, and another had seven live rows. Two
# windows editing one working tree overwrite each other with no warning, and git
# only notices at merge time, which never comes when there is no branch between
# them.
#
# IN MEMORY ONLY, deliberately. This is a few minutes of liveness; it is
# worthless after a restart, and persisting it would mean a row per edit written
# from every window at once, on the hot path of each one. A restart simply means
# nobody is known to be editing anything until the next heartbeat, which is the
# safe direction to be wrong in: it produces silence, not a false claim.
#
# NOT a complete picture of who touches what: only the editing tools report,
# because their target path is a field the hook can read. A write made through
# Bash is invisible here and cannot cheaply be made visible — parsing a shell
# command to find its target catches the rare forms and misses the common one.
# So this answers "who else is EDITING this file", never "is this file free".

# How long a reported touch survives HERE, which is not the same question as how
# long a touch is interesting. The 30-minute window belongs to the PLUGIN, which
# re-sends its live set on every beat (15 s); this store only has to survive
# between beats.
#
# "Its live set" is capped at 50, newest first, so a window editing more than 50
# files inside its own 30 minutes stops refreshing the oldest of them and they
# expire here. That is a real narrowing versus the previous 30-minute store, and
# it is the right direction: the plugin's own ordering says those are the least
# recent, and the alternative is a claim nobody is refreshing.
#
# Making this 30 minutes too made the two windows ADD UP —
# a path last touched 30 minutes ago was re-stamped `now` on every beat until the
# plugin dropped it, and then sat here for another 30 — so a claim could outlive
# the edit by an hour. A few beats of slack is all this needs.
TOUCH_TTL_SECONDS = 90.0

# Cap per window, mirroring the plugin's own cap. A window reporting more than
# this is either very busy or broken; either way we keep the newest.
MAX_PATHS_PER_WINDOW = 50

# instance id -> {path: last-seen epoch seconds}
_touched: dict[str, dict[str, float]] = {}

# The registry HTTP server is a ThreadingHTTPServer: every window's heartbeat
# lands on its own thread, and they all reach into this one dict. Without the
# lock a `for path in window` in snapshot() races a write in note_touched() from
# the next window's beat and raises "dictionary changed size during iteration" —
# which would fail that window's heartbeat, not just this feature.
_lock = threading.Lock()


def note_touched(instance_id: str, paths: list, now: float | None = None) -> None:
    """Record the paths a window reported on its heartbeat."""
    if not instance_id:
        return
    stamp = time.time() if now is None else now
    with _lock:
        window = _touched.setdefault(instance_id, {})
        for raw in paths[:MAX_PATHS_PER_WINDOW]:
            path = str(raw or "").strip()
            if path:
                window.pop(path, None)   # re-insert: dict order is then oldest-first
                window[path] = stamp
        _prune(window, stamp)
        # Cap the STORE, not the batch. Trimming only the incoming list bounded
        # nothing: fifty fresh paths per beat, each beat a different fifty, and
        # the window grew without limit until the TTL happened to catch up.
        while len(window) > MAX_PATHS_PER_WINDOW:
            del window[next(iter(window))]


def touching(path: str, exclude_instance: str = "", now: float | None = None) -> list[tuple[str, float]]:
    """Which OTHER windows reported editing `path` recently.

    Returns [(instance_id, seconds since it was reported)], newest first. The
    caller decides what to do with it — this module never blocks anything.
    """
    stamp = time.time() if now is None else now
    cutoff = stamp - TOUCH_TTL_SECONDS
    out: list[tuple[str, float]] = []
    with _lock:
        for instance_id, window in list(_touched.items()):
            _prune(window, stamp)
            if not window:
                _touched.pop(instance_id, None)
                continue
            if instance_id == exclude_instance:
                continue
            seen = window.get(path)
            if seen is not None and seen >= cutoff:
                out.append((instance_id, stamp - seen))
    out.sort(key=lambda item: item[1])
    return out


def snapshot(exclude_instance: str = "", now: float | None = None) -> dict[str, list[str]]:
    """Everything currently known, minus one window: {path: [instance ids]}.

    This is what rides back down on the heartbeat, so a window's own hook can
    answer the question locally instead of asking across the mesh on every edit.
    """
    stamp = time.time() if now is None else now
    out: dict[str, list[str]] = {}
    with _lock:
        for instance_id, window in list(_touched.items()):
            _prune(window, stamp)
            if not window:
                _touched.pop(instance_id, None)
                continue
            if instance_id == exclude_instance:
                continue
            for path in list(window):
                out.setdefault(path, []).append(instance_id)
    return out


def paths_of(instance_id: str, now: float | None = None) -> list[tuple[str, float]]:
    """What ONE window reported editing: [(path, seconds since reported)],
    newest first.

    The counterpart of `touching`, which answers "who is in this file". This one
    answers "what is this window in", which is what a person asks when they want
    to know whether to wait.
    """
    stamp = time.time() if now is None else now
    out: list[tuple[str, float]] = []
    with _lock:
        window = _touched.get(instance_id)
        if window:
            _prune(window, stamp)
            out = [(path, stamp - at) for path, at in window.items()]
    out.sort(key=lambda item: item[1])
    return out


def forget(instance_id: str) -> None:
    """Drop a window's claims — called when it leaves the registry."""
    with _lock:
        _touched.pop(instance_id, None)


def _prune(window: dict[str, float], now: float) -> None:
    cutoff = now - TOUCH_TTL_SECONDS
    for path in [p for p, at in window.items() if at < cutoff]:
        del window[path]


def _reset() -> None:
    """Test seam."""
    with _lock:
        _touched.clear()


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/touched.py
    _reset()
    T = 1_000_000.0
    note_touched("winA", ["/a.py", "/shared.py"], now=T)
    note_touched("winB", ["/b.py", "/shared.py"], now=T + 10)

    # The whole point: a window must not be told it is competing with itself.
    assert [i for i, _ in touching("/shared.py", exclude_instance="winA", now=T + 20)] == ["winB"]
    assert [i for i, _ in touching("/shared.py", exclude_instance="winB", now=T + 20)] == ["winA"]
    assert touching("/a.py", exclude_instance="winA", now=T + 20) == [], "only winA touched it"
    assert touching("/never.py", now=T + 20) == []

    # One window's own view, which is the other half of the question. Newest
    # first, so a person reading it sees what the window is in RIGHT NOW at the
    # top rather than what it opened with.
    note_touched("winA", ["/later.py"], now=T + 5)
    assert [p for p, _ in paths_of("winA", now=T + 20)] == ["/later.py", "/a.py", "/shared.py"]
    assert dict(paths_of("winA", now=T + 20))["/later.py"] == 15.0
    assert paths_of("nobody", now=T + 20) == []
    assert paths_of("winA", now=T + TOUCH_TTL_SECONDS + 60) == [], "expiry applies here too"

    # Age is reported, because "who" without "when" sends the human to find out.
    ages = dict(touching("/shared.py", exclude_instance="winA", now=T + 30))
    assert abs(ages["winB"] - 20.0) < 0.001, ages

    # Expiry, on both readers.
    assert touching("/shared.py", now=T + TOUCH_TTL_SECONDS + 60) == []
    assert snapshot(now=T + TOUCH_TTL_SECONDS + 60) == {}

    _reset()
    note_touched("winA", ["/a.py"], now=T)
    note_touched("winB", ["/a.py"], now=T)
    assert snapshot(exclude_instance="winA", now=T + 5) == {"/a.py": ["winB"]}
    assert sorted(snapshot(now=T + 5)["/a.py"]) == ["winA", "winB"]

    # Leaving the registry clears the claim, so a dead window cannot hold one.
    forget("winB")
    assert snapshot(now=T + 5) == {"/a.py": ["winA"]}

    # Junk in, nothing out.
    _reset()
    note_touched("winA", ["", "   ", None], now=T)
    assert snapshot(now=T + 1) == {}
    note_touched("", ["/x.py"], now=T)
    assert snapshot(now=T + 1) == {}

    # The per-window cap holds — both for one huge batch and, the case that
    # actually bit, for many small batches of DIFFERENT paths over time.
    _reset()
    note_touched("winA", [f"/f{i}.py" for i in range(500)], now=T)
    assert len(snapshot(now=T + 1)) == MAX_PATHS_PER_WINDOW
    _reset()
    for i in range(40):
        note_touched("winA", [f"/b{i}_{j}.py" for j in range(5)], now=T + i)
    assert len(snapshot(now=T + 40)["/b39_0.py"]) == 1
    assert sum(len(v) for v in snapshot(now=T + 40).values()) == MAX_PATHS_PER_WINDOW
    assert "/b0_0.py" not in snapshot(now=T + 40), "oldest must be evicted, not kept"

    # The TTL here must NOT stack on top of the plugin's own window: a path the
    # plugin keeps re-sending stays alive, and one it stops sending dies within a
    # few beats rather than half an hour later.
    _reset()
    note_touched("winA", ["/x.py"], now=T)
    for i in range(1, 200):
        note_touched("winA", ["/x.py"], now=T + i * 15)     # a beat every 15 s
    assert snapshot(now=T + 199 * 15) == {"/x.py": ["winA"]}, "re-sent path must live"
    assert snapshot(now=T + 199 * 15 + TOUCH_TTL_SECONDS + 1) == {}, "silence must expire it"
    print("touched self-check OK")
