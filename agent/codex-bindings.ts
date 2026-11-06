// Window → Codex thread bindings, persisted on THIS host only.
//
// A Codex window is identified by the window id its channel plugin sends with
// every delivery: a random id minted once per plugin process. The app-server
// runs one plugin process per loaded thread, so the id names one plugin
// connection inside one thread for as long as that plugin lives. (TG_WINDOW_UID
// is NOT used for Codex: the plugin inherits the shared app-server's
// environment, so every Codex window would carry the same inherited value.)
// Display names and folder names are never keys: two windows of the same agent
// in one folder differ only by this id, and a rename must not move a binding.
//
// The file lives next to agentd's own state (~/.tg-bridge, override with
// TG_CODEX_BINDINGS for tests), mode 0600. Every read-modify-write holds an
// exclusive OS-level lock (see the lock section), so concurrent agentd
// processes and launchers cannot lose each other's updates.
//
// Rules enforced HERE, under the lock, whatever the caller decided before:
// - a window's row is never replaced by a different thread (no silent rebind);
// - a thread bound to another window is never bound again unless the caller
//   names that window as retired (it must have proven the window dead);
// - a malformed row is not "absent": callers refuse until it is rebound;
// - a window counts as gone only when the plugin PROCESS that created its row
//   is verifiably dead (creator pid gone or start token changed); eviction and
//   retirement both require that.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { processState, type ProcessIdentity } from './proc-token.ts'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CodexBinding = {
  thread_id: string
  cwd: string
  bound_at: number
  last_seen: number
  source: 'probed' | 'adopted'
  /** sha256 of the per-process secret of the plugin that created the row. */
  secret_sha256?: string
  /** The plugin process that created the row (pid + OS start token, computed
   *  by agentd at bind time). The row is retired only when THIS process is
   *  verifiably dead; a missing or stale registry row proves nothing. */
  creator?: ProcessIdentity
}
export type BindingRead = { state: 'none' } | { state: 'malformed' } | { state: 'ok'; row: CodexBinding }

const WINDOW_ID = /^[A-Za-z0-9_.:-]{8,128}$/
const THREAD_ID = /^[A-Za-z0-9_-]{1,160}$/
const maxRows = () => Number(process.env.TG_CODEX_BINDINGS_MAX || 1000)
// A dead window's row may be evicted once it has not been seen for this long.
const EVICT_UNSEEN_MS = 24 * 3600 * 1000
const lockWaitMs = () => Number(process.env.TG_CODEX_BINDINGS_LOCK_WAIT_MS || 5_000)
const TOUCH_EVERY_MS = 10 * 60 * 1000

export class BindingConflict extends Error {}

export function validWindowId(id: unknown): id is string { return typeof id === 'string' && WINDOW_ID.test(id) }
export function validThreadId(id: unknown): id is string { return typeof id === 'string' && THREAD_ID.test(id) }
export function secretHash(secret: unknown): string | undefined {
  return typeof secret === 'string' && secret.length >= 16 ? createHash('sha256').update(secret).digest('hex') : undefined
}

// The OS-locked store has its own file; the older `codex-bindings.json` is
// imported once at agentd start (see the migration section).
export function bindingsPath(): string {
  return process.env.TG_CODEX_BINDINGS || join(homedir(), '.tg-bridge', 'codex-bindings.v2.json')
}

function legacyBindingsPath(): string | null {
  const legacy = process.env.TG_CODEX_BINDINGS_LEGACY || join(dirname(bindingsPath()), 'codex-bindings.json')
  return legacy === bindingsPath() ? null : legacy
}

function wellFormed(row: unknown): row is CodexBinding {
  const r = row as CodexBinding
  return !!r && typeof r === 'object' && validThreadId(r.thread_id) && typeof r.cwd === 'string'
    && Number.isFinite(r.bound_at) && (r.secret_sha256 === undefined || /^[0-9a-f]{64}$/.test(r.secret_sha256))
}

function readAll(): Record<string, unknown> {
  if (storeBlocked) throw new Error(storeBlocked)
  let raw: string
  try { raw = readFileSync(bindingsPath(), 'utf8') } catch (e: any) {
    if (e?.code === 'ENOENT') return {}
    throw new Error(`codex bindings unreadable: ${e}`)
  }
  return parseRows(raw)
}

