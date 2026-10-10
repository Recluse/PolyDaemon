"""Agent-aware launch routing; no real windows or remote machines."""
import asyncio
from types import SimpleNamespace as NS
from unittest.mock import patch

import httpx
from bot import launcher
from bot.callbacks import launch_callback
from bot.keyboards import build_launch_keyboard, cb_token
from bot.topics import instance_agent, resolve_workspace_id
from bridge.client import ChannelPluginClient


async def check():
    topics = [(p, 1, i, "shared") for i, p in enumerate((
        "/work/shared", "/work/shared#codex", "/work/shared#mimo", "C:\\work\\shared", "#shared"))]
    live = NS(cwd="/work/shared", display_name="shared-codex", instance_name="shared-codex")
    assert instance_agent(live) == "codex" and resolve_workspace_id(live) == "/work/shared#codex"
    ctx = NS(application=NS(bot_data={"config": {"bot": {"launch_agents": [
        {"label": "Mac", "url": "http://mac", "prefixes": ["/work"]},
        {"label": "Windows", "url": "http://win", "prefixes": ["C:/work"]},
    ]}}, "storage": NS(all_topics=lambda: topics)}))
    with patch.object(launcher, "refresh_instances", return_value=[live]):
        assert len(launcher.list_launchable(ctx, kind="mimo")) == 2
        assert launcher.list_launchable(ctx, kind="codex") == [("shared", "C:\\work\\shared")]
        keyboard = build_launch_keyboard(launcher.list_launchable(ctx), ["Mac", "Windows"], "Windows", "mimo", True)
        callbacks = [b.callback_data for row in keyboard.inline_keyboard for b in row]
        assert f"launch:go:mimo:1:{cb_token('C:\\work\\shared')}" in callbacks
        assert all(len(s.encode()) <= 64 for s in callbacks)
        calls = []
        async def post(*args): calls.append(args)
        ctx.application.bot_data["bridge_client"] = NS(post_launch=post)
        async def noop(*args, **kwargs): pass
        query = NS(data=f"launch:go:mimo:1:{cb_token('C:\\work\\shared')}", answer=noop, edit_message_text=noop)
        await launch_callback(NS(callback_query=query), ctx)
        assert calls == [("http://win", "", "shared", "C:\\work\\shared", "mimo", True)]
        calls.clear()
        query.data = f"launch:go:codex:0:{cb_token('/work/shared')}"
        await launch_callback(NS(callback_query=query), ctx)
        query.data = f"launch:go:{cb_token('shared')}"  # ambiguous legacy title
        await launch_callback(NS(callback_query=query), ctx)
        assert not calls

    requests = []
    modern = False
    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={"ok": True, **({"agents": list(launcher.AGENT_LABELS), "new_session": True} if modern else {})})
    client = ChannelPluginClient([])
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        try:
            await client.post_launch("http://mac", "fixture", "shared", "/work/shared", "mimo", True)
            raise AssertionError("old agent must not silently start Claude")
        except RuntimeError:
            pass
        assert all(r.method == "GET" for r in requests)
        modern = True
        await client.post_launch("http://mac", "fixture", "shared", "/work/shared", "mimo", True)
        import json
        assert json.loads(requests[-1].content)["agent"] == "mimo"
        assert json.loads(requests[-1].content)["new_session"] is True
    finally:
        await client.aclose()
    print("agent launch routing check OK")


if __name__ == "__main__":
    asyncio.run(check())
