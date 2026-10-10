"""Per-window forum topics.

When a dedicated Telegram forum group is configured (`telegram.forum_chat_id`),
every VSCode window gets its own topic. Traffic for that window is mirrored
there so the whole history lives in one place; the private chat stays the
default channel.

Binding key — `workspace_id`. For Slice 1 this is the plugin-reported `cwd`
(host-stable, survives restarts, and matches `process.cwd()` so the channel
plugin can join against `topic-bindings.json` directly). A later slice layers a
logical id on top (marker file → manual alias → git remote → host:path) for
cross-machine / cross-OS binding — see plan/active/forum-topics-per-window.md.

Idempotency: `ensure_topic` is get-or-create under a lock, and the DB enforces
one topic per `workspace_id` (PRIMARY KEY). Repeated registry events therefore
never spawn duplicate topics.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from telegram.error import BadRequest, TelegramError, TimedOut
from telegram.ext import Application

from bot.common import atomic_write_text
from bot.i18n import t
from bot.paths import TOPIC_BINDINGS_PATH
from bot.storage import Storage
from bridge.registry import RuntimeInstance


logger = logging.getLogger(__name__)

# create_forum_topic is NOT idempotent: if the client times out but Telegram
# created the topic anyway, the next tick creates a duplicate (and the Bot API
# has no "list topics" method to reconcile). The default 5s read timeout trips
# under transient slowness, so we give these calls generous timeouts to make
# that window rare.
_FORUM_TIMEOUT = 30.0


def forum_chat_id(config: dict[str, Any]) -> int | None:
    """Configured forum group chat_id, or None when the feature is off."""
    raw = config.get("telegram", {}).get("forum_chat_id")
    if raw in (None, "", 0):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning("telegram.forum_chat_id is not an int: %r — feature disabled", raw)
        return None


def instance_agent(instance: RuntimeInstance) -> str:
    for agent in ("codex", "opencode", "mimo"):
        if instance.display_name.endswith(f"-{agent}") or instance.instance_name.endswith(f"-{agent}"):
            return agent
    return "claude"


def resolve_workspace_id(instance: RuntimeInstance) -> str:
    """Host-stable binding key. Slice 1: raw cwd (so the plugin can match by
    process.cwd()); fall back to the instance key for older plugins.

    Codex windows ("<ws>-codex", renamed by the plugin after the MCP
    handshake) get their OWN topic per workspace — same cwd as the Claude
    window, so the key is suffixed to keep the bindings apart."""
    base = instance.cwd or instance.key
    agent = instance_agent(instance)
    return base if agent == "claude" else f"{base}#{agent}"


def _topic_lock(application: Application, workspace_id: str) -> asyncio.Lock:
    """Per-workspace lock — was global, which serialised every ensure_topic
    call across all windows behind each ``edit_forum_topic`` (up to 30s timeout
    per round-trip × 2-3 calls per topic). A single transient hang on one
    window then stalled the whole `ensure_topics_for` sweep. Locking on the
    workspace_id keeps within-workspace ops sequential (still required — we
    do read-modify-write on `window_topics`) but lets unrelated windows
    proceed in parallel."""
    locks: dict[str, asyncio.Lock] = application.bot_data.setdefault("topic_locks", {})
    lock = locks.get(workspace_id)
    if lock is None:
        lock = asyncio.Lock()
        locks[workspace_id] = lock
    return lock


# Topic icons by meaning. Emojis must come from Telegram's fixed
# getForumTopicIconStickers set; first matching rule wins, else a neutral
# default. Match is a case-insensitive substring on the topic title (the window
# display name), so ORDER MATTERS — put the more specific needle first when two
# would both match.
#
# These defaults are deliberately generic. A workspace vocabulary is personal
# (the shipped list used to encode one user's actual project names, which both
# leaked the portfolio and made no sense to anyone else), so a deployment's own
# keywords belong in config — see configure() and bot.topic_icons.
_DEFAULT_ICON_RULES: tuple[tuple[str, str], ...] = (
    ("infra", "💻"),
    ("api", "📡"),
    ("web", "🌐"),
    ("docs", "📚"),
    ("data", "📊"),
    ("mobile", "📱"),
    ("game", "🎮"),
    ("bot", "🤖"),
    ("code", "💻"),
)
_ICON_RULES: tuple[tuple[str, str], ...] = _DEFAULT_ICON_RULES
_DEFAULT_ICON = "📁"

# ── One topic per window, or one topic for everybody? ────────────────────────
#
# Per-window (the default) gives each window its own thread: the history of one
# project stays in one place and talking in a thread targets that window.
#
# Shared puts every window in ONE thread and prefixes each message with the
# window it came from. The point is conversation BETWEEN windows across
# platforms — a Claude window and a Codex window on two machines read as one
# conversation instead of two threads nobody can correlate — and addressing one
# of them by name, which per-window mode gets from the thread and shared mode
# has to get from the text.
#
# Switching either way leaves topics behind, and nothing is ever deleted —
# Telegram gives no way to know whether a topic still matters to the person, so
# the safe move is always to stop using one rather than remove it. Going to
# shared re-binds each window to the shared thread and abandons its own topic;
# coming back gives each window a FRESH topic, because the binding that named
# the old one was overwritten on the way out and there is no list API to find it
# again. The old topics sit in the group, readable, until someone deletes them.
_MODE_SHARED = "shared"
_MODE_PER_WINDOW = "per-window"
_TOPIC_MODE = _MODE_PER_WINDOW
_SHARED_TITLE = ""

# Reserved workspace_id for the shared thread's own row. Starts with '#' so it
# can never collide with a cwd, which is what every other key is.
SHARED_WORKSPACE_ID = "#shared"

# Has this process confirmed the shared topic still exists?
#
# The per-window path learns a topic was deleted because it EDITS the title on
# every status flip and Telegram answers "thread not found". Shared mode edits
# nothing — the title is static — so it would reuse a stored thread_id forever
# and every window's replies would fail into a thread that is gone, with no way
# back: the binding outlives a restart, so restarting would not help either.
#
# So confirm it ONCE per process, with an edit to the title it already has.
# Once, not per tick, because editForumTopic is flood-limited; a restart is what
# re-arms the check, and a restart is what a person does when messages stop
# arriving anyway.
_shared_topic_checked = False

# Connection-status marker prepended to the topic title. 🟢 = the window is
# currently reachable (its plugin answered a status ping this tick); 🔴 = it
# dropped out of the registry / went offline. This is plain text in the title,
# independent of the topic *icon* (icon_custom_emoji_id) above.
_STATUS_ONLINE = "🟢"
_STATUS_OFFLINE = "🔴"


def parse_icon_rules(raw: Any) -> tuple[tuple[str, str], ...] | None:
    """Turn a config value into icon rules, or None if there is nothing usable.

    Accepts a list of one-entry mappings (YAML's way of writing an ORDERED
    mapping) or a plain mapping; both keep their written order. A malformed
    entry is skipped rather than failing startup — a typo in a cosmetic setting
    must not stop the bot from answering."""
    if not raw:
        return None
    pairs: list[tuple[str, str]] = []
    items: list[Any] = raw if isinstance(raw, list) else [raw]
    for item in items:
        if isinstance(item, dict):
            for needle, emoji in item.items():
                if str(needle).strip() and str(emoji).strip():
                    pairs.append((str(needle).strip().lower(), str(emoji).strip()))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            needle, emoji = item
            if str(needle).strip() and str(emoji).strip():
                pairs.append((str(needle).strip().lower(), str(emoji).strip()))
        else:
            logger.warning("bot.topic_icons: skipping unusable entry %r", item)
    return tuple(pairs) or None


def configure(config: dict[str, Any]) -> None:
    """Apply the cosmetic bot.topic_* overrides. Called once at startup.

    Module-level state rather than a threaded-through parameter: these are read
    on nearly every topic edit and never change while the bot runs, so passing
    config down five call sites would be churn for nothing.
    """
    global _ICON_RULES, _DEFAULT_ICON, _STATUS_ONLINE, _STATUS_OFFLINE
    global _TOPIC_MODE, _SHARED_TITLE
    telegram = config.get("telegram", {}) or {}
    raw_mode = str(telegram.get("topic_mode") or "").strip().lower()
    if raw_mode in (_MODE_SHARED, "one", "single"):
        _TOPIC_MODE = _MODE_SHARED
    elif raw_mode in (_MODE_PER_WINDOW, "per_window", "window", ""):
        _TOPIC_MODE = _MODE_PER_WINDOW
    else:
        logger.warning("telegram.topic_mode %r not understood — staying per-window", raw_mode)
        _TOPIC_MODE = _MODE_PER_WINDOW
    shared_title = telegram.get("shared_topic_title")
    _SHARED_TITLE = shared_title.strip() if isinstance(shared_title, str) else ""

    section = config.get("bot", {}) or {}
    rules = parse_icon_rules(section.get("topic_icons"))
    if rules:
        _ICON_RULES = rules
        logger.info("topics: using %d configured icon rule(s)", len(rules))
    for key, name in (
        ("topic_icon_default", "_DEFAULT_ICON"),
        ("topic_status_online", "_STATUS_ONLINE"),
        ("topic_status_offline", "_STATUS_OFFLINE"),
    ):
        value = section.get(key)
        if isinstance(value, str) and value.strip():
            globals()[name] = value.strip()


def topics_are_shared() -> bool:
    """All windows in one thread, each message prefixed with its window name."""
    return _TOPIC_MODE == _MODE_SHARED


def shared_topic_title() -> str:
    return _SHARED_TITLE or t("topics.shared_title")


def window_prefix(display_name: str) -> str:
    """What a window puts in front of everything it says, or '' when its thread
    already identifies it. The plugin is handed this rather than the mode, so
    the rule lives in one place and an older plugin that ignores the field just
    posts unprefixed instead of posting something wrong."""
    return f"[{display_name}]" if topics_are_shared() and display_name else ""


# Addressing one window inside a shared topic: "@name the rest of the message".
#
# Only '@'. A bare "name: ..." was tempting and is a trap — ordinary prose opens
# with a word and a colon constantly ("Ошибка: ...", "TODO: ..."), and a prefix
# that sometimes means routing and sometimes means nothing is worse than no
# prefix at all. '@' is never how a sentence starts by accident.
#
# The name is NOT stripped from the forwarded text. The window seeing that it
# was addressed by name is context, not noise, and stripping would mean teaching
# every other entry point (photos, captions, attachments) to strip it too.
_ADDRESSEE_RE = re.compile(r"^\s*@([^\s:,@]{1,64})\s*[:,]?\s+\S")


def addressed_window(text: str) -> str | None:
    """The window named at the start of `text`, or None when nobody is named."""
    match = _ADDRESSEE_RE.match(text or "")
    return match.group(1) if match else None


def _display_name(status: str | None, title: str) -> str:
    """Topic title as shown in Telegram: status marker + raw window name. The
    raw `title` is what we persist; the marker is reapplied on every edit."""
    title = title or ""
    return f"{status} {title}".strip() if status else title


def _desired_icon(title: str) -> str:
    low = (title or "").lower()
    for needle, emoji in _ICON_RULES:
        if needle in low:
            return emoji
    return _DEFAULT_ICON


async def _icon_id_for(application: Application, emoji: str) -> str | None:
    """custom_emoji_id for a topic-icon emoji, or None if unavailable. The icon
    set is fetched once and cached in bot_data."""
    cache: dict[str, str] | None = application.bot_data.get("forum_icon_ids")
    if cache is None:
        try:
            stickers = await application.bot.get_forum_topic_icon_stickers(read_timeout=_FORUM_TIMEOUT)
        except TelegramError:
            # Don't cache the failure — a transient network/API hiccup would
            # otherwise pin every topic to the default color until restart.
            # Leaving the cache unset lets the next ensure_topic retry the fetch.
            logger.warning("get_forum_topic_icon_stickers failed — topics keep the default color, will retry")
            return None
        cache = {}
        for s in stickers:
            if s.emoji and s.custom_emoji_id:
                cache[s.emoji] = s.custom_emoji_id
                cache.setdefault(s.emoji.rstrip("️"), s.custom_emoji_id)
        application.bot_data["forum_icon_ids"] = cache
    return cache.get(emoji) or cache.get(emoji.rstrip("️"))


async def ensure_topic(
    application: Application, instance: RuntimeInstance, online: bool = True
) -> int | None:
    """Get-or-create the forum topic bound to `instance`. Returns its
    message_thread_id, or None when the feature is off or creation failed.

    `online` sets the status marker (🟢/🔴) in the title; callers pass True for
    reachable windows. The red-sweep for vanished windows lives in
    `ensure_topics_for`."""
    config: dict[str, Any] = application.bot_data["config"]
    chat_id = forum_chat_id(config)
    if chat_id is None:
        return None

    if topics_are_shared():
        return await _ensure_shared_topic(application, instance, chat_id)

    storage: Storage = application.bot_data["storage"]
    workspace_id = resolve_workspace_id(instance)
    title = instance.display_name
    desired_status = _STATUS_ONLINE if online else _STATUS_OFFLINE

    async with _topic_lock(application, workspace_id):
        existing = storage.get_topic(workspace_id)

        # A binding left over from shared mode points at the thread EVERY window
        # shares. Reusing it here would be the worst outcome of the switch: the
        # first window to tick renames the shared topic to its own name, and the
        # rest go on posting into it. Treat it as no binding and make this window
        # its own topic.
        if existing and _is_shared_thread(storage, chat_id, existing[1]):
            logger.info(
                "%s was bound to the shared topic; per-window mode is on — giving it its own",
                workspace_id,
            )
            storage.delete_topic(workspace_id)
            existing = None

        # Reuse only if the binding points at the *currently configured* forum.
        # If the forum chat_id changed, the old thread is in a different chat —
        # treat as missing and create fresh in the new forum.
        if existing and existing[0] == chat_id:
            _, thread_id, stored_title, closed, stored_icon, stored_status = existing
            desired_icon = _desired_icon(title or stored_title)
            try:
                if closed:
                    await application.bot.reopen_forum_topic(
                        chat_id, thread_id, read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT
                    )
                    storage.set_topic_closed(workspace_id, False)
                title_changed = bool(title) and title != stored_title
                if title_changed or desired_status != stored_status:
                    effective_title = title if title_changed else stored_title
                    await application.bot.edit_forum_topic(
                        chat_id, thread_id, name=_display_name(desired_status, effective_title),
                        read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
                    )
                    if title_changed:
                        storage.upsert_topic(workspace_id, chat_id, thread_id, title)
                    storage.set_topic_status(workspace_id, desired_status)
                if desired_icon != stored_icon:
                    icon_id = await _icon_id_for(application, desired_icon)
                    if icon_id:
                        await application.bot.edit_forum_topic(
                            chat_id, thread_id, icon_custom_emoji_id=icon_id,
                            read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
                        )
                        storage.set_topic_icon(workspace_id, desired_icon)
            except BadRequest as exc:
                # Only a genuine "the thread is gone" error justifies dropping the
                # binding and recreating. Telegram reports this as a BadRequest with
                # a recognisable message; anything else (an unexpected BadRequest we
                # don't understand) keeps the binding so we never spawn a duplicate
                # on a misread.
                msg = str(exc).lower()
                if "topic_not_modified" in msg or "topic not modified" in msg:
                    # The title/status on screen already match what we want —
                    # record it as applied, otherwise this retries every tick
                    # and floods the group (live storm: 2026-07-07).
                    if title:
                        storage.upsert_topic(workspace_id, chat_id, thread_id, title)
                    storage.set_topic_status(workspace_id, desired_status)
                    if desired_icon != stored_icon:
                        storage.set_topic_icon(workspace_id, desired_icon)
                    _write_bindings(storage)
                    return thread_id
                gone = (
                    "thread not found" in msg
                    or "topic_deleted" in msg
                    or "topic deleted" in msg
                    or "message to edit not found" in msg
                )
                if gone:
                    logger.warning(
                        "forum topic %s for %s gone server-side (%s) — recreating",
                        thread_id, workspace_id, exc,
                    )
                    storage.delete_topic(workspace_id)
                    existing = None
                else:
                    logger.warning(
                        "edit_forum_topic BadRequest for %s (%s) — keeping binding",
                        workspace_id, exc,
                    )
                    _write_bindings(storage)
                    return thread_id
            except TelegramError as exc:
                # Transient (NetworkError/TimedOut/RetryAfter) or unrelated to the
                # topic's existence. NEVER delete the binding here — a network blip
                # used to be misread as "deleted" and spawned a duplicate topic with
                # the same name on every window restart.
                logger.warning(
                    "edit_forum_topic transient error for %s (%s) — keeping binding, will retry",
                    workspace_id, exc,
                )
                _write_bindings(storage)
                return thread_id
            else:
                _write_bindings(storage)
                return thread_id

        # Create.
        desired_icon = _desired_icon(title or workspace_id)
        icon_id = await _icon_id_for(application, desired_icon)
        try:
            topic = await application.bot.create_forum_topic(
                chat_id, name=_display_name(desired_status, title or workspace_id),
                icon_custom_emoji_id=icon_id,
                read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
            )
        except TimedOut:
            # Telegram may have created the topic server-side despite the client
            # timeout — there's no list API to find it, so we skip storing and
            # retry next tick. That retry can leave an orphan duplicate; the long
            # _FORUM_TIMEOUT makes this rare.
            logger.warning(
                "create_forum_topic timed out for %s — may have orphaned a topic; will retry",
                workspace_id,
            )
            return None
        except TelegramError:
            logger.exception(
                "create_forum_topic failed (chat_id=%s, workspace=%s) — "
                "is the bot an admin with Manage Topics?",
                chat_id, workspace_id,
            )
            return None

        storage.upsert_topic(workspace_id, chat_id, topic.message_thread_id, title or workspace_id)
        storage.set_topic_status(workspace_id, desired_status)
        if icon_id:
            storage.set_topic_icon(workspace_id, desired_icon)
        _write_bindings(storage)
        logger.info(
            "created forum topic '%s' %s (thread=%s) for %s",
            title, desired_icon, topic.message_thread_id, workspace_id,
        )
        return topic.message_thread_id


async def _thread_alive(application: Application, chat_id: int, thread_id: int) -> bool:
    """Does this forum thread still exist?

    There is no getForumTopic in the Bot API, so the question is asked by trying
    to set the title it already has. "topic_not_modified" is the answer we want:
    it means Telegram found the thread and had nothing to change. A transient
    failure answers True — assuming a topic is gone on a network blip is how the
    per-window path used to spawn duplicates.
    """
    try:
        await application.bot.edit_forum_topic(
            chat_id, thread_id, name=shared_topic_title(),
            read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
        )
        return True
    except BadRequest as exc:
        msg = str(exc).lower()
        if "not modified" in msg:
            return True
        return not (
            "thread not found" in msg
            or "topic_deleted" in msg
            or "topic deleted" in msg
            or "message to edit not found" in msg
        )
    except TelegramError as exc:
        logger.warning("could not verify the shared topic (%s) — assuming it is there", exc)
        return True


def _is_shared_thread(storage: Storage, chat_id: int, thread_id: int) -> bool:
    """Is `thread_id` the one topic every window shares?"""
    row = storage.get_topic(SHARED_WORKSPACE_ID)
    return bool(row and row[0] == chat_id and row[1] == thread_id)


async def _ensure_shared_topic(
    application: Application, instance: RuntimeInstance, chat_id: int
) -> int | None:
    """One thread for every window. Two steps, deliberately under two different
    locks: the thread itself must be created exactly once no matter how many
    windows ask at the same moment, while binding a window to it is that
    window's own business and must not queue behind anyone else's."""
    global _shared_topic_checked
    storage: Storage = application.bot_data["storage"]
    title = shared_topic_title()

    async with _topic_lock(application, SHARED_WORKSPACE_ID):
        existing = storage.get_topic(SHARED_WORKSPACE_ID)
        # Same reuse rule as per-window: a binding into a DIFFERENT forum is a
        # binding into a chat we are no longer using.
        if existing and existing[0] == chat_id and not _shared_topic_checked:
            _shared_topic_checked = True     # set first: one probe per process,
                                             # whatever the outcome
            if not await _thread_alive(application, chat_id, existing[1]):
                logger.warning(
                    "shared forum topic %s is gone server-side — recreating", existing[1],
                )
                storage.delete_topic(SHARED_WORKSPACE_ID)
                existing = None
        if existing and existing[0] == chat_id:
            thread_id = existing[1]
        else:
            icon_id = await _icon_id_for(application, _DEFAULT_ICON)
            try:
                topic = await application.bot.create_forum_topic(
                    chat_id, name=title, icon_custom_emoji_id=icon_id,
                    read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
                )
            except TimedOut:
                # Same trap as per-window: Telegram may have created it anyway
                # and there is no list API to find out. Retry next tick.
                logger.warning("create_forum_topic timed out for the shared topic; will retry")
                return None
            except TelegramError:
                logger.exception(
                    "create_forum_topic failed for the shared topic (chat_id=%s) — "
                    "is the bot an admin with Manage Topics?", chat_id,
                )
                return None
            thread_id = topic.message_thread_id
            storage.upsert_topic(SHARED_WORKSPACE_ID, chat_id, thread_id, title)
            logger.info("created shared forum topic '%s' (thread=%s)", title, thread_id)

    workspace_id = resolve_workspace_id(instance)
    async with _topic_lock(application, workspace_id):
        current = storage.get_topic(workspace_id)
        # The window's own row still exists and still carries its display name:
        # that is what lets an addressed message find it, and what a reader sees
        # when the window is gone. Only the thread it points at is shared.
        if not (current and current[0] == chat_id and current[1] == thread_id
                and current[2] == instance.display_name):
            storage.upsert_topic(workspace_id, chat_id, thread_id, instance.display_name)
            _write_bindings(storage)
    return thread_id


async def ensure_topics_for(application: Application, instances: list[RuntimeInstance]) -> None:
    """Ensure topics for all currently-available windows, then mark any topic
    whose window is no longer reachable as 🔴. `instances` is the set of windows
    that answered a status ping this tick. Idempotent and self-healing: a no-op
    once bindings exist (status only re-edits on a 🟢↔🔴 transition)."""
    chat_id = forum_chat_id(application.bot_data["config"])
    if chat_id is None:
        return
    online_ids: set[str] = set()
    online_threads: set[int] = set()
    for instance in instances:
        # Phantom guard: a plugin spawned from a service context (launchd/cron)
        # registers with cwd '/' and empty names — its display degrades to
        # "host:port" and it must NOT own a forum topic (live case: topic
        # "192.0.2.5:3109", 2026-07-19).
        if (instance.cwd or "") in ("", "/") or instance.display_name == f"{instance.host}:{instance.port}":
            logger.warning("skipping topic for nameless/rootless window %s (cwd=%r)",
                           instance.key, instance.cwd)
            continue
        try:
            tid = await ensure_topic(application, instance, online=True)
            online_ids.add(resolve_workspace_id(instance))
            if tid is not None:
                online_threads.add(tid)
        except Exception:
            logger.exception("ensure_topic failed for %s", instance.key)

    # No 🟢/🔴 sweep in shared mode: the marker belongs to a title that names one
    # window, and the shared topic names none. Marking it 🔴 the moment the last
    # window goes quiet would relabel the room, not a window.
    if not topics_are_shared():
        await _mark_offline_topics(application, chat_id, online_ids, online_threads)


async def _mark_offline_topics(
    application: Application, chat_id: int, online_ids: set[str], online_threads: set[int]
) -> None:
    """Set the 🔴 marker on topics in the configured forum whose window didn't
    report in this tick. Skips topics already marked offline so we don't spam
    editForumTopic (it's flood-limited).

    Also skips any thread that ANOTHER (live) row is bound to: after a window is
    re-registered onto an old topic (Windows path C:\\Work\\X → Mac /Users/.../X),
    two workspace_id rows share one thread_id. The dead-cwd row would otherwise
    mark the shared thread 🔴 while the live row believes it's already 🟢 and never
    repaints — freezing a live window's topic red (live case 2026-08-23)."""
    storage: Storage = application.bot_data["storage"]
    for workspace_id, topic_chat, thread_id, title, status in storage.topics_status():
        if topic_chat != chat_id or workspace_id in online_ids or thread_id in online_threads:
            continue
        # The shared topic is a ROOM, not a window, so it has no 🟢/🔴 to set.
        # Its row survives a switch back to per-window mode — nothing is ever
        # deleted here — and without this the first sweep afterwards would rename
        # it to "🔴 Агенты", labelling an abandoned room as a dead window.
        if workspace_id == SHARED_WORKSPACE_ID:
            continue
        if status == _STATUS_OFFLINE:
            continue
        try:
            await application.bot.edit_forum_topic(
                chat_id, thread_id, name=_display_name(_STATUS_OFFLINE, title),
                read_timeout=_FORUM_TIMEOUT, write_timeout=_FORUM_TIMEOUT,
            )
        except BadRequest as exc:
            # Topic_not_modified = the title is ALREADY 🔴 (a prior tick edited it
            # but the confirming set_topic_status never ran). Persist it now,
            # otherwise the DB stays 🟢 while the title is 🔴 — and when the window
            # comes back online ensure_topic sees stored==desired 🟢 and never
            # repaints, freezing a live window's topic red (live case 2026-08-23).
            if "not modified" in str(exc).lower():
                storage.set_topic_status(workspace_id, _STATUS_OFFLINE)
            else:
                logger.warning("could not mark topic %s (%s) offline: %s", thread_id, workspace_id, exc)
            continue
        except TelegramError as exc:
            logger.warning("could not mark topic %s (%s) offline: %s", thread_id, workspace_id, exc)
            continue
        storage.set_topic_status(workspace_id, _STATUS_OFFLINE)


def _write_bindings(storage: Storage) -> None:
    """Project window_topics → topic-bindings.json for the channel plugin.

    Keyed by workspace_id (== plugin's cwd in Slice 1) so the plugin can look up
    its own binding and dual-send outbound messages into the topic.
    """
    try:
        payload = {
            workspace_id: {
                "forum_chat_id": chat_id,
                "message_thread_id": thread_id,
                "title": title,
                # Empty unless the thread is shared — see window_prefix.
                "prefix": window_prefix(title),
            }
            for workspace_id, chat_id, thread_id, title in storage.all_topics()
        }
        atomic_write_text(TOPIC_BINDINGS_PATH, json.dumps(payload, indent=2))
    except Exception:
        logger.exception("failed to write topic bindings")


if __name__ == "__main__":  # self-check: python3 tg-bot/bot/topics.py
    # Ordered form (list of one-entry maps) — the order written must survive,
    # because a later needle must not steal a match from an earlier one.
    rules = parse_icon_rules([{"customs": "🛃"}, {"code": "💻"}])
    assert rules == (("customs", "🛃"), ("code", "💻")), rules
    # Pair form, and case is normalised so matching against a lowered title works.
    assert parse_icon_rules([["API", "📡"]]) == (("api", "📡"),)
    # A plain mapping is accepted too.
    assert parse_icon_rules({"web": "🌐"}) == (("web", "🌐"),)
    # Junk is skipped, not fatal — a typo in a cosmetic key must not stop the bot.
    assert parse_icon_rules([{"ok": "✅"}, 42, ["only-one"], {"": "x"}]) == (("ok", "✅"),)
    # Nothing usable reads as "no override", so the generic defaults stay.
    assert parse_icon_rules([]) is None
    assert parse_icon_rules(None) is None
    assert parse_icon_rules([42]) is None

    # configure() must leave the defaults alone when the keys are absent, and
    # must not be fooled by blank strings.
    before = (_ICON_RULES, _DEFAULT_ICON, _STATUS_ONLINE, _STATUS_OFFLINE)
    configure({})
    configure({"bot": {"topic_icons": [], "topic_icon_default": "  "}})
    assert (_ICON_RULES, _DEFAULT_ICON, _STATUS_ONLINE, _STATUS_OFFLINE) == before

    configure({"bot": {"topic_icons": [{"zzz": "🛃"}], "topic_status_offline": "⚫"}})
    assert _ICON_RULES == (("zzz", "🛃"),)
    assert _STATUS_OFFLINE == "⚫"
    assert _STATUS_ONLINE == "🟢", "untouched keys must not change"
    assert _desired_icon("my-zzz-window") == "🛃"
    assert _desired_icon("nothing-matches-here") == _DEFAULT_ICON

    # --- shared-topic mode ------------------------------------------------
    configure({})
    assert not topics_are_shared(), "per-window is the default"
    configure({"telegram": {"topic_mode": "shared"}})
    assert topics_are_shared()
    assert window_prefix("api-gateway") == "[api-gateway]"
    assert window_prefix("") == "", "a nameless window prefixes nothing"
    configure({"telegram": {"topic_mode": "nonsense"}})
    assert not topics_are_shared(), "an unreadable mode must fall back, not crash"
    assert window_prefix("api-gateway") == "", "per-window topics need no prefix"
    configure({"telegram": {"topic_mode": "shared", "shared_topic_title": "  Штаб  "}})
    assert shared_topic_title() == "Штаб"
    configure({"telegram": {"topic_mode": "shared"}})
    assert shared_topic_title(), "a default title always exists"
    configure({})

    # Switching back to per-window must not hand a window the SHARED topic —
    # the first window to tick would rename the room after itself.
    class _FakeStorage:
        def __init__(self, rows): self.rows = rows
        def get_topic(self, wid): return self.rows.get(wid)

    shared_row = {SHARED_WORKSPACE_ID: (-100, 77, "Агенты", 0, "📁", "")}
    assert _is_shared_thread(_FakeStorage(shared_row), -100, 77)
    assert not _is_shared_thread(_FakeStorage(shared_row), -100, 78), "another thread is not the shared one"
    assert not _is_shared_thread(_FakeStorage(shared_row), -999, 77), "a binding in another forum is not ours"
    assert not _is_shared_thread(_FakeStorage({}), -100, 77), "never shared → nothing to confuse"

    # _thread_alive decides whether to RECREATE the shared topic, so its
    # classification of Telegram's error text is load-bearing in both
    # directions: a false "gone" spawns a duplicate topic, a false "alive"
    # leaves every window posting into a thread that no longer exists.
    import asyncio as _asyncio

    class _Bot:
        def __init__(self, exc): self.exc = exc
        async def edit_forum_topic(self, *a, **kw):
            if self.exc: raise self.exc

    class _App:
        def __init__(self, exc): self.bot = _Bot(exc)

    def alive(exc):
        return _asyncio.run(_thread_alive(_App(exc), -100, 7))

    assert alive(None) is True, "an edit that simply worked means it is there"
    assert alive(BadRequest("Topic_not_modified")) is True, "nothing to change = found it"
    assert alive(BadRequest("Message thread not found")) is False
    assert alive(BadRequest("TOPIC_DELETED")) is False
    assert alive(BadRequest("message to edit not found")) is False
    assert alive(BadRequest("CHAT_ADMIN_REQUIRED")) is True, \
        "an unrelated BadRequest must NOT be read as deleted"
    assert alive(TimedOut()) is True, "a blip must not be read as deleted — that spawns duplicates"
    assert alive(TelegramError("network is unreachable")) is True

    # Addressing inside a shared topic. The negatives matter more than the
    # positives: a false match silently sends the message to another window.
    assert addressed_window("@api-gateway check the logs") == "api-gateway"
    assert addressed_window("  @docs: rebuild it") == "docs"
    assert addressed_window("@webapp, go") == "webapp"
    assert addressed_window("@webapp") is None, "a name with no message is not a message"
    assert addressed_window("@webapp    ") is None
    assert addressed_window("Error: not found") is None, "word+colon is ordinary prose"
    assert addressed_window("have a look @webapp") is None, "only at the very start"
    assert addressed_window("@ work tomorrow") is None
    assert addressed_window("@a@b тест") is None
    assert addressed_window("") is None
    assert addressed_window(None) is None

    # The shipped defaults must stay generic — no personal project vocabulary.
    leaked = [n for n, _ in _DEFAULT_ICON_RULES
              if n in {"vet", "custom", "customs", "minecraft", "toxic", "ytdlp", "ytdnl"}]
    assert not leaked, f"personal keywords back in the defaults: {leaked}"
    print("topics self-check OK")
