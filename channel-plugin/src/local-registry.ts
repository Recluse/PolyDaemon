import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, chmodSync } from 'fs'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { STATE_DIR } from './config.ts'
import { log } from './logger.ts'

// ---------------------------------------------------------------------------
// Local registry — ~/.tg-bridge-channel/instances.json
//
// The bridge hooks (~/.claude/hooks/tg-bridge-locate.js, channel-plugin/hooks/
// pre-tool-use.ts) need to find THIS machine's plugin to POST approvals/asks/
// progress to it. They used to read the shared bot.db — but a ROAMING plugin
// (TG_BRIDGE_BOT_URL set) registers with the bot over HTTP and never writes
// bot.db, so on a client device there IS no bot.db for the hooks to read.
//
// So every plugin ALSO writes a small JSON file co-located with the hooks. It
// mirrors the bot.db `instances` shape but is purely LOCAL (one file per
// device, keyed by the per-process registry id), and lets the hooks resolve
// their local plugin with a plain JSON read — no SQLite, works on any Node.
// ---------------------------------------------------------------------------

const LOCAL_REGISTRY_PATH = join(STATE_DIR, 'instances.json')
const STALE_AFTER_MS = 60_000
let lock: Database | null = null

function update(change: (map: Record<string, LocalRow>) => void): void {
  if (!lock) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const path = join(STATE_DIR, 'registry-lock.db')
    const opened = new Database(path, { create: true })
    try {
      chmodSync(path, 0o600)
      opened.exec('PRAGMA busy_timeout=5000')
      lock = opened
    } catch (e) { opened.close(); throw e }
  }
  // SQLite serializes the whole read/modify/rename across processes and releases on crash.
  lock.transaction(() => change(readAll())).immediate()
}

export interface LocalRow {
  host: string
  port: number
  auth_token: string
  instance_name: string
  workspace_name: string
  cwd: string
  pid: number
  parent_pid: number
  started_at: string
  heartbeat_at: number
  // Optional: absent for rows written before this existed, and for windows the
  // launcher did not start.
  window_uid?: string
}

function readAll(): Record<string, LocalRow> {
  try {
    const obj = JSON.parse(readFileSync(LOCAL_REGISTRY_PATH, 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, LocalRow>): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${LOCAL_REGISTRY_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, LOCAL_REGISTRY_PATH)  // atomic — a hook never reads half a file
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

// Drop entries from crashed sibling plugins on this device: heartbeat lapsed AND
// the pid is gone. Local pids are probable (same machine), unlike the bot's
// cross-host case. Keeps the file from accumulating dead windows.
function sweep(map: Record<string, LocalRow>, exceptId: string): void {
  const cutoff = Date.now() - STALE_AFTER_MS
  for (const [id, row] of Object.entries(map)) {
    if (id === exceptId) continue
    if ((row.heartbeat_at ?? 0) * 1000 < cutoff && !pidAlive(row.pid)) delete map[id]
  }
}

export function upsertLocal(id: string, row: Omit<LocalRow, 'heartbeat_at'>): void {
  try {
    update(map => {
      map[id] = { ...row, heartbeat_at: Date.now() / 1000 }
      sweep(map, id)
      writeAll(map)
    })
  } catch (e) {
    log(`PolyDaemon: local registry upsert failed: ${e}`)
  }
}

export function heartbeatLocal(id: string): void {
  try {
    update(map => {
      if (!map[id]) return
      map[id].heartbeat_at = Date.now() / 1000
      // Only the plugin can observe adoption after its agent exits.
      map[id].parent_pid = process.ppid
      sweep(map, id)
      writeAll(map)
    })
  } catch (e) {
    log(`PolyDaemon: local registry heartbeat failed: ${e}`)
  }
}

export function removeLocal(id: string): void {
  try {
    update(map => {
      if (!(id in map)) return
      delete map[id]
      if (Object.keys(map).length === 0) {
        try { unlinkSync(LOCAL_REGISTRY_PATH) } catch {}
      } else {
        writeAll(map)
      }
    })
  } catch (e) {
    log(`PolyDaemon: local registry remove failed: ${e}`)
  }
}
