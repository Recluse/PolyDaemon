"""/restart of a Codex window resumes the thread BOUND to that window.

The old relaunch passed only the folder, and the launcher then resumed the
folder's most recently updated thread: with two Codex windows (or child and
`codex exec` threads) in one folder that is another conversation. No network,
no real windows: the plugin, launch-agent and launcher are faked.
"""
import asyncio
import json
from types import SimpleNamespace as NS

import httpx

from bot import exit_window, i18n, launcher
from bridge.client import ChannelPluginClient

i18n.configure({"bot": {"locale": "en"}})

ONE = NS(key="shared-codex", display_name="shared-codex", instance_name="shared-codex", cwd="/work/shared",
         workspace_name="shared-codex", agent="codex", row_id="r1")
TWO = NS(key="shared2-codex", display_name="shared2-codex", instance_name="shared2-codex", cwd="/work/shared",
         workspace_name="shared2-codex", agent="codex", row_id="r2")


class Bridge:
    def __init__(self, threads, can_pin=True):
        self.threads, self.can_pin, self.asked = threads, can_pin, []

    async def get_codex_thread(self, key):
        self.asked.append(key)
        thread = self.threads.get(key)
        return (thread, "") if thread else (None, "ambiguous: 2 codex threads in this folder")

    async def launch_supports_thread(self, url):
        return self.can_pin


def _context(bridge):
    config = {"bot": {"launch_agents": [{"label": "Mac", "url": "http://mac", "prefixes": ["/work"]}]}}
    return NS(application=NS(bot_data={"config": config, "bridge_client": bridge}), args=[])


def _patch(monkeypatch, target, live):
    exits, launches = [], []

    async def deliver(context, instances, key, cmd):
        exits.append(key)
        return True, ""

    async def launch(context, name, cwd="", kind="claude", new_session=False, thread_id=""):
        launches.append((name, cwd, kind, thread_id))

    async def gone(context, key):
        return True

    monkeypatch.setattr(exit_window, "refresh_instances", lambda context: list(live))
    monkeypatch.setattr(exit_window, "resolve_topic_target", lambda *a: target)
    # The confirmation was shown for `target` (see test_window_identity.py for
    # the confirmation store itself).
    monkeypatch.setattr(exit_window, "take_confirmation", lambda context, message, action, instances: target)
    monkeypatch.setattr(exit_window, "get_user_id", lambda update: 1)
    monkeypatch.setattr(exit_window, "get_display_name", lambda context, key: key)
    monkeypatch.setattr(exit_window, "deliver_slash_command", deliver)
    monkeypatch.setattr(exit_window, "launch_workspace", launch)
    monkeypatch.setattr(exit_window, "_wait_until_gone", gone)
    return exits, launches


def _query():
    alerts = []

    async def answer(text=None, show_alert=False):
        if show_alert:
            alerts.append(text)

    async def edit(text, **kw):
        pass

    return NS(data="restart:go", answer=answer, edit_message_text=edit, message=None), alerts


def test_restart_resumes_each_windows_own_thread(monkeypatch):
    bridge = Bridge({"shared-codex": "thr-one", "shared2-codex": "thr-two"})
    for window, thread in ((ONE, "thr-one"), (TWO, "thr-two")):
        exits, launches = _patch(monkeypatch, window.key, [ONE, TWO])
        query, alerts = _query()
        asyncio.run(exit_window.restart_callback(NS(callback_query=query), _context(bridge)))
        assert not alerts, alerts
        assert exits == [window.key]
        assert launches == [(window.key, "/work/shared", "codex", thread)]


def test_restart_refuses_codex_window_without_bound_thread(monkeypatch):
    bridge = Bridge({})
    exits, launches = _patch(monkeypatch, ONE.key, [ONE, TWO])
    query, alerts = _query()
    asyncio.run(exit_window.restart_callback(NS(callback_query=query), _context(bridge)))
    assert exits == [] and launches == [], "nothing is closed when the relaunch cannot be pinned"
    assert "ambiguous" in alerts[0]


def test_restart_refuses_when_launcher_cannot_pin_thread(monkeypatch):
    bridge = Bridge({"shared-codex": "thr-one"}, can_pin=False)
    exits, launches = _patch(monkeypatch, ONE.key, [ONE])
    query, alerts = _query()
    asyncio.run(exit_window.restart_callback(NS(callback_query=query), _context(bridge)))
    assert exits == [] and launches == []
    assert alerts


def test_restart_all_pins_codex_threads(monkeypatch):
    bridge = Bridge({"shared-codex": "thr-one"})
    exits, launches = _patch(monkeypatch, "", [ONE, TWO])

    async def sort(context, instances):
        return list(instances), [], []

    monkeypatch.setattr(exit_window, "_sort_windows", sort)

    class Bot:
        async def edit_message_text(self, **kw):
            pass

    context = _context(bridge)
    context.bot = Bot()
    asyncio.run(exit_window._restart_all_run(context, chat_id=1, message_id=2))
    assert launches == [("shared-codex", "/work/shared", "codex", "thr-one")]
    assert exits == ["shared-codex"], "the unbound window is left open, not relaunched on a guess"


def test_client_sends_thread_and_requires_capability():
    requests = []
    state = {"pin": False}

    def handler(req):
        requests.append(req)
        if req.url.path == "/health":
            return httpx.Response(200, json={"ok": True, "agents": list(launcher.AGENT_LABELS),
                                             "new_session": True, "thread_resume": state["pin"]})
        return httpx.Response(200, json={"ok": True})

    async def run():
        client = ChannelPluginClient([])
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            try:
                await client.post_launch("http://mac", "t", "shared", "/work/shared", "codex", thread_id="thr-one")
                raise AssertionError("an old launch-agent would drop the thread and resume the newest")
            except RuntimeError:
                pass
            assert all(r.method == "GET" for r in requests)
            state["pin"] = True
            assert await client.launch_supports_thread("http://mac") is True
            await client.post_launch("http://mac", "t", "shared", "/work/shared", "codex", thread_id="thr-one")
            assert json.loads(requests[-1].content)["thread_id"] == "thr-one"
            for bad in ({"agent": "claude"}, {"agent": "codex", "thread_id": "x; rm"}):
                try:
                    await client.post_launch("http://mac", "t", "shared", "/work/shared",
                                             bad["agent"], thread_id=bad.get("thread_id", "thr-one"))
                    raise AssertionError(bad)
                except ValueError:
                    pass
        finally:
            await client.aclose()

    asyncio.run(run())


def test_restart_all_skips_a_window_that_reconnected_after_the_confirmation(monkeypatch):
    # The person confirmed row r1. Before its turn, the plugin reconnected: the
    # same key (uid and scope) now belongs to row r1b, a process nobody confirmed.
    confirmed = NS(key="claude-w", display_name="claude-w", instance_name="claude-w", cwd="/work/a",
                   workspace_name="claude-w", agent="claude", row_id="r1")
    reconnected = NS(**{**vars(confirmed), "row_id": "r1b"})
    bridge = Bridge({})
    exits, launches = _patch(monkeypatch, "", [reconnected])

    async def sort(context, instances):
        return [confirmed], [], []

    monkeypatch.setattr(exit_window, "_sort_windows", sort)
    statuses = []

    class Bot:
        async def edit_message_text(self, **kw):
            statuses.append(kw["text"])

    context = _context(bridge)
    context.bot = Bot()
    asyncio.run(exit_window._restart_all_run(context, chat_id=1, message_id=2, confirmed_rows={"r1"}))
    assert exits == [] and launches == [], "/exit must not reach a process that was not confirmed"
    assert "reconnected" in statuses[-1]
