"""A topic whose window is not running must not reach another window that shares
its title: PYTHONPATH=tg-bot python3 -B tg-bot/test_topic_dead_window.py.

Real storage and registry, fake Telegram and bridge transport. Two machines run
a workspace called "infra" with a topic each; the Mac window is down."""
import asyncio
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from telegram import Update

from bot import commands, common, effort, exit_window, inject, messages, model_cmd
from bot.session import SessionStore
from bot.storage import Storage
from bridge.client import ChannelPluginClient
from bridge.registry import UNAVAILABLE_PREFIX

FORUM = -1001
USER = 42
MAC, WINDOWS = "/Users/r/infra", "C:\\Work\\infra"


class RecordingClient(ChannelPluginClient):
    def __init__(self):
        super().__init__([])
        self.posts = []
        self.asks = []

    async def post_message(self, instance_name, body, *, pinned=None):
        instance = pinned or self._get_instance(instance_name)  # the production lookup
        self.posts.append((instance_name, instance.port, body["text"]))

    async def post_inject(self, instance_name, cmd, *, pinned=None):
        instance = pinned or self._get_instance(instance_name)
        self.posts.append((instance_name, instance.port, cmd))
        return True, ""

    async def post_ask_action(self, instance_name, ask_id, **kwargs):
        self.asks.append((instance_name, ask_id, kwargs))
        return True

    async def get_context(self, instance_name):
        instance = self._instances.get(instance_name)  # production: unknown name -> None
        if instance is not None:
            self.posts.append((instance_name, instance.port, "/context"))
        return None


class Context:
    def __init__(self, bot_data):
        self.application = SimpleNamespace(bot_data=bot_data)
        self.bot = SimpleNamespace(send_chat_action=_noop, send_message=_noop, get_custom_emoji_stickers=_none)
        self.bot_data = bot_data
        self.chat_data = {}
        self.args = []


async def _noop(*args, **kwargs):
    pass


async def _none(*args):
    return []


def window_row(name, cwd, port, host="198.51.100.5"):
    # A remote host, so slash commands go through post_inject and are recorded.
    return dict(id=name + str(port), host=host, port=port, auth_token="t", instance_name=name,
                workspace_name=name, cwd=cwd, pid=port + 1, parent_pid=port, started_at="100",
                heartbeat_at=time.time())


def topic_update(text, thread):
    message = {"message_id": 1, "date": 1, "text": text, "message_thread_id": thread, "is_topic_message": True,
               "chat": {"id": FORUM, "type": "supergroup", "is_forum": True},
               "from": {"id": USER, "is_bot": False, "first_name": "R"}}
    return Update.de_json({"update_id": 1, "message": message}, None)


def callback_update(data, thread):
    replies = []

    async def answer(*args, **kwargs):
        replies.append(args[0] if args else kwargs.get("text"))

    message = topic_update("", thread).effective_message
    query = SimpleNamespace(data=data, answer=answer, message=message, edit_message_text=_noop)
    return SimpleNamespace(callback_query=query, effective_user=message.from_user,
                           effective_message=message, effective_chat=message.chat), replies


def setup(tmp):
    Path(tmp).mkdir(parents=True, exist_ok=True)
    storage = Storage(Path(tmp) / "bot.db")
    storage.upsert_topic(MAC, FORUM, 11, "infra")      # Mac window: down
    storage.upsert_topic(WINDOWS, FORUM, 22, "infra")  # Windows window: live
    client = RecordingClient()
    context = Context({"config": {"telegram": {"forum_chat_id": FORUM}, "bot": {}}, "storage": storage,
                       "sessions": SessionStore(storage), "bridge_client": client})
    return storage, client, context


def recorder():
    replies = []

    async def record_reply(update, context, text, **kwargs):
        replies.append(text)

    return replies, record_reply


async def check_text(tmp):
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("infra", WINDOWS, 3105))
    replies, record_reply = recorder()
    with patch.object(messages, "reply", record_reply):
        # Text typed in the dead window's topic: refused, not delivered to the namesake.
        dead = topic_update("git reset --hard", 11)
        target = messages._resolve_topic_target(dead, context)
        assert common.find_instance(common.refresh_instances(context), target[0]) is None, target
        await messages._forward_message(dead, context, text="git reset --hard", topic_target=target)
        assert client.posts == [], client.posts
        assert len(replies) == 1 and "infra" in replies[0] and UNAVAILABLE_PREFIX not in replies[0], replies

        # The live window's own topic still routes to it.
        live = topic_update("status", 22)
        await messages._forward_message(live, context, text="status",
                                        topic_target=messages._resolve_topic_target(live, context))
        assert client.posts == [("r:infra3105", 3105, "status")], client.posts
    storage.close()


