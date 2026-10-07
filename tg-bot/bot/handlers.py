from __future__ import annotations

import logging
from typing import Any

from telegram import Chat, Update
from telegram.ext import (
    Application,
    ApplicationHandlerStop,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    MessageReactionHandler,
    TypeHandler,
    filters,
)

from bot.callback_data import (
    CB_APPROVE,
    CB_ASK,
    CB_EFFORT,
    CB_EXIT,
    CB_LAUNCH,
    CB_MODEL,
    CB_RESTART,
    CB_UPDATE,
    CB_PERM,
    CB_PLAN,
    CB_REPLY_TO,
    CB_SETTINGS,
    CB_WINDOW,
    CB_WSTATUS,
)
from bot.callbacks import (
    approve_callback,
    ask_callback,
    launch_callback,
    permissions_callback,
    plan_callback,
    reply_to_callback,
    settings_callback,
    window_callback,
    window_status_callback,
)
from bot.commands import (
    chatid_command,
    clear_command,
    compact_command,
    context_command,
    help_command,
    launch_command,
    settings_command,
    start_command,
    status_command,
    who_command,
    tasks_command,
    window_command,
)
from bot.effort import effort_callback, effort_command
from bot.exit_window import exit_callback, exit_command, restart_callback, restart_command
from bot.i18n import t
from bot.model_cmd import model_callback, model_command
from bot.messages import attachment_message, image_message, reaction_message, text_message, unhandled_message
from bot.session import SessionStore
from bot.storage import Storage
from bot.versions import update_callback, versions_command
from bridge.client import ChannelPluginClient


logger = logging.getLogger(__name__)


def register_handlers(
    application: Application,
    config: dict[str, Any],
    sessions: SessionStore,
    bridge_client: ChannelPluginClient,
    storage: Storage,
) -> None:
    application.bot_data["config"] = config
    application.bot_data["sessions"] = sessions
    application.bot_data["bridge_client"] = bridge_client
    application.bot_data["storage"] = storage

    # Gatekeeper runs in group=-1 so it can short-circuit unauthorized users
    # before any other handler sees the update. Replaces the per-handler
    # _ensure_allowed checks.
    application.add_handler(TypeHandler(Update, _allowed_users_gate), group=-1)

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("clear", clear_command))
    application.add_handler(CommandHandler("compact", compact_command))
    application.add_handler(CommandHandler("context", context_command))
    application.add_handler(CommandHandler("model", model_command))
    application.add_handler(CommandHandler("status", status_command))
    application.add_handler(CommandHandler("who", who_command))
    application.add_handler(CommandHandler("versions", versions_command))
    application.add_handler(CommandHandler("tasks", tasks_command))
    application.add_handler(CommandHandler("window", window_command))
    application.add_handler(CommandHandler("settings", settings_command))
    application.add_handler(CommandHandler("launch", launch_command))
    application.add_handler(CommandHandler("effort", effort_command))
    application.add_handler(CommandHandler("exit", exit_command))
    application.add_handler(CommandHandler("restart", restart_command))
    application.add_handler(CommandHandler("chatid", chatid_command))
    application.add_handler(CallbackQueryHandler(window_callback, pattern=rf"^{CB_WINDOW}:"))
    application.add_handler(CallbackQueryHandler(launch_callback, pattern=rf"^{CB_LAUNCH}:"))
    application.add_handler(CallbackQueryHandler(effort_callback, pattern=rf"^{CB_EFFORT}:"))
    application.add_handler(CallbackQueryHandler(model_callback, pattern=rf"^{CB_MODEL}:"))
    application.add_handler(CallbackQueryHandler(exit_callback, pattern=rf"^{CB_EXIT}:"))
    application.add_handler(CallbackQueryHandler(restart_callback, pattern=rf"^{CB_RESTART}:"))
    application.add_handler(CallbackQueryHandler(update_callback, pattern=rf"^{CB_UPDATE}:"))
    application.add_handler(CallbackQueryHandler(approve_callback, pattern=rf"^{CB_APPROVE}:"))
    application.add_handler(CallbackQueryHandler(ask_callback, pattern=rf"^{CB_ASK}:"))
    application.add_handler(CallbackQueryHandler(plan_callback, pattern=rf"^{CB_PLAN}:"))
    application.add_handler(CallbackQueryHandler(reply_to_callback, pattern=rf"^{CB_REPLY_TO}:"))
    application.add_handler(CallbackQueryHandler(permissions_callback, pattern=rf"^{CB_PERM}:"))
    application.add_handler(CallbackQueryHandler(settings_callback, pattern=rf"^{CB_SETTINGS}:"))
    application.add_handler(CallbackQueryHandler(window_status_callback, pattern=rf"^{CB_WSTATUS}:"))
    application.add_handler(MessageHandler((filters.PHOTO | filters.Document.IMAGE) & ~filters.COMMAND, image_message))
    # Any other attachment kind — PDFs, archives, video, audio, voice notes.
    # Without this, non-image files from the user hit no handler and are
    # silently dropped (never forwarded to Claude).
    application.add_handler(
        MessageHandler(
            (
                (filters.Document.ALL & ~filters.Document.IMAGE)
                | filters.VIDEO
                | filters.AUDIO
                | filters.VOICE
                | filters.VIDEO_NOTE
            )
            & ~filters.COMMAND,
            attachment_message,
        )
    )
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_message))
    # Catch-all — MUST be registered after every specific MessageHandler above so
    # they match first (PTB uses the first matching handler per group). Anything
    # left (sticker, dice, GIF, poll, story, or a content type newer than this
    # bot's library) would otherwise fall through every handler and vanish with no
    # log. This forwards a placeholder + logs the type instead.
    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, unhandled_message))
    application.add_handler(MessageReactionHandler(reaction_message))


