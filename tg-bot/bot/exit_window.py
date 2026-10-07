from __future__ import annotations

import asyncio
import logging

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from bot.callback_data import CB_EXIT, CB_RESTART
from bot.common import (
    find_instance,
    get_bridge_client,
    get_display_name,
    get_user_id,
    refresh_instances,
    reply,
    resolve_topic_target,
)
from bot.i18n import t
from bot.inject import deliver_slash_command
from bot.launcher import launch_workspace


logger = logging.getLogger(__name__)


def _confirm_keyboard() -> InlineKeyboardMarkup:
    # Closing a window loses the live session, so gate it behind one confirm tap
    # (mirrors the bypass-permissions confirm). The session is resumable via
    # /launch (the launchers pass --continue), which the message spells out.
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(t("exit.btn_confirm"), callback_data=f"{CB_EXIT}:go"),
        InlineKeyboardButton(t("exit.btn_cancel"), callback_data=f"{CB_EXIT}:cancel"),
    ]])


async def exit_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Ask to close a window — runs claude's own /exit in it. Targets the window
    bound to the topic the command was sent in (like /effort), else the active one."""
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)
    await reply(
        update, context,
        t("exit.confirm", display=display),
        parse_mode="HTML",
        reply_markup=_confirm_keyboard(),
    )


async def exit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return
    parts = query.data.split(":")
    if len(parts) != 2 or parts[0] != CB_EXIT:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    action = parts[1]

    if action == "cancel":
        await query.answer(t("exit.cancelled_toast"))
        try:
            await query.edit_message_text(t("exit.cancelled"))
        except Exception:
            pass
        return
    if action != "go":
        await query.answer(t("common.unknown_action"), show_alert=True)
        return

    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    # Re-resolve from the topic the confirm sits in (the confirm was sent into the
    # window's topic), so we close the window the user was looking at.
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)

    # Same transport as /effort: type "/exit" into the window's claude TUI —
    # locally (AttachConsole) or via the remote window's plugin (/inject). The
    # plugin returns ok before claude actually exits, so there's no response race.
    ok, reason = await deliver_slash_command(context, runtime_instances, target, "/exit")
    if not ok:
        logger.warning("exit inject failed instance=%s reason=%s", target, reason)
        await query.answer(
            t("common.failed_reason", reason=reason or t("common.window_unavailable")),
            show_alert=True,
        )
        return

    await query.answer(t("exit.sent_toast", display=display))
    try:
        await query.edit_message_text(
            t("exit.closing", display=display),
            parse_mode="HTML",
        )
    except Exception:
        pass
    logger.info("exit sent instance=%s", target)


async def _wait_until_gone(context: ContextTypes.DEFAULT_TYPE, key: str) -> bool:
    """Bounded wait for a closing window to leave the registry, so the relaunch
    does not collide with the dying one on the same workspace name.

    False = it is still listed. /exit being typed is not the window closing (a
    dialog, a turn in progress, a keystroke that went nowhere), and relaunching
    over a window that is still up would give that folder two."""
    for _ in range(10):
        await asyncio.sleep(1.2)
        if find_instance(refresh_instances(context), key) is None:
            return True
    return False


def _restart_confirm_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(t("exit.btn_restart_confirm"), callback_data=f"{CB_RESTART}:go"),
        InlineKeyboardButton(t("exit.btn_cancel"), callback_data=f"{CB_RESTART}:cancel"),
    ]])


async def restart_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Restart a window: close it (claude /exit) and launch it fresh. The launcher
    resumes the same session (--continue), so the practical use is rolling out a new
    plugin build (e.g. to pick up /inject) or unsticking a TUI without losing the
    conversation. Targets the window bound to the topic, else the active one.

    `/restart all` restarts every window that is not in the middle of something —
    the way to roll a plugin update out to all of them at once."""
    mode = context.args[0].strip().lower() if context.args else ""
    if mode in ("all", "stale"):
        await _restart_all_prompt(update, context, only_stale=mode == "stale")
        return
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)
    await reply(
        update, context,
        t("exit.restart_confirm", display=display),
        parse_mode="HTML",
        reply_markup=_restart_confirm_keyboard(),
    )


