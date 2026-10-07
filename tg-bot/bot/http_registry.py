from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

from bot.storage import Storage
from bot.touched import forget, note_touched, snapshot
from bot.topics import resolve_workspace_id, window_prefix
from bridge.registry import RuntimeInstance, _row_is_stale, canonical_cwd, is_local_host

if TYPE_CHECKING:
    from bot.interwindow import InterWindowRouter


logger = logging.getLogger(__name__)

# Inbound registration server for ROAMING plugins (claude sessions on other
# machines that can't share the bot's SQLite file). Same-machine plugins still
# write bot.db directly; remote plugins POST here and the bot writes the row.
#
# stdlib http.server in a daemon thread — zero extra deps (matters for the
# bot-host deploy), and Storage is already thread-safe (its own Lock + sqlite
# check_same_thread=False), so calling it from the handler thread is safe.
#
# Endpoints (all require Authorization: Bearer <enroll_token>):
#   POST /register    {id, host, port, auth_token, instance_name, workspace_name, cwd, pid, parent_pid, started_at}
#   POST /heartbeat   {id}              -> 200 {ok:true} | 404 {ok:false,reason:"unknown"} (re-register)
#   POST /unregister  {id}              -> 200
#   POST /topic       {cwd}             -> 200 {ok:true, forum_chat_id, message_thread_id,
#                                                title, prefix} | 404 {ok:false,reason:"unbound"}
#                                       for LOCAL background jobs that post to Telegram
#                                       themselves and would otherwise land in General
# Bind to the MESH interface only (e.g. 198.51.100.<gw>), never 0.0.0.0 — the
# WireGuard tunnel is the transport boundary and nftables should still scope it.

_REQUIRED_REGISTER_FIELDS = ("id", "port")


