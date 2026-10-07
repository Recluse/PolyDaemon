from __future__ import annotations

import logging
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from telegram.ext import ContextTypes

from bot.common import get_bridge_client, get_config, get_storage, refresh_instances


logger = logging.getLogger(__name__)

# A workspace name is a folder basename — letters/digits/space/dot/dash/underscore,
# and must NOT start with '-' (PowerShell would parse a leading-dash token as a
# parameter to launch-ws.ps1, not the positional $Name). Popen's list form already
# blocks shell metachar injection; this is defence-in-depth on the arg parser.
_SAFE_NAME = re.compile(r"^[\w.][\w .\-]*$")

# launch-ws.ps1 lives in the repo root (one above tg-bot/). It opens the folder
# it is given (-Dir), or finds the workspace by folder NAME (scans the workspace
# root for polydaemon-claude.cmd; that root is the script's own -WorkspaceRoot /
# $env:TG_WS_ROOT setting, NOT something this side configures), opens a visible console with claude, nudges the startup TUI
# with Enters and minimizes the window — all logic we don't want to duplicate.
LAUNCH_SCRIPT = Path(__file__).resolve().parents[2] / "launch-ws.ps1"
MAC_LAUNCH_SCRIPT = Path(__file__).resolve().parents[2] / "clients" / "launch-ws.sh"

# Win32: hide the powershell HOST window (the script itself opens the visible
# claude console via Start-Process). CREATE_NO_WINDOW only — combining it with
# DETACHED_PROCESS is invalid (mutually-exclusive console-creation flags) and
# left powershell console-less: its Start-Process then never produced a
# visible cmd window, so /launch taps silently did nothing. Popen doesn't
# wait, so the script's ~12s Enter-nudge never blocks the bot either way.
_CREATE_NO_WINDOW = 0x08000000


# ── Which machine can launch what ────────────────────────────────────────────
#
# /launch used to know exactly one machine: `bot.launch_agent_url`, the Windows
# PC. The Mac counterpart of the launch script (clients/launch-ws.sh) existed but
# nothing called it, so half the windows could not be started from Telegram at
# all.
#
# Several agents now, each declaring which working trees it owns by cwd PREFIX.
# Prefix, not "guess from the path shape": `/Users/...` vs `C:\...` happens to
# separate these two machines today and would silently mis-route the moment a
# second POSIX box joins the mesh. The bot should not infer which computer a
# folder is on — that is a fact about the setup, so the setup states it.
#
# One agent with no prefixes owns everything, which is what keeps the old
# single-machine config working untouched.


@dataclass(frozen=True, slots=True)
class LaunchAgent:
    label: str                     # what the tab says; '' = the only machine, no tabs
    url: str
    prefixes: tuple[str, ...]      # canonicalised cwd prefixes; () = everything


def _norm_path(p: str) -> str:
    return str(p or "").replace("\\", "/").rstrip("/").lower()


def _owns(agent: LaunchAgent, cwd: str) -> bool:
    if not agent.prefixes:
        return True
    target = _norm_path(cwd)
    # Prefix match on SEGMENT boundaries: "/Users/x/Work" must not claim
    # "/Users/x/Workshop".
    return any(target == p or target.startswith(p + "/") for p in agent.prefixes)


def launch_agents(context: ContextTypes.DEFAULT_TYPE) -> list[LaunchAgent]:
    """Configured launch agents, in config order. Empty = no agent at all, so
    the co-located spawn path in `launch_workspace` is used."""
    section = get_config(context).get("bot", {}) or {}
    raw = section.get("launch_agents")
    agents: list[LaunchAgent] = []
    if isinstance(raw, (list, tuple)):
        for entry in raw:
            if not isinstance(entry, dict):
                logger.warning("bot.launch_agents entry is not a mapping: %r — skipped", entry)
                continue
            url = str(entry.get("url") or "").strip()
            if not url:
                logger.warning("bot.launch_agents entry has no url: %r — skipped", entry)
                continue
            prefixes = entry.get("prefixes") or []
            if isinstance(prefixes, str):
                prefixes = [prefixes]
            agents.append(LaunchAgent(
                label=str(entry.get("label") or "").strip(),
                url=url,
                prefixes=tuple(_norm_path(p) for p in prefixes if str(p or "").strip()),
            ))
    if agents:
        return agents
    # Legacy single-agent form. Deliberately still supported and deliberately
    # label-less: one machine needs no tab to choose it.
    single = str(section.get("launch_agent_url", "")).strip()
    return [LaunchAgent(label="", url=single, prefixes=())] if single else []


