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


def active_local_pid(context: ContextTypes.DEFAULT_TYPE, target_key: str) -> int | None:
    """The claude process id of window ``target_key``, IFF it's on this machine.

    parent_pid is the claude TUI (the plugin's parent); fall back to the plugin
    pid (it shares the same console). Remote (non-loopback) rows are skipped — the
    bot can't AttachConsole across hosts (the plugin handles those, see
    ``deliver_slash_command``)."""
    from bot.common import get_storage  # local import: bot.common imports nothing from here

    storage = get_storage(context)
    rows = [r for r in storage.get_instances() if str(r.get("workspace_name") or "") == target_key]
    rows.sort(key=lambda r: r.get("heartbeat_at") or 0, reverse=True)
    for r in rows:
        if str(r.get("host") or "") not in _LOOPBACK_HOSTS:
            continue
        pid = r.get("parent_pid") or r.get("pid")
        if pid:
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
        pid = active_local_pid(context, target_key)
        if pid is None:
            return False, t("inject.local_window_no_pid")
        try:
            inject_window_text(pid, cmd)
        except Exception as exc:
            logger.exception("inject failed instance=%s cmd=%s", target_key, cmd)
            return False, str(exc)
        return True, ""
    return await get_bridge_client(context).post_inject(target_key, cmd)
