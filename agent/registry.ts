import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Read-only view over the plugins' local registry
// (~/.tg-bridge-channel/instances.json — written by channel-plugin/src/
// local-registry.ts). The row shape mirrors LocalRow there; re-declared here
// because importing channel-plugin/src modules pulls in config.ts, which
// process.exit()s without TG_BOT_TOKEN — the daemon must run without it.
//
// Staleness is a TS port of tg-bot/bridge/registry.py::_row_is_stale for the
// local (same-machine) case — instances.json is always same-machine, so the
// remote branch ("lapsed remote heartbeat = stale") never applies here.
// ---------------------------------------------------------------------------

export const REGISTRY_PATH = join(homedir(), '.tg-bridge-channel', 'instances.json')

/** Mirrors registry.py HEARTBEAT_FRESH_SECONDS. */
export const HEARTBEAT_FRESH_SECONDS = 45

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
  heartbeat_at: number // unix seconds
}

export function readRegistry(): Record<string, LocalRow> {
  try {
    const obj = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {} // missing / unreadable / half-written → empty, never throw
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** The process's start-time token, used to detect PID reuse. '' = PID gone,
 *  null = lookup failed (fall back to plain liveness). Uses `ps -o lstart` —
 *  the same signal the plugins would record in started_at. On macOS ps can
 *  fail for other users' processes; errors are swallowed into null. */
export function procStartToken(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
    if (proc.exitCode !== 0) return '' // ps exits 1 when the PID doesn't exist
    return proc.stdout.toString().trim()
  } catch {
    return null
  }
}

/** Port of registry.py::_row_is_stale (local case). Fresh heartbeat → live
 *  without touching the PID. Lapsed heartbeat → probe the PID; a live PID with
 *  a mismatching recorded start-time token means the PID was recycled by
 *  another process, so the original window is dead. */
export function rowIsStale(row: LocalRow, nowSec = Date.now() / 1000): boolean {
  const heartbeat = row.heartbeat_at
  if (typeof heartbeat === 'number' && nowSec - heartbeat <= HEARTBEAT_FRESH_SECONDS) {
    return false
  }

  const pid = row.pid
  if (Number.isInteger(pid) && pid > 1) {
    const live = procStartToken(pid)
    if (live === '') return true // PID gone → window exited
    if (live === null) return !pidAlive(pid) // token lookup failed → plain liveness
    const recorded = row.started_at
    if (typeof recorded === 'string' && recorded && recorded !== live) {
      return true // PID reused by another process → original is dead
    }
  }
  return false
}

/** Find a window by its board key (instance_name; workspace_name fallback for
 *  older rows, mirroring the bot's key fallback chain). */
export function findByKey(key: string): { id: string; row: LocalRow } | null {
  for (const [id, row] of Object.entries(readRegistry())) {
    if (row.instance_name === key || (!row.instance_name && row.workspace_name === key)) {
      return { id, row }
    }
  }
  return null
}
