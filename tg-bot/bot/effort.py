from __future__ import annotations

import logging

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from bot.callback_data import CB_EFFORT
from bot.common import (
    get_display_name,
    get_user_id,
    refresh_instances,
    reply,
    resolve_topic_target,
)
from bot.i18n import t
from bot.inject import deliver_slash_command


logger = logging.getLogger(__name__)

# /effort values accepted by claude (verbatim from claude.exe: the arg validator is
# ["low","medium","high","xhigh","max"], usage `/effort <low|medium|high|xhigh|max>`,
# and `ultracode` is additionally settable for supported models — "xhigh effort +
# dynamic workflows for maximum thoroughness").
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max", "ultracode", "auto")
_EFFORT_LABELS = {
    "low": "Low", "medium": "Medium", "high": "High",
    "xhigh": "xHigh", "max": "Max", "ultracode": "🔥 Ultracode", "auto": "⚙️ Auto",
}


def effort_keyboard() -> InlineKeyboardMarkup:
    def btn(lvl: str) -> InlineKeyboardButton:
        return InlineKeyboardButton(_EFFORT_LABELS[lvl], callback_data=f"{CB_EFFORT}:{lvl}")
    # ultracode on its own row — the special "max thoroughness" mode, long label.
    return InlineKeyboardMarkup([
        [btn("low"), btn("medium"), btn("high")],
        [btn("xhigh"), btn("max")],
        [btn("ultracode"), btn("auto")],
    ])


async def effort_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)
    await reply(
        update, context,
        t("effort.pick_level", display=display),
        parse_mode="HTML",
        reply_markup=effort_keyboard(),
    )


async def effort_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return
    parts = query.data.split(":")
    if len(parts) != 2 or parts[0] != CB_EFFORT:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    level = parts[1]
    if level not in EFFORT_LEVELS:
        await query.answer(t("effort.unknown_level"), show_alert=True)
        return

    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    # Resolve from the TOPIC the button sits in (not the active window) so /effort
    # always hits the window whose conversation you're looking at.
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)

    # The bridge can't deliver "/effort high" as a slash command (it'd arrive as a
    # normal prompt), so deliver_slash_command types it straight into the window's
    # TUI — locally (AttachConsole) or via the remote window's plugin (/inject).
    ok, reason = await deliver_slash_command(context, runtime_instances, target, f"/effort {level}")
    if not ok:
        logger.warning("effort inject failed instance=%s level=%s reason=%s", target, level, reason)
        await query.answer(t("common.failed_reason", reason=reason or t("common.window_unavailable")), show_alert=True)
        return

    await query.answer(f"🧠 {display}: effort → {level}")
    try:
        original_html = ""
        if query.message:
            original_html = getattr(query.message, "text_html", None) or query.message.text or ""
        suffix = f"\n\n→ 🧠 {level}"
        new_text = original_html + suffix if not original_html.endswith(suffix) else original_html
        await query.edit_message_text(text=new_text, reply_markup=None, parse_mode="HTML")
    except Exception:
        pass
    logger.info("effort set instance=%s level=%s", target, level)