# cwds that matched no agent, so the warning is said once rather than on every
# refresh. A workspace that quietly stops being offered is the kind of thing
# nobody notices until they go looking for a window that will not start.
_unclaimed_warned: set[str] = set()


def list_launchable(
    context: ContextTypes.DEFAULT_TYPE, agent: LaunchAgent | None = None
) -> list[tuple[str, str]]:
    """Registered-but-not-running workspaces that can be started.

    "Registered" = has a row in `window_topics` (was connected at least once,
    so the bot knows its cwd and its forum topic). "Can be started" = a
    tg-claude launcher exists at that cwd. Currently-live windows are excluded
    by canonical-cwd match against the runtime registry.

    With `agent`, only the workspaces THAT machine owns. Without it, everything
    any configured agent owns — which is the whole list when there is one agent
    and the list shown before tabs existed.

    Returns [(title, cwd)] sorted by title.
    """
    storage = get_storage(context)
    agents = launch_agents(context)
    # Remote mode: the workspaces live on another machine (the bot runs on
    # bot-host, the windows on the Mac and the Windows PC), so we can't stat
    # the launcher locally — trust the topic registry, the launch-agent owns the
    # on-disk check.
    remote = bool(agents)
    live_cwds = {
        (inst.cwd or "").lower()
        for inst in refresh_instances(context)
    }
    result: list[tuple[str, str]] = []
    for workspace_id, _chat, _thread, title in storage.all_topics():
        if workspace_id.lower() in live_cwds:
            continue
        if not remote and not _has_local_launcher(workspace_id):
            continue
        # "Claimed by anyone" and "claimed by THIS machine" are two separate
        # questions, and the warning belongs to the first one. Nesting it in the
        # else of the second made it unreachable in the only configuration where
        # it matters: with tabs on screen every call names an agent, so an
        # unclaimed folder was dropped in total silence — the exact failure this
        # warning exists to prevent. Found auditing this code, 2026-09-24.
        if agents and not any(_owns(a, workspace_id) for a in agents):
            if workspace_id not in _unclaimed_warned:
                _unclaimed_warned.add(workspace_id)
                logger.warning(
                    "no launch agent claims %r — it will not be offered; add its root to "
                    "a bot.launch_agents prefixes list", workspace_id,
                )
            continue
        if agent is not None and not _owns(agent, workspace_id):
            continue
        result.append((title, workspace_id))
    return sorted(result, key=lambda t: t[0].lower())


def _has_local_launcher(cwd: str) -> bool:
    """Co-located bot only: does this folder have a launcher we can run here?
    Both names, because the co-located case is a Windows PC today and a Mac
    tomorrow and the check should not be the thing that decides."""
    return any((Path(cwd) / name).is_file() for name in (
        "polydaemon-claude.cmd", "polydaemon-claude.sh", "tg-claude.cmd", "tg-claude.sh",
    ))


