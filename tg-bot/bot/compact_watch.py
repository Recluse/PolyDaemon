from __future__ import annotations

import logging
import time
from typing import Any

from telegram.ext import ContextTypes

from bot.common import get_bridge_client, get_storage, refresh_instances
from bot.i18n import t
from bot.inject import deliver_slash_command
from bot.topics import resolve_workspace_id


logger = logging.getLogger(__name__)

# Idle compaction.
#
# Claude's own auto-compact is deliberately OFF in every window we launch
# (clients/tg-claude.sh writes {"autoCompactEnabled": false} into a --settings
# file). The reason is in that script: a window started with a full --continue
# resume got compacted the instant it loaded, throwing away exactly the context
# the owner had asked to keep. Turning the flag back on brings that back.
#
# So we compact on a trigger that CANNOT fire at load time: the window has been
# silent for hours AND its context is genuinely big. Loading is not idleness, so
# a fresh resume is never touched. The bot already knows how to compact a window
# (/compact injects the real slash command into the TUI, cross-host) — this job
# only supplies the occasion.
#
# ponytail: absolute token floor instead of a percentage. The context WINDOW size
# is not recoverable — 1M is a beta header, and the model id in the transcript
# carries no [1m] suffix — so a percentage would need a guess. 400k is above what
# a 200k window can physically hold, so this never fires on a small-window session
# (they are simply never auto-compacted) and is ~40% on a 1M one. If small windows
# ever need this, the fix is to learn the real window size, not to lower the floor.
DEFAULT_MIN_TOKENS = 400_000
DEFAULT_IDLE_SECONDS = 7200.0  # 2h

# After firing, ignore a window for a while. Compaction normally drops `used` far
# below the floor on its own, so the gate re-closes without help; this covers the
# poll or two before that shows up.
COOLDOWN_SECONDS = 1800.0

# A compaction that did not shrink anything must not be retried forever.
#
# Live case 2026-09-17: a window sat on 486k tokens in very FEW turns, and claude
# answered `/compact` with "Not enough messages to compact." The injection still
# wrote records to the transcript, which reset the idle clock, so the gate re-armed
# and fired again every ~2h05m — seven identical notes into one topic overnight.
# `used` never moved, because it is read from the newest assistant turn and there
# was no new turn.
#
# So: remember what `used` was when we fired, and if it has not dropped by at
# least this fraction next time round, stop trying for that window. This covers
# every reason a compaction can fail to help, not just the one we saw — a refusal,
# a lost injection, a window that is not a claude TUI at all.
MIN_DROP_FRACTION = 0.10


def should_compact(
    used: int,
    idle_s: float | None,
    uptime_s: float | None,
    busy: bool,
    min_tokens: float,
    idle_seconds: float,
) -> bool:
    """The whole gate, isolated so it can be checked without a running bot.

    Idleness is floored by the window's own uptime. A window resumed with
    --continue reopens the PREVIOUS session's transcript, whose newest record can
    be days old, so `idle_s` alone would report a window that loaded ten seconds
    ago as idle for days — and we would compact it on the spot, which is the exact
    regression that made auto-compact get disabled in the first place. A window
    cannot have been idle longer than it has existed.

    `busy` is the window's own answer to "am I in the middle of something": a turn
    running, or parked on an approval/question/plan waiting for the owner. A parked
    window writes no transcript records, so it reads as idle — and /compact typed
    into it would be typed into that prompt, answering it.

    Unknown idleness or unknown uptime (a plugin too old to report either) is
    NEVER a reason to act."""
    if min_tokens <= 0 or idle_seconds <= 0:
        return False
    if busy:
        return False
    if idle_s is None or uptime_s is None:
        return False
    effective_idle = min(float(idle_s), float(uptime_s))
    return used >= min_tokens and effective_idle >= idle_seconds


