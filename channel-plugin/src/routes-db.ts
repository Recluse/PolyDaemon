import { mkdirSync } from 'fs'
import { Database } from 'bun:sqlite'
import { BRIDGE_DIR, DB_PATH, BOT_URL } from './config.ts'
import { MY_PORT } from './state.ts'
import { log } from './logger.ts'
import { recordRouteRemote } from './bot-rpc.ts'
import { effectiveWorkspaceName, REGISTRY_ID, routeIdentity } from './registry.ts'

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
  // Columns added later (mirrors Storage._ADDED_COLUMNS in tg-bot/bot/storage.py).
  // Either side may add them first; a concurrent add of the same column fails
  // with "duplicate column", which is fine.
  const added: Record<string, [string, string][]> = {
    instances: [['window_uid', 'TEXT'], ['agent', 'TEXT']],
    message_routes: [['row_id', 'TEXT'], ['window_uid', 'TEXT'], ['scope_host', 'TEXT'],
      ['scope_cwd', 'TEXT'], ['scope_agent', 'TEXT']],
  }
  for (const [table, columns] of Object.entries(added)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
    for (const [name, kind] of columns) {
      if (have.has(name)) continue
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${kind}`) }
      catch (e) { if (!/duplicate column/i.test(String(e))) throw e }
    }
  }
  // Binds every writer of bot.db, older plugins included: a route owned by a
  // row is never moved to another row nor stripped of its identity. Same text
  // as ROUTE_KEEP_TRIGGER in tg-bot/bot/storage.py.
  db.exec(`CREATE TRIGGER IF NOT EXISTS message_routes_keep_owner BEFORE INSERT ON message_routes `
    + `WHEN EXISTS (SELECT 1 FROM message_routes m WHERE m.chat_id = NEW.chat_id `
    + `AND m.message_id = NEW.message_id AND m.row_id IS NOT NULL AND m.row_id IS NOT NEW.row_id) `
    + `BEGIN SELECT RAISE(IGNORE); END`)
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
  window_uid?: string
  agent?: string
}

// Register / refresh this window's row. INSERT OR REPLACE keyed on the per-process
// id, so re-registering (or a stale row from a crashed previous run with the same
// id — impossible since id is random per process) is idempotent. `heartbeat_at` is
// stamped now; `heartbeatInstance` keeps it fresh so the bot can tell live from dead.
export function upsertInstance(row: InstanceRow): void {
  try {
    getRoutesDb().prepare(
      `INSERT OR REPLACE INTO instances
       (id, host, port, auth_token, instance_name, workspace_name, cwd, pid, parent_pid, started_at, heartbeat_at,
        window_uid, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.host, row.port, row.auth_token, row.instance_name,
      row.workspace_name, row.cwd, row.pid, row.parent_pid, row.started_at,
      Date.now() / 1000, row.window_uid || null, row.agent || null,
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
// message, without changing the user's active window. An existing route is
// refreshed only for the same row, because Telegram occasionally reissues the
// same (chat, message) pair after edits.
export function recordMessageRoute(chatId: string | number, messageId: number): void {
  if (!MY_PORT) return
  // Remote mode (bot on another machine): we can't write the shared bot.db, so
  // ask the bot to record the route over HTTP. Fire-and-forget to match the sync
  // callers; recordRouteRemote logs its own failures. The instance value is
  // the current registered workspace_name (including Codex's handshake rename),
  // so the bot maps it
  // to this window exactly as the local path below does.
  if (BOT_URL) {
    // The bot derives the identity from our registry row (by row id).
    void recordRouteRemote(Number(chatId), messageId, effectiveWorkspaceName(), REGISTRY_ID)
    return
  }
  try {
    const db = getRoutesDb()
    // Same identity the bot would derive from our row: incarnation, window, scope.
    const id = routeIdentity()
    // One statement, so it is atomic against the bot's own check-and-write:
    // a route already held by another row is left alone (a message is never
    // moved to another window); our own row may refresh it after an edit.
    db.prepare(
      `INSERT INTO message_routes(chat_id, message_id, instance, created_at,
         row_id, window_uid, scope_host, scope_cwd, scope_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, message_id) DO UPDATE SET
         instance=excluded.instance, created_at=excluded.created_at, window_uid=excluded.window_uid,
         scope_host=excluded.scope_host, scope_cwd=excluded.scope_cwd, scope_agent=excluded.scope_agent
       WHERE message_routes.row_id IS excluded.row_id AND message_routes.instance = excluded.instance`
    ).run(Number(chatId), messageId, effectiveWorkspaceName(), Date.now() / 1000,
      id.row_id, id.window_uid, id.scope_host, id.scope_cwd, id.scope_agent)
  } catch (e) {
    log(`PolyDaemon: failed to record message route: ${e}`)
  }
}