async def _allowed_users_gate(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Reject updates from non-allowed users with a single short reply."""
    allowed = context.application.bot_data["config"].get("telegram", {}).get("allowed_users", []) or []
    if not allowed:
        # Unreachable in a normal start: tgbridge.build_application refuses to
        # boot on an empty allowlist. Kept as a second line of defence, and it
        # now DENIES rather than letting everyone through — if this list is ever
        # empty at runtime, the safe reading is "nobody is authorised", not
        # "everybody is".
        raise ApplicationHandlerStop

    user = update.effective_user
    if user is not None and user.id in allowed:
        return  # authorized — let other handlers run

    # Drop silently (no refusal) for updates that aren't a human asking for
    # something: the bot's own activity — notably the `forum_topic_created`
    # service message Telegram posts into each topic we create, whose from-user
    # is the bot itself — and anonymous service updates. Without this the gate
    # spammed "🚫 Доступ запрещён" into every freshly-created forum topic.
    if user is None or user.is_bot:
        raise ApplicationHandlerStop

    # Unauthorized human. Only bother replying in private chats — a per-message
    # refusal in a group/forum is noise.
    #
    # The refusal names the person's OWN user id. Without it, setup had no way
    # in: the bot will not start on an empty allowlist, so a first run carries
    # a placeholder; the way to learn your id is /chatid; and /chatid sits behind
    # this very gate, so it answered "access denied" and nothing else — while the
    # config example told people to use it. Saying someone's own id back to them
    # discloses nothing: Telegram already gave it to us in this update, and it
    # reveals nothing about who IS allowed.
    chat = update.effective_chat
    if chat is not None and chat.type == Chat.PRIVATE:
        refusal = t("gate.access_denied", user_id=user.id)
        message = update.effective_message
        if message is not None:
            try:
                await message.reply_text(refusal)
            except Exception:
                pass
        query = update.callback_query
        if query is not None:
            try:
                await query.answer(refusal, show_alert=True)
            except Exception:
                pass

    raise ApplicationHandlerStop
