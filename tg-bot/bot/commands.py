from __future__ import annotations

import html
import logging
import time
from os.path import basename
from typing import Any

from telegram import BotCommand, Update
from telegram.ext import Application, ContextTypes

from bot.common import (
    build_status_lines,
    find_instance,
    build_window_options,
    ensure_active_session,
    get_bridge_client,
    get_display_name,
    get_storage,
    get_user_id,
    refresh_instances,
    reply,
    resolve_topic_target,
)
from bot.i18n import t
from bot.inject import deliver_slash_command
from bot.keyboards import (
    build_settings_root_keyboard,
    build_status_windows_keyboard,
    build_window_reply_keyboard,
)
from bot.launcher import build_launch_view
from bot.touched import paths_of
from bridge.protocol import make_request_id
from bridge.registry import _row_is_stale, canonical_cwd, is_local_host


logger = logging.getLogger(__name__)

# Files listed per window before the list is cut short. Enough to see what a
# window is doing, short enough that five windows still fit in one message.
MAX_PATHS_SHOWN = 5


# Telegram-side command list (drives the / menu autocomplete in the chat).
# A function, not a module constant: a constant is built at import time, before
# i18n.configure() has read bot.locale, which would freeze the menu in the
# default language. Same reason keyboards.py makes its labels functions.
def bot_commands() -> list[BotCommand]:
    return [
        BotCommand("start", t("cmd.desc_start")),
        BotCommand("help", t("cmd.desc_help")),
        BotCommand("clear", t("cmd.desc_clear")),
        BotCommand("compact", t("cmd.desc_compact")),
        BotCommand("status", t("cmd.desc_status")),
        BotCommand("who", t("cmd.desc_who")),
        BotCommand("versions", t("cmd.desc_versions")),
        BotCommand("tasks", t("cmd.desc_tasks")),
        BotCommand("window", t("cmd.desc_window")),
        BotCommand("launch", t("cmd.desc_launch")),
        BotCommand("effort", t("cmd.desc_effort")),
        BotCommand("model", t("cmd.desc_model")),
        BotCommand("context", t("cmd.desc_context")),
        BotCommand("exit", t("cmd.desc_exit")),
        BotCommand("restart", t("cmd.desc_restart")),
        BotCommand("settings", t("cmd.desc_settings")),
    ]