async def launch_workspace(
    context: ContextTypes.DEFAULT_TYPE, name: str, cwd: str = ""
) -> None:
    """Launch the window for `name` (folder basename) in the tree at `cwd`.

    Two transports:
      • an agent owns `cwd` → the workspace is on ANOTHER machine. POST `/launch`
                to that machine's launch-agent (clients/launch-agent.ts) over the
                same mesh-HTTP + Bearer channel the bot already uses to reach
                plugins — no SSH, no tunnel. The agent runs its platform's
                launch script locally.
      • no agents configured → the bot is co-located with the workspaces;
                run this platform's launch script directly (launch-ws.ps1
                on Windows, clients/launch-ws.sh on macOS and Linux — the latter
                in tmux).
    Both transports pass `cwd` along, so the script opens that folder rather
    than searching its workspace root by name.

    `cwd` is what picks the MACHINE; the name is only the fallback the launch
    script searches its workspace root for when it gets no usable folder.
    Two machines can hold a folder of the same name, and sending the name alone
    used to mean the single configured agent got it whether the folder was
    its own or not.

    With one agent (or none) `cwd` may be omitted: there is only one place to go.
    With several it is REQUIRED. An earlier version fell back to the first agent
    instead, and /restart — the one caller that did not pass a cwd — then closed
    a Windows window and tried to reopen it on the Mac. Guessing a machine is
    worse than refusing: the refusal is visible, the wrong machine is not.

    `name` is `_SAFE_NAME`-validated either way (it crosses an HTTP/arg boundary
    and feeds a `-File … <name>` invocation). Raises on a missing script /
    unreachable agent / no agent for that tree, so the caller can surface it.
    """
    if not _SAFE_NAME.match(name):
        raise ValueError(f"unsafe workspace name: {name!r}")
    bot_config = get_config(context).get("bot", {})
    agents = launch_agents(context)
    if agents:
        if cwd:
            agent = next((a for a in agents if _owns(a, cwd)), None)
            if agent is None:
                raise LookupError(
                    f"no launch agent owns {cwd!r} — add its root to a "
                    f"bot.launch_agents prefixes list"
                )
        elif len(agents) == 1:
            agent = agents[0]
        else:
            raise ValueError(
                f"which machine? {len(agents)} launch agents are configured and no "
                f"cwd was given for {name!r}"
            )
        token = str(bot_config.get("registry_enroll_token", "")).strip()
        await get_bridge_client(context).post_launch(agent.url, token, name, cwd)
        logger.info("launch requested for workspace %r via agent %s (%s)",
                    name, agent.url, agent.label or "unlabelled")
        return
    # Co-located: the bot runs on the machine that holds the workspaces.
    if sys.platform == "win32":
        script, argv, flags = LAUNCH_SCRIPT, [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(LAUNCH_SCRIPT), name] + (["-Dir", cwd] if cwd else []), _CREATE_NO_WINDOW
    else:
        # macOS: an iTerm2 tab or Terminal window; Linux: a detached tmux session.
        if sys.platform != "darwin" and not shutil.which("tmux"):
            raise NotImplementedError("/launch on Linux needs tmux installed")
        script, argv, flags = MAC_LAUNCH_SCRIPT, [
            "bash", str(MAC_LAUNCH_SCRIPT), name] + ([cwd] if cwd else []), 0
    if not script.is_file():
        raise FileNotFoundError(f"launch script not found: {script}")
    subprocess.Popen(
        argv,
        creationflags=flags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )
    logger.info("launch requested for workspace %r via %s", name, script.name)


def resolve_agent_label(context: ContextTypes.DEFAULT_TYPE, token: str) -> str:
    """Callback token back to a machine label, or '' if it names none."""
    from bot.keyboards import cb_token
    return next((a.label for a in launch_agents(context)
                 if a.label and cb_token(a.label) == token), "")


def build_launch_view(
    context: ContextTypes.DEFAULT_TYPE, label: str = ""
) -> tuple[str, object | None]:
    """The /launch picker for one machine: (text, keyboard) — keyboard None when
    there is nothing to offer anywhere.

    Shared by the command and both callbacks so the three cannot drift: the tab
    row, the default tab and the empty-state wording are decided once.
    """
    from bot.i18n import t
    from bot.keyboards import build_launch_keyboard

    agents = launch_agents(context)
    tabs = [a.label for a in agents if a.label]
    # Default to the first machine rather than a merged list: with tabs on
    # screen, "one machine at a time" is what the tabs say it is. Unlabelled
    # (single-machine or legacy config) keeps the old undivided list.
    if tabs and label not in tabs:
        label = tabs[0]
    agent = next((a for a in agents if a.label and a.label == label), None)
    workspaces = list_launchable(context, agent)
    if not workspaces and not tabs:
        return t("common.launch_all_running"), None
    if not workspaces:
        # An empty MACHINE is not an empty system — keep the tabs so the other
        # one is still one tap away instead of a dead end.
        return t("cb.launch_none_here", machine=label), build_launch_keyboard([], tabs, label)
    return t("cb.launch_pick"), build_launch_keyboard(workspaces, tabs, label)


