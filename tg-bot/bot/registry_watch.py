from __future__ import annotations

import asyncio
import logging
import shutil
import socket
from html import escape
from pathlib import Path
from typing import Any

from telegram.ext import Application, ContextTypes

from bot.common import (
    QUICK_PING_TIMEOUT,
    find_instance,
    persist_active_instances,
    refresh_instances,
    resolve_default_key,
)
from bot.i18n import t
from bot.keyboards import build_window_reply_keyboard
from bot.session import SessionStore
from bot.topics import ensure_topics_for
from bridge.client import ChannelPluginClient


logger = logging.getLogger(__name__)


# Registry poll interval (seconds). Since the registry moved from watched files to
# the bot.db `instances` table (written by the plugins), there's no filesystem
# event to react to — this periodic job is the sole trigger that picks up newly
# registered / departed windows. config.yaml: bot.instance_poll_interval overrides.
DEFAULT_POLL_INTERVAL = 30.0

# How many consecutive ticks a window can stay in the registry but not answer
# /status before we forget we announced it — so it gets a fresh "появилось" the
# next time it actually responds. Tuned to be longer than a single tool-call
# churn (a busy plugin can miss /status for a few seconds under load) but short
# enough that a genuine recovery still triggers a re-announce. With the default
# 3s poll this is 60s of no-status before we expire.
OFFLINE_EXPIRE_TICKS = 20


# ---------------------------------------------------------------------------
# JobQueue callback — runs periodically and on watchdog events
# ---------------------------------------------------------------------------

async def broadcast_changes_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    # Loudly surface any per-tick failure — APScheduler logs job errors but PTB's
    # error_handler only catches update-handler errors, not JobQueue ones, and a
    # silent stall here looks exactly like "bot died" (no topic-status updates,
    # no instance changes broadcast). Catching keeps the next tick fresh.
    try:
        await _broadcast_instance_changes(context.application)
    except Exception:
        logger.exception("broadcast_changes_job tick failed")


async def cleanup_routes_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    storage = context.application.bot_data["storage"]
    removed = storage.cleanup_old_routes(max_age_hours=24.0)
    if removed:
        logger.info("cleaned up %d old message routes", removed)


# Watch the bot's state filesystem, not the remote agents' session disks.
# Hysteresis: warn once on the way down, re-arm only after it recovers.
LOW_DISK_DEFAULT_GB = 2.0


def infra_warn_chat_id(application: Application) -> int | None:
    """Where infrastructure-level warnings go (disk, provider outages). Shared on
    purpose: two copies of this fallback would drift, and a warning that lands in
    the wrong chat is a warning nobody reads."""
    config = application.bot_data.get("config", {})
    override = config.get("bot", {}).get("low_disk_warn_chat_id")
    if override:
        try:
            return int(override)
        except (TypeError, ValueError):
            pass
    # Fall back to any known forum chat — all window topics live in one supergroup.
    storage = application.bot_data.get("storage")
    if storage is not None:
        try:
            for _ws, chat, _thread, _title in storage.all_topics():
                if chat:
                    return int(chat)
        except Exception:
            logger.debug("disk_watch: all_topics lookup failed", exc_info=True)
    return None


async def disk_watch_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    application = context.application
    config = application.bot_data.get("config", {})
    try:
        threshold_gb = float(config.get("bot", {}).get("low_disk_warn_gb", LOW_DISK_DEFAULT_GB))
    except (TypeError, ValueError):
        threshold_gb = LOW_DISK_DEFAULT_GB
    if threshold_gb <= 0:
        return  # disabled
    disk_path = Path.home()
    host = str(config.get("bot", {}).get("host_name") or socket.gethostname())
    try:
        usage = shutil.disk_usage(disk_path)
        free_gb = usage.free / (1024 ** 3)
    except Exception:
        logger.debug("disk_watch: disk_usage failed", exc_info=True)
        return

    warned = bool(application.bot_data.get("low_disk_warned", False))
    if free_gb < threshold_gb and not warned:
        chat_id = infra_warn_chat_id(application)
        if chat_id is not None:
            try:
                await context.bot.send_message(
                    chat_id,
                    t("watch.low_disk", host=escape(host), path=escape(str(disk_path)),
                      free_gb=free_gb, total_gb=usage.total / (1024 ** 3), threshold_gb=threshold_gb),
                    parse_mode="HTML",
                )
            except Exception:
                logger.exception("disk_watch: failed to send low-disk warning")
        application.bot_data["low_disk_warned"] = True
        logger.warning("disk_watch: LOW disk on %s (%s) — %.1f GiB free (threshold %.0f)",
                       host, disk_path, free_gb, threshold_gb)
    elif free_gb >= threshold_gb + 1.0 and warned:
        application.bot_data["low_disk_warned"] = False  # re-arm with 1 GiB hysteresis
        logger.info("disk_watch: disk recovered — %.1f GiB free", free_gb)


# ---------------------------------------------------------------------------
# Broadcast: notify users when the set of registered windows changes
# ---------------------------------------------------------------------------

async def _broadcast_instance_changes(application: Application) -> None:
    # Watchdog fires on_any_event for every fs event (create + content write
    # via os.replace, plus the polling job), and each event schedules 4 retries.
    # Without a lock, concurrent runs all read announced_instance_keys=∅ before
    # any of them writes it back, and each sends its own "🟢 появилось" line.
    lock: asyncio.Lock = application.bot_data.setdefault("broadcast_lock", asyncio.Lock())
    async with lock:
        await _broadcast_instance_changes_locked(application)


