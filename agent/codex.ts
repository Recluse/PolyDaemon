// Codex adapter: the daemon OWNS a `codex app-server` (WebSocket on loopback)
// and delivers Telegram inbound into Codex threads via turn/start — the push
// channel Codex itself lacks. TUIs attach to the same server with `codex --remote`, so a turn
// started here is visible live in the user's terminal.
//
// Delivery contract (POST /v1/codex/deliver): {cwd, text, window_id} → the
// thread BOUND to that window (codex-bindings.ts), never "the newest thread in
// the folder"; an unbound window is bound only when its own plugin confirms
// the thread or exactly one candidate exists, otherwise the delivery is
// refused. Then start (or steer) a turn. A thread held open
// by a STANDALONE codex TUI (not --remote) is refused: two processes writing
// one rollout corrupt state — the caller falls back to the queue + hint.
import { readFileSync } from 'node:fs'
import { spawn, type Subprocess } from 'bun'
import { log } from './log.ts'
import { canonicalWindowsPath, isCodexExecutable, isCodexTuiCommand, standaloneWindowsTui } from './windows-codex.ts'
import { readRegistry, rowIsStale, type LocalRow } from './registry.ts'
import { processStartToken, type ProcessIdentity } from './proc-token.ts'
import { BindingConflict, bind, bindingsBlocked, creatorState, isReserved, readBinding, reserveThread, secretHash, touch, validWindowId, windowsBoundTo } from './codex-bindings.ts'

const WS_PORT = Number(process.env.TG_CODEX_WS_PORT || 3210)
const WS_URL = `ws://127.0.0.1:${WS_PORT}`

// launchd's PATH is minimal — resolve the codex binary explicitly.
function codexBin(): string | null {
  const cands = [
    process.env.TG_CODEX_BIN,
    `${process.env.HOME}/.local/bin/codex`,
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ].filter(Boolean) as string[]
  for (const c of cands) {
    try { if (Bun.file(c).size > 0 || c === 'codex') return c } catch { /* next */ }
  }
  return null
}

// ── app-server supervision ───────────────────────────────────────────────────

