"""Window identity: windows are addressed by identity (incarnation row id,
launcher window uid, host+cwd+agent scope), never by name.
PYTHONPATH=tg-bot python3 -B tg-bot/test_window_identity.py.

Real SQLite storage and registry; fake Telegram and bridge transport."""
import asyncio
import sqlite3
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from telegram import Update

from bot import callbacks, common, exit_window, messages
from bot.session import SessionStore
from bot.storage import Storage
from bridge.client import ChannelPluginClient
from bridge.registry import route_identity

FORUM = -1001
USER = 42


class RecordingClient(ChannelPluginClient):
    def __init__(self):
        super().__init__([])
        self.posts = []

    async def post_message(self, instance_name, body, *, pinned=None):
        instance = pinned or self._get_instance(instance_name)
        self.posts.append((instance_name, instance.port, body.get("text", "")))

    async def post_inject(self, instance_name, cmd, *, pinned=None):
        instance = pinned or self._get_instance(instance_name)
        self.posts.append((instance_name, instance.port, cmd))
        return True, ""


async def _noop(*args, **kwargs):
    return SimpleNamespace(chat_id=FORUM, message_id=900)


def make_context(tmp):
    Path(tmp).mkdir(parents=True, exist_ok=True)
    storage = Storage(Path(tmp) / "bot.db")
    client = RecordingClient()
    bot_data = {"config": {"telegram": {"forum_chat_id": FORUM}, "bot": {}}, "storage": storage,
                "sessions": SessionStore(storage), "bridge_client": client}
    context = SimpleNamespace(application=SimpleNamespace(bot_data=bot_data), bot_data=bot_data, chat_data={},
                              args=[], bot=SimpleNamespace(send_chat_action=_noop, send_message=_noop,
                                                           get_custom_emoji_stickers=_noop))
    return storage, client, context


def row(row_id, name, cwd, port, host="198.51.100.5", uid=None, agent="claude", started="100"):
    return dict(id=row_id, host=host, port=port, auth_token="t", instance_name=name, workspace_name=name,
                cwd=cwd, pid=port + 1, parent_pid=port, started_at=started, heartbeat_at=time.time(),
                window_uid=uid, agent=agent)


def update(text="hi", thread=None, chat_id=FORUM, reply_to=None, message_id=1):
    msg = {"message_id": message_id, "date": 1, "text": text,
           "chat": {"id": chat_id, "type": "supergroup" if chat_id < 0 else "private", "is_forum": chat_id < 0},
           "from": {"id": USER, "is_bot": False, "first_name": "R"}}
    if thread is not None:
        msg["message_thread_id"] = thread
        msg["is_topic_message"] = True
    if reply_to is not None:
        msg["reply_to_message"] = {"message_id": reply_to, "date": 1, "text": "old",
                                   "chat": {"id": chat_id, "type": "supergroup" if chat_id < 0 else "private"}}
    return Update.de_json({"update_id": message_id, "message": msg}, None)


def recorder():
    replies = []

    async def record(update, context, text, **kwargs):
        replies.append(text)
        return SimpleNamespace(chat_id=FORUM, message_id=900 + len(replies))
    return replies, record


def run(check):
    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(common, "ACTIVE_INSTANCES_PATH", Path(tmp) / "active-instances.json"):
            asyncio.run(check(tmp))


# --- registry -----------------------------------------------------------------

async def check_same_name_windows_are_separate(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "/Users/r/infra", 3101, host="198.51.100.5", uid="U1"))
    storage.upsert_instance(row("b", "infra", "C:\\Work\\infra", 3102, host="198.51.100.6", uid="U2"))
    instances = common.refresh_instances(context)
    assert sorted(i.key.split("@")[0] for i in instances) == ["w:U1", "w:U2"], instances
    labels = {i.display_name for i in instances}
    assert len(labels) == 2 and all("infra" in label for label in labels), labels
    # A name alone does not choose between them.
    assert len(common.instances_named(instances, "infra")) == 2
    storage.close()


