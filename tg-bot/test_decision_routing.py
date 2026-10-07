"""Run with: python test_decision_routing.py (from tg-bot/)."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import Mock

import httpx

from bot.common import refresh_instances
from bridge.client import ChannelPluginClient


async def check():
    def row(port, name="sample-project-codex", **overrides):
        return dict(id=str(port), host="192.0.2.5", port=port,
                    auth_token=f"token-{port}", workspace_name=name,
                    instance_name=name, cwd="/work/sample-project", pid=port,
                    started_at=str(port), heartbeat_at=time.time(), **overrides)

    rows = [row(3100), row(3101), row(3102), row(3103, "Other")]
    rows += [dict(row(3104), host="203.0.113.5"),
             dict(row(3105), heartbeat_at=time.time() - 1000)]
    storage = SimpleNamespace(get_instances=lambda: rows, delete_instances=Mock())
    client = ChannelPluginClient([])
    app = SimpleNamespace(bot_data={
        "config": {"bot": {"mesh_subnet": "192.0.2.0/24"}},
        "storage": storage, "bridge_client": client,
    })
    selected = refresh_instances(app)
    assert [(i.key, i.port) for i in selected] == [("Other", 3103), ("sample-project-codex", 3102)]
    assert {i.port for i in client._decision_instances} == {3100, 3101, 3102, 3103}
    storage.delete_instances.assert_called_with(["3105"])

    calls = []
    unreachable_primary = False
    owner_port = 3100

    def respond(request):
        port = request.url.port
        body = json.loads(request.content) if request.content else {}
        assert request.headers["authorization"] == f"Bearer token-{port}"
        calls.append((port, request.url.path, body))
        if unreachable_primary and port == 3102:
            raise httpx.ConnectError("primary down", request=request)
        accepted = request.url.path == "/message" or (port == owner_port and body.get("id") == "owned")
        return httpx.Response(200 if accepted else 404, json={"ok": accepted})

    client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    try:
        for decide, path, expected in [
            (lambda: client.post_approve_callback("sample-project-codex", "owned", "once"),
             "/approve-callback", {"id": "owned", "action": "once"}),
            (lambda: client.post_plan_callback("sample-project-codex", "owned", "apply"),
             "/plan-callback", {"id": "owned", "action": "apply"}),
            (lambda: client.post_ask_action("sample-project-codex", "owned", action="toggle", option_idx=1),
             "/ask-callback", {"id": "owned", "action": "toggle", "idx": 1}),
            (lambda: client.post_ask_action("sample-project-codex", "owned", text="my answer"),
             "/ask-callback", {"id": "owned", "text": "my answer"}),
        ]:
            calls.clear()
            # A subsequent refresh must retain the custom-answer route too.
            refresh_instances(app)
            assert await decide(), path
            assert calls[0][0] == 3102, "selected window remains the fast path"
            assert {port for port, _, _ in calls} == {3100, 3101, 3102}
            assert all(p == path and body == expected for _, p, body in calls)

        unreachable_primary = True
        assert await client.post_approve_callback("sample-project-codex", "owned", "deny")
        unreachable_primary = False
        assert not await client.post_approve_callback("sample-project-codex", "expired", "once")
        calls.clear()
        owner_port = 3102
        assert await client.post_approve_callback("sample-project-codex", "owned", "once")
        assert len(calls) == 1, "an accepted decision is never broadcast"
        owner_port = 3100
        calls.clear()
        await client.post_message("sample-project-codex", {"text": "normal prompt"})
        assert calls == [(3102, "/message", {"text": "normal prompt"})]

        rows[:] = [row(3102)]
        refresh_instances(app)
        assert not await client.post_approve_callback("sample-project-codex", "owned", "once")
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(check())
    print("decision routing check OK")
