"""A message whose delivery outcome is unknown must not be reported (and recorded)
as not delivered: PYTHONPATH=tg-bot python3 -B tg-bot/test_interwindow_outcome.py."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx

from bot import interwindow
from bridge.registry import RuntimeInstance


async def check():
    left = RuntimeInstance("left", "left", "left", "127.0.0.1", 3100, "t", "/work/left")
    right = RuntimeInstance("right", "right", "right", "127.0.0.1", 3101, "t", "/work/right")
    storage = SimpleNamespace(get_topic=Mock(return_value=(-100123, 10)), create_task=Mock(return_value=42),
                              answer_open_ask=Mock(return_value=None), set_task_state=Mock())
    bot = SimpleNamespace(send_message=AsyncMock())
    client = SimpleNamespace(post_message=AsyncMock())
    router = interwindow.InterWindowRouter(SimpleNamespace(bot=bot), client, storage,
                                           {"telegram": {"allowed_users": [123]}})
    request = httpx.Request("POST", "http://127.0.0.1:3101/message")
    with patch.object(interwindow, "load_runtime_instances", return_value=[left, right]):
        # The plugin's answer was lost: unknown, the task is not marked failed.
        client.post_message.side_effect = httpx.ReadTimeout("read timed out", request=request)
        result = await router.route("left", "right", "do it", "tell")
        assert not result["ok"] and result.get("uncertain") is True, result
        storage.set_task_state.assert_not_called()

        # A 5xx from a queued client may come after it stored the message.
        storage.set_task_state.reset_mock()
        client.post_message.side_effect = httpx.HTTPStatusError(
            "500", request=request, response=httpx.Response(500, request=request))
        result = await router.route("left", "right", "do it", "tell")
        assert not result["ok"] and result.get("uncertain") is True, result
        storage.set_task_state.assert_not_called()

        # A 4xx is the plugin refusing it: definitely not delivered.
        client.post_message.side_effect = httpx.HTTPStatusError(
            "401", request=request, response=httpx.Response(401, request=request))
        result = await router.route("left", "right", "do it", "tell")
        assert not result["ok"] and not result.get("uncertain"), result

        # Refused before anything was sent: definitely not delivered.
        client.post_message.side_effect = httpx.ConnectError("refused", request=request)
        result = await router.route("left", "right", "do it", "tell")
        assert not result["ok"] and not result.get("uncertain"), result
        assert storage.set_task_state.call_args.args[1] == "failed"

        # The send is pinned to the window route() chose.
        client.post_message.side_effect = None
        result = await router.route("left", "right", "do it", "tell")
        assert result["ok"], result
        assert client.post_message.await_args.kwargs["pinned"].port == 3101


def test_unknown_outcome_is_not_reported_as_failed():
    asyncio.run(check())


if __name__ == "__main__":
    asyncio.run(check())
    print("interwindow outcome check OK")
