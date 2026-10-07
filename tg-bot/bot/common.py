from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from telegram import ReplyKeyboardMarkup, Update
from telegram.ext import Application, ContextTypes

from bot.keyboards import WindowOption, build_window_reply_keyboard
from bot.paths import ACTIVE_INSTANCES_PATH
from bot.session import SessionStore
from bot.storage import Storage
from bridge.client import ChannelPluginClient
from bridge.registry import RuntimeInstance, build_instance_configs, load_runtime_instances


logger = logging.getLogger(__name__)

# Short timeout used only for quick pings during /window and /status.
QUICK_PING_TIMEOUT = 1.5


# ---------------------------------------------------------------------------
# Atomic file writes
# ---------------------------------------------------------------------------

def atomic_write_text(path: Path, content: str) -> None:
    """Write `content` to `path` via a tempfile + os.replace in the same dir.

    `os.replace` is atomic within a filesystem on POSIX and Windows (NT5+), so
    concurrent readers never see a half-written file. On Windows the replace
    can lose a race with AV / cloud-sync briefly holding the dest open
    (`WinError 5: Access is denied`); retry with backoff before giving up since
    those locks clear in milliseconds. `topic-bindings.json` saw this several
    times/day before this guard.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        # 5 attempts ramping 50ms→800ms — total worst-case ~1.5s, well under any
        # caller timeout. PermissionError is the WinError 5 we keep seeing; on
        # POSIX os.replace doesn't raise that, so the loop is a no-op there.
        delay = 0.05
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                logger.warning("atomic_write_text: replace failed (attempt %d/5) for %s — retrying in %.0fms", attempt + 1, path, delay * 1000)
                time.sleep(delay)
                delay *= 2
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Application-data accessors
# ---------------------------------------------------------------------------

def get_config(context: ContextTypes.DEFAULT_TYPE) -> dict[str, Any]:
    return context.application.bot_data["config"]


def get_sessions(context: ContextTypes.DEFAULT_TYPE) -> SessionStore:
    return context.application.bot_data["sessions"]


def get_bridge_client(context: ContextTypes.DEFAULT_TYPE) -> ChannelPluginClient:
    return context.application.bot_data["bridge_client"]


def get_storage(context: ContextTypes.DEFAULT_TYPE) -> Storage:
    return context.application.bot_data["storage"]


def get_user_id(update: Update) -> int:
    user = update.effective_user
    if user is None:
        raise RuntimeError("Update has no effective user.")
    return user.id


# ---------------------------------------------------------------------------
# Instance/session helpers
# ---------------------------------------------------------------------------

def refresh_instances(context_or_app: Any) -> list[RuntimeInstance]:
    application = context_or_app.application if hasattr(context_or_app, "application") else context_or_app
    config = application.bot_data["config"]
    storage: Storage = application.bot_data["storage"]
    bridge_client: ChannelPluginClient = application.bot_data["bridge_client"]
    instances = load_runtime_instances(config, storage)
    bridge_client.sync_instances(
        build_instance_configs(instances),
        decision_instances=build_instance_configs(
            load_runtime_instances(config, storage, keep_duplicates=True)
        ),
    )
    application.bot_data["runtime_instances"] = instances
    return instances


def resolve_default_key(config: dict[str, Any], instances: list[RuntimeInstance]) -> str:
    # Override file (settings menu) wins over config.yaml — user-set in the UI
    # should not be silently overridden by a stale yaml default.
    from bot.settings import load_default_instance_override
    override = load_default_instance_override()
    if override:
        for i in instances:
            if override == i.key:
                return i.key
    default = str(config.get("bot", {}).get("default_instance", "")).strip()
    if default:
        for i in instances:
            if default in {i.key, i.instance_name, i.display_name}:
                return i.key
    return instances[0].key


def find_instance(instances: list[RuntimeInstance], key: str) -> RuntimeInstance | None:
    return next((i for i in instances if i.key == key), None)


def ensure_active_session(
    context: ContextTypes.DEFAULT_TYPE,
    user_id: int,
    runtime_instances: list[RuntimeInstance] | None = None,
):
    sessions = get_sessions(context)
    session = sessions.get(user_id)
    instances = runtime_instances if runtime_instances is not None else refresh_instances(context)
    if not instances:
        return session
    if find_instance(instances, session.active_instance) is not None:
        return session
    default_key = resolve_default_key(get_config(context), instances)
    result = sessions.set_active_instance(user_id, default_key)
    persist_active_instances(context.application)
    return result


def resolve_topic_target(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    runtime_instances: list[RuntimeInstance],
    user_id: int,
) -> str:
    """Which window a per-window action (e.g. /effort, /exit) targets.

    In a per-window forum TOPIC, the window bound to that topic — so the command
    (or its button tapped) hits THE window whose conversation you're looking at,
    exactly like a native reply, not whatever happens to be the globally active
    window. Falls back to the user's active window in DMs / unbound threads."""
    msg = update.effective_message
    if msg is not None and msg.message_thread_id is not None:
        storage = get_storage(context)
        # A thread may be bound by SEVERAL workspaces (the same project open on
        # two machines, so two different absolute paths). Try every binding and
        # route to whichever has a LIVE window — the dead machine's row must not
        # shadow it. Live case, 2026-08-21: a /compact typed in one topic landed
        # in the OTHER machine's window, because the first binding stored was the
        # path on the machine that was no longer running.
        from bot.topics import resolve_workspace_id
        candidates = storage.get_workspaces_by_thread(msg.chat_id, msg.message_thread_id)
        if candidates:
            for ws in candidates:
                inst = next((i for i in runtime_instances if resolve_workspace_id(i) == ws), None)
                if inst is not None:
                    return inst.key
            # Bound topic but NO live window for any binding: return the stored
            # title so the command targets THAT window and fails cleanly
            # ("окно недоступно") instead of silently rerouting to the globally
            # active window (which just compacted/steered the wrong project).
            topic = storage.get_topic(candidates[0])
            return topic[2] if topic and len(topic) > 2 else candidates[0]
    return ensure_active_session(context, user_id, runtime_instances).active_instance


