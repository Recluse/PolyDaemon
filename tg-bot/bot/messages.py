from __future__ import annotations

import asyncio
import html
import logging
from typing import Any

from telegram import MessageEntity, ReactionTypeCustomEmoji, ReactionTypeEmoji, Update
from telegram.constants import ChatAction
from telegram.ext import ContextTypes

from bot.common import (
    build_window_options,
    ensure_active_session,
    find_instance,
    get_bridge_client,
    get_display_name,
    get_sessions,
    get_storage,
    get_user_id,
    persist_active_instances,
    refresh_instances,
    reply,
)
from bot.i18n import t
from bot.keyboards import (
    back_button_text,
    launch_button_text,
    save_button_text,
    settings_button_text,
    status_list_button_text,
    status_windows_button_text,
    build_launch_keyboard,
    build_settings_root_keyboard,
    build_status_windows_keyboard,
    build_window_quick_switch_keyboard,
    build_window_reply_keyboard,
)
from bot.launcher import list_launchable
from bot.topics import addressed_window, forum_chat_id, resolve_workspace_id, topics_are_shared
from bridge.protocol import make_request_id


# Prompt fanned out to every active window when the user taps 💾 Сохраняемся.
# Each window persists its own context and reports back into its own forum topic.
SAVE_PROMPT = (
    "💾 Контрольная точка сессии. Сохрани текущий контекст в файлы проекта: "
    "обнови документацию, планы и прогресс (docs / plans / progress — куда у тебя "
    "принято), зафиксируй ключевые решения, открытые задачи и следующий шаг, чтобы "
    "новая сессия могла продолжить без потерь. Затем кратко отчитайся, что именно сохранил."
)
from utils.image_utils import encode_image_bytes, pick_image_mime_type


logger = logging.getLogger(__name__)


def _instance_named(instances: list[Any], name: str) -> Any | None:
    """A live window that answers to `name`, case-insensitively. Tries the name
    the person sees first, then the ones only the machinery uses."""
    wanted = name.strip().lower()
    for attr in ("display_name", "instance_name", "key"):
        for inst in instances:
            if str(getattr(inst, attr, "") or "").lower() == wanted:
                return inst
    return None


