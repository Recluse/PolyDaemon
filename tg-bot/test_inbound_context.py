"""Check sender/forward metadata at the router HTTP boundary."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from telegram import Chat, Message, MessageOriginHiddenUser, Update, User
from bot import messages


async def check():
    user = User(123, "Alice", False, last_name="Example", username="alice")
    client = SimpleNamespace(post_message=AsyncMock())
    context = SimpleNamespace(bot=SimpleNamespace(send_chat_action=AsyncMock()))
    for origin in (None, MessageOriginHiddenUser(datetime.now(timezone.utc), "Original Author")):
        message = Message(42, datetime.now(timezone.utc), Chat(-100123, "supergroup", title="Test chat"),
                          from_user=user, text="hello", forward_origin=origin)
        update = Update(1, message=message)
        with patch.object(messages, "refresh_instances", return_value=[object()]), \
             patch.object(messages, "ensure_active_session", return_value=SimpleNamespace(active_instance="test-codex")), \
             patch.object(messages, "get_bridge_client", return_value=client), \
             patch.object(messages, "get_storage"), \
             patch.object(messages, "_collect_custom_emojis", new=AsyncMock(return_value=[])), \
             patch.object(messages, "_mirror_inbound_to_dm", new=AsyncMock()):
            await messages._forward_message(update, context, text="hello", topic_target=("test-codex", -100123, 7))
        target, body = client.post_message.await_args.args
        assert target == "test-codex"
        assert body["sender_name"] == "Alice Example"
        assert body["sender_username"] == "alice"
        assert body["chat_title"] == "Test chat"
        assert body["forward_from"] == ("Original Author" if origin else "")
        assert body["text"] == ("[Форвард от: Original Author]\nhello" if origin else "hello")
        assert body["chat_id"] == -100123 and body["message_id"] == 42


if __name__ == "__main__":
    asyncio.run(check())
    print("inbound sender/forward context check OK")
