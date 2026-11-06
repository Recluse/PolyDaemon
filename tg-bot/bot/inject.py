from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path

from telegram.ext import ContextTypes

from bot.i18n import t


logger = logging.getLogger(__name__)

# Loopback hosts = same-machine windows (the bot can AttachConsole into them).
# Anything else is a remote window whose console lives on another host. Empty
# host (older plugin rows) is treated as local. Mirrors registry._LOOPBACK_HOSTS.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", ""}

# inject-keys.ps1 lives in the repo root (one above tg-bot/), next to launch-ws.ps1.
INJECT_SCRIPT = Path(__file__).resolve().parents[2] / "inject-keys.ps1"

# Win32: hide the powershell host window (same flag launcher.py uses).
_CREATE_NO_WINDOW = 0x08000000

# Defence-in-depth on the text we type into a live TUI: a leading '/' then a slash
# command of word chars, optionally followed by space-separated args. Args allow
# word chars, dot, dash and square brackets — the last for model aliases like
# `opus[1m]` (/model). Still no whitespace-within-arg, newlines, control chars or
# shell metacharacters, so we can never inject arbitrary keystrokes.
_SAFE_INJECT = re.compile(r"^/[A-Za-z][\w-]*(?: [\w.\[\]-]+)*$")


def inject_window_text(pid: int, text: str) -> None:
    """Type `text` (then Enter) into the console owned by `pid` on THIS machine.

    Used to drive in-session slash commands the bridge can't deliver as prompts
    (the channel injects text as a normal user message, not a slash command). Fire-
    and-forget powershell spawn — errors inside land in its own (hidden) console.
    Raises on a missing script / bad pid / unsafe text before spawning.

    AttachConsole is local-only, so `pid` must be a same-machine process. Callers
    must ensure the target window is local (loopback host) before calling.
    """
    if not INJECT_SCRIPT.is_file():
        raise FileNotFoundError(f"inject script not found: {INJECT_SCRIPT}")
    if not isinstance(pid, int) or pid <= 1:
        raise ValueError(f"bad pid: {pid!r}")
    if not _SAFE_INJECT.match(text):
        raise ValueError(f"unsafe inject text: {text!r}")
    subprocess.Popen(
        [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(INJECT_SCRIPT), "-ProcId", str(pid), "-Text", text,
        ],
        creationflags=_CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )
    logger.info("injected %r into pid %s via %s", text, pid, INJECT_SCRIPT.name)


def active_local_pid(context: ContextTypes.DEFAULT_TYPE, target_key: str, port: int | None = None,
                     row_id: str | None = None) -> int | None:
    """The claude process id of window ``target_key``, IFF it's on this machine.

    parent_pid is the claude TUI (the plugin's parent); fall back to the plugin
    pid (it shares the same console). Remote (non-loopback) rows are skipped — the
    bot can't AttachConsole across hosts (the plugin handles those, see
    ``deliver_slash_command``).

    ``row_id`` names the registry row routing chose: with two windows on one
    name (or a reused port) the freshest heartbeat is often the other one. The
    plugin pid's start token must still match the one it registered, or the pid
    now belongs to another process and nothing is returned."""
    from bot.common import get_storage  # local import: bot.common imports nothing from here
    from bridge.registry import _proc_start_token

    storage = get_storage(context)
    if not row_id:
        return None  # only the exact registry row routing chose is a valid target
    rows = [r for r in storage.get_instances() if str(r.get("id") or "") == row_id]
    rows.sort(key=lambda r: r.get("heartbeat_at") or 0, reverse=True)
    for r in rows:
        if str(r.get("host") or "") not in _LOOPBACK_HOSTS:
            continue
        # Typing into a console is only safe when the row's process is provably
        # the one that registered: no recorded token, a failed lookup or a
        # different token all refuse. (Console injection is Windows-only, where
        # tokens are always recorded.) The keystrokes go to the TUI, the
        # plugin's parent: a parent that exited could leave its pid to a newer
        # process, so the target must have started no later than the plugin.
        plugin_pid, recorded = r.get("pid"), str(r.get("started_at") or "")
        live = _proc_start_token(plugin_pid) if isinstance(plugin_pid, int) and plugin_pid > 1 else None
        if not recorded or live is None or live != recorded:
            logger.warning("inject: cannot confirm that pid %s still belongs to window %s", plugin_pid, target_key)
            return None
        pid = r.get("parent_pid") or plugin_pid
        if pid != plugin_pid:
            parent = _proc_start_token(int(pid))
            if not parent or not parent.isdigit() or not recorded.isdigit() or int(parent) > int(recorded):
                logger.warning("inject: pid %s is no longer the console of window %s", pid, target_key)
                return None
        return int(pid)
    return None


async def deliver_slash_command(
    context: ContextTypes.DEFAULT_TYPE,
    runtime_instances: list,
    target_key: str,
    cmd: str,
) -> tuple[bool, str]:
    """Type slash command ``cmd`` (e.g. ``"/effort high"``, ``"/exit"``) into window
    ``target_key``'s claude TUI. The bridge delivers Telegram text as a normal
    prompt, never as a slash command, so a slash command can only be RUN by typing
    it into the console. Transport depends on where the window lives:

      • loopback host → AttachConsole into its console directly (local-only);
      • remote host   → dial the plugin (co-located with its own claude TUI), which
        injects via ``POST /inject`` against its parent pid.

    Returns ``(ok, reason)``; ``reason`` is human-readable on failure. Never raises."""
    from bot.common import find_instance, get_bridge_client

    inst = find_instance(runtime_instances, target_key)
    if inst is None:
        return False, t("inject.reason_window_not_found")
    host = str(getattr(inst, "host", "") or "")
    if host in _LOOPBACK_HOSTS:
        pid = active_local_pid(context, target_key, inst.port, getattr(inst, "row_id", "") or None)
        if pid is None:
            return False, t("inject.local_window_no_pid")
        try:
            inject_window_text(pid, cmd)
        except Exception as exc:
            logger.exception("inject failed instance=%s cmd=%s", target_key, cmd)
            return False, str(exc)
        return True, ""
    from bridge.registry import instance_config
    return await get_bridge_client(context).post_inject(target_key, cmd, pinned=instance_config(inst))


async def deliver_unattended_slash_command(
    context: ContextTypes.DEFAULT_TYPE,
    runtime_instances: list,
    target_key: str,
    cmd: str,
) -> tuple[str, str]:
    """``deliver_slash_command`` for a command nobody is watching (auto-compact),
    returning the plugin's outcome (see ``BridgeClient.post_inject_outcome``).

    Only typed where the input can be seen to be empty: a loopback console and a
    plugin without that check answer ``unsupported`` and get nothing typed."""
    from bot.common import find_instance, get_bridge_client

    inst = find_instance(runtime_instances, target_key)
    if inst is None:
        return "failed", t("inject.reason_window_not_found")
    if str(getattr(inst, "host", "") or "") in _LOOPBACK_HOSTS:
        return "unsupported", "a local console cannot show its input"
    from bridge.registry import instance_config
    return await get_bridge_client(context).post_inject_outcome(
        target_key, cmd, pinned=instance_config(inst), require_empty_prompt=True,
    )