// ── migration from the older store (once, at agentd start) ───────────────────
// agentd older than the OS lock kept bindings in `codex-bindings.json` under a
// lock-file protocol that cannot be made exclusive with this one, so the two
// never share a file. Before serving, agentd imports the old file once into
// its own file and records a SHA-256 of the exact bytes it imported
// (`<v2>.imported`, written after the v2 file, so an interrupted import is
// simply repeated). It runs only after agentd has bound its port: an old agentd
// still holding that port makes it exit first. If the old file's CONTENT
// differs from what was imported (an old agentd ran meanwhile, e.g. a rollback
// and a second roll-forward), its bindings would be invisible here: every
// binding decision then refuses, for the life of this process, until an
// operator settles it. A damaged marker also refuses.
let storeBlocked: string | null = null

/** Why binding decisions are refused in this process, or null. */
export function bindingsBlocked(): string | null { return storeBlocked }

function importMarkerPath(): string { return `${bindingsPath()}.imported` }

/** The old file's bytes, or null when there is none. */
function readLegacyBytes(): Buffer | null {
  const legacy = legacyBindingsPath()
  if (!legacy) return null
  try { return readFileSync(legacy) } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e }
}

const digest = (bytes: Buffer | null): string => bytes ? createHash('sha256').update(bytes).digest('hex') : 'none'

// ── one agentd per bindings store ────────────────────────────────────────────
// The port proves one agentd per PORT, not per store: a second agentd on
// another port with the same home would share it. A new agentd therefore holds
// an OS lock on `<v2>.instance.db` for its whole life (released by the kernel
// when it dies), and also looks for any other agentd process of this user
// (older ones hold no lock). Either finding blocks every binding decision.
let instanceDb: { file: string; db: Database } | null = null

function takeInstanceLock(): string | null {
  const file = `${bindingsPath()}.instance.db`
  if (instanceDb?.file === file) return null
  if (instanceDb) { instanceDb.db.close(); instanceDb = null }   // the store moved (tests)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true })
  try { chmodSync(file, 0o600) } catch { /* best-effort */ }
  db.exec('PRAGMA busy_timeout = 0')
  try { db.exec('BEGIN EXCLUSIVE') } catch {
    db.close()
    return `another agentd already serves the Codex bindings store ${bindingsPath()}; this one refuses binding decisions`
  }
  instanceDb = { file, db }            // held open, uncommitted, until exit
  return null
}

/** Other agentd processes of this user (pid, command line); [] when none.
 *  A process is agentd when bun or node runs a path to agentd.ts/.js (not
 *  `bun test`, not another program that merely names the file). A
 *  process of this user whose command line cannot be read is a possible
 *  agentd. Throws when the process list cannot be read. */
export function otherAgentdProcesses(list: () => { pid: number; command: string | null }[] = processList): { pid: number; command: string }[] {
  return list().filter(p => p.pid !== process.pid && (p.command === null || runsAgentd(p.command)))
    .map(p => ({ pid: p.pid, command: p.command ?? '(command line unreadable)' }))
}

function runsAgentd(command: string): boolean {
  const tokens = (command.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? []).map(t => t.replace(/^"(.*)"$/, '$1'))
  // Run by bun or node, and the script (the first .ts/.js argument; options
  // such as `--cwd <dir>` may come first) is agentd. `bun test` is a test run,
  // whatever its patterns name. Unsure cases count as agentd (refuse).
  if (!/(?:^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(tokens[0] ?? '')) return false
  if (tokens.slice(1).find(t => !t.startsWith('-')) === 'test') return false
  const script = tokens.slice(1).find(t => !t.startsWith('-') && /\.(?:ts|js|mjs)$/i.test(t))
  return !!script && /(?:^|[\\/])agentd\.(?:ts|js|mjs)$/i.test(script)
}

function processList(): { pid: number; command: string | null }[] {
  if (process.platform === 'win32') {
    // This user's bun processes (owner SID = ours), and those whose owner
    // cannot be read (not proven foreign). A null command line is reported as
    // unreadable.
    const script = "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
      + "Get-CimInstance Win32_Process -Filter \"Name LIKE 'bun%'\" | Where-Object { "
      + "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; $o.ReturnValue -ne 0 -or $o.Sid -eq $me } | "
      + "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    const r = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000 } as any)
    if (r.exitCode !== 0) throw new Error('cannot list processes')
    const raw = r.stdout.toString().trim()
    const rows = raw ? JSON.parse(raw) : []
    return (Array.isArray(rows) ? rows : [rows]).map((x: any) => ({ pid: Number(x.ProcessId),
      command: typeof x.CommandLine === 'string' && x.CommandLine ? x.CommandLine : null }))
  }
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : ''
  const r = Bun.spawnSync(['ps', ...(uid ? ['-U', uid] : []), '-o', 'pid=,args='], { timeout: 10_000 } as any)
  if (r.exitCode !== 0) throw new Error('cannot list processes')
  return r.stdout.toString().split('\n').map(l => l.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m![1]), command: m![2] }))
}