let child: Subprocess | null = null
let stopping = false

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${WS_PORT}/healthz`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

export async function ensureAppServer(): Promise<void> {
  if (await healthy()) { log(`codex: app-server already serving on :${WS_PORT}`); await connect(); return }
  const bin = codexBin()
  if (!bin) { log('codex: binary not found (set TG_CODEX_BIN) — adapter disabled'); return }
  child = spawn([bin, 'app-server', '--listen', WS_URL], {
    stdout: 'ignore',
    stderr: 'ignore',
    onExit(_p, code) {
      if (stopping) return
      log(`codex: app-server exited (code=${code}) — respawning in 3s`)
      setTimeout(() => { void ensureAppServer() }, 3000)
    },
  })
  for (let i = 0; i < 20; i++) {
    if (await healthy()) { log(`codex: app-server up on :${WS_PORT} (pid ${child.pid})`); await connect(); return }
    await new Promise((r) => setTimeout(r, 500))
  }
  log('codex: app-server did not become healthy in 10s')
}

export function stopAppServer(): void {
  stopping = true
  try { child?.kill() } catch { /* noop */ }
}

// ── JSON-RPC over WebSocket ──────────────────────────────────────────────────

let ws: WebSocket | null = null
let wsReady: Promise<void> | null = null
let rpcId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; sock?: WebSocket }>()

/** The request reached the socket but no answer came (timeout, or the socket
 *  closed first). The server may or may not have applied it: a caller must not
 *  fall back to another call with the same effect. */
export class RpcOutcomeUnknown extends Error {}

function connect(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve()
  if (wsReady) return wsReady
  wsReady = new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL)
    const fail = (e: unknown) => { wsReady = null; reject(new Error(`codex ws: ${e}`)) }
    sock.onopen = () => {
      ws = sock
      void rpc('initialize', { clientInfo: { name: 'polydaemon-adapter', title: 'PolyDaemon', version: '0.1' } })
        .then(() => { wsReady = null; resolve() })
        .catch(fail)
    }
    sock.onerror = fail
    sock.onclose = () => {
      // A late close of an OLD socket must not detach the current one or fail
      // requests that were sent on it.
      if (ws === sock) ws = null
      for (const [id, p] of pending) {
        if (p.sock !== sock) continue
        pending.delete(id)
        p.reject(new RpcOutcomeUnknown('codex ws closed before answering'))
      }
    }
    sock.onmessage = (e) => {
      let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: any }
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id)!
        pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
        else p.resolve(m.result)
      }
      if (m.method) void notifyCodexError(m.method, m.params).catch(e => log(`codex: error notification failed: ${e}`))
    }
  })
  return wsReady
}

async function rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<unknown> {
  if (method !== 'initialize') await connect()
  const i = ++rpcId
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(i)
      reject(new RpcOutcomeUnknown(`codex rpc ${method}: no answer in ${timeoutMs} ms`))
    }, timeoutMs)
    pending.set(i, {
      resolve: (v) => { clearTimeout(t); resolve(v) },
      reject: (e) => { clearTimeout(t); reject(e) },
    })
    const sock = ws
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      clearTimeout(t); pending.delete(i)
      reject(new Error('codex ws not connected'))
      return
    }
    pending.get(i)!.sock = sock
    sock.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }))
  })
}

// ── delivery ─────────────────────────────────────────────────────────────────

type ThreadSummary = {
  id: string
  cwd?: string
  status?: { type?: string } | string
  source?: unknown
  ephemeral?: boolean
  parentThreadId?: string | null
  createdAt?: number
  updatedAt?: number
}

function canon(p: string): string {
  if (process.platform === 'win32') return canonicalWindowsPath(p)
  try { return require('fs').realpathSync(p) } catch { return p }
}

function statusType(t: ThreadSummary): string {
  return typeof t.status === 'string' ? t.status : t.status?.type ?? ''
}

// A root conversation a window can own: not an ephemeral helper, not a child
// agent, not a `codex exec` run.
function isRootThread(t: ThreadSummary | null): t is ThreadSummary {
  if (!t || typeof t.id !== 'string' || t.ephemeral === true) return false
  if (t.parentThreadId != null) return false
  const src = t.source
  if (src === 'subAgent' || src === 'exec') return false
  if (src && typeof src === 'object' && ('subAgent' in src || 'exec' in src)) return false
  return true
}

// NOTE (Windows): canon() keeps the existing lowercase-cwd comparison on
// win32. Whether thread/list and thread/read report the same casing there is
// an open question without Windows evidence; not changed here.
function sameCwd(t: ThreadSummary, want: string): boolean {
  return !!t.cwd && canon(t.cwd) === want
}

const MAX_PAGES = 20
const PAGE_SIZE = 100

/** Every page of a cursor-paginated listing. `complete` is false when the page
 *  cap was hit, a page was malformed or the server did not state nextCursor:
 *  an incomplete listing never authorizes choosing a thread. */
async function allPages<T>(method: string, params: Record<string, unknown>): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await rpc(method, cursor ? { ...params, cursor } : params) as Record<string, unknown>
    const data = (res?.data ?? res?.threads ?? res?.items) as T[] | undefined
    if (!Array.isArray(data)) return { items, complete: false }
    items.push(...data)
    if (!res || !('nextCursor' in res)) return { items, complete: false }
    const next = res.nextCursor
    if (next == null || next === '') return { items, complete: true }
    if (typeof next !== 'string' || next === cursor) return { items, complete: false }
    cursor = next
  }
  return { items, complete: false }
}

/** Loaded root threads of this folder (a live window's thread is loaded).
 *  A thread that cannot be read makes the listing INCOMPLETE: dropping it
 *  could turn two candidates into "the only one". */
async function loadedRootThreads(want: string): Promise<{ threads: ThreadSummary[]; complete: boolean }> {
  const { items, complete } = await allPages<string>('thread/loaded/list', { limit: PAGE_SIZE })
  let readable = true
  const summaries = await Promise.all(items.map(async id => {
    try {
      const r = await rpc('thread/read', { threadId: id }) as { thread: ThreadSummary }
      if (!r?.thread || r.thread.id !== id) { readable = false; return null }
      return r.thread
    } catch { readable = false; return null }
  }))
  return { threads: summaries.filter((t): t is ThreadSummary => isRootThread(t) && sameCwd(t, want)), complete: complete && readable }
}

/** Persisted root threads of this folder, every page. Children are filtered
 *  after collecting all pages, so a folder full of child threads cannot hide
 *  its root conversation behind the first page. */
async function savedRootThreads(want: string): Promise<{ threads: ThreadSummary[]; complete: boolean }> {
  const { items, complete } = await allPages<ThreadSummary>('thread/list', { cwd: want, sortKey: 'recency_at', limit: PAGE_SIZE })
  return { threads: items.filter(t => isRootThread(t) && sameCwd(t, want)), complete }
}

const BRIDGE_SERVER = process.env.TG_CODEX_BRIDGE_SERVER || 'tg-bridge'

/** Ask the tg-bridge plugin running INSIDE this thread which window id it has.
 *  The app-server routes the call to that thread's own MCP connection, so the
 *  answer proves which plugin CONNECTION lives in the thread. It does not prove
 *  which UI (TUI) shows the thread. null = no usable answer. */
async function windowOfThread(threadId: string): Promise<string | null> {
  try {
    const r = await rpc('mcpServer/tool/call', { threadId, server: BRIDGE_SERVER, tool: 'bridge_status', arguments: {} }, 10000) as any
    if (r?.isError) return null
    const v = r?.structuredContent ?? JSON.parse(r?.content?.find((p: any) => p?.type === 'text')?.text ?? 'null')
    return validWindowId(v?.window_id) ? v.window_id : null
  } catch { return null }
}

export type ThreadChoice =
  | { ok: true; thread: ThreadSummary | null; binding: 'bound' | 'probed' | 'single' | 'none' }
  | { ok: false; reason: string; code: 'bound-missing' | 'bound-elsewhere' | 'malformed' | 'secret' | 'ambiguous' | 'incomplete' | 'conflict' | 'reserved' | 'none' }

function ambiguous(n: number, why = 'codex threads in this folder'): ThreadChoice {
  return { ok: false, code: 'ambiguous',
    reason: `ambiguous: ${n} ${why}, bind the window (restart it via the launcher, or resume an explicit thread id)` }
}
const incomplete: ThreadChoice = { ok: false, code: 'incomplete',
  reason: 'thread listing incomplete (unreadable thread, page cap or no nextCursor); not guessing' }

// Binding decisions of this process run one at a time: two windows resolving
// concurrently must not both take the same thread from one snapshot. (Other
// processes are excluded by the file lock and the re-checks in bind().)
let decisions: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = decisions.then(fn, fn)
  decisions = run.catch(() => undefined)
  return run
}

/** The thread a window's binding names; refuses (never falls back) when the
 *  row is malformed, the secret does not match, the thread cannot be read or
 *  it belongs to another folder. null = this window has no row. */
async function boundThread(windowId: string, want: string, secret: string | undefined | null): Promise<ThreadChoice | null> {
  const b = readBinding(windowId)
  if (b.state === 'none') return null
  if (b.state === 'malformed') return { ok: false, code: 'malformed', reason: 'this window\'s binding is malformed; restart the window to rebind' }
  // secret === null: a read-only lookup (resume) that does not act as the window.
  if (secret !== null && b.row.secret_sha256 && b.row.secret_sha256 !== secret) {
    return { ok: false, code: 'secret', reason: 'window secret does not match its binding; refusing' }
  }
  let t: ThreadSummary | null = null
  try { t = (await rpc('thread/read', { threadId: b.row.thread_id }) as { thread: ThreadSummary }).thread } catch { /* refused below */ }
  if (!t || t.id !== b.row.thread_id) {
    return { ok: false, code: 'bound-missing',
      reason: `bound thread ${b.row.thread_id} of this window is unavailable; not choosing another — restart the window via the launcher to rebind` }
  }
  if (!sameCwd(t, want)) {
    return { ok: false, code: 'bound-elsewhere', reason: `bound thread ${b.row.thread_id} belongs to another folder; restart the window to rebind` }
  }
  return { ok: true, thread: t, binding: 'bound' }
}

/** Other windows bound to `threadId`: which can be retired, and whether any
 *  blocks the thread. A window is gone only when the plugin process that
 *  created its binding is verifiably dead (pid gone / start token changed);
 *  a missing or stale registry row proves nothing (reaper, lost write, hung
 *  heartbeat). Alive, unknown or malformed → blocked. */
function otherOwners(threadId: string, windowId: string | undefined): { retire: string[]; blocked: string | null } {
  const retire: string[] = []
  for (const { windowId: w, row } of windowsBoundTo(threadId)) {
    if (w === windowId) continue
    if (!row) return { retire, blocked: `a malformed binding (window ${w})` }
    const state = creatorState(row)
    if (state !== 'dead') return { retire, blocked: `window ${w} (${state === 'alive' ? 'live' : 'unknown'})` }
    retire.push(w)
  }
  return { retire, blocked: null }
}

function doBind(windowId: string, thread: ThreadSummary, want: string, secret: string | undefined, retire: string[],
    creator: ProcessIdentity): ThreadChoice | null {
  try {
    bind({ windowId, threadId: thread.id, cwd: want, source: 'probed', secretSha256: secret, retire, creator })
    return null
  } catch (e) {
    if (e instanceof BindingConflict) return { ok: false, code: 'conflict', reason: e.message }
    throw e
  }
}

/** The thread a Telegram message for this window goes to.
 *
 *  A binding is created ONLY from an unambiguous probe over a COMPLETE loaded
 *  listing: exactly one loaded root thread whose own plugin answers with this
 *  window id, the window process identifiable (pid + start token), and every
 *  other window bound to that thread verifiably dead. Without
 *  such proof a delivery may still use the single root thread of a folder
 *  (complete loaded AND saved listings, nothing owned by another live window),
 *  but that guess is never persisted. */
export function threadForWindow(cwd: string, windowId?: string, windowSecret?: string, windowPid?: number): Promise<ThreadChoice> {
  return serialized(async () => {
    const want = canon(cwd)
    const id = validWindowId(windowId) ? windowId : undefined
    const secret = secretHash(windowSecret)
    if (id) {
      const bound = await boundThread(id, want, secret)
      if (bound) {
        if (bound.ok) touch(id)
        return bound
      }
    }
    const loaded = await loadedRootThreads(want)
    const owners = new Map<string, string | null>()
    if (id) for (const t of loaded.threads) owners.set(t.id, await windowOfThread(t.id))
    if (id) {
      const mine = loaded.threads.filter(t => owners.get(t.id) === id)
      if (mine.length > 1) return ambiguous(mine.length, 'threads answer as this window')
      if (mine.length === 1) {
        // An unreadable or unlisted loaded thread could ALSO answer as this id.
        if (!loaded.complete) return incomplete
        const start = windowPid ? processStartToken(windowPid) : null
        if (!start) return { ok: false, code: 'conflict', reason: 'the window process cannot be identified (pid/start token); not binding' }
        // The probe proves this plugin connection lives in the thread. A
        // previous window bound to it (e.g. the plugin before a reload) is
        // retired only when its plugin is provably gone.
        const { retire, blocked } = otherOwners(mine[0].id, id)
        if (blocked) return ambiguous(2, `owners of thread ${mine[0].id}: this window and ${blocked}`)
        const refused = doBind(id, mine[0], want, secret, retire, { pid: windowPid!, start })
        return refused ?? { ok: true, thread: mine[0], binding: 'probed' }
      }
    }
    // No proof of ownership: only the single root thread of the folder, and
    // only from complete listings; never persisted.
    if (!loaded.complete) return incomplete
    const saved = await savedRootThreads(want)
    if (!saved.complete) return incomplete
    const union = new Map<string, ThreadSummary>()
    for (const t of [...saved.threads, ...loaded.threads]) union.set(t.id, t)
    const pool: ThreadSummary[] = []
    for (const t of union.values()) {
      const owner = owners.get(t.id)
      if (owner && owner !== id) continue                     // another live plugin's thread
      const { blocked } = otherOwners(t.id, id)
      if (blocked) {
        if (/unknown|malformed/.test(blocked)) return incomplete
        continue                                               // bound to another live window
      }
      pool.push(t)
    }
    if (pool.length > 1) return ambiguous(pool.length)
    if (pool.length === 0) return { ok: false, code: 'none', reason: `no codex thread for this window in ${cwd}` }
    return { ok: true, thread: pool[0], binding: 'single' }
  })
}

/** The thread a (re)launch resumes: the window's bound thread, else the only
 *  saved root conversation of the folder that no live window owns; null =
 *  none (start fresh). Never creates or changes a binding; an automatic pick
 *  is reserved for a short time so two launchers do not both get it, unless
 *  `reserve` is false (a dry run that only reports the pick: -Plan/-Check). */
export function resumeThreadFor(cwd: string, windowId?: string, reserve = true): Promise<ThreadChoice> {
  return serialized(async () => {
    const blocked = bindingsBlocked()
    if (blocked) return { ok: false, code: 'conflict', reason: blocked }
    const want = canon(cwd)
    const id = validWindowId(windowId) ? windowId : undefined
    if (id) {
      const bound = await boundThread(id, want, null)
      if (bound) return bound
    }
    const saved = await savedRootThreads(want)
    if (!saved.complete) return incomplete
    const loaded = await loadedRootThreads(want)
    if (!loaded.complete) return incomplete
    const loadedIds = new Set(loaded.threads.map(t => t.id))
    const pool: ThreadSummary[] = []
    for (const t of saved.threads) {
      const { blocked } = otherOwners(t.id, id)
      if (blocked) {
        if (/unknown|malformed/.test(blocked)) return incomplete
        continue                        // a live window has it: a second UI must not resume it
      }
      // Loaded with a live plugin of an unknown/other window: also taken.
      if (loadedIds.has(t.id)) {
        const owner = await windowOfThread(t.id)
        // A plugin answering inside it is alive: the thread has a window.
        if (owner && owner !== id) continue
      }
      pool.push(t)
    }
    if (pool.length > 1) return ambiguous(pool.length)
    if (pool.length === 0) return { ok: true, thread: null, binding: 'none' }
    // Hand the thread to ONE automatic resume until a window binds it or the
    // reservation expires; a second launcher meanwhile is refused.
    if (!reserve) {
      if (isReserved(pool[0].id)) return { ok: false, code: 'reserved', reason: `thread ${pool[0].id} was just handed to another launch` }
      return { ok: true, thread: pool[0], binding: 'single' }
    }
    try { reserveThread(pool[0].id, `resume:${process.pid}`, id) } catch (e) {
      if (e instanceof BindingConflict) return { ok: false, code: 'reserved', reason: e.message }
      throw e
    }
    return { ok: true, thread: pool[0], binding: 'single' }
  })
}

const processPlatform = process.platform

/** The process's argv as one command line with argument boundaries kept
 *  (arguments with blanks re-quoted). `ps` prints the arguments joined by
 *  spaces, so `codex "help me"` would read as the subcommand `help`. Linux
 *  only (/proc). Returns '' when the process has gone or has no argv (kernel
 *  thread, zombie): nothing to check; null when it cannot be read (other
 *  platforms, or /proc hidden from us). */
export function argvCommandLine(pid: number): string | null {
  if (processPlatform !== 'linux' || !pid) return null
  let raw: string
  try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch (e: any) { return e?.code === 'ENOENT' ? '' : null }
  return raw.split('\0').filter(Boolean).map(a => /[\s"]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a).join(' ')
}

/** A standalone codex TUI (own process, not attached to our server) holding
 *  this cwd — концурентный resume порвёт rollout, отказываемся доставлять. */
function standaloneTuiFor(cwd: string): number | null {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    const proc = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command', script])
    if (proc.exitCode !== 0) throw new Error('cannot check Windows Codex processes; refusing concurrent resume')
    const raw = proc.stdout.toString().trim()
    const parsed = raw ? JSON.parse(raw) : []
    return standaloneWindowsTui(Array.isArray(parsed) ? parsed : [parsed], cwd)
  }
  const out = Bun.spawnSync(['ps', '-axo', 'pid=,command=']).stdout.toString()
  for (const line of out.split('\n')) {
    const process = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!process) continue
    // On Linux the exact argv decides; if it cannot be read there, any codex
    // process counts as a TUI (checked by cwd below) rather than trusting the
    // boundary-less `ps` text. Elsewhere `ps` is all there is (known gap:
    // a quoted prompt starting with a subcommand word reads as that subcommand).
    const argv = argvCommandLine(Number(process[1]))
    const tui = argv !== null ? argv !== '' && isCodexTuiCommand(argv)
      : processPlatform === 'linux' ? isCodexExecutable(process[2]) : isCodexTuiCommand(process[2], false)
    if (!tui) continue
    const pid = Number(process[1])
    if (!pid) continue
    const cwdOut = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout.toString()
    const m = cwdOut.match(/\nn(.+)/)
    if (m && m[1] === cwd) return pid
  }
  return null
}

export async function deliverToCodex(cwd: string, text: string, windowId?: string, windowSecret?: string, windowPid?: number): Promise<{ ok: boolean; reason?: string; thread_id?: string; mode?: string; uncertain?: boolean; binding?: string }> {
  const tuiPid = standaloneTuiFor(cwd)
  if (tuiPid) {
    return { ok: false, reason: `standalone codex TUI (pid ${tuiPid}) holds this cwd — restart it via codex --remote (polydaemon-codex.sh)` }
  }
  const choice = await threadForWindow(cwd, windowId, windowSecret, windowPid)
  if (!choice.ok) return { ok: false, reason: choice.reason, binding: choice.code }
  if (!choice.thread) return { ok: false, reason: `no codex threads for cwd ${cwd}` }
  const th = choice.thread
  const input = [{ type: 'text', text }]
  const st = statusType(th)
  // Active turn → steer (queues into the running turn); idle → start a turn.
  if (st === 'active') {
    try {
      await rpc('turn/steer', { threadId: th.id, input })
      return { ok: true, thread_id: th.id, mode: 'steer' }
    } catch (e) {
      // An explicit refusal (e.g. the turn just ended) means nothing was
      // applied, so starting a turn is safe. No answer means the text may
      // already be in the turn: starting another would deliver it twice.
      if (e instanceof RpcOutcomeUnknown) {
        return { ok: false, uncertain: true, thread_id: th.id, mode: 'steer',
          reason: `${e.message}; the message may already be in the running turn, not sent again` }
      }
    }
  }
  if (st === 'notLoaded') {
    await rpc('thread/resume', { threadId: th.id }).catch(() => { /* resume best-effort; turn/start may load it */ })
  }
  try {
    await rpc('turn/start', { threadId: th.id, input }, 30000)
  } catch (e) {
    if (e instanceof RpcOutcomeUnknown) {
      return { ok: false, uncertain: true, thread_id: th.id, mode: 'turn',
        reason: `${e.message}; the turn may have started, not sent again` }
    }
    throw e
  }
  return { ok: true, thread_id: th.id, mode: 'turn' }
}

/** The window that owns a thread, for error notices: the live plugin of the
 *  window BOUND to it. A thread nobody is bound to goes to the folder's Codex
 *  window only when there is exactly one; otherwise nobody (no guessing by
 *  freshest heartbeat). */
function errorRecipient(threadId: string, cwd: string): LocalRow | null {
  const live = Object.values(readRegistry()).filter(r => !rowIsStale(r) && /-codex$/i.test(r.instance_name || r.workspace_name))
  const owners = windowsBoundTo(threadId)
  if (owners.length) {
    const ids = new Set(owners.filter(o => o.row).map(o => o.windowId))
    const rows = live.filter(r => r.codex_window_id && ids.has(r.codex_window_id))
    return rows.length === 1 ? rows[0] : null
  }
  const rows = live.filter(r => canon(r.cwd) === canon(cwd))
  return rows.length === 1 ? rows[0] : null
}

const reportedErrors = new Set<string>()
export async function notifyCodexError(method: string, params: any): Promise<void> {
  const error = method === 'error' ? params?.error : method === 'turn/completed' ? params?.turn?.error : null
  const threadId = params?.threadId
  if (!error?.message || !threadId) return
  const key = `${threadId}:${params.turnId ?? params.turn?.id ?? ''}:${error.message}`
  if (reportedErrors.has(key)) return
  reportedErrors.add(key)
  try {
    const { thread } = await rpc('thread/read', { threadId }) as { thread: ThreadSummary }
    if (!thread.cwd || thread.ephemeral || thread.source === 'subAgent'
      || (thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source)) {
      reportedErrors.delete(key); return
    }
    const row = errorRecipient(threadId, thread.cwd)
    if (!row) { reportedErrors.delete(key); log(`codex: cannot route error for ${threadId}: no single live owning window`); return }
    if (reportedErrors.size > 256) reportedErrors.delete(reportedErrors.values().next().value!)
    const response = await fetch(`http://${row.host}:${row.port}/notify`, {
      method: 'POST', headers: { Authorization: `Bearer ${row.auth_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'api_error', cwd: thread.cwd, message: error.message, will_retry: params.willRetry === true }),
      signal: AbortSignal.timeout(10000),
    })
    const result = await response.json() as { status?: string }
    if (!response.ok || result.status !== 'ok') throw new Error(`notify failed: ${response.status}/${result.status}`)
  } catch (error) { reportedErrors.delete(key); throw error }
}

/** Resume target for a launcher; throws on ambiguity/missing binding. */
export async function lastThreadFor(cwd: string, windowId?: string, reserve = true): Promise<string | null> {
  const choice = await resumeThreadFor(cwd, windowId, reserve)
  if (!choice.ok) throw new ThreadChoiceRefused(choice.reason, choice.code)
  return choice.thread?.id ?? null
}

export class ThreadChoiceRefused extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

export async function codexStatus(): Promise<Record<string, unknown>> {
  const up = await healthy()
  if (!up) return { app_server: 'down', ws_port: WS_PORT }
  let loaded: unknown = null
  try { loaded = await rpc('thread/loaded/list', {}) } catch (e) { loaded = String(e) }
  return { app_server: 'up', ws_port: WS_PORT, loaded }
}