def giveup_expired(gave_up_at_used: int, used: int) -> bool:
    """Has the window had any activity since we gave up on it?

    The owner's rule, 2026-09-24: no retry unless there was activity in the
    window. It is also the right rule on its own terms — claude refuses with
    "Not enough messages to compact" when there are too few TURNS since the last
    compaction, which only new turns can change; retrying an untouched window can
    only fail the same way.

    `used` is read off the newest assistant record that carries token usage, so
    it moves only when the model actually answered something. A refused /compact
    is a local command with no API call and leaves it exactly as it was. Checked
    on the incident that started all this — four refusals over six hours on one
    window, 16-17 Sep, `used` 486287 before every one of them, byte for byte.

    Deliberately NOT "seconds since the newest record": the plugin's idle clock
    counts every timestamped record, housekeeping included (attachments, queue
    operations), which would read as activity and trigger exactly the retry this
    rule exists to prevent.

    Any change counts, in either direction: growth is new turns, a shrink is a
    cleared or compacted session. Both mean the old verdict is about something
    else. An earlier version cleared it only on a shrink, which meant a window
    that merely gained turns — the case that CAN now be compacted — was never
    tried again.
    """
    return used != gave_up_at_used


def dropped_enough(before: int, after: int) -> bool:
    """Did a compaction actually shrink the context? Isolated so it is checkable.

    A window whose context did not move is a window our /compact does not help,
    whatever the reason — and the cost of guessing wrong the optimistic way is a
    note in the owner's topic every couple of hours, forever.
    """
    if before <= 0:
        return True          # nothing to compare against: let it try
    return after <= before * (1.0 - MIN_DROP_FRACTION)


def _cfg(config: dict[str, Any], key: str, default: float) -> float:
    try:
        return float(config.get("bot", {}).get(key, default))
    except (TypeError, ValueError):
        return default


async def compact_watch_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    application = context.application
    config = application.bot_data.get("config", {})
    min_tokens = _cfg(config, "compact_min_tokens", DEFAULT_MIN_TOKENS)
    idle_seconds = _cfg(config, "compact_idle_seconds", DEFAULT_IDLE_SECONDS)
    if min_tokens <= 0 or idle_seconds <= 0:
        return  # disabled

    instances = refresh_instances(application)
    if not instances:
        return
    client = get_bridge_client(context)
    # key -> {"at": monotonic, "used": tokens at fire time}
    #
    # In memory, and that is fine for these two: `at` is a monotonic clock that
    # means nothing across a restart anyway, and losing `used` only costs one
    # extra attempt.
    state: dict[str, dict] = application.bot_data.setdefault("compact_state", {})
    # Giving up is the exception — it lives in the DB. The note says "I have
    # stopped trying", and an in-memory flag made that a lie: CI redeploys this
    # bot on every push, the flag went with it, and the same window got the same
    # note again. Seen live 2026-09-24 — gave up 07:03, restart 10:00, tried
    # again 13:02.
    storage = get_storage(context)
    gave_up = storage.compact_giveups()
    now = time.monotonic()
    # Rollout breadcrumb. This job's healthy state is total silence, and silence
    # reads exactly like "the job never ran" — the same ambiguity that hid a dead
    # status watch. So say how many windows can actually be compacted, once at
    # startup and again whenever that count moves. It doubles as the readout for
    # the relaunch rollout: a window only counts here once it runs the new plugin.
    eligible = 0

    for inst in instances:
        # Codex has no context reader yet; older plugins report Claude's transcript.
        if resolve_workspace_id(inst).endswith(("#codex", "#opencode")):
            continue
        key = inst.key
        prev = state.get(key)
        if prev and now - prev["at"] < COOLDOWN_SECONDS:
            continue
        try:
            info = await client.get_context(key)
        except Exception:
            logger.debug("compact_watch: /context failed for %s", key, exc_info=True)
            continue
        if not info:
            continue
        # Unknown idleness/uptime (old plugin) is handled inside should_compact.
        idle = info.get("idle_s")
        uptime = info.get("uptime_s")
        if uptime is not None:
            eligible += 1
        used = int(info.get("used") or 0)

        # Already given up on this window? Stay given up until it has had
        # activity — see giveup_expired for why that is the signal and why
        # `used` is how we can tell.
        if key in gave_up:
            was = gave_up[key]          # read BEFORE dropping it, or the log says 0
            if giveup_expired(was, used):
                storage.clear_compact_giveup(key)
                del gave_up[key]
                # And forget the attempt that led to it: `prev` still holds the
                # tokens from back then, and growth since is "did not shrink" to
                # the check below, which gave up again without ever compacting.
                state.pop(key, None)
                prev = None
                logger.info(
                    "compact_watch: %s has had activity since we gave up (%d -> %d) — "
                    "eligible again", key, was, used,
                )
            else:
                continue

        if not should_compact(used, idle, uptime, bool(info.get("busy")), min_tokens, idle_seconds):
            continue

        # Did the previous attempt actually shrink anything? If not, this window
        # cannot be compacted by us and retrying only reposts the same note.
        if prev and not dropped_enough(prev["used"], used):
            state[key] = {"at": now, "used": used}
            storage.set_compact_giveup(key, used)
            gave_up[key] = used
            logger.warning(
                "compact_watch: giving up on %s — still %d tokens after a /compact "
                "(was %d), it is not shrinking", key, used, prev["used"],
            )
            await _note_gave_up(context, inst, used)
            continue

        ok, reason = await deliver_slash_command(context, instances, key, "/compact")
        state[key] = {"at": now, "used": used}
        if not ok:
            logger.warning("compact_watch: /compact to %s failed: %s", key, reason)
            continue
        effective_idle = min(float(idle), float(uptime))
        logger.info(
            "compact_watch: compacted %s (used=%d, idle=%.0fs)", key, used, effective_idle
        )
        await _note(context, inst, used, effective_idle)

    prior = application.bot_data.get("compact_eligible")
    if prior != eligible:
        application.bot_data["compact_eligible"] = eligible
        logger.info(
            "compact_watch: %d of %d window(s) report uptime and can be auto-compacted",
            eligible, len(instances),
        )