async def check_stale_cache(tmp):
    # The topic is resolved against a cached instance list while the Mac window is
    # still up; it then goes away and the Windows namesake registers before send.
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("infra", MAC, 3101))
    dead = topic_update("git reset --hard", 11)
    target = messages._resolve_topic_target(dead, context)
    assert target[0] == "r:infra3101"
    storage.delete_instance("infra3101")
    storage.upsert_instance(window_row("infra", WINDOWS, 3105))
    replies, record_reply = recorder()
    with patch.object(messages, "reply", record_reply):
        await messages._forward_message(dead, context, text="git reset --hard", topic_target=target)
    assert client.posts == [], client.posts
    assert len(replies) == 1 and "infra" in replies[0], replies
    storage.close()


async def check_commands(tmp):
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("infra", WINDOWS, 3105))
    captured, record_reply = recorder()
    dead = topic_update("/compact", 11)
    handlers = [(commands, commands.compact_command), (commands, commands.context_command),
                (commands, commands.clear_command),
                (commands, commands.who_command), (effort, effort.effort_command),
                (model_cmd, model_cmd.model_command), (exit_window, exit_window.exit_command),
                (exit_window, exit_window.restart_command)]
    with patch.object(inject, "inject_window_text", lambda pid, cmd: client.posts.append(("local", pid, cmd))):
        for module, handler in handlers:
            with patch.object(module, "reply", record_reply):
                await handler(dead, context)
        context.args = ["sonnet"]
        with patch.object(model_cmd, "reply", record_reply):
            await model_cmd.model_command(dead, context)
        for callback, data in [(effort.effort_callback, "effort:high"), (model_cmd.model_callback, "model:sonnet"),
                               (exit_window.exit_callback, "exit:go"), (exit_window.restart_callback, "restart:go")]:
            update, answers = callback_update(data, 11)
            await callback(update, context)
            captured.extend(answers)
    assert client.posts == [], client.posts
    assert captured, "handlers produced no user-visible answer"
    assert all(UNAVAILABLE_PREFIX not in str(text) for text in captured), captured
    storage.close()


async def check_shared_topic_clear(tmp):
    # /clear, /compact and the other per-window commands in a shared topic go
    # to the active window, as in a DM.
    from bot import topics
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("alpha", "/w/alpha", 3101))
    storage.upsert_instance(window_row("beta", "/w/beta", 3102))
    storage.upsert_topic("/w/alpha", FORUM, 50, "shared")
    storage.upsert_topic("/w/beta", FORUM, 50, "shared")
    common.refresh_instances(context)
    context.bot_data["sessions"].set_active_instance(USER, "r:beta3102")
    replies, record_reply = recorder()
    with patch.object(topics, "_TOPIC_MODE", "shared"), patch.object(commands, "reply", record_reply):
        await commands.clear_command(topic_update("/clear", 50), context)
        assert common.resolve_topic_target(topic_update("/compact", 50), context,
                                           common.refresh_instances(context), USER) == "r:beta3102"
    assert [p[0] for p in client.posts] == ["r:beta3102"], client.posts
    storage.close()


async def check_reserved_name(tmp):
    # A registration may not claim the reserved prefix and so become the target
    # of every dead topic with that title.
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row(UNAVAILABLE_PREFIX + "infra", "/elsewhere", 3107))
    assert common.refresh_instances(context) == []
    dead = topic_update("hello", 11)
    replies, record_reply = recorder()
    with patch.object(messages, "reply", record_reply):
        await messages._forward_message(dead, context, text="hello",
                                        topic_target=messages._resolve_topic_target(dead, context))
    assert client.posts == [], client.posts
    storage.close()


async def check_swap_during_send(tmp):
    # The registry changes while _forward_message awaits (typing cue): the Mac
    # window goes away and the Windows namesake registers. The send must go to
    # the process that was checked, never to the newcomer.
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("infra", MAC, 3101))

    async def swap(**kwargs):
        storage.delete_instance("infra3101")
        storage.upsert_instance(window_row("infra", WINDOWS, 3105))
        common.refresh_instances(context)

    context.bot.send_chat_action = swap
    dead = topic_update("git reset --hard", 11)
    replies, record_reply = recorder()
    with patch.object(messages, "reply", record_reply):
        await messages._forward_message(dead, context, text="git reset --hard",
                                        topic_target=messages._resolve_topic_target(dead, context))
    assert all(port != 3105 for _, port, _ in client.posts), client.posts
    storage.close()