function writeMarker(marker: string, value: string): void {
  const tmp = `${marker}.${process.pid}.next`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, value) } finally { closeSync(fd) }
  renameSync(tmp, marker)
}

/** Import the older store once; refuse binding decisions when it changed after
 *  the import. Called once by agentd before it serves. Returns the refusal
 *  reason, or null. */
export function migrateBindingsStore(others: () => { pid: number; command: string }[] = otherAgentdProcesses): string | null {
  storeBlocked = 'Codex bindings migration has not finished'
  try { storeBlocked = takeInstanceLock() } catch (e) {
    storeBlocked = `cannot take the Codex bindings instance lock (${e}); binding decisions are refused`
  }
  if (storeBlocked) return storeBlocked
  try {
    const found = others()
    if (found.length) {
      storeBlocked = `another agentd is running (pid ${found.map(p => p.pid).join(', ')}); Codex binding decisions `
        + 'are refused. Stop the old agentd and its supervisor, then restart this one'
      return storeBlocked
    }
  } catch (e) {
    storeBlocked = `cannot check for another agentd (${e}); Codex binding decisions are refused`
    return storeBlocked
  }
  const legacy = legacyBindingsPath()
  storeBlocked = 'Codex bindings migration has not finished'
  try {
  return withBindingsLock(() => {
    const marker = importMarkerPath()
    let bytes: Buffer | null
    try { bytes = readLegacyBytes() } catch (e) { storeBlocked = `old codex bindings ${legacy} unreadable: ${e}`; return storeBlocked }
    let recorded: string | null = null
    try { recorded = readFileSync(marker, 'utf8').trim() } catch (e: any) { if (e?.code !== 'ENOENT') throw e }
    const haveOwn = existsSync(bindingsPath())
    // The marker is written as "pending:<digest>" BEFORE the store and as the
    // digest after it, so a pending marker proves an import was interrupted
    // before this process served anything: repeating it loses nothing. A
    // missing marker next to an existing store proves nothing.
    const interrupted = recorded !== null && recorded.startsWith('pending:')
    if (interrupted && haveOwn && recorded !== `pending:${digest(bytes)}`) {
      // The interrupted import was of another old file (or of one that is gone):
      // repeating it from what is there now could lose the store.
      storeBlocked = `an import into ${bindingsPath()} was interrupted and ${legacy} has changed since; `
        + `Codex binding decisions are refused. Stop every old agentd, then either delete ${legacy} and ${marker} `
        + `(keep the new store) or delete ${bindingsPath()} (re-import), and restart agentd`
      return storeBlocked
    }
    if (haveOwn && !interrupted && recorded === null) {
      if (bytes === null) { writeMarker(marker, 'none'); storeBlocked = null; return null }
      storeBlocked = `${bindingsPath()} exists but its import marker ${marker} is missing, and ${legacy} exists: `
        + `cannot prove the store holds only that import. Codex binding decisions are refused. Stop every old `
        + `agentd, then either delete ${legacy} (keep the new store) or delete ${bindingsPath()} (re-import), and restart agentd`
      return storeBlocked
    }
    if (haveOwn && !interrupted) {
      // No old file (any more): nothing can be invisible, whatever the marker
      // says. With an old file, a marker that does not match it (a damaged one
      // included) refuses.
      if (bytes !== null && recorded !== digest(bytes)) {
        storeBlocked = `${legacy} differs from what this host imported into ${bindingsPath()} (an old agentd ran `
          + `meanwhile, or the marker ${marker} is damaged); Codex binding decisions are refused. Stop every old `
          + `agentd, then either delete ${bindingsPath()} and ${marker} (re-import the old file) or delete ${legacy} `
          + `(keep the new store), and restart agentd`
        return storeBlocked
      }
      storeBlocked = null
      return null
    }
    // First start, or an interrupted import: (re)import.
    let rows: Record<string, unknown> = {}
    if (bytes) {
      try { rows = parseRows(bytes.toString('utf8')) } catch (e) {
        storeBlocked = `old codex bindings ${legacy} unreadable: ${e}`
        return storeBlocked
      }
    }
    writeMarker(marker, `pending:${digest(bytes)}`)
    writeAll(rows)
    writeMarker(marker, digest(bytes))
    storeBlocked = null
    return null
  })
  } catch (e) {
    // Any failure here (marker unreadable or unwritable, store unwritable)
    // leaves the import unproven: refuse, and repeat it at the next start.
    storeBlocked = `Codex bindings migration failed (${e}); binding decisions are refused until agentd restarts cleanly`
    return storeBlocked
  }
}

