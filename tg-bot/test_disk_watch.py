"""Disk alerts identify the bot host/path and retain their one-warning hysteresis."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bot import i18n, registry_watch as watch


async def check():
    gib = 1024 ** 3
    context = SimpleNamespace(
        application=SimpleNamespace(bot_data={"config": {"bot": {
            "host_name": "bot-host<&>", "low_disk_warn_chat_id": 123,
        }}}),
        bot=SimpleNamespace(send_message=AsyncMock()),
    )
    for locale in ("ru", "en"):
        i18n.configure({"bot": {"locale": locale}})
        context.application.bot_data.pop("low_disk_warned", None)
        context.bot.send_message.reset_mock()
        with patch.object(watch.Path, "home", return_value=Path("/data")), \
             patch.object(watch.shutil, "disk_usage", return_value=SimpleNamespace(total=58 * gib, free=gib)) as usage:
            await watch.disk_watch_job(context)
            await watch.disk_watch_job(context)
            context.bot.send_message.assert_awaited_once()
            args = context.bot.send_message.await_args
            assert args.args[0] == 123
            text = args.args[1]
            assert "bot-host&lt;&amp;&gt;" in text and "<code>/data</code>" in text
            assert "58.0" in text and "1.0" in text and "Claude" not in text
            assert args.kwargs["parse_mode"] == "HTML"
            usage.return_value.free = 4 * gib
            await watch.disk_watch_job(context)
            assert context.application.bot_data["low_disk_warned"] is False
            usage.return_value.free = gib
            context.application.bot_data["config"]["bot"]["host_name"] = ""
            with patch.object(watch.socket, "gethostname", return_value="bot-container"):
                await watch.disk_watch_job(context)
            assert context.bot.send_message.await_count == 2
            assert "bot-container" in context.bot.send_message.await_args.args[1]
        context.application.bot_data["config"]["bot"]["host_name"] = "bot-host<&>"
    assert i18n.check_tables() == []


if __name__ == "__main__":
    asyncio.run(check())
    print("disk warning check OK")