def _resolve_topic_target(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> tuple[str | None, int | None, int | None]:
    """If the message sits in a forum topic bound to a window, return
    (instance_key, forum_chat_id, message_thread_id). Else (None, None, None).

    This is the Slice 3 signal: talking inside a topic targets THAT topic's
    window, regardless of the user's active window.

    Two outcomes when the binding exists:
      • live window matches the topic's cwd → return its runtime key.
      • binding exists but no live window → return the stored title (== the
        original workspace_name). The caller's ``post_message`` will then raise
        ``KeyError`` and the user sees a clean "🚫 окно X не найдено" instead
        of having the message silently rerouted to whichever window is active
        (which used to look like "the topic and the window got swapped").
    """
    message = update.effective_message
    if message is None or message.message_thread_id is None:
        return None, None, None
    thread_id = message.message_thread_id
    storage = get_storage(context)
    candidates = storage.get_workspaces_by_thread(message.chat_id, thread_id)
    if not candidates:
        return None, None, None
    instances = context.application.bot_data.get("runtime_instances") or refresh_instances(context)

    # One topic for every window: the thread cannot say who is meant, so the
    # message has to. Unaddressed messages fall through to the active window,
    # which is exactly what the same message would do in a DM — the shared topic
    # changes who can be addressed, not what "no address" means.
    if topics_are_shared():
        name = addressed_window(message.text or message.caption or "")
        if name is None:
            return None, None, None
        inst = _instance_named(instances, name)
        # No live window by that name: hand the name back anyway. post_message
        # raises KeyError on it and the person gets "🚫 окно X не найдено",
        # which is the truth, instead of the message quietly going to whichever
        # window happened to be active.
        return (inst.key if inst is not None else name), message.chat_id, thread_id

    # Shared thread (one project on several machines): route to whichever
    # binding has a LIVE window — the dead machine's row must not shadow it.
    inst = None
    workspace_id = candidates[0]
    for cand in candidates:
        inst = next((i for i in instances if resolve_workspace_id(i) == cand), None)
        if inst is not None:
            workspace_id = cand
            break
    if inst is not None:
        return inst.key, message.chat_id, thread_id
    topic = storage.get_topic(workspace_id)
    if topic is None:
        return None, None, None
    title = topic[2]  # (forum_chat_id, message_thread_id, title, closed, icon, status)
    return title, message.chat_id, thread_id


async def text_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None or message.text is None:
        return

    # Messages typed inside a window's forum topic route straight to that window.
    # Skip the DM-only reply-keyboard / quick-switch handling — a window name
    # typed in a topic must be a prompt, not a switch.
    # Resolve once and reuse — _forward_message would otherwise re-query the
    # storage (workspace_by_thread + get_topic) and re-scan runtime_instances.
    topic_target = _resolve_topic_target(update, context)
    if topic_target[0] is None:
        if await _maybe_handle_window_button(update, context):
            return

    # AskUserQuestion free-text reply: if the user previously tapped «Свой ответ»
    # we deliver THIS message as the answer instead of forwarding it as a new
    # turn. Checked for BOTH DMs and topics — the ask is SENT into the window's
    # topic (plugin: forumThreadFor), and the button sits there, so the topic is
    # where the answer is normally typed. This used to live inside the DM-only
    # branch above, which meant an answer typed in the topic was forwarded as an
    # ordinary turn while the tool call kept blocking, AND the still-armed marker
    # then swallowed the next DM message instead (found by audit, 2026-09-15).
    # Kept after the button check so a reply-keyboard tap still wins in a DM.
    if await _maybe_deliver_custom_ask(update, context, message.text, topic_key=topic_target[0]):
        return

    logger.info("text message user_id=%s len=%s", user.id, len(message.text))
    await _forward_message(update, context, text=message.text, topic_target=topic_target)


def _describe_unhandled(message: Any) -> str:
    """Human-readable placeholder for a message type we don't natively forward
    (sticker, dice, GIF, poll, story, …) so the window gets *something* instead
    of the message silently vanishing. Order = most-common first."""
    m = message
    if getattr(m, "sticker", None):
        kind = ("анимированный стикер" if m.sticker.is_animated
                else "видео-стикер" if m.sticker.is_video else "стикер")
        return f"[{kind} {m.sticker.emoji or ''}]".strip()
    if getattr(m, "dice", None):
        return f"[Telegram dice {m.dice.emoji} = {m.dice.value}]"
    if getattr(m, "animation", None):
        cap = (m.caption or "").strip()
        return f"[GIF/анимация{f' — {cap}' if cap else ''}]"
    if getattr(m, "poll", None):
        return f"[опрос: {m.poll.question}]"
    if getattr(m, "story", None):
        return "[Telegram story]"
    if getattr(m, "contact", None):
        return f"[контакт: {(m.contact.first_name or '')} {(m.contact.phone_number or '')}]".strip()
    if getattr(m, "location", None):
        return f"[локация: {m.location.latitude}, {m.location.longitude}]"
    if getattr(m, "venue", None):
        return f"[место: {m.venue.title}]"
    if getattr(m, "game", None):
        return f"[игра: {m.game.title}]"
    # New/unknown Telegram feature: python-telegram-bot stashes any API fields it
    # doesn't model in `api_kwargs`, so that's where a content type newer than the
    # bot's library shows up. Surface its keys so it's diagnosable (live case:
    # 2026-08-28 — a message type produced NO handler match and vanished silently).
    extra = list((getattr(m, "api_kwargs", None) or {}).keys())
    if extra:
        return f"[сообщение Telegram неподдерживаемого типа: {', '.join(extra)}]"
    return "[сообщение Telegram неподдерживаемого типа — бот его пока не разбирает]"


# --- Bot API 10.1 Rich Messages -------------------------------------------
# Telegram now auto-converts long text into a `rich_message` (blocks: headings,
# paragraphs, lists, code, quotes, tables …). Our python-telegram-bot (22.8, the
# latest release) doesn't model it yet, so it arrives unparsed in
# message.api_kwargs['rich_message']. We flatten it to Markdown for the window —
# Claude reads Markdown natively — until PTB ships native 10.1 support and this
# can be dropped. Schema per the 10.1 spec; the extractor is defensive (unknown
# block/inline types degrade to their text) since we can't rely on it exactly.

def _rich_text_to_str(node: Any) -> str:
    """Flatten a RichText node to Markdown-ish text. A RichText is a plain
    string, a list of RichText, or an inline dict {type, text, …}."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_rich_text_to_str(n) for n in node)
    if isinstance(node, dict):
        inner = _rich_text_to_str(node.get("text"))
        kind = node.get("type")
        if kind == "bold":
            return f"**{inner}**"
        if kind == "italic":
            return f"*{inner}*"
        if kind == "code":
            return f"`{inner}`"
        if kind == "strikethrough":
            return f"~~{inner}~~"
        if kind == "url":
            url = node.get("url") or ""
            return f"[{inner}]({url})" if url else inner
        if kind == "mention":
            return inner or f"@{node.get('username', '')}"
        return inner  # underline/spoiler/marked/sub/superscript/unknown → keep text
    return ""


def _rich_blocks_to_text(blocks: Any, depth: int = 0) -> str:
    """Flatten a list of RichBlock objects to Markdown. Depth-guarded against
    pathological nesting."""
    if not isinstance(blocks, list) or depth > 12:
        return ""
    out: list[str] = []
    for b in blocks:
        if isinstance(b, str):
            out.append(b)
            continue
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "heading":
            size = b.get("size")
            level = size if isinstance(size, int) and 1 <= size <= 6 else 2
            out.append("#" * level + " " + _rich_text_to_str(b.get("text")))
        elif kind == "paragraph":
            out.append(_rich_text_to_str(b.get("text")))
        elif kind == "pre":
            out.append(f"```{b.get('language') or ''}\n{_rich_text_to_str(b.get('text'))}\n```")
        elif kind == "blockquote":
            inner = _rich_blocks_to_text(b.get("blocks"), depth + 1)
            out.append("\n".join("> " + ln for ln in inner.split("\n")))
            if b.get("credit"):
                out.append("> — " + _rich_text_to_str(b.get("credit")))
        elif kind == "pullquote":
            out.append("> " + _rich_text_to_str(b.get("text")))
            if b.get("credit"):
                out.append("> — " + _rich_text_to_str(b.get("credit")))
        elif kind == "list":
            for it in (b.get("items") or []):
                if not isinstance(it, dict):
                    continue
                marker = ("[x]" if it.get("is_checked") else "[ ]") if it.get("has_checkbox") else (it.get("label") or "-")
                body = _rich_blocks_to_text(it.get("blocks"), depth + 1).strip()
                out.append(f"{'  ' * depth}{marker} {body}")
        elif kind in ("photo", "video", "audio", "animation"):
            out.append(f"[{kind}]")
        else:
            # Unknown block type: salvage any text/nested blocks it carries.
            if "text" in b:
                out.append(_rich_text_to_str(b.get("text")))
            if isinstance(b.get("blocks"), list):
                out.append(_rich_blocks_to_text(b.get("blocks"), depth + 1))
    return "\n".join(s for s in out if s)


def _rich_message_to_text(rich: Any) -> str:
    if not isinstance(rich, dict):
        return ""
    return _rich_blocks_to_text(rich.get("blocks"), 0).strip()


async def unhandled_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Catch-all for messages no specific handler matched. Without this the update
    fell through every handler and was dropped with zero logging — the window
    just never saw it (live case 2026-08-28: relaunched window "не получало"
    rich messages). Parse Bot API 10.1 rich_message into Markdown; otherwise
    forward a placeholder so nothing is silently lost."""
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return
    api_kwargs = getattr(message, "api_kwargs", None) or {}
    topic_target = _resolve_topic_target(update, context)

    rich = api_kwargs.get("rich_message")
    if isinstance(rich, dict):
        text = _rich_message_to_text(rich)
        if text:
            caption = (message.caption or "").strip()
            if caption:
                text = f"{caption}\n\n{text}"
            # Log the block TYPES (not content) so a future unhandled block kind
            # (e.g. a real table) is spottable without dumping message text.
            block_types = sorted({b.get("type") for b in (rich.get("blocks") or [])
                                  if isinstance(b, dict)} - {None})
            logger.info("rich_message forwarded user_id=%s len=%s blocks=%s",
                        user.id, len(text), block_types)
            await _forward_message(update, context, text=text, topic_target=topic_target)
            return

    descr = _describe_unhandled(message)
    logger.info("unhandled message user_id=%s -> %s (api_kwargs=%s)",
                user.id, descr, list(api_kwargs.keys()))
    await _forward_message(update, context, text=descr, topic_target=topic_target)


async def _maybe_deliver_custom_ask(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    text: str,
    topic_key: str | None = None,
) -> bool:
    """Deliver `text` as the answer to a pending AskUserQuestion. True if handled.

    ``topic_key`` is the window bound to the topic this message was typed in, or
    None for a DM. Inside a topic the answer is accepted ONLY for that topic's
    own window: a question pending in another window must not swallow a prompt
    that was clearly addressed to this one. Peeked before consuming, so a
    non-matching marker stays armed for the window it belongs to.
    """
    user = update.effective_user
    if user is None:
        return False
    sessions = get_sessions(context)
    if topic_key is not None:
        pending = sessions.peek_pending_custom_ask(user.id)
        if pending is None or pending.instance_key != topic_key:
            return False
    marker = sessions.consume_pending_custom_ask(user.id)
    if marker is None:
        return False

    bridge_client = get_bridge_client(context)
    ok = await bridge_client.post_ask_action(
        marker.instance_key, marker.ask_id, text=text,
    )
    if ok:
        logger.info(
            "custom-ask answered user_id=%s instance=%s len=%s",
            user.id, marker.instance_key, len(text),
        )
        await reply(update, context, t("msg.answer_delivered"))
    else:
        # Plugin no longer tracks this id — either the ask already timed out
        # on the plugin side, or the plugin restarted. Tell the user instead
        # of silently swallowing their typed reply.
        # The ask is gone on the plugin side (timed out, or the plugin restarted).
        # Say so, then return False so the caller forwards the text as an ordinary
        # prompt: the user typed something deliberate, and dropping it made them
        # retype it for nothing.
        logger.info(
            "custom-ask expired user_id=%s instance=%s — forwarding as a normal prompt",
            user.id, marker.instance_key,
        )
        await reply(update, context, t("msg.ask_expired"))
        return False
    return True


async def image_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return

    logger.info("image message user_id=%s", user.id)
    # No forced default: a captionless image goes to the window as pure context
    # (modern models handle a bare image in the conversation) instead of being
    # coerced into "опиши это изображение". Owner's choice, 2026-07-28.
    caption = (message.caption or "").strip()

    if context.application.bot_data.get("use_local"):
        # Local Bot API stores files on the server's (Docker) volume — we can't
        # read the bytes from the host. Forward the file_id like any other
        # attachment; Claude pulls it via download_attachment.
        attachment = _extract_image_as_attachment(message)
        if attachment is None:
            await reply(update, context, t("msg.image_failed"))
            return
        await _forward_message(update, context, text=caption, attachment=attachment)
        return

    payload = await _extract_image_payload(update, context)
    if payload is None:
        await reply(update, context, t("msg.image_failed"))
        return

    image_bytes, mime_type = payload
    await _forward_message(update, context, text=caption, image={
        "data": encode_image_bytes(image_bytes),
        "mime_type": mime_type,
    })


def _extract_image_as_attachment(message: Any) -> dict[str, Any] | None:
    if message.photo:
        photo = message.photo[-1]
        return {
            "file_id": photo.file_id,
            "file_name": f"photo_{photo.file_unique_id}.jpg",
            "mime_type": "image/jpeg",
            "file_size": getattr(photo, "file_size", None),
        }
    doc = message.document
    if doc is not None and doc.file_id:
        return {
            "file_id": doc.file_id,
            "file_name": doc.file_name or f"image_{doc.file_unique_id}",
            "mime_type": doc.mime_type,
            "file_size": doc.file_size,
        }
    return None


async def attachment_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Forward any non-image attachment (document, video, audio, voice) to Claude.

    We don't pull the bytes here — that can be up to ~2 GB on the local Bot API
    server. Instead we hand Claude the ``file_id`` via the channel meta; Claude
    fetches it on demand through the ``download_attachment`` MCP tool.
    """
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return

    attachment = _extract_attachment(message)
    if attachment is None:
        await reply(update, context, t("msg.attachment_unrecognized"))
        return

    logger.info(
        "attachment message user_id=%s name=%s size=%s",
        user.id, attachment["file_name"], attachment.get("file_size"),
    )

    size = _human_size(attachment.get("file_size"))
    descr = f"📎 Файл: {attachment['file_name']}" + (f" ({size})" if size else "")
    caption = (message.caption or "").strip()
    text = f"{descr}\n\n{caption}" if caption else descr
    await _forward_message(update, context, text=text, attachment=attachment)


def _extract_attachment(message: Any) -> dict[str, Any] | None:
    obj = (
        message.document
        or message.video
        or message.audio
        or message.voice
        or message.video_note
    )
    file_id = getattr(obj, "file_id", None)
    if obj is None or not file_id:
        return None
    name = getattr(obj, "file_name", None)
    if not name:
        # voice / video_note carry no file_name — synthesize a stable one.
        kind = type(obj).__name__.lower()
        name = f"{kind}_{getattr(obj, 'file_unique_id', 'file')}"
    return {
        "file_id": file_id,
        "file_name": name,
        "mime_type": getattr(obj, "mime_type", None),
        "file_size": getattr(obj, "file_size", None),
    }


def _human_size(num: int | None) -> str:
    if not num:
        return ""
    value = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return ""


async def reaction_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Only forward reactions on messages routed to a Claude instance —
    # reactions on user-only messages would be noise.
    reaction = update.message_reaction
    user = update.effective_user
    if reaction is None or user is None:
        return

    chat_id = reaction.chat.id
    target_message_id = reaction.message_id

    storage = get_storage(context)
    routed = storage.lookup_route(chat_id, target_message_id)
    if not routed:
        return  # not a Claude message — nothing to forward

    runtime_instances = refresh_instances(context)
    if find_instance(runtime_instances, routed) is None:
        logger.info("reaction skipped: instance=%s no longer registered", routed)
        return

    old_emojis = _render_reactions(reaction.old_reaction)
    new_emojis = _render_reactions(reaction.new_reaction)
    text = (
        f"[reaction] user {user.id} на сообщение {target_message_id}: "
        f"{old_emojis or '∅'} → {new_emojis or '∅'}"
    )
    logger.info(
        "reaction user_id=%s msg=%s instance=%s %s -> %s",
        user.id, target_message_id, routed, old_emojis or '∅', new_emojis or '∅',
    )

    # Premium/custom emoji in the NEW reaction ride along as images too, same as
    # in a message — so a custom-emoji reaction shows the actual emoji, not just
    # the <custom:id> placeholder. Only the added reaction (new), not what was
    # removed.
    new_custom_ids = [r.custom_emoji_id for r in (reaction.new_reaction or ())
                      if isinstance(r, ReactionTypeCustomEmoji) and r.custom_emoji_id]
    emojis = await _emojis_from_ids(new_custom_ids, context.bot)

    body: dict[str, Any] = {
        "request_id": make_request_id(),
        "chat_id": chat_id,
        "user_id": user.id,
        "message_id": target_message_id,
        "text": text,
        "event": "reaction",
        "sender_name": user.full_name,
        "sender_username": user.username or "",
    }
    if emojis:
        body["emojis"] = emojis

    bridge_client = get_bridge_client(context)
    try:
        await bridge_client.post_message(routed, body)
    except KeyError:
        logger.info("reaction forward: unknown instance %s", routed)
    except PermissionError as exc:
        logger.info("reaction forward auth failure for %s: %s", routed, exc)
    except Exception:
        logger.exception("reaction forward failed instance=%s", routed)


def _render_reactions(reactions: Any) -> str:
    parts: list[str] = []
    for r in reactions or ():
        if isinstance(r, ReactionTypeEmoji):
            parts.append(r.emoji)
        elif isinstance(r, ReactionTypeCustomEmoji):
            parts.append(f"<custom:{r.custom_emoji_id}>")
    return "".join(parts)


async def _emojis_from_ids(ids: list[str], bot: Any) -> list[dict[str, Any]]:
    """custom_emoji_ids → sticker file_id + metadata (deduped, order-preserving).

    We forward the sticker file_id (not bytes — in local-Bot-API mode the bot
    can't read the file host-side; the plugin downloads it), plus pack_id
    (set_name) / emoji_id / base_emoji. Animated (tgs) and video (webm) emoji
    can't be shown as a still, so we forward their static thumbnail.
    """
    if not ids:
        return []
    seen: set[str] = set()
    uniq = [i for i in ids if not (i in seen or seen.add(i))]
    try:
        stickers = await bot.get_custom_emoji_stickers(uniq)
    except Exception:
        logger.exception("get_custom_emoji_stickers failed for %s ids", len(uniq))
        return []
    out: list[dict[str, Any]] = []
    for s in stickers:
        file_id = s.file_id
        if (getattr(s, "is_animated", False) or getattr(s, "is_video", False)) and s.thumbnail is not None:
            file_id = s.thumbnail.file_id
        out.append({
            "file_id": file_id,
            "pack_id": s.set_name or "",
            "emoji_id": s.custom_emoji_id or "",
            "base_emoji": s.emoji or "",
        })
    return out


async def _collect_custom_emojis(message: Any, bot: Any) -> list[dict[str, Any]]:
    """Telegram premium/custom emoji used in a message's text → emoji payloads."""
    entities = list(message.entities or []) + list(message.caption_entities or [])
    ids = [e.custom_emoji_id for e in entities
           if e.type == MessageEntity.CUSTOM_EMOJI and e.custom_emoji_id]
    return await _emojis_from_ids(ids, bot)


def _origin_label(origin: Any) -> str | None:
    """Human label of a MessageOrigin (forward source / external reply source)."""
    if origin is None:
        return None
    kind = getattr(origin, "type", "")
    if kind == "user":
        u = origin.sender_user
        name = " ".join(filter(None, [u.first_name, u.last_name])) or u.username or str(u.id)
        return f"{name} (@{u.username})" if u.username else name
    if kind == "hidden_user":
        return str(origin.sender_user_name)
    if kind == "chat":
        c = origin.sender_chat
        return f"чат «{c.title or c.username or c.id}»"
    if kind == "channel":
        c = origin.chat
        return f"канал «{c.title or c.username or c.id}»"
    return "неизвестный источник"


def _forward_origin_label(message: Any) -> str | None:
    """Origin of a forwarded message, or None for own messages (2026-07-07)."""
    return _origin_label(getattr(message, "forward_origin", None))


def _quote_block(message: Any) -> str | None:
    """Reply-quote context: native TG quotes (including cross-chat "reply in
    another chat") arrive as message.quote (+ external_reply for the source
    chat). Prepend them so the window sees WHAT the user is answering/citing
    (feature request 2026-07-08)."""
    quote = getattr(message, "quote", None)
    qtext = getattr(quote, "text", None) if quote is not None else None
    ext = getattr(message, "external_reply", None)
    if not qtext and ext is None:
        return None
    src = _origin_label(getattr(ext, "origin", None)) if ext is not None else None
    if qtext:
        quoted = "\n".join("> " + ln for ln in str(qtext).splitlines())
        return f"[Цитата{f' из: {src}' if src else ''}]\n{quoted}"
    return f"[Ответ на сообщение из: {src}]" if src else None


async def _forward_message(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    text: str,
    image: dict[str, str] | None = None,
    attachment: dict[str, Any] | None = None,
    topic_target: tuple[str | None, int | None, int | None] | None = None,
) -> None:
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return

    # Forwarded content is marked so the model can distinguish the user's own
    # words from material they forwarded in (and from whom it came).
    fwd = _forward_origin_label(message)
    if fwd is not None:
        text = f"[Форвард от: {fwd}]\n{text}"
    quote_block = _quote_block(message)
    if quote_block is not None:
        text = f"{quote_block}\n{text}"

    runtime_instances = refresh_instances(context)
    if not runtime_instances:
        await reply(update, context, t("common.no_windows"))
        return

    # Best-effort "typing…" cue. It's cosmetic AND rate-limited by Telegram, so
    # it must never abort the forward: a burst of forwards (e.g. 20+ channel
    # posts at once) trips Flood control → RetryAfter here, which used to
    # propagate, drop the actual forward, and surface as "❌ Внутренняя ошибка"
    # — the real message never reached the window. Swallow any failure.
    try:
        await context.bot.send_chat_action(chat_id=message.chat_id, action=ChatAction.TYPING)
    except Exception:
        logger.debug("send_chat_action failed (ignored)", exc_info=True)

    session = ensure_active_session(context, user.id, runtime_instances)
    bridge_client = get_bridge_client(context)
    storage = get_storage(context)

    # Routing precedence:
    #   1) forum topic → its bound window (Slice 3): strongest signal — you're
    #      talking inside a specific window's topic.
    #   2) native Telegram reply → the window that sent the replied-to message.
    #   3) the user's active window (DM default).
    # None of these change the active window.
    # Caller (text_message) may have already resolved this — reuse to avoid the
    # duplicate storage query + instance scan.
    topic_key, _topic_chat, _topic_thread = topic_target if topic_target is not None else _resolve_topic_target(update, context)
    target_instance = session.active_instance
    if topic_key is not None:
        target_instance = topic_key
    else:
        reply_to = message.reply_to_message
        if reply_to is not None:
            routed = storage.lookup_route(message.chat_id, reply_to.message_id)
            if routed and find_instance(runtime_instances, routed) is not None:
                if routed != session.active_instance:
                    logger.info(
                        "reply-to routing user_id=%s reply_to=%s instance=%s (active=%s)",
                        user.id, reply_to.message_id, routed, session.active_instance,
                    )
                target_instance = routed

    body: dict[str, Any] = {
        "request_id": make_request_id(),
        "chat_id": message.chat_id,
        "user_id": user.id,
        "message_id": message.message_id,
        "text": text,
        "sender_name": user.full_name,
        "sender_username": user.username or "",
        "chat_title": message.chat.title or "",
        "forward_from": fwd or "",
    }
    if image is not None:
        body["image"] = image
    if attachment is not None:
        body["attachment"] = attachment
    # Premium/custom emoji ride along on any message type (their sticker file_ids +
    # pack/emoji ids); the plugin downloads each image and shows it to Claude.
    emojis = await _collect_custom_emojis(message, context.bot)
    if emojis:
        body["emojis"] = emojis

    logger.info("forwarding to instance=%s user_id=%s", target_instance, user.id)
    try:
        await bridge_client.post_message(target_instance, body)
    except KeyError:
        target_label = get_display_name(context, target_instance)
        await reply(update, context, t("msg.window_not_running", name=target_label))
    except PermissionError as exc:
        await reply(update, context, t("msg.auth_error", error=exc))
    except Exception as exc:
        logger.exception("forward failed instance=%s", target_instance)
        await reply(update, context, t("cmd.error", error=exc))
    else:
        await _mirror_inbound_to_dm(
            context, user.id, target_instance, topic_key, text, image, attachment,
        )


async def _mirror_inbound_to_dm(
    context: ContextTypes.DEFAULT_TYPE,
    user_id: int,
    target_instance: str,
    topic_key: str | None,
    text: str | None,
    image: dict[str, str] | None,
    attachment: dict[str, Any] | None,
) -> None:
    """Echo a message typed inside a window's forum topic into the user's DM,
    so the DM stays a single flat feed of all traffic (as it was pre-topics).
    "→ <window>" marks the inbound direction; window output is mirrored the
    other way ("<window> →") from the channel plugin. Skipped for DM-origin
    messages (topic_key is None) — those are already in the DM."""
    if topic_key is None:
        return
    win = get_display_name(context, target_instance)
    parts = [f"<b>→ {html.escape(win)}</b>"]
    if text:
        parts.append(html.escape(text))
    elif image is not None:
        parts.append(t("msg.mirror_image"))
    elif attachment is not None:
        parts.append(t("msg.mirror_attachment"))
    try:
        await context.bot.send_message(
            chat_id=user_id, text="\n".join(parts), parse_mode="HTML",
        )
    except Exception:
        logger.exception("DM inbound mirror failed for user_id=%s", user_id)


# Three-slot tracking in context.chat_data — separated by what
# ReplyKeyboardMarkup each message carries. Deleting a message also drops the
# reply-keyboard it brought to the client, so anything that wants to keep a
# given keyboard alive must keep that message alive.
#
#   MAIN_ANCHOR_MSG_KEY → latest message that brought the MAIN reply keyboard
#     (📊 Окна / ⚙️ Настройки). Examples: ✅ switch confirmation, 🪟 back marker,
#     🚫 error. Always alive in main mode.
#   PICKER_MSG_KEY     → "📊 Выбери окно:" prompt — brings the picker reply
#     keyboard. Always alive in picker mode.
#   AUX_MSG_KEY        → any other transient bot UI message that uses an
#     INLINE keyboard (settings panel, status list, status panel, no-instances
#     error). Doesn't affect reply keyboard — can be added/removed freely
#     without touching MAIN_ANCHOR or PICKER.
MAIN_ANCHOR_MSG_KEY = "main_anchor_msg_id"
PICKER_MSG_KEY = "picker_prompt_msg_id"
AUX_MSG_KEY = "aux_msg_id"


async def _safe_delete(context: ContextTypes.DEFAULT_TYPE, chat_id: int, message_id: int | None) -> None:
    if message_id is None:
        return
    try:
        await context.bot.delete_message(chat_id=chat_id, message_id=message_id)
    except Exception:
        # Message already gone, too old (>48h for user msgs), or no rights — silent.
        pass


async def _clean_slot(context: ContextTypes.DEFAULT_TYPE, chat_id: int, key: str) -> None:
    mid = context.chat_data.pop(key, None)
    await _safe_delete(context, chat_id, mid)


async def _broadcast_save(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Fan the 💾 save prompt out to every registered window. Each window persists
    its context and reports into its OWN forum topic: we send with
    chat_id=forum_chat_id, and the plugin's forumThreadFor() threads the window's
    reply into its topic (same path as typing inside that topic). If no forum is
    configured, replies fall back to this DM."""
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return
    chat_id = message.chat_id
    await _safe_delete(context, chat_id, message.message_id)

    instances = refresh_instances(context)
    if not instances:
        sent = await context.bot.send_message(
            chat_id=chat_id,
            text=t("common.no_windows"),
            reply_markup=build_window_reply_keyboard(),
        )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        context.chat_data[AUX_MSG_KEY] = sent.message_id
        return

    bridge_client = get_bridge_client(context)
    forum = forum_chat_id(context.bot_data["config"])
    reply_chat = forum if forum is not None else chat_id

    async def _send_one(inst: Any) -> tuple[str, bool]:
        body: dict[str, Any] = {
            "request_id": make_request_id(),
            "chat_id": reply_chat,
            "user_id": user.id,
            "message_id": message.message_id,
            "text": SAVE_PROMPT,
        }
        try:
            await bridge_client.post_message(inst.key, body)
            return inst.display_name, True
        except Exception as exc:
            logger.warning("save broadcast to %s failed: %s", inst.key, exc)
            return inst.display_name, False

    results = await asyncio.gather(*(_send_one(i) for i in instances))
    ok = [name for name, good in results if good]
    failed = [name for name, good in results if not good]

    lines = [t("msg.save_broadcast", sent=len(ok), total=len(instances))]
    if ok:
        lines.append(
            t("msg.save_reports_topics", names=", ".join(ok))
            if forum is not None
            else t("msg.save_reports_dm", names=", ".join(ok))
        )
    if failed:
        lines.append(t("msg.save_failed", names=", ".join(failed)))

    sent = await context.bot.send_message(chat_id=chat_id, text="\n".join(lines))
    await _clean_slot(context, chat_id, AUX_MSG_KEY)
    context.chat_data[AUX_MSG_KEY] = sent.message_id


async def _maybe_handle_window_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    """Handle taps on the persistent reply keyboard and the temporary
    quick-switch keyboard that 📊 Окна swaps in.

    Cleanup rules per action — see PICKER_MSG_KEY / AUX_MSG_KEY above:
      - 📊 Окна → ENTER picker. Clean both slots, send new picker, store as PICKER.
      - tap window name → EXIT picker → main. Clean both, send ✅, store as AUX.
      - 📈 Статус → STAY in picker, ADD status list. Clean AUX only, send list, store as AUX.
        Picker prompt stays alive — that's where the reply keyboard lives.
      - ◀️ Назад → EXIT picker → main. Clean both, send ◀️, store as AUX.
      - ⚙️ Настройки → main mode with inline settings. Clean both, send settings, store as AUX.

    Order: always send-new BEFORE delete-old, so the reply keyboard never
    flickers off (the new message that carries the keyboard exists before the
    old carrier is gone).
    """
    message = update.effective_message
    if message is None or message.text is None:
        return False

    text = message.text.strip()
    chat_id = message.chat_id

    if text == settings_button_text():
        # Stay in main mode → keep MAIN_ANCHOR alive, just replace AUX with
        # the inline settings panel.
        await _safe_delete(context, chat_id, message.message_id)
        sent = await context.bot.send_message(
            chat_id=chat_id,
            text=t("cb.settings_title"),
            reply_markup=build_settings_root_keyboard(),
            parse_mode="HTML",
        )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        context.chat_data[AUX_MSG_KEY] = sent.message_id
        return True

    if text == save_button_text():
        await _broadcast_save(update, context)
        return True

    if text == launch_button_text():
        # Same shape as ⚙️ Настройки: stay in main mode, AUX slot carries the
        # inline picker of registered-but-offline workspaces (== /launch).
        workspaces = list_launchable(context)
        await _safe_delete(context, chat_id, message.message_id)
        if workspaces:
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("cb.launch_pick"),
                reply_markup=build_launch_keyboard(workspaces),
            )
        else:
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("common.launch_all_running"),
            )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        context.chat_data[AUX_MSG_KEY] = sent.message_id
        return True

    if text == status_windows_button_text():
        # main → picker (or stay in main on edge case)
        instances = refresh_instances(context)
        await _safe_delete(context, chat_id, message.message_id)
        if not instances:
            # No instances: present a main-mode error with the main keyboard.
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("common.no_windows"),
                reply_markup=build_window_reply_keyboard(),
            )
            await _clean_slot(context, chat_id, AUX_MSG_KEY)
            await _clean_slot(context, chat_id, PICKER_MSG_KEY)
            await _clean_slot(context, chat_id, MAIN_ANCHOR_MSG_KEY)
            context.chat_data[MAIN_ANCHOR_MSG_KEY] = sent.message_id
            return True
        sent = await context.bot.send_message(
            chat_id=chat_id,
            text=t("msg.pick_window"),
            reply_markup=build_window_quick_switch_keyboard([i.display_name for i in instances]),
        )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        await _clean_slot(context, chat_id, MAIN_ANCHOR_MSG_KEY)
        await _clean_slot(context, chat_id, PICKER_MSG_KEY)
        context.chat_data[PICKER_MSG_KEY] = sent.message_id
        return True

    if text == back_button_text():
        # picker → main. The marker message has to exist (only way to swap
        # reply keyboard back to main), so make it useful: show current active.
        await _safe_delete(context, chat_id, message.message_id)
        user_id_local = get_user_id(update)
        session = get_sessions(context).get(user_id_local)
        active_label = get_display_name(context, session.active_instance) if session.active_instance else None
        marker_text = (
            t("msg.active_window", name=active_label)
            if active_label
            else t("msg.no_active_window")
        )
        sent = await context.bot.send_message(
            chat_id=chat_id,
            text=marker_text,
            reply_markup=build_window_reply_keyboard(),
        )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        await _clean_slot(context, chat_id, PICKER_MSG_KEY)
        await _clean_slot(context, chat_id, MAIN_ANCHOR_MSG_KEY)
        context.chat_data[MAIN_ANCHOR_MSG_KEY] = sent.message_id
        return True

    if text == status_list_button_text():
        # Stay in picker → keep PICKER alive, replace AUX with the inline
        # status list. Reply keyboard (picker) is unchanged.
        user_id_local = get_user_id(update)
        session = get_sessions(context).get(user_id_local)
        options = await build_window_options(context, session.active_instance)
        await _safe_delete(context, chat_id, message.message_id)
        if not options:
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("common.no_windows"),
            )
        else:
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("msg.status_pick_window"),
                reply_markup=build_status_windows_keyboard(options),
            )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        context.chat_data[AUX_MSG_KEY] = sent.message_id
        return True

    # Quick-switch by window name → picker → main mode.
    instances = context.application.bot_data.get("runtime_instances") or []
    match = next((i for i in instances if i.display_name == text), None)
    if match is not None:
        fresh = refresh_instances(context)
        match = next((i for i in fresh if i.display_name == text), None)
        await _safe_delete(context, chat_id, message.message_id)
        if match is None:
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("msg.window_gone", name=text),
                reply_markup=build_window_reply_keyboard(),
            )
        else:
            user_id = get_user_id(update)
            get_sessions(context).set_active_instance(user_id, match.key)
            persist_active_instances(context.application)
            logger.info(
                "window switch via quick keyboard user_id=%s instance=%s",
                user_id, match.key,
            )
            sent = await context.bot.send_message(
                chat_id=chat_id,
                text=t("msg.active_window_switched", name=match.display_name),
                reply_markup=build_window_reply_keyboard(),
            )
        await _clean_slot(context, chat_id, AUX_MSG_KEY)
        await _clean_slot(context, chat_id, PICKER_MSG_KEY)
        await _clean_slot(context, chat_id, MAIN_ANCHOR_MSG_KEY)
        context.chat_data[MAIN_ANCHOR_MSG_KEY] = sent.message_id
        return True

    return False


async def _extract_image_payload(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> tuple[bytes, str] | None:
    message = update.effective_message
    if message is None:
        return None
    if message.photo:
        tf = await context.bot.get_file(message.photo[-1].file_id)
        return bytes(await tf.download_as_bytearray()), pick_image_mime_type(None, default="image/jpeg")
    doc = message.document
    if doc is not None and doc.file_id:
        tf = await context.bot.get_file(doc.file_id)
        return bytes(await tf.download_as_bytearray()), pick_image_mime_type(doc.mime_type)
    return None