async def restart_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return
    parts = query.data.split(":")
    if len(parts) != 2 or parts[0] != CB_RESTART:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    action = parts[1]

    if action == "cancel":
        await query.answer(t("exit.cancelled_toast"))
        try:
            await query.edit_message_text(t("exit.restart_cancelled"))
        except Exception:
            pass
        return
    if action in ("all", "stale"):
        await query.answer()
        message = query.message
        if message is None:
            return
        await query.edit_message_text(t("exit.restart_all_started"), parse_mode="HTML")
        # In the background: one window takes ~15 s, twenty take minutes, and a
        # callback handler must not hold the update for that long.
        context.application.create_task(
            _restart_all_run(context, message.chat_id, message.message_id, only_stale=action == "stale")
        )
        return
    if action != "go":
        await query.answer(t("common.unknown_action"), show_alert=True)
        return

    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    inst = find_instance(runtime_instances, target)
    if inst is None:
        await query.answer(t("common.window_not_found"), show_alert=True)
        return
    display = get_display_name(context, target)
    # The folder NAME for the relaunch = workspace_name (== inst.key), which the
    # plugin computed as basename(cwd) on its own host. Don't os.path.basename the
    # cwd here — the bot runs on Linux and the cwd is a Windows path (no '/' to split).
    name = target

    # 1) Close it — inject claude's /exit. Needs the window's plugin to expose
    #    /inject (remote windows). If that fails we must NOT launch (the old window
    #    is still up → a relaunch would duplicate it).
    ok, reason = await deliver_slash_command(context, runtime_instances, target, "/exit")
    if not ok:
        logger.warning("restart: exit failed instance=%s reason=%s", target, reason)
        await query.answer(
            t("exit.restart_close_failed", reason=reason or t("common.window_unavailable")),
            show_alert=True,
        )
        return
    await query.answer(t("exit.restart_toast", display=display))
    try:
        await query.edit_message_text(
            t("exit.restart_pending", display=display),
            parse_mode="HTML",
        )
    except Exception:
        pass

    # 2) Wait (bounded) for it to deregister, so the relaunch doesn't collide with
    #    the dying window on the same workspace name.
    if not await _wait_until_gone(context, target):
        try:
            await query.edit_message_text(
                t("exit.restart_not_closed", display=display), parse_mode="HTML",
            )
        except Exception:
            pass
        return

    # 3) Launch it fresh — same transport as /launch (launch-agent on the host).
    #    The cwd goes with it: it is what picks the MACHINE. This call used to pass
    #    a name alone, and with several machines that reopened a Windows window on
    #    the Mac; launch_workspace now refuses a missing cwd outright when there is
    #    more than one machine. The cwd was captured above, before /exit, while the
    #    window was still listed.
    try:
        await launch_workspace(context, name, inst.cwd)
    except Exception as exc:
        logger.exception("restart: launch failed name=%r", name)
        try:
            await query.edit_message_text(
                t("exit.restart_launch_failed", display=display, error=exc),
                parse_mode="HTML",
            )
        except Exception:
            pass
        return
    try:
        await query.edit_message_text(
            t("exit.restart_done", display=display),
            parse_mode="HTML",
        )
    except Exception:
        pass
    logger.info("restart done instance=%s name=%s", target, name)


# ── /restart all ──────────────────────────────────────────────────────────────
#
# Rolling a plugin update out means restarting every window, and a window in the
# middle of a turn must not be cut off — including, very likely, the one the
# request came from. So windows are sorted first and only the quiet ones go.
#
# The awkward case is the one this command exists for: `busy` is a field only
# newer plugins report, and the windows that most need restarting are exactly the
# ones still running an older plugin. Skipping everything without the field would
# skip them all; treating a missing field as "free" could cut one off mid-turn.
# So a missing `busy` falls back to how long the window has been silent, and a
# window that reports neither is left alone and NAMED — /restart on it, one at a
# time, still works and asks first.

# A window silent for less than this, with no `busy` field to go on, is treated as
# working. Two minutes covers a model thinking between tool calls.
QUIET_ENOUGH_SECONDS = 120