function parseRows(raw: string): Record<string, unknown> {
  // A corrupt file must not read as "no bindings": that would turn every bound
  // window into an unbound one and re-enable guessing.
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('codex bindings file is not an object')
  return parsed as Record<string, unknown>
}

function writeAll(rows: Record<string, unknown>): void {
  const file = bindingsPath()
  const tmp = `${file}.${process.pid}.next`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, JSON.stringify(rows)) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

// ── lock ─────────────────────────────────────────────────────────────────────
// An exclusive SQLite transaction on a side file is the lock. SQLite takes an
// OS file lock (fcntl on POSIX, LockFileEx on Windows), which the kernel drops
// when the holder exits or dies. Nothing is ever "taken over": there is no
// stale-lock judgement by age or by pid, so a paused holder keeps its lock and
// two processes can never both hold it. The lock file is local to this host
// (~/.tg-bridge); SQLite locking is not reliable on network file systems.
function lockPath(): string { return `${bindingsPath()}.lock.db` }

/** Exclusive inter-process lock around a read-modify-write of the files.
 *  Not re-entrant: a nested call from the same process waits for itself and
 *  fails after the lock wait. */
export function withBindingsLock<T>(fn: () => T): T {
  const file = bindingsPath()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const lock = lockPath()
  const db = new Database(lock, { create: true })
  try {
    try { chmodSync(lock, 0o600) } catch { /* best-effort; the directory is 0700 */ }
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(lockWaitMs()))}`)
    try { db.exec('BEGIN EXCLUSIVE') } catch (e: any) {
      if (/busy|locked/i.test(String(e?.message ?? e))) throw new Error('codex bindings are locked by another process')
      throw e
    }
    try { return fn() } finally { try { db.exec('ROLLBACK') } catch { /* closing releases it too */ } }
  } finally { db.close() }
}

export function readBinding(windowId: string): BindingRead {
  const all = readAll()
  if (!Object.hasOwn(all, windowId)) return { state: 'none' }
  const row = all[windowId]
  return wellFormed(row) ? { state: 'ok', row } : { state: 'malformed' }
}

/** Every window whose row names this thread; row null = malformed row. */
export function windowsBoundTo(threadId: string): Array<{ windowId: string; row: CodexBinding | null }> {
  return Object.entries(readAll()).filter(([, r]) => (r as any)?.thread_id === threadId)
    .map(([windowId, r]) => ({ windowId, row: wellFormed(r) ? r : null }))
}

/** Whether the window of this row is verifiably gone: its creator process is
 *  dead. Rows without a creator (older rows) are 'unknown'. */
export function creatorState(row: CodexBinding | null): 'alive' | 'dead' | 'unknown' {
  return row ? processState(row.creator) : 'unknown'
}

/** Create (or confirm) windowId → threadId. Re-checks everything under the
 *  lock: throws BindingConflict instead of replacing a different thread of
 *  this window, a malformed row, or a thread bound to a window that is not in
 *  `retire` AND verifiably dead. */
export function bind(opts: {
  windowId: string; threadId: string; cwd: string; source: CodexBinding['source']
  creator: ProcessIdentity; secretSha256?: string; retire?: string[]
}): void {
  const { windowId, threadId } = opts
  if (!validWindowId(windowId) || !validThreadId(threadId)) throw new Error('invalid window or thread id')
  if (processState(opts.creator) !== 'alive') throw new BindingConflict('the window process cannot be identified; not binding')
  withBindingsLock(() => {
    const all = readAll()
    const now = Date.now()
    if (Object.hasOwn(all, windowId)) {
      const mine = all[windowId]
      if (!wellFormed(mine)) throw new BindingConflict(`binding of window ${windowId} is malformed; restart the window to rebind`)
      if (mine.thread_id !== threadId) throw new BindingConflict(`window ${windowId} is already bound to thread ${mine.thread_id}`)
      if (mine.secret_sha256 && mine.secret_sha256 !== opts.secretSha256) throw new BindingConflict('window secret does not match its binding')
      return
    }
    for (const [w, r] of Object.entries(all)) {
      if (w === windowId || (r as any)?.thread_id !== threadId) continue
      if (!opts.retire?.includes(w) || creatorState(wellFormed(r) ? r : null) !== 'dead') {
        throw new BindingConflict(`thread ${threadId} is already bound to window ${w}`)
      }
      delete all[w]
    }
    if (Object.keys(all).length >= maxRows()) {
      for (const [w, r] of Object.entries(all)) {
        const seen = Number((r as any)?.last_seen ?? (r as any)?.bound_at ?? 0)
        if (now - seen > EVICT_UNSEEN_MS && wellFormed(r) && creatorState(r) === 'dead') delete all[w]
      }
      if (Object.keys(all).length >= maxRows()) throw new BindingConflict('codex binding table is full of windows not verifiably gone; not evicting any')
    }
    all[windowId] = { thread_id: threadId, cwd: opts.cwd, bound_at: now, last_seen: now, source: opts.source,
      creator: { pid: opts.creator.pid, start: opts.creator.start },
      ...(opts.secretSha256 ? { secret_sha256: opts.secretSha256 } : {}) } satisfies CodexBinding
    // A thread that now has a window is no longer waiting for one.
    const res = readReservations()
    if (res[threadId]) { delete res[threadId]; writeReservations(res) }
    writeAll(all)
  })
}

// ── resume reservations ──────────────────────────────────────────────────────
// An automatic resume hands out an unloaded thread before any TUI has attached
// to it; a second automatic resume in that window of time would hand out the
// same thread. The first one reserves it for RESERVE_MS (same lock, own file);
// explicit `resume <id>` never asks agentd and is unaffected.
const reserveMs = () => Number(process.env.TG_CODEX_RESERVE_MS ?? 120_000)
type Reservations = Record<string, { until: number; by: string }>

function reservationsPath(): string { return bindingsPath().replace(/\.json$/, '') + '.reservations.json' }

function readReservationsAt(file: string): Reservations {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (e: any) {
    if (e?.code === 'ENOENT') return {}
    throw new Error(`codex reservations unreadable: ${e}`)
  }
  const v = JSON.parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('codex reservations file is not an object')
  const now = Date.now()
  return Object.fromEntries(Object.entries(v as Reservations).filter(([, r]) => Number(r?.until) > now))
}

/** This store's live reservations, plus (read only) those of the old agentd:
 *  a thread it handed out just before it was replaced is not handed out again. */
function readReservations(): Reservations {
  const own = readReservationsAt(reservationsPath())
  const legacy = legacyBindingsPath()
  if (!legacy) return own
  // A thread that has a window in this store is no longer waiting for one
  // (bind() clears only our own file; the old one is never written).
  const bound = new Set(Object.values(readAll()).map(r => (r as any)?.thread_id).filter(Boolean))
  const old = Object.entries(readReservationsAt(legacy.replace(/\.json$/, '') + '.reservations.json'))
    .filter(([thread]) => !bound.has(thread))
  return { ...Object.fromEntries(old), ...own }
}

function writeReservations(res: Reservations): void {
  const file = reservationsPath()
  const tmp = `${file}.${process.pid}.next`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, JSON.stringify(res)) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

export function isReserved(threadId: string): boolean { return !!readReservations()[threadId] }

/** Reserve a thread for one automatic resume; throws when already reserved,
 *  or when, re-checked under the lock, a window other than `windowId` holds a
 *  binding to it that is not verifiably dead (another agentd may have bound
 *  it after the caller chose it). */
export function reserveThread(threadId: string, by: string, windowId?: string): void {
  withBindingsLock(() => {
    for (const { windowId: w, row } of windowsBoundTo(threadId)) {
      if (w === windowId) continue
      if (creatorState(row) !== 'dead') throw new BindingConflict(`thread ${threadId} is already bound to window ${w}`)
    }
    const res = readReservations()
    if (res[threadId]) throw new BindingConflict(`thread ${threadId} was just handed to another launch; resume it explicitly or wait`)
    res[threadId] = { until: Date.now() + reserveMs(), by }
    writeReservations(res)
  })
}

/** Record that a bound window was just used (throttled). Best-effort. */
export function touch(windowId: string): void {
  try {
    const r = readBinding(windowId)
    if (r.state !== 'ok' || Date.now() - (r.row.last_seen ?? 0) < TOUCH_EVERY_MS) return
    withBindingsLock(() => {
      const all = readAll()
      const row = all[windowId]
      if (!wellFormed(row)) return
      all[windowId] = { ...row, last_seen: Date.now() }
      writeAll(all)
    })
  } catch { /* last_seen only steers eviction of dead windows */ }
}
