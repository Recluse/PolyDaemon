"""Check cross-window topic routing: PYTHONPATH=tg-bot python3 -B tg-bot/test_interwindow_topics.py."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call, patch

from bot import interwindow
from bridge.registry import RuntimeInstance


async def check():
    def window(name, folder):
        return RuntimeInstance(name, name, name, "127.0.0.1", 3100, "test", folder)

    left = window("left", "/work/left")
    right = window("right", "/work/right")
    left_codex = window("left-codex", left.cwd)
    right_codex = window("right-codex", right.cwd)
    left_opencode = window("left-opencode", left.cwd)
    right_opencode = window("right-opencode", right.cwd)
    topics = {
        left.cwd: (-100123, 10), left.cwd + "#codex": (-100123, 20),
        right.cwd: (-100123, 30), right.cwd + "#codex": (-100123, 40),
        left.cwd + "#opencode": (-100123, 50), right.cwd + "#opencode": (-100123, 60),
    }
    storage = SimpleNamespace(
        get_topic=Mock(side_effect=topics.get), create_task=Mock(return_value=42),
        answer_open_ask=Mock(return_value=None),
    )
    bot = SimpleNamespace(send_message=AsyncMock())
    client = SimpleNamespace(post_message=AsyncMock())
    router = interwindow.InterWindowRouter(
        SimpleNamespace(bot=bot), client, storage, {"telegram": {"allowed_users": [123]}},
    )
    with patch.object(interwindow, "load_runtime_instances", return_value=[
        left, right, left_codex, right_codex, left_opencode, right_opencode,
    ]):
        for source, target, source_topic, target_topic in (
            (left_codex, right_codex, left.cwd + "#codex", right.cwd + "#codex"),
            (left, right, left.cwd, right.cwd),
            (left_opencode, right_opencode, left.cwd + "#opencode", right.cwd + "#opencode"),
            (left_codex, right_opencode, left.cwd + "#codex", right.cwd + "#opencode"),
        ):
            for kind in ("ask", "tell"):
                storage.get_topic.reset_mock()
                bot.send_message.reset_mock()
                result = await router.route(source.key, target.key, "control ping", kind)
                assert result["ok"], result
                assert storage.get_topic.call_args_list == [
                    call(target_topic), call(target_topic), call(source_topic),
                ], "delivery fallback and both notes must use the agent-aware binding"
                assert [c.kwargs["message_thread_id"] for c in bot.send_message.await_args_list] == [
                    topics[target_topic][1], topics[source_topic][1],
                ]

        del topics[right.cwd + "#codex"]
        bot.send_message.reset_mock()
        result = await router.route(left_codex.key, right_codex.key, "control ping", "ask")
        assert result["ok"], result
        assert client.post_message.await_args.args[1]["chat_id"] == 123
        assert [c.kwargs["message_thread_id"] for c in bot.send_message.await_args_list] == [20], \
            "an unbound Codex window must not inherit its Claude topic"


if __name__ == "__main__":
    asyncio.run(check())
    print("interwindow topic routing check OK")