def classify_for_restart(info: dict | None) -> str:
    """'idle', 'busy' or 'unknown' for one window's /context answer."""
    if not info:
        return "unknown"
    busy = info.get("busy")
    if busy is True:
        return "busy"
    if busy is False:
        return "idle"
    idle_s = info.get("idle_s")
    if isinstance(idle_s, (int, float)):
        return "idle" if idle_s >= QUIET_ENOUGH_SECONDS else "busy"
    return "unknown"


async def _sort_windows(context: ContextTypes.DEFAULT_TYPE, instances: list) -> tuple[list, list, list]:
    client = get_bridge_client(context)
    idle, busy, unknown = [], [], []
    for inst in instances:
        try:
            info = await client.get_context(inst.key)
        except Exception:
            info = None
        {"idle": idle, "busy": busy, "unknown": unknown}[classify_for_restart(info)].append(inst)
    return idle, busy, unknown


def _names(instances: list) -> str:
    return ", ".join(sorted(i.display_name for i in instances)) or "—"


def _skipped_lines(busy: list, unknown: list) -> str:
    out = ""
    if busy:
        out += t("exit.restart_all_skip_busy", names=_names(busy))
    if unknown:
        out += t("exit.restart_all_skip_unknown", names=_names(unknown))
    return out


async def _candidates(context: ContextTypes.DEFAULT_TYPE, only_stale: bool) -> list:
    instances = refresh_instances(context)
    if only_stale and instances:
        from bot.versions import stale_window_keys
        stale = await stale_window_keys(context, instances)
        instances = [i for i in instances if i.key in stale]
    return instances


async def _restart_all_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE, only_stale: bool = False) -> None:
    instances = await _candidates(context, only_stale)
    if not instances:
        await reply(update, context, t("exit.restart_stale_none") if only_stale else t("common.no_windows"))
        return
    idle, busy, unknown = await _sort_windows(context, instances)
    skipped = _skipped_lines(busy, unknown)
    if not idle:
        await reply(update, context, t("exit.restart_all_none", skipped=skipped), parse_mode="HTML")
        return
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton(t("exit.btn_restart_all", count=len(idle)),
                             callback_data=f"{CB_RESTART}:{'stale' if only_stale else 'all'}"),
        InlineKeyboardButton(t("exit.btn_cancel"), callback_data=f"{CB_RESTART}:cancel"),
    ]])
    await reply(
        update, context,
        t("exit.restart_all_confirm", count=len(idle), names=_names(idle), skipped=skipped),
        parse_mode="HTML",
        reply_markup=keyboard,
    )


async def _restart_all_run(context: ContextTypes.DEFAULT_TYPE, chat_id: int, message_id: int,
                           only_stale: bool = False) -> None:
    async def status(text: str) -> None:
        try:
            await context.bot.edit_message_text(
                chat_id=chat_id, message_id=message_id, text=text, parse_mode="HTML",
            )
        except Exception:
            pass

    # Sort AGAIN, now: minutes may have passed since the confirm, and a window that
    # was quiet then may be working now.
    idle, busy, unknown = await _sort_windows(context, await _candidates(context, only_stale))
    done, failed = [], []
    for n, inst in enumerate(idle, 1):
        await status(t("exit.restart_all_progress", i=n, n=len(idle), name=inst.display_name))
        current = refresh_instances(context)
        if find_instance(current, inst.key) is None:
            continue                         # closed on its own meanwhile
        ok, reason = await deliver_slash_command(context, current, inst.key, "/exit")
        if not ok:
            failed.append(f"{inst.display_name} ({reason or t('common.window_unavailable')})")
            continue
        if not await _wait_until_gone(context, inst.key):
            failed.append(f"{inst.display_name} ({t('exit.still_open')})")
            continue
        try:
            await launch_workspace(context, inst.key, inst.cwd)
            done.append(inst.display_name)
        except Exception as exc:
            logger.exception("restart all: launch failed name=%r", inst.key)
            failed.append(f"{inst.display_name} ({exc})")
    failed_lines = t("exit.restart_all_failed", items=", ".join(failed)) if failed else ""
    await status(t(
        "exit.restart_all_done",
        done=", ".join(done) or "—",
        failed=failed_lines,
        skipped=_skipped_lines(busy, unknown),
    ))
    logger.info("restart all: done=%s failed=%s", done, failed)