async def _broadcast_instance_changes_locked(application: Application) -> None:
    config: dict[str, Any] = application.bot_data["config"]
    bridge_client: ChannelPluginClient = application.bot_data["bridge_client"]
    sessions: SessionStore = application.bot_data["sessions"]

    instances = refresh_instances(application)

    new_keys = {i.key for i in instances}
    new_display = {i.key: i.display_name for i in instances}
    # `announced` = the set of keys the user has already been told about. We
    # only announce a window once it's actually reachable, so a brand-new
    # plugin whose HTTP server hasn't bound yet gets deferred to the next tick
    # instead of producing a "🟢 появилось" line with no keyboard button.
    old_announced: set[str] = application.bot_data.get("announced_instance_keys", set())
    old_display: dict[str, str] = application.bot_data.get("known_instance_display", {})

    application.bot_data["known_instance_display"] = new_display

    is_initial = not application.bot_data.get("instance_snapshot_initialized")
    application.bot_data["instance_snapshot_initialized"] = True

    if instances:
        results = await asyncio.gather(
            *(bridge_client.get_status(i.key, timeout=QUICK_PING_TIMEOUT) for i in instances),
            return_exceptions=True,
        )
        available_keys = {
            inst.key for inst, res in zip(instances, results, strict=False)
            if not isinstance(res, Exception) and res is not None
        }
    else:
        available_keys = set()

    # Track per-key offline streaks so a window that's been in-registry but
    # unreachable for OFFLINE_EXPIRE_TICKS gets dropped from `announced` — a
    # short blip stays in (no spam), but a long absence followed by recovery
    # re-announces. Counter resets on each successful /status response.
    offline_streaks: dict[str, int] = application.bot_data.setdefault("offline_streaks", {})
    for key in list(offline_streaks):
        if key not in new_keys:
            offline_streaks.pop(key, None)  # reaped from registry — fully forget
    for key in new_keys:
        if key in available_keys:
            offline_streaks.pop(key, None)  # reset on recovery
        else:
            offline_streaks[key] = offline_streaks.get(key, 0) + 1
    expired = {k for k, n in offline_streaks.items() if n >= OFFLINE_EXPIRE_TICKS}

    # Drop announcements for instances that vanished from the registry OR have
    # been silently offline long enough to count as "left and came back". Keep
    # announcements for ones currently reachable or only briefly offline —
    # transient blips shouldn't spam "появилось" again when they recover.
    new_announced = ((old_announced & new_keys) - expired) | available_keys
    appeared = available_keys - old_announced
    disappeared = {k for k in old_announced if k not in new_keys}
    application.bot_data["announced_instance_keys"] = new_announced

    # Forum topics: ensure one per *live* window (no-op unless a forum chat is
    # configured). Idempotent/self-healing — see bot/topics.py.
    #
    # Drive the topic 🟢/🔴 marker off registry presence, NOT the 1.5s /status
    # ping: a window churning through a tool call (e.g. a big Bash unzip) can't
    # answer /status in time and would flap 🔴↔🟢 every tick under the watchdog's
    # retry burst. `instances` is already liveness-filtered by the start-time
    # token, so a busy-but-alive window stays 🟢; 🔴 now means the window
    # actually left the registry. (The "появилось" announcement above still
    # gates on `available_keys`, so we don't announce a window before it's
    # reachable.)
    await ensure_topics_for(application, instances)

    base_lines: list[str] = []
    if is_initial:
        if not available_keys:
            return
        base_lines.append(t("watch.bot_started"))
        for key in sorted(available_keys):
            base_lines.append(f"🟢 {new_display.get(key, key)}")
    else:
        for key in sorted(appeared):
            base_lines.append(t("watch.window_appeared", display=new_display.get(key, key)))
        for key in sorted(disappeared):
            base_lines.append(t("watch.window_disconnected", display=old_display.get(key, key)))
        if not base_lines:
            return

    targets = _resolve_notify_targets(config, sessions)
    if not targets:
        return

    persist_needed = False
    for user_id in targets:
        try:
            session = sessions.get(user_id)
            user_lines = list(base_lines)
            # If the user's active window vanished, fall back to the configured default.
            if instances and find_instance(instances, session.active_instance) is None:
                fallback = resolve_default_key(config, instances)
                sessions.set_active_instance(user_id, fallback)
                session = sessions.get(user_id)
                persist_needed = True
                user_lines.append(t("watch.active_window", display=new_display.get(fallback, fallback)))

            # Persistent keyboard is static now, so we don't need a per-instance
            # status fan-out here. Re-send it cheaply so brand-new chats also
            # get the keyboard on first registry tick.
            await application.bot.send_message(
                chat_id=user_id,
                text="\n".join(user_lines),
                reply_markup=build_window_reply_keyboard(),
            )
        except Exception:
            logger.exception("instance broadcast failed for user_id=%s", user_id)

    if persist_needed:
        persist_active_instances(application)


def _resolve_notify_targets(config: dict[str, Any], sessions: SessionStore) -> list[int]:
    """Pick chat_ids to push registry changes to. In private chats, chat_id == user_id."""
    allowed = config.get("telegram", {}).get("allowed_users", []) or []
    if allowed:
        return [int(uid) for uid in allowed]
    return list(sessions.to_active_map().keys())
