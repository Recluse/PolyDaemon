"""Durable receipt before PTB acknowledges an update to Telegram.

Pending receipts are replayable; interrupted handlers are deliberately NOT
replayed automatically because they may already have performed a side effect.
This is crash accounting, not an exactly-once delivery claim.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from pathlib import Path

from telegram import Update
from telegram.ext import Application

logger = logging.getLogger(__name__)


class UpdateJournal:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None)
        path.chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("""CREATE TABLE IF NOT EXISTS telegram_updates (
            update_id INTEGER PRIMARY KEY, payload TEXT,
            state TEXT NOT NULL CHECK(state IN ('pending','processing','done','uncertain')),
            received_at REAL NOT NULL, updated_at REAL NOT NULL
        )""")

    def receive(self, update: Update) -> bool:
        now = time.time()
        cursor = self.db.execute(
            "INSERT OR IGNORE INTO telegram_updates VALUES (?,?,'pending',?,?)",
            (update.update_id, update.to_json(), now, now),
        )
        return cursor.rowcount == 1

    def claim(self, update_id: int) -> bool:
        return self.db.execute(
            "UPDATE telegram_updates SET state='processing',updated_at=? "
            "WHERE update_id=? AND state='pending'", (time.time(), update_id)
        ).rowcount == 1

    def finish(self, update_id: int) -> None:
        # Keep the small ID receipt for deduplication; erase processed message bodies.
        self.db.execute(
            "UPDATE telegram_updates SET state='done',payload=NULL,updated_at=? "
            "WHERE update_id=? AND state='processing'", (time.time(), update_id)
        )

    def uncertain(self, update_id: int) -> None:
        self.db.execute(
            "UPDATE telegram_updates SET state='uncertain',updated_at=? "
            "WHERE update_id=?", (time.time(), update_id)
        )

    def recover(self, bot) -> list[Update]:
        self.db.execute("UPDATE telegram_updates SET state='uncertain' WHERE state='processing'")
        count = self.db.execute(
            "SELECT count(*) FROM telegram_updates WHERE state='uncertain'"
        ).fetchone()[0]
        if count:
            logger.error("%d Telegram updates require reconciliation; no automatic side-effect replay", count)
        return [Update.de_json(json.loads(payload), bot) for (payload,) in self.db.execute(
            "SELECT payload FROM telegram_updates WHERE state='pending' ORDER BY received_at,update_id"
        )]

    def close(self) -> None:
        self.db.close()


class DurableUpdateQueue(asyncio.Queue):
    def __init__(self, journal: UpdateJournal) -> None:
        super().__init__()
        self.journal = journal
        self.on_failure = None

    async def put(self, item) -> None:
        if isinstance(item, Update):
            try:
                inserted = self.journal.receive(item)
            except Exception:
                logger.exception("Telegram receipt could not be persisted; stopping polling")
                if self.on_failure:
                    self.on_failure()
                raise
            if not inserted:
                return
        # Unbounded just like PTB's default. There is no wait for an agent turn.
        await super().put(item)

    async def restore(self, bot) -> None:
        for update in self.journal.recover(bot):
            await super().put(update)


class JournalApplication(Application):
    def _journal_write(self, method, *args):
        try:
            return method(*args)
        except Exception:
            logger.exception("Telegram journal unavailable; stopping the router")
            self.stop_running()
            raise

    async def process_update(self, update) -> None:
        if not isinstance(update, Update):
            await super().process_update(update)
            return
        journal = self.update_queue.journal
        if not self._journal_write(journal.claim, update.update_id):
            return
        try:
            await super().process_update(update)
        except BaseException:
            self._journal_write(journal.uncertain, update.update_id)
            raise
        else:
            self._journal_write(journal.finish, update.update_id)

    async def process_error(self, update, error, job=None, coroutine=None) -> bool:
        if isinstance(update, Update):
            self._journal_write(self.update_queue.journal.uncertain, update.update_id)
        return await super().process_error(update, error, job, coroutine)
