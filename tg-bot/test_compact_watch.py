"""Keep Claude auto-compaction and notices separate from co-located Codex windows."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call, patch

from bot import compact_watch as watch
from bridge.registry import RuntimeInstance


async def check():
    claude = RuntimeInstance("project", "project", "project", "127.0.0.1", 3100, "test", "/work/project")
    codex = RuntimeInstance("project-codex", "project-codex", "project-codex", "127.0.0.1", 3101, "test", claude.cwd)
    opencode = RuntimeInstance("project-opencode", "project-opencode", "project-opencode", "127.0.0.1", 3102, "test", claude.cwd)
    topics = {claude.cwd: (1, 10), claude.cwd + "#codex": (1, 20)}
    storage = SimpleNamespace(
        compact_giveups=lambda: {},
        set_compact_giveup=Mock(),
        get_topic=Mock(side_effect=topics.get),
    )
    client = SimpleNamespace(get_context=AsyncMock(return_value={
        "used": 500_000, "idle_s": 9000, "uptime_s": 10000, "busy": False,
    }))
    context = SimpleNamespace(
        application=SimpleNamespace(bot_data={
            "config": {}, "storage": storage, "bridge_client": client,
            "compact_state": {claude.key: {"at": time.monotonic() - 1900, "used": 500_000}},
        }),
        bot=SimpleNamespace(send_message=AsyncMock()),
    )
    with patch.object(watch, "refresh_instances", return_value=[codex, opencode, claude]), \
         patch.object(watch, "deliver_slash_command", new_callable=AsyncMock, return_value=(True, "")) as inject:
        await watch.compact_watch_job(context)
        assert client.get_context.await_args_list == [call(claude.key)], "never read Claude usage through a Codex plugin"
        inject.assert_not_awaited()
        storage.set_compact_giveup.assert_called_once_with(claude.key, 500_000)
        assert context.bot.send_message.await_args.kwargs["message_thread_id"] == 10

    context.application.bot_data["compact_state"].clear()
    context.bot.send_message.reset_mock()
    with patch.object(watch, "refresh_instances", return_value=[codex, opencode, claude]), \
         patch.object(watch, "deliver_slash_command", new_callable=AsyncMock, return_value=(True, "")) as inject:
        await watch.compact_watch_job(context)
        inject.assert_awaited_once_with(context, [codex, opencode, claude], claude.key, "/compact")
        assert context.bot.send_message.await_args.kwargs["message_thread_id"] == 10

    # Both notice paths use the agent-aware binding, even when called directly.
    for notice, args in [(watch._note, (500_000, 9000)), (watch._note_gave_up, (500_000,))]:
        await notice(context, codex, *args)
        assert context.bot.send_message.await_args.kwargs["message_thread_id"] == 20


if __name__ == "__main__":
    asyncio.run(check())
    print("compact routing check OK")