async def check_duplicate_uid_is_not_a_window(tmp):
    # Two windows started from one shell inherited the same uid (or a spoof):
    # neither gets the window key; each stays addressable per row, flagged.
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "/w/infra", 3101, uid="SAME"))
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, uid="SAME"))
    instances = common.refresh_instances(context)
    assert sorted(i.key for i in instances) == ["r:a", "r:b"], instances
    assert all(i.uid_conflict and "⚠️" in i.display_name for i in instances)
    storage.close()


async def check_migration_is_idempotent(tmp):
    # A database from before the identity columns: migrate, migrate again, and
    # keep the old rows (their new columns NULL = unknown).
    Path(tmp).mkdir(parents=True, exist_ok=True)
    db = Path(tmp) / "bot.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE message_routes (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
            instance TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (chat_id, message_id));
        CREATE TABLE instances (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL,
            auth_token TEXT NOT NULL, instance_name TEXT NOT NULL, workspace_name TEXT NOT NULL,
            cwd TEXT NOT NULL, pid INTEGER NOT NULL, parent_pid INTEGER, started_at TEXT, heartbeat_at REAL NOT NULL);
        INSERT INTO message_routes VALUES (-1001, 5, 'infra', 1.0);
    """)
    conn.commit()
    conn.close()
    for _ in range(2):
        storage = Storage(db)
        assert storage.lookup_route(-1001, 5) == {"instance": "infra", "row_id": None, "window_uid": None,
                                                  "scope_host": None, "scope_cwd": None, "scope_agent": None}
        storage.close()


# --- topics ---------------------------------------------------------------------

async def check_two_windows_one_folder_refuse_topic(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "/w/infra", 3101, uid="U1"))
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, uid="U2"))
    storage.upsert_topic("/w/infra", FORUM, 11, "infra")
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        u = update("rm -rf build", thread=11)
        await messages._forward_message(u, context, text="rm -rf build",
                                        topic_target=messages._resolve_topic_target(u, context))
    assert client.posts == [], client.posts
    assert len(replies) == 1 and "infra" in replies[0], replies
    storage.close()


async def check_same_path_on_two_hosts_refuses_topic(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "/srv/infra", 3101, host="198.51.100.5"))
    storage.upsert_instance(row("b", "infra", "/srv/infra", 3102, host="198.51.100.6"))
    storage.upsert_topic("/srv/infra", FORUM, 11, "infra")
    instances = common.refresh_instances(context)
    target = common.resolve_topic_target(update("/compact", thread=11), context, instances, USER)
    assert common.find_instance(instances, target) is None and common.is_ambiguous(target), target
    storage.close()


async def check_window_without_cwd_is_not_topic_bound(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "", 3101))
    storage.upsert_topic("r:a", FORUM, 11, "infra")   # a binding keyed by an incarnation
    _cands, live = common.topic_windows(storage, FORUM, 11, common.refresh_instances(context))
    assert live == [], live
    storage.close()


# --- replies and reactions --------------------------------------------------------

def record_route(storage, chat_id, message_id, r):
    storage.record_message_route(chat_id, message_id, r["workspace_name"], route_identity(r))


async def check_reply_follows_only_the_same_window(tmp):
    storage, client, context = make_context(tmp)
    old = row("old", "infra", "/w/infra", 3101, uid="U1")
    storage.upsert_instance(old)
    record_route(storage, USER, 50, old)
    # The incarnation is still live: the reply goes to it.
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages._forward_message(update("yes", chat_id=USER, reply_to=50, message_id=2), context, text="yes")
    assert client.posts[-1][1] == 3101, client.posts

    # The window reconnected (same uid, same host, folder and agent): follow it.
    storage.delete_instance("old")
    storage.upsert_instance(row("new", "infra", "/w/infra", 3105, uid="U1"))
    with patch.object(messages, "reply", record):
        await messages._forward_message(update("yes", chat_id=USER, reply_to=50, message_id=3), context, text="yes")
    assert client.posts[-1][1] == 3105, client.posts

    # The same uid from another host (a spoof or a copied env): not that window.
    storage.delete_instance("new")
    storage.upsert_instance(row("spoof", "infra", "/w/infra", 3107, host="198.51.100.9", uid="U1"))
    before = len(client.posts)
    with patch.object(messages, "reply", record):
        await messages._forward_message(update("yes", chat_id=USER, reply_to=50, message_id=4), context, text="yes")
    assert len(client.posts) == before, client.posts
    assert any("закрыто" in r or "closed" in r for r in replies), replies

    # Two live rows claim the uid: refuse, do not pick the newer.
    storage.delete_instance("spoof")
    storage.upsert_instance(row("x", "infra", "/w/infra", 3108, uid="U1", started="300"))
    storage.upsert_instance(row("y", "infra", "/w/infra", 3109, uid="U1", started="400"))
    with patch.object(messages, "reply", record):
        await messages._forward_message(update("yes", chat_id=USER, reply_to=50, message_id=5), context, text="yes")
    assert len(client.posts) == before, client.posts
    storage.close()


async def check_legacy_route_by_name_is_refused(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("w", "infra", "C:\\Work\\infra", 3105, uid="U9"))
    storage.record_message_route(USER, 60, "infra")      # written by older code: name only
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages._forward_message(update("go", chat_id=USER, reply_to=60, message_id=6), context, text="go")
    assert client.posts == [], client.posts
    storage.close()


async def check_message_ids_repeat_across_chats(tmp):
    storage, client, context = make_context(tmp)
    a = row("a", "alpha", "/w/alpha", 3101, uid="UA")
    b = row("b", "beta", "/w/beta", 3102, uid="UB")
    storage.upsert_instance(a)
    storage.upsert_instance(b)
    record_route(storage, USER, 7, a)
    record_route(storage, FORUM, 7, b)
    instances = common.refresh_instances(context)
    assert common.route_target(storage.lookup_route(USER, 7), instances).row_id == "a"
    assert common.route_target(storage.lookup_route(FORUM, 7), instances).row_id == "b"
    storage.close()


async def check_rename_does_not_move_routes(tmp):
    storage, client, context = make_context(tmp)
    r = row("a", "infra", "/w/infra", 3101, uid="UA")
    storage.upsert_instance(r)
    record_route(storage, USER, 8, r)
    storage.upsert_instance({**r, "workspace_name": "renamed", "instance_name": "renamed"})
    storage.upsert_instance(row("other", "infra", "/w/other", 3102, uid="UB"))   # takes the old name
    target = common.route_target(storage.lookup_route(USER, 8), common.refresh_instances(context))
    assert target is not None and target.row_id == "a", target
    storage.close()


# --- callbacks ---------------------------------------------------------------------

async def check_decision_owner_is_the_exact_incarnation(tmp):
    storage, client, context = make_context(tmp)
    old = row("old", "infra", "/w/infra", 3101, uid="U1")
    storage.upsert_instance(old)
    record_route(storage, FORUM, 70, old)
    card = SimpleNamespace(callback_query=SimpleNamespace(message=SimpleNamespace(
        chat_id=FORUM, message_id=70, message_thread_id=None)))
    assert callbacks._owning_instance_for_message(card, context, common.refresh_instances(context)).startswith("w:U1@")
    # Reconnected window, same uid: a pending decision of the OLD process is not its.
    storage.delete_instance("old")
    storage.upsert_instance(row("new", "infra", "/w/infra", 3105, uid="U1"))
    assert callbacks._owning_instance_for_message(card, context, common.refresh_instances(context)) is None
    storage.close()


async def check_confirmation_is_bound_and_consumed(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/alpha", 3101, uid="UA"))
    storage.upsert_instance(row("b", "beta", "/w/beta", 3102, uid="UB"))
    keys = {i.row_id: i.key for i in common.refresh_instances(context)}
    context.bot_data["sessions"].set_active_instance(USER, keys["a"])
    replies, record = recorder()
    with patch.object(exit_window, "reply", record):
        await exit_window.exit_command(update("/exit", chat_id=USER), context)
    shown = SimpleNamespace(chat_id=FORUM, message_id=901)     # the message the buttons sit on
    # The active window changes before the tap: the confirmation still means alpha.
    context.bot_data["sessions"].set_active_instance(USER, keys["b"])
    answers = []

    async def answer(*args, **kwargs):
        answers.append(args[0] if args else kwargs.get("text"))

    tap = SimpleNamespace(callback_query=SimpleNamespace(data="exit:go", message=shown, answer=answer,
                                                         edit_message_text=_noop),
                          effective_user=SimpleNamespace(id=USER), effective_message=shown)
    await exit_window.exit_callback(tap, context)
    assert [p[1] for p in client.posts] == [3101], client.posts
    # A second tap on the same button does nothing.
    await exit_window.exit_callback(tap, context)
    assert [p[1] for p in client.posts] == [3101], client.posts
    # The same message id in another chat is another button.
    other = SimpleNamespace(chat_id=USER, message_id=901)
    tap.callback_query.message = other
    await exit_window.exit_callback(tap, context)
    assert [p[1] for p in client.posts] == [3101], client.posts
    storage.close()


async def check_stored_key_is_not_captured_cross_host(tmp):
    # The active window is stored by key. Window A closes; the same uid shows
    # up on another host. The stored key must not resolve to it.
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "infra", "/w/infra", 3101, host="198.51.100.5", uid="U1"))
    storage.upsert_instance(row("c", "other", "/w/other", 3103, uid="UC"))
    key_a = next(i.key for i in common.refresh_instances(context) if i.row_id == "a")
    storage.delete_instance("a")
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, host="198.51.100.6", uid="U1"))
    assert common.find_instance(common.refresh_instances(context), key_a) is None
    storage.close()


async def check_labels_are_unique(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("firstabcd", "infra", "/w/infra", 3101))
    storage.upsert_instance(row("secondabcd", "infra", "/w/infra", 3102))
    labels = [i.display_name for i in common.refresh_instances(context)]
    assert len(set(labels)) == 2, labels
    storage.close()


async def check_reply_to_bot_message_without_route_is_refused(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/alpha", 3101, uid="UA"))
    context.bot_data["sessions"].set_active_instance(USER, common.refresh_instances(context)[0].key)
    u = update("go", chat_id=USER, reply_to=99, message_id=9)
    u.effective_message.reply_to_message._unfreeze()
    u.effective_message.reply_to_message.from_user = SimpleNamespace(is_bot=True, id=1)
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages._forward_message(u, context, text="go")
    assert client.posts == [], client.posts
    storage.close()


async def check_route_cannot_be_reassigned(tmp):
    # A peer may not claim another window's message (http_registry /route).
    storage, client, context = make_context(tmp)
    a = row("a", "alpha", "/w/alpha", 3101, uid="UA")
    storage.upsert_instance(a)
    record_route(storage, USER, 5, a)
    from bot import http_registry
    srv = http_registry.make_registry_server(storage, "127.0.0.1", 0, "enroll", verify_source_ip=False)
    import threading, json, urllib.request
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        storage.upsert_instance(row("evil", "evil", "/w/evil", 3109))
        req = urllib.request.Request(f"http://127.0.0.1:{srv.server_address[1]}/route",
                                     data=json.dumps({"chat_id": USER, "message_id": 5, "instance": "evil",
                                                      "row_id": "evil"}).encode(),
                                     headers={"Authorization": "Bearer enroll", "Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=5)
            raise AssertionError("route was reassigned")
        except urllib.error.HTTPError as e:
            assert e.code == 409, e.code
        assert storage.lookup_route(USER, 5)["row_id"] == "a"
    finally:
        srv.shutdown()
    storage.close()


async def check_custom_ask_answer_never_reaches_another_window(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/alpha", 3101, uid="UA"))
    storage.upsert_instance(row("b", "beta", "/w/beta", 3102, uid="UB"))
    keys = {i.row_id: i.key for i in common.refresh_instances(context)}
    context.bot_data["sessions"].set_pending_custom_ask(USER, "ask-1", "row:a")
    context.bot_data["sessions"].set_active_instance(USER, keys["b"])
    storage.delete_instance("a")                      # the asking window closed
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        handled = await messages._maybe_deliver_custom_ask(update("delete it", chat_id=USER), context, "delete it")
    assert handled and client.posts == [], (handled, client.posts)
    storage.close()


async def check_permission_modes_are_per_workspace_name(tmp):
    from bot import permissions
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/alpha", 3101, uid="UA"))
    assert [n for n, _ in permissions.list_workspaces_with_modes(context)] == ["alpha"]
    storage.close()


async def check_custom_ask_in_topic_with_owner_gone_is_not_forwarded(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, uid="UB"))   # new window, same folder
    storage.upsert_topic("/w/infra", FORUM, 11, "infra")
    context.bot_data["sessions"].set_pending_custom_ask(USER, "ask-1", "row:a")   # A asked, A is gone
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages.text_message(update("delete it", thread=11), context)
    assert client.posts == [], client.posts
    storage.close()


async def check_dead_ask_does_not_swallow_another_topics_message(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/a", 3101, uid="UA"))
    storage.upsert_instance(row("b", "beta", "/w/b", 3102, uid="UB"))
    storage.upsert_topic("/w/a", FORUM, 10, "alpha")
    storage.upsert_topic("/w/b", FORUM, 12, "beta")
    context.bot_data["sessions"].set_pending_custom_ask(USER, "ask-1", "row:a", place=(FORUM, 10), card_id=500)
    storage.delete_instance("a")                       # A, the asking window, closes
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages.text_message(update("deploy the docs", thread=12), context)
    assert [p[1] for p in client.posts] == [3102], client.posts          # B got its own task
    assert context.bot_data["sessions"].peek_pending_custom_ask(USER) is not None   # marker untouched
    storage.close()


async def check_dead_ask_answer_in_its_topic_never_reaches_a_new_window(tmp):
    # A asked in topic 11 and closed; B (another uid) now lives in the same
    # folder and topic. The answer typed there is refused, not given to B.
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, uid="UB"))
    storage.upsert_topic("/w/infra", FORUM, 11, "infra")
    context.bot_data["sessions"].set_pending_custom_ask(USER, "ask-1", "row:a", place=(FORUM, 11), card_id=500)
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        await messages.text_message(update("delete it", thread=11), context)
    assert client.posts == [], client.posts
    assert context.bot_data["sessions"].peek_pending_custom_ask(USER) is None
    storage.close()


async def check_ask_answer_is_matched_by_card_place(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("b", "beta", "/w/b", 3102, uid="UB"))
    storage.upsert_topic("/w/b", FORUM, 12, "beta")
    sessions = context.bot_data["sessions"]
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        # Card in General (thread 0); A gone; a task typed in B's topic is B's.
        sessions.set_pending_custom_ask(USER, "ask-1", "row:a", place=(FORUM, 0), card_id=500)
        await messages.text_message(update("deploy the docs", thread=12), context)
        assert [p[1] for p in client.posts] == [3102], client.posts
        assert sessions.peek_pending_custom_ask(USER) is not None
        # Card in topic 10; A gone; a message in General is not its answer.
        sessions.set_pending_custom_ask(USER, "ask-2", "row:a", place=(FORUM, 10), card_id=501)
        handled = await messages._maybe_deliver_custom_ask(update("status?"), context, "status?")
        assert handled is False and sessions.peek_pending_custom_ask(USER) is not None
        # Typed in the card's place but as a reply to another message: not the answer.
        handled = await messages._maybe_deliver_custom_ask(
            update("this one", thread=10, reply_to=777), context, "this one", topic_key=None)
        assert handled is False and sessions.peek_pending_custom_ask(USER) is not None
        # A reply to a message of another chat (external_reply): not the answer either.
        sessions.set_pending_custom_ask(USER, "ask-3", "row:a", place=(USER, 0), card_id=502)
        dm = update("that one", chat_id=USER)
        dm = Update.de_json({"update_id": 2, "message": {**dm.message.to_dict(), "external_reply": {
            "origin": {"type": "hidden_user", "sender_user_name": "x", "date": 1}}}}, None)
        handled = await messages._maybe_deliver_custom_ask(dm, context, "that one")
        assert handled is False and sessions.peek_pending_custom_ask(USER) is not None
    storage.close()


async def check_live_owner_does_not_take_a_message_from_elsewhere(tmp):
    # A is alive and waiting in its topic 10; a DM to the bot is not A's answer.
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("a", "alpha", "/w/a", 3101, uid="UA"))
    storage.upsert_topic("/w/a", FORUM, 10, "alpha")
    sessions = context.bot_data["sessions"]
    sessions.set_pending_custom_ask(USER, "ask-1", "row:a", place=(FORUM, 10), card_id=500)
    asked = []

    async def ask_action(*a, **k):
        asked.append(a)
        return True
    client.post_ask_action = ask_action
    handled = await messages._maybe_deliver_custom_ask(update("hi", chat_id=USER), context, "hi")
    assert handled is False and asked == [] and sessions.peek_pending_custom_ask(USER) is not None
    replies, record = recorder()
    with patch.object(messages, "reply", record):
        # Telegram adds an implicit reply to the topic root (id = thread id).
        handled = await messages._maybe_deliver_custom_ask(update("yes", thread=10, reply_to=10), context, "yes",
                                                           topic_key=None)
    assert handled is True and len(asked) == 1 and sessions.peek_pending_custom_ask(USER) is None
    # Shared topic: A asked, the person writes `@B …` there; the message is B's.
    storage.upsert_instance(row("b", "beta", "/w/b", 3102, uid="UB"))
    b_key = next(i.key for i in common.refresh_instances(context) if i.row_id == "b")
    sessions.set_pending_custom_ask(USER, "ask-2", "row:a", place=(FORUM, 10), card_id=501)
    handled = await messages._maybe_deliver_custom_ask(update("@beta deploy", thread=10), context, "@beta deploy",
                                                       topic_key=b_key)
    assert handled is False and len(asked) == 1 and sessions.peek_pending_custom_ask(USER) is not None
    # An ambiguous topic (two windows in one folder) does not reject the answer,
    # nor does a target key when the person replies to the card itself.
    with patch.object(messages, "reply", record):
        handled = await messages._maybe_deliver_custom_ask(update("yes", thread=10), context, "yes",
                                                           topic_key=common.AMBIGUOUS_PREFIX + "2")
        assert handled is True and len(asked) == 2
        sessions.set_pending_custom_ask(USER, "ask-3", "row:a", place=(FORUM, 10), card_id=502)
        handled = await messages._maybe_deliver_custom_ask(update("no", thread=10, reply_to=502), context, "no",
                                                           topic_key=b_key)
        assert handled is True and len(asked) == 3
    storage.close()


async def check_old_writers_cannot_move_a_route(tmp):
    # Plugins older than this code write bot.db with INSERT OR REPLACE, with or
    # without identity columns. The trigger in the file keeps the claimed owner.
    storage, client, context = make_context(tmp)
    a = row("a", "alpha", "/w/a", 3101, uid="UA")
    storage.upsert_instance(a)
    assert storage.record_message_route_once(USER, 79, "alpha", route_identity(a))
    old = sqlite3.connect(str(Path(tmp) / "bot.db"), isolation_level=None)
    old.execute("INSERT OR REPLACE INTO message_routes(chat_id, message_id, instance, created_at, row_id) "
                "VALUES (?,?,?,?,?)", (USER, 79, "beta", time.time(), "b"))
    old.execute("INSERT OR REPLACE INTO message_routes(chat_id, message_id, instance, created_at) VALUES (?,?,?,?)",
                (USER, 79, "beta", time.time()))
    old.close()
    route = storage.lookup_route(USER, 79)
    assert (route["row_id"], route["instance"]) == ("a", "alpha"), route
    # A route without an owner row (older code) is still writable.
    storage.record_message_route(USER, 80, "legacy")
    storage.record_message_route(USER, 80, "legacy2")
    assert storage.lookup_route(USER, 80)["instance"] == "legacy2"
    storage.close()


async def check_route_claim_is_atomic_against_another_connection(tmp):
    # A local plugin writes the same bot.db through its own connection. Its
    # write lands while the bot's claim waits; the claim must then be refused,
    # not overwrite the plugin's row.
    storage, client, context = make_context(tmp)
    a, b = row("a", "alpha", "/w/a", 3101, uid="UA"), row("b", "beta", "/w/b", 3102, uid="UB")
    storage.upsert_instance(a); storage.upsert_instance(b)
    other = sqlite3.connect(str(Path(tmp) / "bot.db"), isolation_level=None)
    other.execute("BEGIN IMMEDIATE")
    other.execute("INSERT INTO message_routes(chat_id, message_id, instance, created_at, row_id) VALUES (?,?,?,?,?)",
                  (USER, 78, "beta", time.time(), "b"))
    import threading
    result = []
    th = threading.Thread(target=lambda: result.append(
        storage.record_message_route_once(USER, 78, "alpha", route_identity(a))))
    th.start()
    time.sleep(0.2)
    assert th.is_alive(), "the claim must wait for the other writer"
    other.execute("COMMIT")
    th.join(5)
    assert result == [False], result
    assert storage.lookup_route(USER, 78)["row_id"] == "b"
    other.close()
    storage.close()


async def check_route_claims_are_atomic(tmp):
    storage, client, context = make_context(tmp)
    a, b = row("a", "alpha", "/w/a", 3101, uid="UA"), row("b", "beta", "/w/b", 3102, uid="UB")
    storage.upsert_instance(a); storage.upsert_instance(b)
    import threading
    results = []
    barrier = threading.Barrier(2)

    def claim(r):
        barrier.wait()
        results.append(storage.record_message_route_once(USER, 77, r["workspace_name"], route_identity(r)))
    threads = [threading.Thread(target=claim, args=(r,)) for r in (a, b)]
    for th in threads: th.start()
    for th in threads: th.join()
    assert sorted(results) == [False, True], results
    storage.close()


async def check_card_without_route_has_no_owner(tmp):
    storage, client, context = make_context(tmp)
    storage.upsert_instance(row("b", "infra", "/w/infra", 3102, uid="UB"))
    storage.upsert_topic("/w/infra", FORUM, 11, "infra")
    card = SimpleNamespace(callback_query=SimpleNamespace(message=SimpleNamespace(
        chat_id=FORUM, message_id=71, message_thread_id=11)))
    assert callbacks._owning_instance_for_message(card, context, common.refresh_instances(context)) is None
    storage.close()


async def check_restart_all_button_is_bound_and_single_use(tmp):
    storage, client, context = make_context(tmp)
    started = []

    async def fake_run(ctx, chat_id, message_id, only_stale=False, confirmed_rows=None):
        started.append(confirmed_rows)
    context.application.create_task = lambda coro: asyncio.get_event_loop().create_task(coro)
    shown = SimpleNamespace(chat_id=FORUM, message_id=950)
    context.bot_data.setdefault("confirmations", {})[(FORUM, 950)] = ("restart_all", ("a",), time.time(), "")

    async def answer(*a, **k):
        pass
    tap = SimpleNamespace(callback_query=SimpleNamespace(data="restart:all", message=shown, answer=answer,
                                                         edit_message_text=_noop))
    with patch.object(exit_window, "_restart_all_run", fake_run):
        await exit_window.restart_callback(tap, context)
        await exit_window.restart_callback(tap, context)        # second tap: nothing
        await asyncio.sleep(0)
    assert started == [{"a"}], started
    storage.close()


CHECKS = [check_custom_ask_in_topic_with_owner_gone_is_not_forwarded, check_route_claims_are_atomic,
          check_dead_ask_does_not_swallow_another_topics_message, check_route_claim_is_atomic_against_another_connection,
          check_dead_ask_answer_in_its_topic_never_reaches_a_new_window, check_ask_answer_is_matched_by_card_place,
          check_live_owner_does_not_take_a_message_from_elsewhere, check_old_writers_cannot_move_a_route,
          check_card_without_route_has_no_owner, check_restart_all_button_is_bound_and_single_use,
          check_custom_ask_answer_never_reaches_another_window, check_permission_modes_are_per_workspace_name,
          check_labels_are_unique, check_reply_to_bot_message_without_route_is_refused,
          check_route_cannot_be_reassigned, check_stored_key_is_not_captured_cross_host, check_same_name_windows_are_separate, check_duplicate_uid_is_not_a_window, check_migration_is_idempotent,
          check_two_windows_one_folder_refuse_topic, check_same_path_on_two_hosts_refuses_topic,
          check_window_without_cwd_is_not_topic_bound, check_reply_follows_only_the_same_window,
          check_legacy_route_by_name_is_refused, check_message_ids_repeat_across_chats,
          check_rename_does_not_move_routes, check_decision_owner_is_the_exact_incarnation,
          check_confirmation_is_bound_and_consumed]


def test_window_identity():
    for check in CHECKS:
        run(check)


if __name__ == "__main__":
    for check in CHECKS:
        run(check)
        print("ok", check.__name__)
