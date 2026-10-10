import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.ts'

export type InboundItem = { id: string; content: string; meta: Record<string, unknown>; queued_at: string }
let db: Database | null = null
const root = realpathSync(process.cwd())
const agent = process.env.TG_BRIDGE_AGENT === 'mimo' ? 'mimo' : 'opencode'
const workspace = `${root}#${agent}`

function database(): Database {
  if (db) return db
  mkdirSync(STATE_DIR, { recursive: true })
  const path = join(STATE_DIR, 'opencode-inbound.db')
  const opened = new Database(path, { create: true })
  try {
    chmodSync(path, 0o600)
    opened.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
    opened.exec(`CREATE TABLE IF NOT EXISTS inbound (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, item TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS inbound_workspace ON inbound(workspace)`)
    // Existing unqualified queues belonged only to OpenCode. MiMo must not consume them.
    if (agent === 'opencode') opened.query('UPDATE inbound SET workspace=? WHERE workspace=?').run(workspace, root)
  } catch (error) { opened.close(); throw error }
  db = opened
  return db
}

export function persistInbound(item: InboundItem): void {
  database().query('INSERT INTO inbound(id, workspace, item) VALUES (?, ?, ?)')
    .run(item.id, workspace, JSON.stringify(item))
}

export function peekInbound(): InboundItem | null {
  const row = database().query('SELECT item FROM inbound WHERE workspace=? ORDER BY rowid LIMIT 1')
    .get(workspace) as { item: string } | null
  return row ? JSON.parse(row.item) : null
}

export function ackInbound(id: string): boolean {
  return database().query(`DELETE FROM inbound WHERE workspace=? AND id=? AND rowid=(
    SELECT rowid FROM inbound WHERE workspace=? ORDER BY rowid LIMIT 1
  )`).run(workspace, id, workspace).changes === 1
}
