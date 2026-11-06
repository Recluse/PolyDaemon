// Child for routes-db-mixed.test.ts: a NEW plugin opening a bot.db created by an
// OLD bot (no identity columns), writing its row and a route, same host.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const dir = join(process.env.HOME!, '.tg-copilot-bridge')
mkdirSync(dir, { recursive: true })
const old = new Database(join(dir, 'bot.db'), { create: true })
old.exec(`CREATE TABLE message_routes (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  instance TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE instances (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL,
  auth_token TEXT NOT NULL, instance_name TEXT NOT NULL, workspace_name TEXT NOT NULL, cwd TEXT NOT NULL,
  pid INTEGER NOT NULL, parent_pid INTEGER, started_at TEXT, heartbeat_at REAL NOT NULL);`)
old.close()
const { setMyPort } = await import('./state.ts')
const { upsertInstance, recordMessageRoute, getRoutesDb } = await import('./routes-db.ts')
const { REGISTRY_ID } = await import('./registry.ts')
setMyPort(3101)
upsertInstance({ id: REGISTRY_ID, host: '127.0.0.1', port: 3101, auth_token: 't', instance_name: 'infra',
  workspace_name: 'infra', cwd: process.cwd(), pid: process.pid, parent_pid: process.ppid, started_at: '1',
  window_uid: 'U1', agent: 'claude' })
recordMessageRoute(-1, 77)
recordMessageRoute(-1, 77)                     // an edit re-records our own route
const db = getRoutesDb()
// A route the bot already recorded for another window is never taken over.
db.prepare("INSERT INTO message_routes(chat_id, message_id, instance, created_at, row_id) VALUES (-1, 78, 'other', 1, 'other-row')").run()
recordMessageRoute(-1, 78)
console.log(JSON.stringify({
  row: db.prepare('SELECT id, window_uid, agent FROM instances').get(),
  route: db.prepare('SELECT instance, row_id, window_uid, scope_host, scope_cwd, scope_agent FROM message_routes WHERE message_id = 77').get(),
  foreign: db.prepare('SELECT instance, row_id FROM message_routes WHERE message_id = 78').get(),
  rowId: REGISTRY_ID,
}))