async def register_bot_commands(application: Application) -> None:
    """Push the slash-command list to Telegram so the / menu shows autocomplete."""
    try:
        await application.bot.set_my_commands(bot_commands())
    except Exception:
        logger.exception("set_my_commands failed")


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # /start is the one place we (re)send the persistent keyboard. The keyboard
    # is static (📊 Окна / ⚙️ Настройки) so subsequent replies skip it.
    await reply(
        update, context,
        t("cmd.start_greeting"),
        reply_markup=build_window_reply_keyboard(),
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await reply(update, context, t("cmd.help"))


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return

    runtime_instances = refresh_instances(context)
    session = ensure_active_session(context, user.id, runtime_instances)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return

    body: dict[str, Any] = {
        "request_id": make_request_id(),
        "chat_id": message.chat_id,
        "user_id": user.id,
        "message_id": message.message_id,
        "text": "",
        "clear": True,
    }
    bridge_client = get_bridge_client(context)
    try:
        await bridge_client.post_message(session.active_instance, body)
        await reply(update, context, t("cmd.clear_sent"))
    except Exception as exc:
        logger.exception("clear failed instance=%s", session.active_instance)
        await reply(update, context, t("cmd.error", error=exc))


async def compact_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Run claude's own /compact in the target window — summarize & shrink the
    context. Unlike /clear (a soft "disregard history" prompt that still SENDS the
    over-limit context, so it fails too when a window is stranded on "Prompt is too
    long"), this injects the real slash command into the TUI, which actually frees
    the context window. Targets the window bound to the topic, else the active one."""
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)
    ok, reason = await deliver_slash_command(context, runtime_instances, target, "/compact")
    if not ok:
        await reply(
            update, context,
            t("cmd.compact_failed", display=display, reason=reason or t("common.window_unavailable")),
            parse_mode="HTML",
        )
        return
    await reply(
        update, context,
        t("cmd.compact_sent", display=display),
        parse_mode="HTML",
    )


async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    lines = await build_status_lines(context)
    await reply(update, context, "\n".join(lines) or t("common.no_windows"))


def windows_in(
    rows: list[dict[str, Any]], host: str, cwd: str, now: float
) -> list[tuple[str, str, int, str]]:
    """Live windows in one working tree: [(instance id, name, port, instance name)].

    The port is there because the name cannot tell these windows apart: every
    window in one folder has the same workspace name, which is the folder's. On
    a single host the port is unique, so it is what says which row is which.

    Three filters, all load-bearing, each already earned elsewhere in this
    codebase:
      • the registry's own staleness rule, PID-probed only for LOCAL rows —
        probing a remote pid against this machine's process table can match an
        unrelated process and revive a dead window;
      • parent_pid <= 1, the orphan whose agent died and whose plugin launchd
        kept alive, still heartbeating;
      • the same HOST, because a folder with the same absolute path on another
        machine is a different folder. This is the filter that makes the answer
        mean anything on a mesh of similar boxes.
    """
    wanted = canonical_cwd(cwd)
    out: list[tuple[str, str]] = []
    for row in rows:
        if _row_is_stale(row, now, is_local_host(str(row.get("host") or ""))):
            continue
        try:
            if int(row.get("parent_pid") or 0) <= 1:
                continue
        except (TypeError, ValueError):
            continue
        if str(row.get("host") or "") != host:
            continue
        if not wanted or canonical_cwd(str(row.get("cwd") or "")) != wanted:
            continue
        rid = str(row.get("id"))
        try:
            port = int(row.get("port") or 0)
        except (TypeError, ValueError):
            port = 0
        out.append((
            rid,
            str(row.get("workspace_name") or row.get("instance_name") or rid),
            port,
            str(row.get("instance_name") or ""),
        ))
    return out


def who_window_lines(
    here: list[tuple[str, str, int, str, list[tuple[str, float]]]], target_port: int
) -> list[str]:
    """One block per window: its name, whether it is the one asking, and what it
    reported editing. Pure, so the marking can be tested without a bot."""
    here = sorted(here, key=lambda item: (item[1].lower(), item[2]))
    names = [item[1] for item in here]
    lines: list[str] = []
    for _rid, name, port, inst_name, paths in here:
        # "This one" by ADDRESS, not by name. Every window in one folder shares
        # the folder's name, so a name test marked all of them — in exactly the
        # case this command exists for. Host is already equal (windows_in
        # filters on it); port is unique on a host.
        mark = t("who.this_one") if port and port == target_port else ""
        shown = name
        if names.count(name) > 1:
            # Two rows that read identically are no help to a person deciding
            # whether to wait. Prefer the instance name, which a human chose;
            # fall back to the port, which is at least unambiguous.
            tag = inst_name if inst_name and inst_name != name else f":{port}"
            shown = f"{name} ({tag})"
        lines.append(t("who.window", name=html.escape(shown), mark=mark))
        if not paths:
            lines.append(t("who.window_idle"))
            continue
        for path, age in paths[:MAX_PATHS_SHOWN]:
            lines.append(t("who.file", file=html.escape(basename(path)), age=_age(age)))
        if len(paths) > MAX_PATHS_SHOWN:
            lines.append(t("who.more_files", count=len(paths) - MAX_PATHS_SHOWN))
    return lines


async def who_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Who else is in this working tree right now, and what are they editing.

    Deliberately reads the RAW registry rows rather than runtime_instances: that
    list collapses several windows on one folder down to a single winner by
    design (routing must be deterministic), and the windows it collapses are
    exactly the ones this question is about.
    """
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = find_instance(runtime_instances, resolve_topic_target(update, context, runtime_instances, user_id))
    if target is None or not target.cwd:
        await reply(update, context, t("who.no_cwd"))
        return

    storage = get_storage(context)
    now = time.time()
    here = [
        (rid, name, port, inst_name, paths_of(rid, now))
        for rid, name, port, inst_name in windows_in(
            storage.get_instances(), target.host, target.cwd, now
        )
    ]

    if not here:
        await reply(update, context, t("who.nobody", cwd=html.escape(target.cwd)), parse_mode="HTML")
        return

    lines = [t("who.header", cwd=html.escape(target.cwd), count=len(here))]
    lines += who_window_lines(here, target.port)
    lines.append("")
    lines.append(t("who.bash_caveat"))
    await reply(update, context, "\n".join(lines), parse_mode="HTML")


async def context_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """How much of the context window the target window is using — estimated by the
    plugin from its own claude transcript (last assistant turn's input tokens). The
    window size (200K vs 1M) isn't in the transcript, so we show % against both."""
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)
    data = await get_bridge_client(context).get_context(target)
    if not data:
        await reply(
            update, context,
            t("cmd.context_unavailable", display=display),
            parse_mode="HTML",
        )
        return
    used = data["used"]
    model = data["model"]
    lines = [t("cmd.context_used", display=display, used=f"{used / 1000:.0f}")]
    if model:
        lines.append(t("cmd.context_model", model=model))
    lines.append(t("cmd.context_percent", pct_1m=f"{used / 1_000_000 * 100:.0f}",
                   pct_200k=f"{used / 200_000 * 100:.0f}"))
    await reply(update, context, "\n".join(lines), parse_mode="HTML")


async def window_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Synonym for tapping 📊 Окна — opens the inline window list with per-window
    status. From there the user can drill into a window and switch to it."""
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return

    session = ensure_active_session(context, user_id, runtime_instances)
    options = await build_window_options(context, session.active_instance)
    if not options:
        await reply(update, context, t("common.no_windows_available"))
        return

    await reply(
        update, context,
        t("cmd.pick_window"),
        reply_markup=build_status_windows_keyboard(options),
    )


async def chatid_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """One-time setup helper: report the current chat_id (and forum state) so the
    user can paste it into `telegram.forum_chat_id`. Works in groups too."""
    chat = update.effective_chat
    message = update.effective_message
    if chat is None or message is None:
        return
    lines = [
        f"<b>chat_id:</b> <code>{chat.id}</code>",
        f"<b>type:</b> {chat.type}",
        f"<b>is_forum:</b> {bool(getattr(chat, 'is_forum', False))}",
    ]
    if message.message_thread_id is not None:
        lines.append(f"<b>message_thread_id:</b> <code>{message.message_thread_id}</code>")
    if chat.title:
        lines.append(f"<b>title:</b> {chat.title}")
    await message.reply_text("\n".join(lines), parse_mode="HTML")


async def launch_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Picker of registered-but-offline workspaces; tapping one starts its
    claude console on the machine that owns it (see bot/launcher.py). With
    several machines configured the picker opens on the first one and the rest
    are tabs."""
    text, keyboard = build_launch_view(context)
    await reply(update, context, text, reply_markup=keyboard)


async def settings_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await reply(
        update, context,
        t("cb.settings_title"),
        reply_markup=build_settings_root_keyboard(),
        parse_mode="HTML",
    )


def _age(seconds: float) -> str:
    if seconds < 90:
        return t("common.age_seconds", n=int(seconds))
    if seconds < 5400:
        return t("common.age_minutes", n=int(seconds // 60))
    return t("common.age_hours", n=f"{seconds / 3600:.1f}")


async def tasks_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """What is still open between windows.

    Cross-window work used to be fire-and-forget: after dispatching instructions to
    two windows, "what did I ask whom, and did it come back" had to be rebuilt by
    hand from the conversation. This is that list, kept by the bot.
    """
    import time as _time

    storage = get_storage(context)
    rows = storage.open_tasks()
    if not rows:
        await reply(update, context, t("cmd.tasks_none"))
        return

    now = _time.time()
    icon = {"sent": "⏳", "blocked": "⛔"}
    lines = [t("cmd.tasks_header", count=len(rows)), ""]
    for tid, frm, to, kind, text, state, created in rows:
        verb = t("cmd.tasks_verb_asked") if kind == "ask" else "→"
        head = f"{icon.get(state, '•')} <b>#{tid}</b> {frm} {verb} {to} · {_age(now - created)}"
        snippet = " ".join(str(text).split())[:110]
        lines.append(head)
        lines.append(f"    <i>{snippet}</i>")
    lines.append("")
    lines.append(t("cmd.tasks_legend"))
    await reply(update, context, "\n".join(lines), parse_mode="HTML")


if __name__ == "__main__":  # self-check: PYTHONPATH=tg-bot python3 tg-bot/bot/commands.py
    NOW = 1_000_000.0

    def row(**over):
        base = {"id": "i", "workspace_name": "w", "host": "127.0.0.1", "port": 3100,
                "instance_name": "", "cwd": "/Work/proj", "parent_pid": 4242,
                "heartbeat_at": NOW, "pid": 4243}
        return {**base, **over}

    # The case this command exists for: two live windows in ONE tree. The
    # routing list collapses them to a winner by design; this must not.
    both = windows_in([row(id="a", workspace_name="term"), row(id="b", workspace_name="zed")],
                      "127.0.0.1", "/Work/proj", NOW)
    assert [w[1] for w in both] == ["term", "zed"], both

    # Two windows in one folder share the folder's NAME — the whole reason /who
    # exists. The port is what tells them apart; a name test marked both as
    # "this one" (found auditing, 2026-09-24).
    twins = windows_in([row(id="a", workspace_name="proj", port=3100, instance_name="Copilot-mac"),
                        row(id="b", workspace_name="proj", port=3107, instance_name="")],
                       "127.0.0.1", "/Work/proj", NOW)
    assert sorted(w[2] for w in twins) == [3100, 3107], twins
    assert {w[1] for w in twins} == {"proj"}, "the names really are identical"
    assert {w[3] for w in twins} == {"Copilot-mac", ""}, "instance name carried through"

    # …and the RENDERING, which is where the bug actually lived.
    here = [(rid, n, port, inst, []) for rid, n, port, inst in twins]
    out = who_window_lines(here, target_port=3100)
    marked = [line for line in out if t("who.this_one") in line]
    assert len(marked) == 1, f"exactly one window is the one asking, got {marked}"
    assert "Copilot-mac" in marked[0], "and it is the one on port 3100"
    headers = [line for line in out if "proj" in line]
    assert len(set(headers)) == 2, f"two identical names must render distinguishably: {headers}"
    assert any(":3107" in line for line in headers), "no instance name → fall back to the port"
    # A single window keeps its plain name — no noise when there is nothing to tell apart.
    solo = who_window_lines([("a", "proj", 3100, "Copilot-mac", [])], target_port=3100)
    assert "(" not in solo[0], solo

    # …and the three ways a row must NOT count.
    assert windows_in([row(parent_pid=1)], "127.0.0.1", "/Work/proj", NOW) == [], "orphan"
    assert windows_in([row(parent_pid="")], "127.0.0.1", "/Work/proj", NOW) == [], "unparsable pid"
    # Staleness, on the side where it is decided by the heartbeat ALONE: a
    # remote pid cannot be probed from here, so a lapsed beat is the whole
    # answer. (A local row with a lapsed beat is NOT stale by itself — its pid
    # is checked first, which is why this case is written remote.)
    assert windows_in([row(host="198.51.100.7", heartbeat_at=NOW - 10_000)],
                      "198.51.100.7", "/Work/proj", NOW) == [], "stale remote"

    # The filter that makes the answer mean anything on a mesh: the same
    # absolute path on ANOTHER machine is a different folder.
    assert windows_in([row(host="198.51.100.7")], "127.0.0.1", "/Work/proj", NOW) == [], "other machine"
    assert [w[1] for w in windows_in([row(host="198.51.100.7", heartbeat_at=NOW)],
                                     "198.51.100.7", "/Work/proj", NOW)] == ["w"], "…but it IS its own tree"

    assert windows_in([row()], "127.0.0.1", "/Work/other", NOW) == [], "different folder"
    assert windows_in([row()], "127.0.0.1", "", NOW) == [], "no folder to compare → no answer"
    # Windows drive letters are canonicalised on both sides, or one folder reads
    # as two and nobody is ever reported as sharing it.
    assert len(windows_in([row(cwd="c:\\Work\\proj")], "127.0.0.1", "C:\\Work\\proj", NOW)) == 1

    # Ages come from the ONE formatter this file already had — /tasks and /who
    # must not describe "five minutes ago" two different ways. A second copy was
    # written here and silently shadowed by that one; the check is what caught it.
    assert _age(5) == t("common.age_seconds", n=5)
    assert _age(305) == t("common.age_minutes", n=5)
    print("commands self-check OK")