def make_registry_server(
    storage: Storage, host: str, port: int, enroll_token: str, verify_source_ip: bool = True,
    router: "InterWindowRouter | None" = None,
    loop: asyncio.AbstractEventLoop | None = None,
) -> ThreadingHTTPServer:
    # verify_source_ip: when True (default, direct mesh), a remote peer must
    # advertise its OWN source IP and rows are namespaced by it (anti-spoof). Turn
    # OFF when the registry sits behind NAT — e.g. a Docker-published port or a
    # router that rewrites the source — so the seen source != the plugin's real
    # (advertised) mesh IP and the check would wrongly 403 every register. With it
    # off, the Bearer enroll token + the mesh-subnet allowlist (bridge/registry.py
    # _host_allowed) remain the gate, and ids stay as-is (already random per process).
    # Fail closed: a network-reachable (non-loopback) registry with no/weak token
    # would be a fully open /register on the mesh. Refuse to build it.
    if not is_local_host(host) and len(enroll_token) < 32:
        raise ValueError(
            "registry_enroll_token must be >= 32 bytes when registry_bind_host is non-loopback "
            "(an unauthenticated registry on the mesh is an open token-exfil / routing-hijack hole)"
        )
    expected_auth = f"Bearer {enroll_token}" if enroll_token else None

    class Handler(BaseHTTPRequestHandler):
        # Silence the default stderr access log; route through our logger instead.
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: N802
            logger.debug("registry http: " + fmt, *args)

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except Exception:
                pass

        def _authed(self) -> bool:
            if expected_auth is None:
                return True  # no token configured → open (mesh-only bind is the guard)
            import hmac
            got = self.headers.get("Authorization", "")
            return hmac.compare_digest(got, expected_auth)

        def _read_json(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None
            if length <= 0 or length > 1_000_000:
                return {} if length == 0 else None
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                return None

        # Namespace a client's instance id by its SOURCE IP so one mesh peer can
        # never INSERT OR REPLACE another peer's row (a row-hijack that would
        # redirect a victim window's chat + auth token). The namespace is derived
        # from client_address, not the body, so it's unforgeable. Loopback (same
        # machine) keeps the bare id for compatibility with the local path/tests.
        def _scoped_id(self, raw_id: str) -> str:
            ip = self.client_address[0]
            if is_local_host(ip) or not verify_source_ip:
                return raw_id
            return f"{ip}#{raw_id}"

        def _on_loop(self, coro: Any, loop: asyncio.AbstractEventLoop, timeout: float) -> dict:
            """Run an async router coroutine on the PTB event loop from this sync
            handler thread and wait for its result (bounded)."""
            fut = asyncio.run_coroutine_threadsafe(coro, loop)
            return fut.result(timeout=timeout)

        def do_POST(self) -> None:  # noqa: N802
            if not self._authed():
                self._send(401, {"ok": False, "reason": "unauthorized"})
                return
            body = self._read_json()
            if body is None or not isinstance(body, dict):
                self._send(400, {"ok": False, "reason": "bad json"})
                return
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            client_ip = self.client_address[0]
            try:
                if path == "/register":
                    if any(body.get(f) in (None, "") for f in _REQUIRED_REGISTER_FIELDS):
                        self._send(400, {"ok": False, "reason": "missing id/port"})
                        return
                    # Anti-impersonation: a remote peer may only advertise its OWN
                    # source IP as `host`. Otherwise it could point the bot at a
                    # third host (or loopback) and capture that window's chat +
                    # Bearer token. Loopback clients may advertise loopback.
                    host = str(body.get("host") or "")
                    if verify_source_ip and not is_local_host(client_ip) and host != client_ip:
                        logger.warning("registry: /register host %r != source %r — rejected "
                                       "(set bot.registry_verify_source_ip: false if behind NAT)", host, client_ip)
                        self._send(403, {"ok": False, "reason": "host must equal source IP"})
                        return
                    body = {**body, "id": self._scoped_id(str(body["id"]))}
                    storage.upsert_instance(body)
                    logger.info("registry: registered %s (%s) host=%s port=%s",
                                body.get("workspace_name"), body.get("id"), body.get("host"), body.get("port"))
                    self._send(200, {"ok": True})
                elif path == "/heartbeat":
                    iid = body.get("id")
                    if not iid:
                        self._send(400, {"ok": False, "reason": "missing id"})
                        return
                    # Scope ONCE and reuse. Rows are stored under the scoped id
                    # (see /register above), so everything that touches this
                    # window's identity — the heartbeat, its own touch records,
                    # and excluding it from other windows' — has to agree on
                    # which id that is.
                    sid = self._scoped_id(str(iid))
                    try:
                        ppid = int(body["parent_pid"]) if "parent_pid" in body else None
                    except (TypeError, ValueError):
                        ppid = None
                    ok = storage.heartbeat_instance(sid, ppid)
                    resp: dict = {"ok": ok}
                    if not ok:
                        resp["reason"] = "unknown"
                    if ok:
                        # Piggyback the model-switch button list. It is pure CONFIG
                        # (no plugin-local state), so it lives here alone: a model
                        # change then ships via CI in ~30s instead of needing every
                        # window's plugin relaunched. The plugin adopts whatever we
                        # send and keeps a built-in fallback until we answer once.
                        # Duplicating this list in the plugin is what silently killed
                        # the usage-limit button until 2026-09-03.
                        from bot.model_cmd import _MODELS
                        resp["model_buttons"] = [
                            {"alias": alias, "label": label} for alias, label in _MODELS
                        ]
                    if ok and isinstance(body.get("touched"), list):
                        # What this window is editing right now. Kept in memory
                        # only: it is a few minutes of liveness, worthless after a
                        # restart, and writing it to bot.db would put a row per
                        # edit on the hot path of every window at once.
                        note_touched(sid, body["touched"])
                    if ok:
                        # …and the answer comes straight back down, so the hook can
                        # ask its own co-located plugin instead of crossing the mesh
                        # on every edit. Same piggyback trick as topic_binding below.
                        #
                        # Only LIVE windows are reported. A window's claim must die
                        # with the window: a plugin orphaned by a dead agent keeps
                        # heartbeating, and without this filter it would hold a file
                        # for half an hour against a window that no longer exists.
                        # …and only windows on the SAME MACHINE are reported.
                        # A touch is a claim on a file, and a file is only the
                        # same file when the filesystem is. Two machines with a
                        # clone of one repo at the same absolute path — which is
                        # the normal case on a mesh of similar boxes — are not
                        # editing each other's work, and warning about it teaches
                        # people to ignore the warning that matters.
                        #
                        # `host` is the machine id we already have: a plugin
                        # advertises the address the bot must dial it on, so
                        # loopback means the bot's own box and a mesh IP names
                        # exactly one other. Nothing new has to be reported for
                        # this, and a single-machine deploy (everyone loopback)
                        # behaves exactly as before.
                        now_ = time.time()
                        live_names: dict[str, str] = {}
                        live_hosts: dict[str, str] = {}
                        my_host: str | None = None
                        own_row: dict | None = None
                        for row in storage.get_instances():
                            # Read our own host BEFORE the liveness filters: the
                            # requester is live by definition (its heartbeat is
                            # what we are answering), but a transiently stale row
                            # would otherwise leave my_host unset and silence the
                            # check entirely.
                            if str(row.get("id")) == sid:
                                my_host = str(row.get("host") or "")
                                own_row = row
                            # Two independent ways a row can fail to be a live
                            # window, and both matter. Staleness is the registry's
                            # own rule. parent_pid <= 1 means the AGENT died and
                            # launchd adopted its plugin, which goes on
                            # heartbeating for as long as it is left running —
                            # five such rows were live here on 2026-09-18.
                            # is_local decides whether a lapsed heartbeat may be
                            # second-guessed by probing the PID. That probe reads
                            # THIS machine's process table, so for a roaming
                            # plugin it compares a remote pid against local
                            # processes and can match an unrelated one — reviving
                            # a dead remote window as "live". Only loopback rows
                            # are PID-probable; for everything else the heartbeat
                            # is the only signal, which is the rule the reaper in
                            # bridge/registry.py already follows.
                            if _row_is_stale(row, now_, is_local_host(str(row.get("host") or ""))):
                                continue
                            try:
                                if int(row.get("parent_pid") or 0) <= 1:
                                    continue
                            except (TypeError, ValueError):
                                continue
                            # Already scoped — it was stored that way. Scoping
                            # it again produced "ip#ip#id", which matched nothing
                            # in the touch store, so `touched_by_others` came back
                            # empty every time on any deploy that keeps the
                            # default registry_verify_source_ip: true. Invisible
                            # on the bot host, which sets it false for Docker NAT.
                            live_names[str(row.get("id"))] = str(
                                row.get("workspace_name") or ""
                            )
                            live_hosts[str(row.get("id"))] = str(row.get("host") or "")
                        others = snapshot(exclude_instance=sid)
                        def _same_box(i: str) -> bool:
                            return bool(live_names.get(i)) and live_hosts.get(i) == my_host

                        resp["touched_by_others"] = {
                            path_: sorted({live_names[i] for i in ids if _same_box(i)})
                            for path_, ids in others.items()
                            if any(_same_box(i) for i in ids)
                        }
                    if ok and body.get("cwd"):
                        # Piggyback this window's forum-topic binding. A REMOTE plugin
                        # can't read the bot's container-local topic-bindings.json, so
                        # this is how it learns which topic to thread replies into —
                        # without it a new remote window's replies fall into General.
                        # Use the registered identity, just like topic creation:
                        # Codex and Claude can share a cwd but not a topic. Field
                        # present (object or null) tells the plugin the bot is
                        # topic-aware; omitted for older plugins that send no cwd.
                        topic = None
                        if own_row is not None:
                            name = str(own_row.get("workspace_name") or own_row.get("instance_name") or sid)
                            instance = RuntimeInstance(
                                key=name, display_name=name,
                                instance_name=str(own_row.get("instance_name") or name),
                                host=str(own_row.get("host") or ""),
                                port=int(own_row.get("port") or 0), auth_token="",
                                cwd=canonical_cwd(str(own_row.get("cwd") or "")),
                            )
                            topic = storage.get_topic(resolve_workspace_id(instance))
                        resp["topic_binding"] = (
                            {
                                "forum_chat_id": topic[0],
                                "message_thread_id": topic[1],
                                "title": topic[2],
                                # What this window puts in front of everything it
                                # says. Empty unless the topic is shared — see
                                # topics.window_prefix. Sent as a STRING, not as
                                # a mode flag, so the rule stays in the bot and a
                                # plugin that ignores the field posts unprefixed
                                # rather than posting something wrong.
                                "prefix": window_prefix(topic[2]),
                            }
                            if topic else None
                        )
                    self._send(200 if ok else 404, resp)
                elif path == "/my-tasks":
                    # A window asking what is on its plate. Scoped to the caller's
                    # own name: a window must not be able to enumerate, or later
                    # close, work addressed to someone else.
                    win = str(body.get("window") or "").strip()
                    if not win:
                        self._send(400, {"ok": False, "reason": "missing window"})
                        return
                    rows = storage.tasks_for_window(win)
                    self._send(200, {"ok": True, "tasks": [
                        {"id": r[0], "from": r[1], "kind": r[2], "text": r[3],
                         "state": r[4], "created_at": r[5]}
                        for r in rows
                    ]})
                elif path == "/task-state":
                    # A window reporting its own outcome. `blocked` is deliberately
                    # allowed and is NOT a failure: stopping to ask the owner is the
                    # correct answer to a doubtful relayed instruction.
                    try:
                        tid = int(body.get("id"))
                    except (TypeError, ValueError):
                        self._send(400, {"ok": False, "reason": "bad id"})
                        return
                    state = str(body.get("state") or "").strip().lower()
                    if state not in ("running", "done", "failed", "blocked"):
                        self._send(400, {"ok": False, "reason": "bad state"})
                        return
                    win = str(body.get("window") or "").strip()
                    owner = storage.task_owner(tid)
                    if owner is None:
                        self._send(404, {"ok": False, "reason": "no such task"})
                        return
                    # Only the window the task is addressed to may move it. Without
                    # this any window could close another's work.
                    if win and owner != win:
                        logger.warning("registry: %s tried to move task #%s owned by %s",
                                       win, tid, owner)
                        self._send(403, {"ok": False, "reason": "not your task"})
                        return
                    note = str(body.get("text") or "")[:4000] or None
                    storage.set_task_state(
                        tid, state,
                        result=note if state in ("done", "failed") else None,
                        blocker=note if state == "blocked" else None,
                    )
                    logger.info("registry: task #%s -> %s by %s", tid, state, owner)
                    self._send(200, {"ok": True})
                elif path == "/unregister":
                    iid = body.get("id")
                    if iid:
                        sid = self._scoped_id(str(iid))
                        storage.delete_instance(sid)
                        # Its file claims go with it. forget() said in its
                        # docstring that this is when it is called, and nothing
                        # called it — so a cleanly-exited window went on holding
                        # files until the TTL ran out.
                        forget(sid)
                    self._send(200, {"ok": True})
                elif path == "/route":
                    # A remote plugin can't write the shared bot.db, so it asks the
                    # bot to record its (chat_id, message_id) -> instance route here
                    # (mirrors routes-db.ts recordMessageRoute). Without this, a
                    # native reply / reaction to a remote window's message can't be
                    # routed back to it.
                    try:
                        chat_id = int(body["chat_id"]); message_id = int(body["message_id"])
                    except (KeyError, TypeError, ValueError):
                        self._send(400, {"ok": False, "reason": "missing chat_id/message_id"})
                        return
                    instance = str(body.get("instance") or "")
                    if not instance:
                        self._send(400, {"ok": False, "reason": "missing instance"})
                        return
                    storage.record_message_route(chat_id, message_id, instance)
                    self._send(200, {"ok": True})
                elif path == "/route-window":
                    # Window-to-window messaging: a plugin asks the bot to deliver a
                    # message/question from its window to another window (see
                    # bot/interwindow.py). Runs on the PTB loop (delivery reuses the
                    # async post_message + Telegram sends).
                    if router is None or loop is None:
                        self._send(503, {"ok": False, "reason": "inter-window router not available"})
                        return
                    from_key = str(body.get("from") or "")
                    to_name = str(body.get("to") or "")
                    text = str(body.get("text") or "")
                    kind = "ask" if str(body.get("kind") or "tell") == "ask" else "tell"
                    if not to_name or not text:
                        self._send(400, {"ok": False, "reason": "missing to/text"})
                        return
                    res = self._on_loop(router.route(from_key, to_name, text, kind), loop, timeout=25.0)
                    self._send(200 if res.get("ok") else 404, res)
                elif path == "/topic":
                    # "Which forum topic belongs to this working tree?"
                    #
                    # For the background jobs that post to Telegram THEMSELVES —
                    # a launchd timer, a CI hook, a watcher script. They have no
                    # plugin to piggyback on (a plugin only exists while a window
                    # is up, and these run precisely when it is not), so without
                    # this they send a bare chat_id and land in General. That is
                    # not hypothetical: a spreadsheet watcher had been posting
                    # into General daily at 10:17 and nobody could tell where the
                    # messages were coming from.
                    #
                    # Same Bearer as everything else, and every such script can
                    # already read it — it is the TG_BRIDGE_AUTH_TOKEN the
                    # plugins use. No new credential to distribute.
                    cwd_ = str(body.get("cwd") or "").strip()
                    # A trailing separator is the same folder, and a miss here is
                    # not an error the caller sees — it is a quiet 404, a fallback
                    # to a bare send, and the message back in General: the exact
                    # problem this endpoint exists to end. Root stays root.
                    cwd_ = cwd_.rstrip("/\\") or cwd_
                    if not cwd_:
                        self._send(400, {"ok": False, "reason": "missing cwd"})
                        return
                    topic = storage.get_topic(canonical_cwd(cwd_))
                    if topic is None:
                        # Not an error: the workspace may simply never have had a
                        # window, and the caller should fall back to a bare send
                        # rather than lose the message.
                        self._send(404, {"ok": False, "reason": "unbound"})
                        return
                    self._send(200, {
                        "ok": True,
                        "forum_chat_id": topic[0],
                        "message_thread_id": topic[1],
                        "title": topic[2],
                        # Same rule as the heartbeat: non-empty only when every
                        # window shares one topic, so a background job identifies
                        # itself the same way the windows do.
                        "prefix": window_prefix(topic[2]),
                    })
                elif path == "/windows":
                    if router is None or loop is None:
                        self._send(503, {"ok": False, "reason": "inter-window router not available"})
                        return
                    res = self._on_loop(
                        router.list_windows(str(body.get("from") or "")), loop, timeout=10.0
                    )
                    self._send(200, {"ok": True, "windows": res})
                else:
                    self._send(404, {"ok": False, "reason": "no such endpoint"})
            except Exception:
                logger.exception("registry http handler failed for %s", path)
                self._send(500, {"ok": False, "reason": "internal"})

        def do_GET(self) -> None:  # noqa: N802
            # Liveness probe (no auth). No service identifier — don't fingerprint.
            if self.path.split("?", 1)[0].rstrip("/") in ("", "/health"):
                self._send(200, {"ok": True})
            else:
                self._send(404, {"ok": False})

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def start_registry_server(
    storage: Storage, host: str, port: int, enroll_token: str, verify_source_ip: bool = True,
    router: "InterWindowRouter | None" = None,
    loop: asyncio.AbstractEventLoop | None = None,
) -> ThreadingHTTPServer:
    """Start the registry server in a daemon thread. Returns the server so the
    caller can shut it down in post_shutdown."""
    server = make_registry_server(
        storage, host, port, enroll_token, verify_source_ip, router=router, loop=loop
    )
    t = threading.Thread(target=server.serve_forever, name="tg-bridge-registry", daemon=True)
    t.start()
    logger.info("registry HTTP server listening on %s:%s (verify_source_ip=%s)", host, port, verify_source_ip)
    return server


if __name__ == "__main__":  # self-check: PYTHONPATH=tg-bot python3 tg-bot/bot/http_registry.py
    # End to end over real HTTP against a real server, not a mocked handler:
    # the thing that breaks on a wire protocol is the wire, and the last change
    # to this file that "obviously worked" took the bridge down for three minutes.
    import json as _json
    import threading
    import urllib.error
    import urllib.request

    TOKEN = "t" * 40
    BOUND = "/Users/me/Work/webapp"

    class _FakeStorage:
        codex_bound = True

        def get_instances(self):
            return [
                {"id": name, "workspace_name": name, "instance_name": name,
                 "cwd": BOUND, "host": "127.0.0.1", "port": 3100 + i,
                 "parent_pid": 123, "heartbeat_at": time.time()}
                for i, name in enumerate(("webapp", "webapp-codex"))
            ]

        def heartbeat_instance(self, instance_id, parent_pid=None):
            return any(row["id"] == instance_id for row in self.get_instances())

        def get_topic(self, workspace_id):
            if workspace_id == BOUND + "#codex" and self.codex_bound:
                return (-1001234567890, 43, "webapp-codex", 0, "", "")
            if workspace_id == BOUND:
                return (-1001234567890, 42, "webapp", 0, "📁", "🟢")
            return None

    fake_storage = _FakeStorage()
    srv = make_registry_server(fake_storage, "127.0.0.1", 0, TOKEN)  # port 0 = pick one
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(payload, token=TOKEN, path="/topic"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=_json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     **({"Authorization": f"Bearer {token}"} if token else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, _json.loads(r.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _json.loads(exc.read())

    status, data = call({"cwd": BOUND})
    assert status == 200 and data["ok"], (status, data)
    assert data["message_thread_id"] == 42 and data["forum_chat_id"] == -1001234567890, data
    assert data["title"] == "webapp" and data["prefix"] == "", data

    # A Windows drive letter must resolve the same either way, or one folder is
    # two workspaces and the caller silently gets "unbound".
    status, _ = call({"cwd": BOUND})
    assert status == 200

    # Unbound is 404 and NOT an error the caller should die on: it means "send it
    # without a thread", not "something broke".
    status, data = call({"cwd": BOUND + "/"})
    assert status == 200 and data["message_thread_id"] == 42, \
        f"a trailing slash is the same folder: {(status, data)}"

    status, data = call({"cwd": "/Users/me/Work/never-opened"})
    assert status == 404 and data["reason"] == "unbound", (status, data)

    status, data = call({"cwd": ""})
    assert status == 400, (status, data)
    status, data = call({})
    assert status == 400, (status, data)

    # The Bearer is the whole gate on a mesh-exposed port.
    status, _ = call({"cwd": BOUND}, token="wrong")
    assert status == 401, status
    status, _ = call({"cwd": BOUND}, token="")
    assert status == 401, status

    for name, expected in (("webapp", 42), ("webapp-codex", 43)):
        status, data = call({"id": name, "cwd": BOUND}, path="/heartbeat")
        assert status == 200 and data["topic_binding"]["message_thread_id"] == expected, data

    # An unbound Codex window must never inherit Claude's topic.
    fake_storage.codex_bound = False
    status, data = call({"id": "webapp-codex", "cwd": BOUND}, path="/heartbeat")
    assert status == 200 and data["topic_binding"] is None, data
    status, data = call({"id": "missing", "cwd": BOUND}, path="/heartbeat")
    assert status == 404 and "topic_binding" not in data, data

    srv.shutdown()
    print("http_registry self-check OK")
