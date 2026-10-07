from __future__ import annotations

import html
import logging
import traceback

from telegram import Update
from telegram.error import NetworkError, RetryAfter
from telegram.ext import ContextTypes

from bot.i18n import t


logger = logging.getLogger(__name__)


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Catch-all for exceptions in handlers, jobs, and the polling loop.

    Logs the full traceback and, if there's an update we can reply to, sends a
    short user-facing apology so the user doesn't sit forever in "typing…".
    """
    # Transient Bot-API connectivity (the :8081 tunnel dropping): PTB's polling
    # loop retries forever and recovers on its own, and the apology below would
    # go over the SAME dead connection — raising a second NetworkError and
    # doubling the noise. Log (CompactNetworkErrors collapses it) and bail.
    if isinstance(context.error, NetworkError):
        logger.error("Network error while handling an update", exc_info=context.error)
        return

    # Telegram flood control (RetryAfter): a burst of messages (e.g. 20+ channel
    # posts forwarded at once) trips per-chat rate limits. The action itself is
    # already best-effort; sending an apology here would add MORE traffic to the
    # same throttled chat and just deepen the flood. Log and bail — no apology.
    if isinstance(context.error, RetryAfter):
        logger.warning("flood control (RetryAfter %ss) while handling an update — suppressing apology",
                       getattr(context.error, "retry_after", "?"))
        return

    logger.error("Exception while handling an update:", exc_info=context.error)

    if not isinstance(update, Update):
        return
    message = update.effective_message
    if message is None:
        return

    try:
        await message.reply_text(t("err.internal"))
    except Exception:
        logger.exception("failed to send error notification to user")

    # Verbose detail at debug-level so operators can pull it from logs without
    # spamming the user.
    if context.error:
        tb = "".join(traceback.format_exception(None, context.error, context.error.__traceback__))
        logger.debug("Full traceback:\n%s", html.escape(tb))
