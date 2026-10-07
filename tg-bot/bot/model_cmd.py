from __future__ import annotations

import logging
import re

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from bot.callback_data import CB_MODEL
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

# Model aliases claude accepts after `/model`.
# GOTCHA: the `[1m]` suffix (forces the 1M context window) only attaches to a
# BARE family alias or a FULL model id — never to the short-with-version form.
# So `opus[1m]` and `claude-opus-5[1m]` work, but `opus-5[1m]` is rejected with
# "Model 'opus-5[1m]' not found" (live case 2026-09-03: every 1M button was dead).
#   opus / sonnet / fable / opusplan        bare family aliases (accept [1m])
#   claude-opus-5, claude-opus-4-8, ...     full ids (accept [1m])
#   sonnet                                  Sonnet 5 (always 1M)
# Buttons cover the common picks; `/model <alias>` also takes any alias directly.
_MODELS: list[tuple[str, str]] = [
    ("claude-opus-5[1m]", "🧠 Opus 5 · 1M"),
    ("claude-opus-5", "Opus 5"),
    ("claude-opus-4-8[1m]", "Opus 4.8 · 1M"),
    ("sonnet", "⚡ Sonnet 5 · 1M"),
    ("claude-fable-5[1m]", "🎯 Fable 5 · 1M"),
    ("opusplan[1m]", "🗂 opusplan · 1M"),
]

# A model alias: word chars, dot, dash, and [1m]-style bracket suffix. Mirrors the
# arg half of inject._SAFE_INJECT so a free-typed `/model <alias>` can't smuggle
# anything the injector would reject anyway.
_ALIAS_RE = re.compile(r"^[\w.\[\]-]+$")


def model_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(label, callback_data=f"{CB_MODEL}:{alias}")] for alias, label in _MODELS]
    )


async def _deliver_model(
    context: ContextTypes.DEFAULT_TYPE, runtime_instances, target: str, alias: str
) -> tuple[bool, str]:
    return await deliver_slash_command(context, runtime_instances, target, f"/model {alias}")


async def model_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Switch the target window's model (e.g. enable the 1M context via opus[1m]).
    `/model` opens a picker; `/model <alias>` applies it directly. Targets the
    window bound to the topic (like /effort), else the active one."""
    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)

    alias = " ".join(context.args).strip() if context.args else ""
    if not alias:
        await reply(
            update, context,
            t("model.pick_prompt", display=display),
            parse_mode="HTML",
            reply_markup=model_keyboard(),
        )
        return
    if not _ALIAS_RE.match(alias):
        await reply(update, context, t("model.bad_alias"))
        return
    ok, reason = await _deliver_model(context, runtime_instances, target, alias)
    if not ok:
        await reply(
            update, context,
            t("model.switch_failed", display=display,
              reason=reason or t("common.window_unavailable")),
            parse_mode="HTML",
        )
        return
    await reply(
        update, context,
        t("model.sent", display=display, alias=alias),
        parse_mode="HTML",
    )


async def model_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or not query.data:
        return
    parts = query.data.split(":", 1)
    if len(parts) != 2 or parts[0] != CB_MODEL:
        await query.answer(t("common.bad_callback"), show_alert=True)
        return
    alias = parts[1]
    if not _ALIAS_RE.match(alias):
        await query.answer(t("model.bad_alias_short"), show_alert=True)
        return

    user_id = get_user_id(update)
    runtime_instances = refresh_instances(context)
    target = resolve_topic_target(update, context, runtime_instances, user_id)
    display = get_display_name(context, target)

    ok, reason = await _deliver_model(context, runtime_instances, target, alias)
    if not ok:
        await query.answer(t("common.failed_reason", reason=reason or t("common.window_unavailable")),
                           show_alert=True)
        return
    await query.answer(f"🧠 {display}: model → {alias}")
    try:
        original_html = ""
        if query.message:
            original_html = getattr(query.message, "text_html", None) or query.message.text or ""
        suffix = f"\n\n→ 🧠 {alias}"
        new_text = original_html + suffix if not original_html.endswith(suffix) else original_html
        await query.edit_message_text(text=new_text, reply_markup=None, parse_mode="HTML")
    except Exception:
        pass
    logger.info("model set instance=%s alias=%s", target, alias)