def get_display_name(context: ContextTypes.DEFAULT_TYPE, instance_name: str) -> str:
    instances = context.application.bot_data.get("runtime_instances") or refresh_instances(context)
    found = find_instance(instances, instance_name)
    return found.display_name if found else instance_name


def get_active_instance(update: Update, context: ContextTypes.DEFAULT_TYPE) -> str | None:
    try:
        return get_sessions(context).get(get_user_id(update)).active_instance
    except RuntimeError:
        return None


# ---------------------------------------------------------------------------
# active-instances.json — channel plugin reads this for the "Reply here" button
# ---------------------------------------------------------------------------

def persist_active_instances(application: Application) -> None:
    try:
        sessions: SessionStore = application.bot_data["sessions"]
        payload = {str(uid): key for uid, key in sessions.to_active_map().items()}
        atomic_write_text(ACTIVE_INSTANCES_PATH, json.dumps(payload, indent=2))
    except Exception:
        logger.exception("failed to persist active instances")


# ---------------------------------------------------------------------------
# Window options + reply keyboard
# ---------------------------------------------------------------------------

def build_button_texts(instances: list[RuntimeInstance]) -> dict[str, str]:
    counts: dict[str, int] = {}
    for i in instances:
        counts[i.display_name] = counts.get(i.display_name, 0) + 1
    return {
        i.key: i.display_name if counts[i.display_name] == 1 else f"{i.display_name} [{i.port}]"
        for i in instances
    }


async def build_window_options(
    context: ContextTypes.DEFAULT_TYPE,
    active_instance: str,
) -> list[WindowOption]:
    runtime_instances = refresh_instances(context)
    return await build_window_options_for(get_bridge_client(context), runtime_instances, active_instance)


async def build_window_options_for(
    bridge_client: ChannelPluginClient,
    runtime_instances: list[RuntimeInstance],
    active_instance: str,
) -> list[WindowOption]:
    """Build the inline keyboard rows for /window and 📊 Окна.

    Uses /status (not /ping) so the button label can encode both reachability
    and the workspace's current attention-state. The status emoji ordering
    matters: needs-attention states (ask/approve/plan) override mid-turn
    indicators because they're what the user has to act on.
    """
    if not runtime_instances:
        return []

    results = await asyncio.gather(
        *(bridge_client.get_status(i.key, timeout=QUICK_PING_TIMEOUT) for i in runtime_instances),
        return_exceptions=True,
    )
    button_texts = build_button_texts(runtime_instances)

    options: list[WindowOption] = []
    for instance, result in zip(runtime_instances, results, strict=False):
        is_active = instance.key == active_instance
        btn = button_texts[instance.key]
        active_marker = "✅" if is_active else "•"
        if isinstance(result, Exception) or result is None:
            # Offline path stays available=False so it disappears from the
            # persistent reply keyboard (only available windows go there).
            label = f"🔴 {active_marker} {btn} (offline)"
            options.append(WindowOption(name=instance.key, button_text=btn, label=label, available=False))
            continue
        status_emoji = _pick_status_emoji(result)
        label = f"{status_emoji} {active_marker} {btn}"
        options.append(WindowOption(name=instance.key, button_text=btn, label=label, available=True))
    return options


def _pick_status_emoji(status) -> str:  # type: WindowStatus, but imported at top would create a cycle for type hints
    """Map a WindowStatus snapshot to a single emoji that captures the
    workspace's current state. Attention-needing states take precedence over
    "working" or "idle" since the user has to act on them."""
    if status.pending_ask:
        return "❓"
    if status.pending_plan:
        return "📋"
    if status.pending_approve:
        return "🔐"
    if status.is_working:
        return "⚡"
    return "💤"


# ---------------------------------------------------------------------------
# Reply helper
# ---------------------------------------------------------------------------

async def reply(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    reply_markup: Any | None = None,
    parse_mode: str | None = None,
) -> None:
    """Send a Telegram reply.

    The persistent keyboard is static (`📊 Окна` / `⚙️ Настройки`) and survives
    on the client until a new ReplyKeyboardMarkup is sent. We only re-send it
    from /start and registry_watch broadcasts — NOT on every reply. The old
    behaviour pinged every instance's /status on every reply, which was the
    visible "switch lag" the user complained about.
    """
    message = update.effective_message
    if message is None:
        return
    await message.reply_text(text, reply_markup=reply_markup, parse_mode=parse_mode)


# ---------------------------------------------------------------------------
# Status lines for /status
# ---------------------------------------------------------------------------

async def build_status_lines(context: ContextTypes.DEFAULT_TYPE) -> list[str]:
    runtime_instances = refresh_instances(context)
    bridge_client = get_bridge_client(context)
    if not runtime_instances:
        return []

    results = await asyncio.gather(
        *(bridge_client.ping(i.key, timeout=QUICK_PING_TIMEOUT) for i in runtime_instances),
        return_exceptions=True,
    )
    lines: list[str] = []
    for instance, result in zip(runtime_instances, results, strict=False):
        if isinstance(result, Exception) or result is None:
            lines.append(f"🔴 {instance.display_name} :{instance.port} — offline")
        else:
            lines.append(f"🟢 {instance.display_name} :{instance.port} — online")
    return lines
