from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from threading import Lock


logger = logging.getLogger(__name__)


DEFAULT_DB_PATH = Path.home() / ".tg-copilot-bridge" / "bot.db"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    user_id          INTEGER PRIMARY KEY,
    active_instance  TEXT NOT NULL,
    last_activity    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS message_routes (
    chat_id     INTEGER NOT NULL,
    message_id  INTEGER NOT NULL,
    instance    TEXT NOT NULL,
    created_at  REAL NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_routes_created ON message_routes(created_at);

-- One forum topic per logical workspace. workspace_id is a host-stable key
-- (currently the plugin-reported cwd; see bot/topics.py). PRIMARY KEY enforces
-- "one window ↔ one topic" at the DB level so restarts never spawn duplicates.
CREATE TABLE IF NOT EXISTS window_topics (
    workspace_id        TEXT PRIMARY KEY,
    forum_chat_id       INTEGER NOT NULL,
    message_thread_id   INTEGER NOT NULL,
    title               TEXT NOT NULL,
    created_at          REAL NOT NULL,
    closed              INTEGER NOT NULL DEFAULT 0,
    icon_emoji          TEXT,
    status              TEXT
);

-- Live windows. Written by each channel plugin (bun) under WAL, read + reaped by
-- the bot. Replaces ~/.tg-copilot-bridge/instances/*.json. `id` is per plugin
-- process (random); `heartbeat_at` (epoch seconds) is refreshed periodically so
-- the bot can tell a live window from a crashed one. Schema mirrors
-- channel-plugin/src/routes-db.ts.
CREATE TABLE IF NOT EXISTS instances (
    id             TEXT PRIMARY KEY,
    host           TEXT NOT NULL,
    port           INTEGER NOT NULL,
    auth_token     TEXT NOT NULL,
    instance_name  TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    pid            INTEGER NOT NULL,
    parent_pid     INTEGER,
    started_at     TEXT,
    heartbeat_at   REAL NOT NULL
);

-- Cross-window work, with state. Inter-window messages used to be
-- fire-and-forget: dispatched, then tracked by hand in prose. `blocked` is a
-- first-class outcome, not a failure — a window refusing a relayed instruction
-- until the owner confirms is the correct answer, and it needs somewhere to live.
CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_window  TEXT NOT NULL,
    to_window    TEXT NOT NULL,
    kind         TEXT NOT NULL,   -- ask | tell
    text         TEXT NOT NULL,
    state        TEXT NOT NULL,   -- sent | answered | done | blocked | failed
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL,
    result       TEXT,
    blocker      TEXT
);

-- Legacy data retained for compatibility. The compactor no longer uses token
-- changes as activity; compact_topics below is its durable retry gate.
CREATE TABLE IF NOT EXISTS compact_giveups (
    window_key TEXT PRIMARY KEY,
    used       INTEGER NOT NULL,
    at         REAL NOT NULL
);

-- One automatic attempt per observed topic-activity epoch. No observed message
-- means no attempt: old databases cannot prove a previous dispatch absent.
CREATE TABLE IF NOT EXISTS compact_topics (
    chat_id             INTEGER NOT NULL,
    thread_id           INTEGER NOT NULL,
    activity_message_id INTEGER NOT NULL,
    activity_at         REAL NOT NULL,
    attempt_message_id  INTEGER NOT NULL DEFAULT 0,
    attempted_at        REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, thread_id)
);
"""


# Lives in bot.db itself, so it binds EVERY writer of the file, including
# plugins older than this code (they write routes with INSERT OR REPLACE and no
# identity columns): an insert for a (chat, message) that already has a route
# owned by a row is skipped unless it comes from that same row. A route is never
# moved to another window, nor stripped of its identity. Same text in
# channel-plugin/src/routes-db.ts.
ROUTE_KEEP_TRIGGER = (
    "CREATE TRIGGER IF NOT EXISTS message_routes_keep_owner BEFORE INSERT ON message_routes "
    "WHEN EXISTS (SELECT 1 FROM message_routes m WHERE m.chat_id = NEW.chat_id "
    "AND m.message_id = NEW.message_id AND m.row_id IS NOT NULL AND m.row_id IS NOT NEW.row_id) "
    "BEGIN SELECT RAISE(IGNORE); END"
)


class Storage:
    """Thin SQLite gateway shared by the Python bot and (read-only) channel plugin.

    Both processes open the same DB file in WAL mode so the channel plugin can
    INSERT into message_routes while the bot reads from it without locking.
    """

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        # check_same_thread=False so the JobQueue worker thread can reuse the connection;
        # we serialize access with self._lock for safety.
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(_SCHEMA)
        self._migrate()

    # Columns added after the first release, per table. NULL in rows written by
    # older code (or older plugins, which write bot.db directly with their own
    # column list): readers must treat NULL as "unknown", never as a match.
    _ADDED_COLUMNS = {
        "window_topics": (("icon_emoji", "TEXT"), ("status", "TEXT")),
        # Window identity (launcher-minted TG_WINDOW_UID) and the agent the
        # plugin reports, so neither has to be guessed from the display name.
        "instances": (("window_uid", "TEXT"), ("agent", "TEXT")),
        # The identity a route was recorded for: the incarnation (row id), the
        # window, and its scope (host, cwd, agent), kept here because the
        # instance row is deleted when that window goes away.
        "message_routes": (("row_id", "TEXT"), ("window_uid", "TEXT"), ("scope_host", "TEXT"),
                           ("scope_cwd", "TEXT"), ("scope_agent", "TEXT")),
    }

    def _migrate(self) -> None:
        """Idempotent column adds for DBs created before a column existed. One
        transaction: a crash midway leaves either every column or none."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                for table, columns in self._ADDED_COLUMNS.items():
                    have = {row[1] for row in self._conn.execute(f"PRAGMA table_info({table})")}
                    for name, kind in columns:
                        if name not in have:
                            self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
                self._conn.execute(ROUTE_KEEP_TRIGGER)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    # ----- sessions -----

    def load_sessions(self) -> dict[int, tuple[str, float]]:
        """Return {user_id: (active_instance, last_activity_epoch)}."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT user_id, active_instance, last_activity FROM sessions"
            ).fetchall()
        return {int(uid): (str(inst), float(ts)) for uid, inst, ts in rows}

    def upsert_session(self, user_id: int, active_instance: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions(user_id, active_instance, last_activity) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET active_instance=excluded.active_instance, "
                "last_activity=excluded.last_activity",
                (int(user_id), str(active_instance), now),
            )

    # ----- message routes -----

    def lookup_route(self, chat_id: int, message_id: int) -> dict | None:
        """The identity a message was recorded for: {instance (legacy name),
        row_id, window_uid, scope_host, scope_cwd, scope_agent}; unknown parts
        are None. Routes written by older code carry only the name."""
        with self._lock:
            row = self._conn.execute(
                "SELECT instance, row_id, window_uid, scope_host, scope_cwd, scope_agent "
                "FROM message_routes WHERE chat_id=? AND message_id=?",
                (int(chat_id), int(message_id)),
            ).fetchone()
        if not row:
            return None
        keys = ("instance", "row_id", "window_uid", "scope_host", "scope_cwd", "scope_agent")
        return {k: (str(v) if v not in (None, "") else None) for k, v in zip(keys, row)}

    def record_message_route(self, chat_id: int, message_id: int, instance: str,
                             identity: dict | None = None) -> None:
        """Map a (chat_id, message_id) → window so a Telegram native reply/
        reaction routes back to the originating window. Mirrors the plugin's
        local-write path (routes-db.ts recordMessageRoute) for REMOTE plugins
        that can't write this DB; the bot writes it on their behalf via /route.
        ``identity`` = {row_id, window_uid, scope_host, scope_cwd, scope_agent}."""
        ident = identity or {}
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO message_routes(chat_id, message_id, instance, created_at, "
                "row_id, window_uid, scope_host, scope_cwd, scope_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (int(chat_id), int(message_id), str(instance), time.time(),
                 ident.get("row_id"), ident.get("window_uid"), ident.get("scope_host"),
                 ident.get("scope_cwd"), ident.get("scope_agent")),
            )

    def record_message_route_once(self, chat_id: int, message_id: int, instance: str,
                                  identity: dict | None = None) -> bool:
        """Record a route unless the message is already routed to another window
        (another row id or name). Check and write are one SQLite write
        transaction (BEGIN IMMEDIATE), so two concurrent claims cannot both
        succeed, whether they come through this object or through another
        connection to the same file (a local plugin writes it directly).
        Re-recording the same window (a message edit) succeeds. Returns False
        when refused."""
        ident = identity or {}
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                row = self._conn.execute(
                    "SELECT instance, row_id FROM message_routes WHERE chat_id=? AND message_id=?",
                    (int(chat_id), int(message_id)),
                ).fetchone()
                if row is not None and (row[0] != str(instance) or (row[1] or None) != ident.get("row_id")):
                    self._conn.execute("ROLLBACK")
                    return False
                self._conn.execute(
                    "INSERT OR REPLACE INTO message_routes(chat_id, message_id, instance, created_at, "
                    "row_id, window_uid, scope_host, scope_cwd, scope_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (int(chat_id), int(message_id), str(instance), time.time(),
                     ident.get("row_id"), ident.get("window_uid"), ident.get("scope_host"),
                     ident.get("scope_cwd"), ident.get("scope_agent")),
                )
                self._conn.execute("COMMIT")
            except BaseException:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise
        return True

    def cleanup_old_routes(self, max_age_hours: float = 24.0) -> int:
        cutoff = time.time() - max_age_hours * 3600
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM message_routes WHERE created_at < ?", (cutoff,)
            )
            return cursor.rowcount or 0

    # ----- window topics (forum) -----

    def get_topic(self, workspace_id: str) -> tuple[int, int, str, bool, str | None, str | None] | None:
        """Return (forum_chat_id, message_thread_id, title, closed, icon_emoji, status) or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT forum_chat_id, message_thread_id, title, closed, icon_emoji, status "
                "FROM window_topics WHERE workspace_id=?",
                (str(workspace_id),),
            ).fetchone()
        if not row:
            return None
        return (
            int(row[0]), int(row[1]), str(row[2]), bool(row[3]),
            (str(row[4]) if row[4] else None), (str(row[5]) if row[5] else None),
        )

    def get_workspace_by_thread(self, forum_chat_id: int, message_thread_id: int) -> str | None:
        """Reverse lookup: which workspace owns this forum topic. Drives
        topic→window routing (Slice 3). NOTE: a thread may be shared by several
        workspaces (same project on different machines) — this returns the
        first; routing code should prefer get_workspaces_by_thread and pick
        the one with a live window."""
        rows = self.get_workspaces_by_thread(forum_chat_id, message_thread_id)
        return rows[0] if rows else None

    def get_workspaces_by_thread(self, forum_chat_id: int, message_thread_id: int) -> list[str]:
        """All workspaces bound to this forum topic (cross-machine sharing:
        C:\\Work\\X and /Users/.../X may both point at one thread)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT workspace_id FROM window_topics "
                "WHERE forum_chat_id=? AND message_thread_id=?",
                (int(forum_chat_id), int(message_thread_id)),
            ).fetchall()
        return [str(r[0]) for r in rows]

    def set_topic_icon(self, workspace_id: str, icon_emoji: str | None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE window_topics SET icon_emoji=? WHERE workspace_id=?",
                (icon_emoji, str(workspace_id)),
            )

    # --- idle compaction activity and attempts -----------------------------

    def record_compact_activity(self, chat_id: int, thread_id: int, message_id: int) -> None:
        """Record only a newly observed ordinary topic message, never an edit."""
        with self._lock:
            self._conn.execute(
                "INSERT INTO compact_topics(chat_id, thread_id, activity_message_id, activity_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, thread_id) DO UPDATE SET "
                "activity_message_id=excluded.activity_message_id, activity_at=excluded.activity_at "
                "WHERE excluded.activity_message_id > compact_topics.activity_message_id",
                (int(chat_id), int(thread_id), int(message_id), time.time()),
            )

    def compact_ready(self, chat_id: int, thread_id: int, idle_seconds: float) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM compact_topics WHERE chat_id=? AND thread_id=? "
                "AND activity_message_id > attempt_message_id AND activity_at <= ?",
                (int(chat_id), int(thread_id), time.time() - idle_seconds),
            ).fetchone()
        return row is not None

    def claim_compact_attempt(self, chat_id: int, thread_id: int, idle_seconds: float) -> bool:
        """Consume activity BEFORE dispatch; ambiguous delivery must not retry.

        A single conditional write prevents duplicate jobs/processes from
        dispatching together. Activity during /context closes the idle gate.
        """
        now = time.time()
        with self._lock:
            result = self._conn.execute(
                "UPDATE compact_topics SET attempt_message_id=activity_message_id, attempted_at=? "
                "WHERE chat_id=? AND thread_id=? AND activity_message_id > attempt_message_id "
                "AND activity_at <= ?",
                (now, int(chat_id), int(thread_id), now - idle_seconds),
            )
        return result.rowcount == 1

    def compact_giveups(self) -> dict[str, int]:
        """{window key: context size when we gave up on it}."""
        with self._lock:
            rows = self._conn.execute("SELECT window_key, used FROM compact_giveups").fetchall()
        return {str(r[0]): int(r[1]) for r in rows}

    def set_compact_giveup(self, window_key: str, used: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO compact_giveups (window_key, used, at) VALUES (?,?,?) "
                "ON CONFLICT(window_key) DO UPDATE SET used=excluded.used, at=excluded.at",
                (str(window_key), int(used), time.time()),
            )

    def clear_compact_giveup(self, window_key: str) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM compact_giveups WHERE window_key=?", (str(window_key),)
            )

    def set_topic_status(self, workspace_id: str, status: str | None) -> None:
        """Persist the connection-status marker (🟢/🔴) currently shown in the
        topic title, so we only call editForumTopic when it actually changes."""
        with self._lock:
            self._conn.execute(
                "UPDATE window_topics SET status=? WHERE workspace_id=?",
                (status, str(workspace_id)),
            )

    def upsert_topic(
        self, workspace_id: str, forum_chat_id: int, message_thread_id: int, title: str
    ) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO window_topics"
                "(workspace_id, forum_chat_id, message_thread_id, title, created_at, closed) "
                "VALUES (?, ?, ?, ?, ?, 0) "
                "ON CONFLICT(workspace_id) DO UPDATE SET "
                "forum_chat_id=excluded.forum_chat_id, "
                "message_thread_id=excluded.message_thread_id, "
                "title=excluded.title, closed=0",
                (str(workspace_id), int(forum_chat_id), int(message_thread_id), str(title), now),
            )

    def set_topic_closed(self, workspace_id: str, closed: bool) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE window_topics SET closed=? WHERE workspace_id=?",
                (1 if closed else 0, str(workspace_id)),
            )

    def delete_topic(self, workspace_id: str) -> None:
        """Drop a binding so the next registration recreates the topic (used
        when the forum topic was deleted/invalidated server-side)."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM window_topics WHERE workspace_id=?", (str(workspace_id),)
            )

    def all_topics(self) -> list[tuple[str, int, int, str]]:
        """Return [(workspace_id, forum_chat_id, message_thread_id, title)] for
        building the plugin-facing bindings projection."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT workspace_id, forum_chat_id, message_thread_id, title FROM window_topics"
            ).fetchall()
        return [(str(w), int(c), int(t), str(n)) for w, c, t, n in rows]

    def topics_status(self) -> list[tuple[str, int, int, str, str | None]]:
        """Return [(workspace_id, forum_chat_id, message_thread_id, title, status)]
        for the connection-status sweep (mark vanished windows 🔴)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT workspace_id, forum_chat_id, message_thread_id, title, status "
                "FROM window_topics"
            ).fetchall()
        return [
            (str(w), int(c), int(t), str(n), (str(s) if s else None))
            for w, c, t, n, s in rows
        ]

    # ----- instances (live window registry) -----

    _INSTANCE_COLS = (
        "id", "host", "port", "auth_token", "instance_name",
        "workspace_name", "cwd", "pid", "parent_pid", "started_at", "heartbeat_at",
        "window_uid", "agent",
    )

    def get_instances(self) -> list[dict]:
        """All registered windows, oldest heartbeat first so the newest write wins
        when two rows dedup to the same workspace key (mirrors the old
        oldest→newest mtime sort over registry files)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, host, port, auth_token, instance_name, workspace_name, "
                "cwd, pid, parent_pid, started_at, heartbeat_at, window_uid, agent "
                "FROM instances ORDER BY heartbeat_at ASC"
            ).fetchall()
        return [dict(zip(self._INSTANCE_COLS, r)) for r in rows]

    def get_instance_row(self, instance_id: str) -> dict | None:
        """One registry row by id, or None."""
        return next((r for r in self.get_instances() if str(r.get("id")) == str(instance_id)), None)

    def delete_instances(self, ids: list[str]) -> None:
        """Reap stale rows (dead/reused PID). No-op on empty input."""
        if not ids:
            return
        with self._lock:
            self._conn.executemany(
                "DELETE FROM instances WHERE id=?", [(str(i),) for i in ids]
            )

    # ----- networked registration (bot is the writer; see bot/http_registry.py) -----
    # When a plugin runs on another machine it can't share this SQLite file, so it
    # POSTs its row to the bot's registry HTTP server, which writes it here. The bot
    # stamps heartbeat_at with ITS OWN clock so cross-host clock skew never makes a
    # row look stale/fresh wrongly.

    def upsert_instance(self, row: dict) -> None:
        """Insert/replace one instance row (keyed by id). heartbeat_at is stamped
        with the bot's clock, ignoring any client-supplied value."""
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO instances"
                "(id, host, port, auth_token, instance_name, workspace_name, cwd, pid, parent_pid, started_at, "
                "heartbeat_at, window_uid, agent) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(row["id"]), str(row.get("host") or "127.0.0.1"), int(row["port"]),
                    str(row.get("auth_token") or ""), str(row.get("instance_name") or ""),
                    str(row.get("workspace_name") or ""), str(row.get("cwd") or ""),
                    int(row.get("pid") or 0),
                    (int(row["parent_pid"]) if row.get("parent_pid") not in (None, "") else None),
                    str(row.get("started_at") or ""), now,
                    (str(row["window_uid"]) if row.get("window_uid") else None),
                    (str(row["agent"]) if row.get("agent") else None),
                ),
            )

    def heartbeat_instance(self, instance_id: str, parent_pid: int | None = None) -> bool:
        """Refresh one row's heartbeat. Returns False if the row is unknown (the
        client should re-register).

        parent_pid is the plugin's CURRENT agent pid, which is not necessarily
        the one it registered with: when the agent exits, the plugin is adopted
        by init and its ppid becomes 1. Readers use that to spot an orphan, so a
        row that never re-stamps it reports a dead agent as live forever. Older
        plugins do not send it — then leave the column alone.
        """
        with self._lock:
            if parent_pid is None:
                cur = self._conn.execute(
                    "UPDATE instances SET heartbeat_at=? WHERE id=?", (time.time(), str(instance_id))
                )
            else:
                cur = self._conn.execute(
                    "UPDATE instances SET heartbeat_at=?, parent_pid=? WHERE id=?",
                    (time.time(), int(parent_pid), str(instance_id)),
                )
            return (cur.rowcount or 0) > 0

    def delete_instance(self, instance_id: str) -> None:
        """Drop one row (clean unregister)."""
        with self._lock:
            self._conn.execute("DELETE FROM instances WHERE id=?", (str(instance_id),))

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- cross-window tasks -------------------------------------------------

    def create_task(self, from_window: str, to_window: str, kind: str, text: str) -> int:
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO tasks(from_window, to_window, kind, text, state, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'sent', ?, ?)",
                (str(from_window), str(to_window), str(kind), str(text), now, now),
            )
            return int(cur.lastrowid or 0)

    def open_tasks(self) -> list[tuple]:
        """(id, from, to, kind, text, state, created_at) for everything not closed."""
        with self._lock:
            return list(self._conn.execute(
                "SELECT id, from_window, to_window, kind, text, state, created_at FROM tasks "
                "WHERE state IN ('sent','blocked') ORDER BY created_at"
            ))

    def set_task_state(self, task_id: int, state: str,
                       result: str | None = None, blocker: str | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE tasks SET state=?, updated_at=?, "
                "result=COALESCE(?, result), blocker=COALESCE(?, blocker) WHERE id=?",
                (str(state), time.time(), result, blocker, int(task_id)),
            )

    def tasks_for_window(self, window: str) -> list[tuple]:
        """Open work addressed TO `window`: (id, from_window, kind, text, state, created_at).

        This is what a window needs to answer "what is on my plate" without the
        owner relaying it, and it is scoped to that window on purpose — a window
        has no business seeing, let alone closing, another window's tasks.
        """
        with self._lock:
            return list(self._conn.execute(
                "SELECT id, from_window, kind, text, state, created_at FROM tasks "
                "WHERE to_window=? AND state IN ('sent','blocked') ORDER BY created_at",
                (str(window),),
            ))

    def task_owner(self, task_id: int) -> str | None:
        """Which window a task is addressed to, or None if there is no such task."""
        with self._lock:
            row = self._conn.execute(
                "SELECT to_window FROM tasks WHERE id=?", (int(task_id),)
            ).fetchone()
            return str(row[0]) if row else None

    def answer_open_ask(self, asker: str, answerer: str, result: str) -> int | None:
        """Close the newest open ask from `asker` to `answerer`. Returns its id.

        This is how a task completes without any plugin change: B answering A via
        tell_window IS the completion signal, which is already how the windows
        behave. Newest-first because a second ask supersedes an abandoned one.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT id FROM tasks WHERE from_window=? AND to_window=? AND kind='ask' "
                "AND state='sent' ORDER BY created_at DESC LIMIT 1",
                (str(asker), str(answerer)),
            ).fetchone()
            if row is None:
                return None
            tid = int(row[0])
            self._conn.execute(
                "UPDATE tasks SET state='answered', updated_at=?, result=? WHERE id=?",
                (time.time(), str(result)[:4000], tid),
            )
            return tid