if __name__ == "__main__":  # self-check: PYTHONPATH=tg-bot python3 tg-bot/bot/exit_window.py
    # Who gets restarted. The costly mistakes are cutting off a working window and
    # skipping every window that runs an older plugin — the ones that need it most.
    assert classify_for_restart({"busy": True}) == "busy"
    assert classify_for_restart({"busy": False}) == "idle"
    assert classify_for_restart({"busy": False, "idle_s": 3}) == "idle", "busy=False is authoritative"
    # Older plugin, no `busy`: fall back to how long it has been silent.
    assert classify_for_restart({"idle_s": 3600}) == "idle", "old plugin, quiet an hour"
    assert classify_for_restart({"idle_s": 30}) == "busy", "old plugin, active 30 s ago"
    assert classify_for_restart({"idle_s": QUIET_ENOUGH_SECONDS}) == "idle"
    # Nothing to go on: leave it alone rather than guess.
    assert classify_for_restart({}) == "unknown"
    assert classify_for_restart(None) == "unknown"
    assert classify_for_restart({"used": 5}) == "unknown"

    # The run itself, with the network faked out.
    import asyncio as _asyncio
    from types import SimpleNamespace as _NS
    from bot import i18n as _i18n
    _i18n.configure({"bot": {"locale": "en"}})

    win_ok = _NS(key="api", display_name="api", cwd="C:\\projects\\api")
    mac_ok = _NS(key="web", display_name="web", cwd="/Users/me/Work/web")
    stuck = _NS(key="stuck", display_name="stuck", cwd="/Users/me/Work/stuck")
    working = _NS(key="busy1", display_name="busy1", cwd="/Users/me/Work/busy1")
    wontclose = _NS(key="wontclose", display_name="wontclose", cwd="/Users/me/Work/wc")
    live = {w.key: w for w in (win_ok, mac_ok, stuck, working, wontclose)}

    exits, launches, edits = [], [], []

    async def fake_sort(context, instances):
        return [win_ok, mac_ok, stuck, wontclose], [working], []

    async def fake_deliver(context, instances, key, cmd):
        exits.append((key, cmd))
        if key == "stuck":
            return False, "no /inject"
        live.pop(key, None)                  # it closes
        return True, ""

    async def fake_launch(context, name, cwd=""):
        launches.append((name, cwd))

    async def fake_wait(context, key):
        return key != "wontclose"

    globals()["_sort_windows"] = fake_sort
    globals()["deliver_slash_command"] = fake_deliver
    globals()["launch_workspace"] = fake_launch
    globals()["_wait_until_gone"] = fake_wait
    globals()["refresh_instances"] = lambda context: list(live.values())
    globals()["find_instance"] = lambda instances, key: next((i for i in instances if i.key == key), None)

    class _Bot:
        async def edit_message_text(self, **kw): edits.append(kw["text"])

    _asyncio.run(_restart_all_run(_NS(bot=_Bot()), chat_id=1, message_id=2))

    assert ("busy1", "/exit") not in exits, "a working window is never touched"
    assert launches == [("api", "C:\\projects\\api"), ("web", "/Users/me/Work/web")], \
        f"each reopens with its OWN cwd, i.e. on its own machine: {launches}"
    assert not any(n == "stuck" for n, _ in launches), \
        "if /exit failed the old window is still up — relaunching would duplicate it"
    assert not any(n == "wontclose" for n, _ in launches), \
        "/exit typed but the window stayed up — relaunching would give the folder two"
    final = edits[-1]
    assert "wontclose (did not close)" in final, final
    assert "api" in final and "web" in final, final
    assert "stuck" in final and "no /inject" in final, "a failure is reported with its reason"
    assert "busy1" in final, "and what was skipped is named, not silently dropped"
    print("exit_window self-check OK")