async def check_pending_ask(tmp):
    # A question pending in the Windows window must not take text typed in the
    # Mac topic, even when the cached key still says "infra".
    storage, client, context = setup(tmp)
    storage.upsert_instance(window_row("infra", MAC, 3101))
    dead = topic_update("yes, delete it", 11)
    common.refresh_instances(context)            # cache: Mac window live
    storage.delete_instance("infra3101")
    storage.upsert_instance(window_row("infra", WINDOWS, 3105))
    context.bot_data["sessions"].set_pending_custom_ask(USER, "ask-1", "r:infra3105")
    replies, record_reply = recorder()
    with patch.object(messages, "reply", record_reply):
        await messages.text_message(dead, context)
    assert client.asks == [], client.asks
    assert all(port != 3105 for _, port, _ in client.posts), client.posts
    storage.close()


async def check_local_inject_targets_routed_window(tmp):
    # Two local windows share a name; routing picks the later-started one. The
    # slash command must reach that process, not the one with the fresher beat,
    # also when the older row has the SAME port (a port reused after a restart).
    import bridge.registry as registry
    for old_port in (3101, 3105):
        storage, client, context = setup(tmp + str(old_port))
        older = dict(window_row("infra", "/w/old/infra", old_port, host="127.0.0.1"),
                     id="old-row", pid=5001, started_at="100", parent_pid=7001)
        newer = dict(window_row("infra", WINDOWS, 3105, host="127.0.0.1"),
                     id="new-row", pid=5002, started_at="200", parent_pid=7002)
        storage.upsert_instance(older)
        storage.upsert_instance(newer)
        storage._conn.execute("UPDATE instances SET heartbeat_at=? WHERE id='new-row'", (time.time() - 5,))
        storage._conn.execute("UPDATE instances SET heartbeat_at=? WHERE id='old-row'", (time.time(),))
        tokens = {5001: "100", 5002: "200", 7001: "90", 7002: "190"}  # plugins and their TUIs
        injected = []
        with patch.object(registry, "_proc_start_token", lambda pid: tokens.get(pid, "")), \
             patch.object(inject, "inject_window_text", lambda pid, cmd: injected.append(pid)):
            ok, reason = await inject.deliver_slash_command(context, common.refresh_instances(context), "r:new-row", "/compact")
            assert ok, reason
            assert injected == [7002], (old_port, injected)
            # The TUI exited and a newer process got its pid: refuse.
            tokens[7002] = "250"
            injected.clear()
            ok, reason = await inject.deliver_slash_command(context, common.refresh_instances(context), "r:new-row", "/exit")
            assert not ok and injected == [], (ok, injected)
            tokens[7002] = "190"
            # The routed window's plugin pid now belongs to another process: refuse.
            tokens[5002] = "999"
            ok, reason = await inject.deliver_slash_command(context, common.refresh_instances(context), "r:new-row", "/exit")
            assert not ok and injected == [], (ok, injected)
            # The identity cannot be checked (lookup failed): refuse as well.
            tokens.pop(5002)
            with patch.object(registry, "_proc_start_token", lambda pid: None if pid == 5002 else tokens.get(pid, "")):
                ok, reason = await inject.deliver_slash_command(context, common.refresh_instances(context), "r:new-row", "/exit")
            assert not ok and injected == [], (ok, injected)
        storage.close()


def run(check):
    with tempfile.TemporaryDirectory() as tmp:
        # persist_active_instances writes the plugin's "Reply here" file: keep it in tmp.
        with patch.object(common, "ACTIVE_INSTANCES_PATH", Path(tmp) / "active-instances.json"):
            asyncio.run(check(tmp))


def test_dead_window_topic_never_reaches_namesake():
    run(check_text)


def test_stale_instance_cache_is_rechecked_before_send():
    run(check_stale_cache)


def test_commands_and_callbacks_in_dead_topic_reach_no_window():
    run(check_commands)


def test_clear_in_shared_topic_resets_the_active_window():
    run(check_shared_topic_clear)


def test_reserved_window_name_is_not_registered():
    run(check_reserved_name)


def test_registry_swap_during_send_cannot_redirect():
    run(check_swap_during_send)


def test_pending_ask_of_namesake_does_not_take_dead_topic_text():
    run(check_pending_ask)


def test_local_slash_command_reaches_the_routed_window():
    run(check_local_inject_targets_routed_window)


def main():
    for check in (check_text, check_stale_cache, check_commands, check_reserved_name, check_swap_during_send,
                  check_pending_ask, check_local_inject_targets_routed_window, check_shared_topic_clear):
        run(check)
    print("topic dead-window routing: ok")


if __name__ == "__main__":
    main()
