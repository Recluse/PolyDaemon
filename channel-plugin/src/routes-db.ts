import { mkdirSync } from 'fs'
import { Database } from 'bun:sqlite'
import { BRIDGE_DIR, DB_PATH, BOT_URL } from './config.ts'
import { MY_PORT } from './state.ts'
import { log } from './logger.ts'
import { recordRouteRemote } from './bot-rpc.ts'
import { effectiveWorkspaceName } from './registry.ts'

// Shared SQLite handle. Opened lazily so module load doesn't fail if the bot
// hasn't created the file yet — first write will create it on demand. WAL mode
// lets the Python bot read from the same DB while we INSERT.
let routesDb: Database | null = null

export function getRoutesDb(): Database {
  if (routesDb) return routesDb
  mkdirSync(BRIDGE_DIR, { recursive: true })
  const db = new Database(DB_PATH, { create: true })
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=5000')
  // Schema must mirror tg-bot/bot/storage.py — both processes own these tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_routes (
      chat_id     INTEGER NOT NULL,
      message_id  INTEGER NOT NULL,
      instance    TEXT NOT NULL,
      created_at  REAL NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_routes_created ON message_routes(created_at);

    -- One row per live window. Replaces the old ~/.tg-copilot-bridge/instances/*.json
    -- registry: an atomic upsert can't be seen half-written (the file write could),
    -- and a heartbeat lets readers reap dead rows cheaply. id is per-process
    -- (random), so a window reload writes a fresh row and the old one is reaped.
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
  `)
  routesDb = db
  return db
}

export interface InstanceRow {
  id: string
  host: string
  port: number
  auth_token: string
  instance_name: string
  workspace_name: string
  cwd: string
  pid: number
  parent_pid: number
  started_at: string
}

// Register / refresh this window's row. INSERT OR REPLACE keyed on the per-process
// id, so re-registering (or a stale row from a crashed previous run with the same
// id — impossible since id is random per process) is idempotent. `heartbeat_at` is
// stamped now; `heartbeatInstance` keeps it fresh so the bot can tell live from dead.
export function upsertInstance(row: InstanceRow): void {
  try {
    getRoutesDb().prepare(
      `INSERT OR REPLACE INTO instances
       (id, host, port, auth_token, instance_name, workspace_name, cwd, pid, parent_pid, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.host, row.port, row.auth_token, row.instance_name,
      row.workspace_name, row.cwd, row.pid, row.parent_pid, row.started_at,
      Date.now() / 1000,
    )
  } catch (e) {
    log(`PolyDaemon: failed to register instance: ${e}`)
  }
}

export function heartbeatInstance(id: string): void {
  try {
    getRoutesDb().prepare('UPDATE instances SET heartbeat_at=? WHERE id=?')
      .run(Date.now() / 1000, id)
  } catch (e) {
    log(`PolyDaemon: failed to heartbeat instance: ${e}`)
  }
}

export function deleteInstance(id: string): void {
  try {
    getRoutesDb().prepare('DELETE FROM instances WHERE id=?').run(id)
  } catch (e) {
    log(`PolyDaemon: failed to unregister instance: ${e}`)
  }
}

// Record a (chat_id, message_id) -> instance row so the Python router can
// route a Telegram native "reply" back to the window that originally sent the
// message, without changing the user's active window. INSERT OR REPLACE because
// Telegram occasionally reissues the same (chat, message) pair after edits.
export function recordMessageRoute(chatId: string | number, messageId: number): void {
  if (!MY_PORT) return
  // Remote mode (bot on another machine): we can't write the shared bot.db, so
  // ask the bot to record the route over HTTP. Fire-and-forget to match the sync
  // callers; recordRouteRemote logs its own failures. The instance value is
  // the current registered workspace_name (including Codex's handshake rename),
  // so the bot maps it
  // to this window exactly as the local path below does.
  if (BOT_URL) {
    void recordRouteRemote(Number(chatId), messageId, effectiveWorkspaceName())
    return
  }
  try {
    const db = getRoutesDb()
    db.prepare(
      'INSERT OR REPLACE INTO message_routes(chat_id, message_id, instance, created_at) VALUES (?, ?, ?, ?)'
    ).run(Number(chatId), messageId, effectiveWorkspaceName(), Date.now() / 1000)
  } catch (e) {
    log(`PolyDaemon: failed to record message route: ${e}`)
  }
}
