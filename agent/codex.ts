// Codex adapter: the daemon OWNS a `codex app-server` (WebSocket on loopback)
// and delivers Telegram inbound into Codex threads via turn/start — the push
// channel Codex itself lacks. TUIs attach to the same server with `codex --remote`, so a turn
// started here is visible live in the user's terminal.
//
// Delivery contract (POST /v1/codex/deliver): {cwd, text} → resume the most
// recent thread with that cwd and start (or steer) a turn. A thread held open
// by a STANDALONE codex TUI (not --remote) is refused: two processes writing
// one rollout corrupt state — the caller falls back to the queue + hint.
import { spawn, type Subprocess } from 'bun'
import { log } from './log.ts'
import { canonicalWindowsPath, isCodexTuiCommand, standaloneWindowsTui } from './windows-codex.ts'
import { readRegistry, rowIsStale } from './registry.ts'

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
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

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
      ws = null
      for (const p of pending.values()) p.reject(new Error('codex ws closed'))
      pending.clear()
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
      reject(new Error(`codex rpc ${method}: timeout`))
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

async function threadsFor(cwd: string, includeLoaded = true): Promise<ThreadSummary[]> {
  const want = canon(cwd)
  const matches = (t: ThreadSummary | null): t is ThreadSummary =>
    !!t && !!t.cwd && canon(t.cwd) === want && !t.ephemeral
    && !(t.source && typeof t.source === 'object' && 'subAgent' in t.source)
    && t.source !== 'subAgent'
  // Delivery can target a fresh TUI before its first persisted turn; resume cannot.
  if (includeLoaded) {
    const loaded = await rpc('thread/loaded/list', {}) as { data?: string[] }
    const summaries = await Promise.all((loaded.data ?? []).map(async id => {
      try {
        const r = await rpc('thread/read', { threadId: id }) as { thread: ThreadSummary }
        return r.thread
      } catch { return null } // a thread may unload between list and read
    }))
    const live = summaries.filter(matches)
    if (live.length) {
      return live.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    }
  }
  // Filter before pagination, using the same physical path as the launcher.
  const res = await rpc('thread/list', { cwd: want, sortKey: 'recency_at', limit: 100 }) as { data?: ThreadSummary[]; threads?: ThreadSummary[]; items?: ThreadSummary[] }
  const all = (res.data ?? res.threads ?? res.items ?? []) as ThreadSummary[]
  return all.filter(matches)
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
    if (!process || !isCodexTuiCommand(process[2])) continue
    const pid = Number(process[1])
    if (!pid) continue
    const cwdOut = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout.toString()
    const m = cwdOut.match(/\nn(.+)/)
    if (m && m[1] === cwd) return pid
  }
  return null
}

export async function deliverToCodex(cwd: string, text: string): Promise<{ ok: boolean; reason?: string; thread_id?: string; mode?: string }> {
  const tuiPid = standaloneTuiFor(cwd)
  if (tuiPid) {
    return { ok: false, reason: `standalone codex TUI (pid ${tuiPid}) holds this cwd — restart it via codex --remote (polydaemon-codex.sh)` }
  }
  const threads = await threadsFor(cwd)
  if (threads.length === 0) {
    return { ok: false, reason: `no codex threads for cwd ${cwd}` }
  }
  const th = threads[0]
  const input = [{ type: 'text', text }]
  const st = statusType(th)
  // Active turn → steer (queues into the running turn); idle → start a turn.
  if (st === 'active') {
    try {
      await rpc('turn/steer', { threadId: th.id, input })
      return { ok: true, thread_id: th.id, mode: 'steer' }
    } catch { /* fall through to turn/start */ }
  }
  if (st === 'notLoaded') {
    await rpc('thread/resume', { threadId: th.id }).catch(() => { /* resume best-effort; turn/start may load it */ })
  }
  await rpc('turn/start', { threadId: th.id, input }, 30000)
  return { ok: true, thread_id: th.id, mode: 'turn' }
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
    const row = Object.values(readRegistry()).filter(r =>
      !rowIsStale(r) && /-codex$/i.test(r.instance_name || r.workspace_name)
      && canon(r.cwd) === canon(thread.cwd!),
    ).sort((a, b) => b.heartbeat_at - a.heartbeat_at)[0]
    if (!row) { reportedErrors.delete(key); log(`codex: cannot route error for ${threadId}: no live owning window`); return }
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

export async function lastThreadFor(cwd: string): Promise<string | null> {
  const threads = await threadsFor(cwd, false)
  return threads.length ? threads[0].id : null
}

export async function codexStatus(): Promise<Record<string, unknown>> {
  const up = await healthy()
  if (!up) return { app_server: 'down', ws_port: WS_PORT }
  let loaded: unknown = null
  try { loaded = await rpc('thread/loaded/list', {}) } catch (e) { loaded = String(e) }
  return { app_server: 'up', ws_port: WS_PORT, loaded }
}
