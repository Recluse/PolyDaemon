from __future__ import annotations

import logging
import math
from typing import Any

from telegram.ext import ContextTypes

from bot.common import get_bridge_client, get_storage, refresh_instances
from bot.i18n import t
from bot.inject import deliver_slash_command
from bot.topics import resolve_workspace_id


logger = logging.getLogger(__name__)
DEFAULT_MIN_TOKENS = 400_000
DEFAULT_IDLE_SECONDS = 7200.0


def should_compact(
    used: int,
    idle_s: float | None,
    uptime_s: float | None,
    busy: bool,
    min_tokens: float,
    idle_seconds: float,
) -> bool:
    """Unknown telemetry never authorizes injection into a possibly busy TUI.

    Uptime bounds idleness: resuming an old transcript must not immediately
    compact it. The absolute token floor avoids guessing the model's window size.
    The independent durable topic gate is checked again just before dispatch.
    """
    if type(used) is not int or used < 0 or busy is not False:
        return False
    values = (idle_s, uptime_s, min_tokens, idle_seconds)
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values):
        return False
    return (min_tokens > 0 and idle_seconds > 0 and used >= min_tokens
            and min(idle_s, uptime_s) >= idle_seconds)


def _cfg(config: dict[str, Any], key: str, default: float) -> float:
    try:
        return float(config.get('bot', {}).get(key, default))
    except (TypeError, ValueError):
        return default


async def compact_watch_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    application = context.application
    config = application.bot_data.get('config', {})
    min_tokens = _cfg(config, 'compact_min_tokens', DEFAULT_MIN_TOKENS)
    idle_seconds = _cfg(config, 'compact_idle_seconds', DEFAULT_IDLE_SECONDS)
    if any(not math.isfinite(v) or v <= 0 for v in (min_tokens, idle_seconds)):
        return

    instances = refresh_instances(application)
    if not instances:
        return
    client, storage = get_bridge_client(context), get_storage(context)
    for inst in instances:
        workspace = resolve_workspace_id(inst)
        if workspace.endswith(('#codex', '#opencode', '#mimo')):
            continue
        try:
            topic = storage.get_topic(workspace)
            if not topic or (len(topic) > 3 and topic[3]):
                continue
            chat_id, thread_id = topic[:2]
            if not storage.compact_ready(chat_id, thread_id, idle_seconds):
                continue
            info = await client.get_context(inst.key)
            if not isinstance(info, dict) or not should_compact(
                info.get('used'), info.get('idle_s'), info.get('uptime_s'),
                info.get('busy'), min_tokens, idle_seconds,
            ):
                continue
            # Rebinding or topic activity during the await invalidates this snapshot.
            if storage.get_topic(workspace) != topic:
                continue
            if not storage.claim_compact_attempt(chat_id, thread_id, idle_seconds):
                continue
        except Exception:
            logger.warning('compact_watch: eligibility unavailable for %s; skipped', inst.key, exc_info=True)
            continue

        # Reservation survives cancellation, timeout, process death and an
        # accepted-but-unconfirmed injection. Token changes cannot re-arm it.
        try:
            ok, reason = await deliver_slash_command(context, instances, inst.key, '/compact')
        except Exception:
            logger.warning('compact_watch: delivery to %s raised; attempt remains consumed', inst.key, exc_info=True)
            continue
        if not ok:
            logger.warning('compact_watch: delivery to %s failed: %s; attempt remains consumed', inst.key, reason)
            continue
        idle = min(info['idle_s'], info['uptime_s'])
        logger.info('compact_watch: sent /compact to %s (used=%d, idle=%.0fs)', inst.key, info['used'], idle)
        try:
            await context.bot.send_message(
                chat_id=chat_id, message_thread_id=thread_id,
                text=t('compact.note_sent', tokens=info['used'] // 1000, hours=idle / 3600),
                rate_limit_args={'topic_activity': False},
            )
        except Exception:
            logger.debug('compact_watch: topic note failed for %s', inst.key, exc_info=True)


if __name__ == '__main__':
    assert should_compact(500_000, 9000, 10000, False, 400_000, 7200)
    assert not should_compact(500_000, 9000, 30, False, 400_000, 7200)
    assert not should_compact(500_000, None, 10000, False, 400_000, 7200)
    assert not should_compact(500_000, 9000, 10000, True, 400_000, 7200)
    print('compact_watch self-check OK')