async def _note(context: ContextTypes.DEFAULT_TYPE, inst: Any, used: int, idle: float) -> None:
    """Say so in the window's own topic. A context that shrank by itself with no
    explanation is the kind of thing that reads as a bug later.

    Worded as "sent", not "done": deliver_slash_command confirms only that the
    keystrokes were delivered. The Windows path returns 200 as soon as PowerShell
    starts, so a failed AttachConsole — or a /compact that errors once it runs —
    is not visible here. Claiming a completed compaction we cannot observe would
    be worse than saying what we actually know."""
    storage = context.application.bot_data.get("storage")
    if storage is None:
        return
    try:
        row = storage.get_topic(resolve_workspace_id(inst))
    except Exception:
        return
    if not row:
        return
    try:
        await context.bot.send_message(
            chat_id=row[0],
            message_thread_id=row[1],
            text=t("compact.note_sent", tokens=used // 1000, hours=idle / 3600),
        )
    except Exception:
        logger.debug("compact_watch: topic note failed for %s", getattr(inst, "key", "?"), exc_info=True)


async def _note_gave_up(context: ContextTypes.DEFAULT_TYPE, inst: Any, used: int) -> None:
    """Say ONCE that we have stopped trying, then never post about this window
    again. Silence after seven identical notes reads as "still going", not as
    "stopped"."""
    storage = context.application.bot_data.get("storage")
    if storage is None:
        return
    try:
        row = storage.get_topic(resolve_workspace_id(inst))
    except Exception:
        return
    if not row:
        return
    try:
        await context.bot.send_message(
            chat_id=row[0],
            message_thread_id=row[1],
            text=t("compact.gave_up", tokens=used // 1000),
        )
    except Exception:
        logger.debug("compact_watch: give-up note failed for %s", getattr(inst, "key", "?"), exc_info=True)


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/compact_watch.py
    UP = 10 * 24 * 3600  # a long-running window, so uptime is not the binding limit
    assert should_compact(500_000, 8000, UP, False, 400_000, 7200)
    assert not should_compact(500_000, 3600, UP, False, 400_000, 7200), "idle too short"
    assert not should_compact(120_000, 99999, UP, False, 400_000, 7200), "context too small"
    assert not should_compact(500_000, None, UP, False, 400_000, 7200), "unknown idleness"
    assert not should_compact(500_000, 99999, None, False, 400_000, 7200), "unknown uptime"
    assert not should_compact(500_000, 99999, UP, False, 0, 7200), "min_tokens=0 disables"
    assert not should_compact(500_000, 99999, UP, False, 400_000, 0), "idle_seconds=0 disables"
    assert should_compact(400_000, 7200, UP, False, 400_000, 7200), "boundary is inclusive"
    # The regression this exists to prevent: a window resumed with --continue has a
    # days-old transcript but has only just started, so it must NOT be compacted.
    assert not should_compact(900_000, 5 * 24 * 3600, 30, False, 400_000, 7200), "fresh resume"
    assert should_compact(900_000, 5 * 24 * 3600, 9000, False, 400_000, 7200), "up long enough"
    # Parked on an approval for hours: idle by the transcript, but /compact would be
    # typed into the prompt it is waiting on.
    assert not should_compact(900_000, 99999, UP, True, 400_000, 7200), "busy window"

    # The retry guard. Live case 2026-09-17: claude answered /compact with "Not
    # enough messages to compact.", the injection still touched the transcript so
    # the idle clock reset, and the gate re-fired every ~2h05m — seven identical
    # notes in one topic overnight.
    assert dropped_enough(500_000, 100_000), "a real compaction must count as help"
    assert dropped_enough(500_000, 450_000), "10% is enough to count"
    assert not dropped_enough(486_000, 486_000), "unchanged means it did not help"
    assert not dropped_enough(486_000, 470_000), "a 3% wobble is not a compaction"
    assert not dropped_enough(486_000, 500_000), "growing is certainly not help"
    assert dropped_enough(0, 500_000), "no baseline yet: allow the first attempt"

    # Giving up must OUTLIVE A RESTART. This is the bug the owner caught on
    # 2026-09-24: gave up at 07:03 saying "I have stopped trying", the container
    # was restarted at 10:00, and at 13:02 the same window got the same note.
    # The flag was in memory; CI redeploys this bot on every push.
    import tempfile
    from pathlib import Path

    from bot.storage import Storage

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "t.db"
        st = Storage(db)
        assert st.compact_giveups() == {}
        st.set_compact_giveup("webapp", 721_000)
        st.close()

        st = Storage(db)                       # ← the restart
        assert st.compact_giveups() == {"webapp": 721_000}, "a give-up must survive it"

        # …and must expire ONLY on activity (the owner's rule, 2026-09-24).
        # The real numbers from the incident that started this: four refusals
        # over six hours on one window, `used` identical before every one. No
        # activity => stay given up, however long it has been.
        assert not giveup_expired(486_287, 486_287), "untouched window: never retry"
        # A new turn moves it — including GROWTH. The previous rule cleared only
        # on a shrink, so a window that merely gained turns (the one case that
        # can now compact) was never tried again.
        assert giveup_expired(486_287, 512_004), "grew: there were new turns"
        assert giveup_expired(486_287, 40_112), "shrank: cleared or compacted session"
        assert giveup_expired(721_000, 720_999), "any change is a new answer from the model"
        st.clear_compact_giveup("webapp")
        st.close()
        st = Storage(db)
        assert st.compact_giveups() == {}, "clearing must persist too"
        # Idempotent: re-giving-up updates rather than blowing up on the PK.
        st.set_compact_giveup("webapp", 500_000)
        st.set_compact_giveup("webapp", 600_000)
        assert st.compact_giveups() == {"webapp": 600_000}
        st.close()
    print("compact_watch self-check OK")