if __name__ == "__main__":  # self-check: PYTHONPATH=tg-bot python3 tg-bot/bot/launcher.py
    # Prefix ownership decides WHICH MACHINE a launch is sent to. Getting it
    # wrong means a 200 and no window, so the negatives matter most.
    mac = LaunchAgent("Mac", "http://mac:8091", (_norm_path("/Users/me/Work"),))
    win = LaunchAgent("Windows", "http://win:8091", (_norm_path("C:\\Work"),))
    any_ = LaunchAgent("", "http://one:8091", ())

    assert _owns(mac, "/Users/me/Work/api-gateway")
    assert _owns(mac, "/users/me/work/api-gateway"), "case-insensitive"
    assert not _owns(mac, "/Users/me/Workshop/x"), "must match on a path segment"
    assert not _owns(mac, "/Users/other/Work/x")
    assert _owns(mac, "/Users/me/Work"), "the root itself belongs to it"

    assert _owns(win, "C:\\Work\\proj"), "backslashes"
    assert _owns(win, "c:/Work/proj"), "…and the same path written either way"
    assert not _owns(win, "D:\\Work\\proj")
    assert not _owns(win, "/Users/me/Work/api-gateway"), "the other machine's tree"
    assert not _owns(mac, "C:\\Work\\proj")

    # An agent with no prefixes owns everything — this is what keeps a
    # single-machine config working with no prefixes written anywhere.
    assert _owns(any_, "/anything") and _owns(any_, "C:\\anything")

    # A trailing slash in config must not change the answer.
    assert _owns(LaunchAgent("M", "u", (_norm_path("/Users/me/Work/"),)),
                 "/Users/me/Work/api-gateway")

    # Both machines can hold a folder of the same NAME; only the cwd tells them
    # apart, which is why launch_workspace routes on cwd and not on name.
    same_name = "/Users/me/Work/shared"
    assert _owns(mac, same_name) and not _owns(win, same_name)
    assert _owns(win, "C:\\Work\\shared") and not _owns(mac, "C:\\Work\\shared")

    # The unclaimed-folder warning must fire when a MACHINE is selected — that
    # is the only configuration where tabs exist, and it was unreachable there.
    import logging as _logging

    class _CountingHandler(_logging.Handler):
        def __init__(self): super().__init__(); self.msgs = []
        def emit(self, record): self.msgs.append(record.getMessage())

    class _FakeStorage:
        def all_topics(self):
            return [("/Users/me/Work/a", -1, 1, "a"), ("/nowhere/b", -1, 2, "b")]
        def get_instances(self):
            return []          # nothing live, so nothing is filtered out as running
        def delete_instances(self, *a, **kw):
            pass

    class _FakeClient:
        def sync_instances(self, *a, **kw):
            pass

    class _Ctx2:
        def __init__(self, cfg, storage):
            self.application = type("A", (), {"bot_data": {
                "config": cfg, "storage": storage,
                "bridge_client": _FakeClient(), "runtime_instances": [],
            }})

    cfg = {"bot": {"launch_agents": [
        {"label": "Mac", "url": "http://mac:8091", "prefixes": ["/Users/me/Work"]},
    ]}}
    ctx = _Ctx2(cfg, _FakeStorage())
    handler = _CountingHandler()
    logger.addHandler(handler)
    _unclaimed_warned.clear()
    mac_agent = launch_agents(ctx)[0]
    got = list_launchable(ctx, mac_agent)
    logger.removeHandler(handler)

    assert [t for t, _ in got] == ["a"], got
    assert any("/nowhere/b" in m for m in handler.msgs), \
        f"an unclaimed folder must be named in the log even when a tab is selected: {handler.msgs}"

    # Config parsing. A typo here yields ZERO agents, which reads on screen as
    # "everything is already running" — so the shapes are pinned down.
    class _Ctx:
        def __init__(self, cfg): self.application = type("A", (), {"bot_data": {"config": cfg}})

    def agents(bot_section):
        return launch_agents(_Ctx({"bot": bot_section}))

    two = agents({"launch_agents": [
        {"label": "Mac", "url": "http://mac:8091", "prefixes": ["/Users/me/Work"]},
        {"label": "Windows", "url": "http://win:8091", "prefixes": "C:\\Work"},
    ]})
    assert [a.label for a in two] == ["Mac", "Windows"], "config order is tab order"
    assert two[1].prefixes == (_norm_path("C:\\Work"),), "a lone prefix may be a bare string"
    assert _owns(two[0], "/Users/me/Work/x") and not _owns(two[1], "/Users/me/Work/x")

    # An entry with no url cannot launch anything; junk must not take the rest
    # of the list down with it.
    partial = agents({"launch_agents": [
        {"label": "Broken"}, "not-a-mapping",
        {"label": "Mac", "url": "http://mac:8091"},
    ]})
    assert [a.label for a in partial] == ["Mac"]

    # Legacy single-agent config: still works, still unlabelled, so no tabs.
    legacy = agents({"launch_agent_url": "http://win:8091"})
    assert len(legacy) == 1 and legacy[0].label == "" and legacy[0].prefixes == ()
    assert _owns(legacy[0], "C:\\Work\\anything"), "one machine owns everything"
    # launch_agents wins over the legacy key when both are present.
    both = agents({"launch_agent_url": "http://old:8091",
                   "launch_agents": [{"label": "Mac", "url": "http://mac:8091"}]})
    assert [a.url for a in both] == ["http://mac:8091"]
    # Nothing configured = co-located spawn path, not a broken agent.
    assert agents({}) == [] and agents({"launch_agents": []}) == []

    # Which machine a launch goes to. The case that broke /restart: several
    # agents, no cwd — it must REFUSE, not quietly pick the first one.
    import asyncio as _asyncio

    class _Posts:
        def __init__(self): self.calls = []
        async def post_launch(self, url, token, name, cwd=""): self.calls.append((url, name, cwd))

    def _launch(agents_cfg, name, cwd=""):
        posts = _Posts()
        ctx = type("C", (), {"application": type("A", (), {"bot_data": {
            "config": {"bot": agents_cfg}, "bridge_client": posts}})})()
        _asyncio.run(launch_workspace(ctx, name, cwd))
        return posts.calls

    both = {"launch_agents": [
        {"label": "Mac", "url": "http://mac:8091", "prefixes": ["/Users/me/Work"]},
        {"label": "Windows", "url": "http://win:8091", "prefixes": ["C:\\projects"]},
    ]}
    assert _launch(both, "shared", "C:\\projects\\shared") == [
        ("http://win:8091", "shared", "C:\\projects\\shared")], \
        "a Windows cwd goes to the Windows agent even though the Mac is listed first"
    assert _launch(both, "shared", "/Users/me/Work/shared") == [
        ("http://mac:8091", "shared", "/Users/me/Work/shared")], "the folder travels to the agent"
    try:
        _launch(both, "shared")
        raise AssertionError("several agents and no cwd must refuse")
    except ValueError:
        pass
    # One agent: nowhere else to go, so no cwd is fine.
    assert _launch({"launch_agent_url": "http://one:8091"}, "x") == [("http://one:8091", "x", "")]

    # The name validator still refuses what the launch scripts cannot take.
    assert _SAFE_NAME.match("api-gateway") and _SAFE_NAME.match("my.proj-1")
    assert not _SAFE_NAME.match("-Force"), "a leading dash parses as a PowerShell parameter"
    assert not _SAFE_NAME.match("a;b") and not _SAFE_NAME.match("../etc")
    assert not _SAFE_NAME.match("")
    print("launcher self-check OK")
