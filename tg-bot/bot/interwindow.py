from __future__ import annotations

import html
import logging
from typing import Any

from telegram.ext import Application

from bot.i18n import t
from bot.storage import Storage
from bot.topics import forum_chat_id, resolve_workspace_id
from bridge.client import ChannelPluginClient
from bridge.protocol import make_request_id
from bridge.registry import RuntimeInstance, load_runtime_instances


logger = logging.getLogger(__name__)

# Hard cap on a cross-window message body — defence against a runaway window
# flooding another. Well above any real instruction.
MAX_TEXT = 8000

# Telegram's per-message hard cap. PTB's send_message does NOT auto-split (unlike
# the plugin's reply path), so we chunk long cross-window notes ourselves.
TG_MSG_LIMIT = 4096


def _chunk_text(text: str, limit: int) -> list[str]:
    """Split on a newline/space boundary near `limit` so a long cross-window
    exchange shows in full across several topic messages instead of being cut."""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = rest.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = rest.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        out.append(rest[:cut])
        rest = rest[cut:].lstrip("\n")
    if rest:
        out.append(rest)
    return out


class InterWindowRouter:
    """Lets one window's Claude talk to another window's Claude via the bot.

    Runs on the bot's async side (the PTB event loop). The registry HTTP server
    (a sync thread) hands requests here through ``run_coroutine_threadsafe`` — see
    bot/http_registry.py. Delivery reuses the exact same path a Telegram message
    takes to reach a window (``ChannelPluginClient.post_message`` with
    ``chat_id=forum`` → the target plugin's ``forumThreadFor`` threads its reply
    into its own topic), so cross-window messages work cross-machine and need no
    plugin ``/inject``. Answers are asynchronous: the target replies by messaging
    back (``tell_window``), so the answer arrives in the asker's session AND both
    topics show the exchange — no blocking, no correlation state.
    """

    def __init__(
        self,
        app: Application,
        bridge_client: ChannelPluginClient,
        storage: Storage,
        config: dict[str, Any],
    ) -> None:
        self._app = app
        self._client = bridge_client
        self._storage = storage
        self._config = config

    def _acting_uid(self) -> int:
        allowed = self._config.get("telegram", {}).get("allowed_users") or []
        try:
            return int(allowed[0]) if allowed else 0
        except (TypeError, ValueError):
            return 0

    async def list_windows(self, from_key: str = "") -> list[dict[str, str]]:
        """Live windows the caller can address (excluding itself)."""
        instances = load_runtime_instances(self._config, self._storage)
        return [
            {"name": i.key, "workspace": i.display_name}
            for i in instances
            if i.key != from_key
        ]

    async def _note_topic(self, instance: RuntimeInstance, header_html: str, body: str) -> None:
        """Post a visibility note (the FULL cross-window text) into a window's
        forum topic, so the user sees the whole exchange rather than a clip.
        `header_html` rides the first chunk only; `body` is plain text, escaped
        and chunked per-message so we never split an HTML tag/entity."""
        workspace_id = resolve_workspace_id(instance)
        row = self._storage.get_topic(workspace_id)
        if not row:
            return
        chat, thread = row[0], row[1]
        chunks = _chunk_text(body, TG_MSG_LIMIT - 200)  # headroom for the header
        for idx, piece in enumerate(chunks):
            text_html = f"{header_html}\n{html.escape(piece)}" if idx == 0 else html.escape(piece)
            try:
                await self._app.bot.send_message(
                    chat_id=chat, text=text_html, message_thread_id=thread, parse_mode="HTML",
                )
            except Exception as exc:
                logger.debug("interwindow topic note failed workspace=%s: %s", workspace_id, exc)
                return

    async def route(self, from_key: str, to_name: str, text: str, kind: str) -> dict[str, Any]:
        """Deliver ``text`` from window ``from_key`` to window ``to_name``.

        ``kind``: 'tell' (a message/instruction) or 'ask' (a question — the target
        is told to answer by messaging back). Returns {ok, delivered|reason, ...}."""
        text = (text or "").strip()
        if not to_name or not text:
            return {"ok": False, "reason": "missing target or text"}
        if len(text) > MAX_TEXT:
            return {"ok": False, "reason": f"text too long (> {MAX_TEXT} chars)"}

        instances = load_runtime_instances(self._config, self._storage)
        target = next((i for i in instances if i.key == to_name), None)
        if target is None:
            target = next((i for i in instances if i.key.lower() == to_name.lower()), None)
        if target is None:
            return {
                "ok": False,
                "reason": f"no live window named '{to_name}'",
                "available": [i.key for i in instances if i.key != from_key],
            }
        if target.key == from_key:
            return {"ok": False, "reason": "a window can't message itself"}
        source = next((i for i in instances if i.key == from_key), None)

        # Book the work BEFORE delivering, so the id can ride along in the prompt —
        # otherwise the target has nothing to address its task_* tools at. A 'tell'
        # back to a window that is waiting on us IS the answer to its ask (already
        # how the windows behave), so that closes their task instead of opening one.
        task_id: int | None = None
        try:
            if kind == "tell" and from_key:
                closed = self._storage.answer_open_ask(target.key, from_key, text)
                if closed is not None:
                    logger.info("interwindow task #%d answered by %s", closed, from_key)
                else:
                    task_id = self._storage.create_task(from_key, target.key, kind, text)
            else:
                task_id = self._storage.create_task(from_key or "?", target.key, kind, text)
        except Exception:
            # Bookkeeping must never block delivery; the message matters more.
            logger.exception("interwindow task bookkeeping failed")

        # The prompt injected into the target's session. For 'ask' we tell it how to
        # answer (message back), so the answer flows to the asker + both topics.
        # The task id is stated so the target can report `blocked` itself instead of
        # the owner having to read a refusal out of prose.
        if task_id is None:
            tag = ""
        else:
            tag = (
                f"\n\n(Это задача #{task_id}. Если выполнить нельзя или нужно решение "
                f"владельца — не молчи и не обходи: вызови task_blocked({task_id}, \"причина\"). "
                f"Закончил — task_done({task_id}, \"итог\").)"
            )
        if kind == "ask":
            delivered = (
                f"❓ Вопрос от окна «{from_key}»:\n{text}\n\n"
                f"(Когда ответишь — верни ответ, вызвав инструмент "
                f"tell_window(\"{from_key}\", \"<твой ответ>\"). Он придёт в окно «{from_key}».)"
                f"{tag}"
            )
        else:
            delivered = f"📩 Сообщение от окна «{from_key}»:\n{text}{tag}"

        # Deliver via the normal inbound path: chat_id=forum so the target's replies
        # thread into ITS topic (forumThreadFor), exactly like a Telegram message.
        forum = forum_chat_id(self._config)
        target_topic = self._storage.get_topic(resolve_workspace_id(target))
        reply_chat = forum if forum is not None else (target_topic[0] if target_topic else self._acting_uid())
        body: dict[str, Any] = {
            "request_id": make_request_id(),
            "chat_id": reply_chat,
            "user_id": self._acting_uid(),
            "message_id": 0,
            "text": delivered,
        }
        try:
            await self._client.post_message(target.key, body)
        except Exception as exc:
            logger.warning("interwindow deliver to %s failed: %s", target.key, exc)
            # Do not leave the row sitting in `sent` for work that never arrived —
            # that would show up in /tasks as something the target is chewing on.
            if task_id is not None:
                try:
                    self._storage.set_task_state(task_id, "failed", result=f"не доставлено: {exc}")
                except Exception:
                    logger.exception("could not mark task #%s failed", task_id)
            return {"ok": False, "reason": f"target unreachable: {exc}"}

        # Visibility notes into both topics (target sees the incoming request; source
        # sees what it sent) — the FULL text, so the whole cross-window exchange is
        # readable in the bot. The message body itself is injected into the target's
        # session and never echoed to Telegram, so without this the topic would show
        # only the target's answer with no context.
        if kind == "ask":
            header = t("iw.topic_incoming_ask", name=html.escape(from_key))
        else:
            header = t("iw.topic_incoming_tell", name=html.escape(from_key))
        await self._note_topic(target, header, text)
        if source is not None:
            if kind == "ask":
                header = t("iw.topic_outgoing_ask", name=html.escape(target.key))
            else:
                header = t("iw.topic_outgoing_tell", name=html.escape(target.key))
            await self._note_topic(source, header, text)

        logger.info("interwindow route %s -> %s (%s) len=%d", from_key or "?", target.key, kind, len(text))
        return {"ok": True, "delivered": target.display_name, "to": target.key,
                "task_id": task_id}
