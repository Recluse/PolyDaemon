import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as registry from './registry.ts'
import { processStartToken } from './proc-token.ts'

// Window → thread binding: delivery and resume follow the window's own thread,
// never "the thread of this folder that was updated last".
//
// codex.ts keeps one module-level connection; every fake socket a test opened
// is closed in finally so the next test (here or in another file) reconnects.

const CWD = '/work/binding-project'
const W1 = 'codex-window-one-0001'
const W2 = 'codex-window-two-0002'
// Plugin process identities: this test process is a real, live "plugin";
// the same pid with another start token is verifiably a dead one.
const PID = process.pid
const ALIVE = { pid: PID, start: processStartToken(PID) ?? 'unavailable' }
const DEAD = { pid: PID, start: 'a-process-that-has-exited' }
const S1 = 'secret-of-window-one-000000000001'
const S2 = 'secret-of-window-two-000000000002'

// The local registry is agentd's proof that a window's plugin is alive.
let registrySpy: any = null
function liveWindows(ids: string[] | 'unreadable') {
  registrySpy?.mockRestore()
  registrySpy = null
  if (!('readRegistryStrict' in registry)) return   // (older code under test)
  registrySpy = spyOn(registry, 'readRegistryStrict').mockImplementation(() => {
    if (ids === 'unreadable') throw new Error('registry unreadable')
    return Object.fromEntries(ids.map((id, i) => [`row${i}`, { instance_name: 'binding-project-codex', workspace_name: 'binding-project-codex',
      cwd: CWD, host: '127.0.0.1', port: 3300 + i, auth_token: 't', pid: process.pid, parent_pid: 1, started_at: '',
      heartbeat_at: Date.now() / 1000, codex_window_id: id }])) as any
  })
}

type Thread = { id: string; cwd: string; updatedAt?: number; status?: any; source?: any; ephemeral?: boolean; parentThreadId?: string }

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TG_TEST_SCRATCH || tmpdir(), 'codex-binding-'))
  process.env.TG_CODEX_BINDINGS = join(dir, 'codex-bindings.v2.json')
  liveWindows([W1, W2])
})
afterEach(() => {
  registrySpy?.mockRestore(); registrySpy = null
  delete process.env.TG_CODEX_BINDINGS
  rmSync(dir, { recursive: true, force: true })
})

function seed(rows: Record<string, string>, creator: any = ALIVE) {
  writeFileSync(process.env.TG_CODEX_BINDINGS!, JSON.stringify(Object.fromEntries(Object.entries(rows).map(
    ([w, t]) => [w, { thread_id: t, cwd: CWD, bound_at: Date.now(), source: 'probed', ...(creator ? { creator } : {}) }]))))
}
function stored(): Record<string, any> {
  const f = process.env.TG_CODEX_BINDINGS!
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}

/** A fake app-server. `pages` drives thread/list; `owners` answers the
 *  bridge_status probe per thread (absent = old plugin, no window_id). */
function fakeServer(opts: {
  threads: Record<string, Thread>
  loaded?: string[]
  loadedCursor?: boolean        // false = server omits nextCursor
  pages?: Thread[][]            // thread/list pages, cursor = page index
  endlessPages?: boolean
  owners?: Record<string, string> | ((threadId: string) => string | undefined)
  readErrors?: string[]
}) {
  const sent: { method: string; params: any }[] = []
  const sockets: any[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: any; onmessage: any; onclose: any
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()) }
    send(raw: string) {
      const m = JSON.parse(raw)
      sent.push(m)
      const reply: any = { id: m.id, result: {} }
      if (m.method === 'thread/loaded/list') {
        reply.result = opts.loadedCursor === false ? { data: opts.loaded ?? [] } : { data: opts.loaded ?? [], nextCursor: null }
      } else if (m.method === 'thread/read') {
        const t = opts.readErrors?.includes(m.params.threadId) ? undefined : opts.threads[m.params.threadId]
        if (t) reply.result = { thread: t }
        else { delete reply.result; reply.error = { message: `thread not found: ${m.params.threadId}` } }
      } else if (m.method === 'thread/list') {
        const at = Number(m.params.cursor ?? 0)
        if (opts.endlessPages) reply.result = { data: [], nextCursor: String(at + 1) }
        else {
          const pages = opts.pages ?? [[]]
          reply.result = { data: pages[at] ?? [], nextCursor: at + 1 < pages.length ? String(at + 1) : null }
        }
      } else if (m.method === 'mcpServer/tool/call') {
        const owner = typeof opts.owners === 'function' ? opts.owners(m.params.threadId) : opts.owners?.[m.params.threadId]
        const data = { version: 1, root: CWD, ...(owner ? { window_id: owner } : {}) }
        reply.result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false }
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    }
  }
  const originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  // Codex process scans are stubbed empty; the process start-token lookups of
  // proc-token.ts (`ps -o lstart=` on macOS, Get-Process -Id on Windows) go to
  // the real OS, so binding checks see live pids as alive on every platform.
  const realSpawnSync = Bun.spawnSync.bind(Bun)
  const isStartTokenQuery = (cmd: unknown): boolean => Array.isArray(cmd)
    && ((cmd[0] === 'ps' && cmd.includes('lstart='))
      || (cmd[0] === 'powershell' && cmd.some((a: unknown) => typeof a === 'string' && a.includes('Get-Process -Id'))))
  const processes = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: any, ...rest: any[]) =>
    isStartTokenQuery(cmd) ? (realSpawnSync as any)(cmd, ...rest) : ({ stdout: Buffer.from(''), exitCode: 0 } as any)) as any)
  return {
    sent,
    turns: () => sent.filter(m => m.method === 'turn/start' || m.method === 'turn/steer').map(m => m.params.threadId),
    restore() {
      for (const s of sockets) { if (s.readyState !== 3) { s.readyState = 3; s.onclose?.() } }
      globalThis.WebSocket = originalWebSocket
      processes.mockRestore()
    },
  }
}

const idle = { type: 'idle' }
const two = (): Record<string, Thread> => ({
  // `newer` is updated last: the old code delivered everything to it.
  older: { id: 'older', cwd: CWD, updatedAt: 10, status: idle, source: 'cli' },
  newer: { id: 'newer', cwd: CWD, updatedAt: 99, status: idle, source: 'cli' },
})

/** A child process that holds the bindings lock until killed. */
async function holdLockInChild() {
  const db = process.env.TG_CODEX_BINDINGS + '.lock.db'
  const code = `const { Database } = require('bun:sqlite'); const d = new Database(${JSON.stringify(db)}, { create: true });`
    + ` d.exec('BEGIN EXCLUSIVE'); console.log('held'); setInterval(() => {}, 1000)`
  const proc = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'inherit' })
  const reader = proc.stdout.getReader()
  const first = await reader.read()
  if (!new TextDecoder().decode(first.value).includes('held')) throw new Error('lock holder did not start')
  reader.releaseLock()
  return proc
}

test('two windows of the same agent in one folder each get their own bound thread', async () => {
  seed({ [W1]: 'older', [W2]: 'newer' })
  const srv = fakeServer({ threads: two(), loaded: ['older', 'newer'] })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect(await deliverToCodex(CWD, 'to one', W1)).toMatchObject({ ok: true, thread_id: 'older' })
    expect(await deliverToCodex(CWD, 'to two', W2)).toMatchObject({ ok: true, thread_id: 'newer' })
    expect(srv.turns()).toEqual(['older', 'newer'])
  } finally { srv.restore() }
})

test('unbound windows are bound by their own plugin, not by recency', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['newer', 'older'], owners: { older: W1, newer: W2 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect(await deliverToCodex(CWD, 'hi', W1, S1, PID)).toMatchObject({ ok: true, thread_id: 'older' })
    expect(await deliverToCodex(CWD, 'hi', W2, S2, PID)).toMatchObject({ ok: true, thread_id: 'newer' })
    expect(stored()[W1].thread_id).toBe('older')
    expect(stored()[W2].thread_id).toBe('newer')
    expect(stored()[W1].source).toBe('probed')
    expect(stored()[W1].secret_sha256).toMatch(/^[0-9a-f]{64}$/)
  } finally { srv.restore() }
})

test('an unbound window with two candidate threads is refused, not sent to the newest', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['older', 'newer'] })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ambiguous: 2 codex threads in this folder')
    expect(srv.turns()).toEqual([])
    expect(stored()).toEqual({})
    // A legacy plugin without a window id gets the same refusal.
    expect((await deliverToCodex(CWD, 'hi')).ok).toBe(false)
    expect(srv.turns()).toEqual([])
  } finally { srv.restore() }
})

test('one candidate: persisted only when its own plugin confirms it, otherwise used but never persisted', async () => {
  const threads: Record<string, Thread> = {
    only: { id: 'only', cwd: CWD, updatedAt: 1, status: idle, source: 'cli' },
    child: { id: 'child', cwd: CWD, updatedAt: 50, status: idle, source: { subAgent: {} }, parentThreadId: 'only' },
    exec: { id: 'exec', cwd: CWD, updatedAt: 60, status: idle, source: 'exec' },
    temp: { id: 'temp', cwd: CWD, updatedAt: 70, status: idle, source: 'cli', ephemeral: true },
  }
  const pages = [[threads.only, threads.child, threads.exec, threads.temp]]
  const srv = fakeServer({ threads, loaded: ['child', 'exec', 'temp', 'only'], pages })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect(await deliverToCodex(CWD, 'hi', W1, S1, PID)).toMatchObject({ ok: true, thread_id: 'only' })
    expect(stored()).toEqual({})          // a probe without an answer never creates a binding
  } finally { srv.restore() }
  const probed = fakeServer({ threads, loaded: ['child', 'exec', 'temp', 'only'], pages, owners: { only: W1 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect(await deliverToCodex(CWD, 'hi', W1, S1, PID)).toMatchObject({ ok: true, thread_id: 'only' })
    expect(stored()[W1]).toMatchObject({ thread_id: 'only', source: 'probed' })
  } finally { probed.restore() }
})

test('a loaded listing without nextCursor never authorizes adoption', async () => {
  const threads = { only: { id: 'only', cwd: CWD, status: idle, source: 'cli' } }
  const srv = fakeServer({ threads, loaded: ['only'], loadedCursor: false })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('incomplete')
    expect(stored()).toEqual({})
  } finally { srv.restore() }
})

test('a bound thread that is gone is refused and the binding is not replaced', async () => {
  seed({ [W1]: 'vanished' })
  const srv = fakeServer({ threads: { other: { id: 'other', cwd: CWD, status: idle, source: 'cli' } }, loaded: ['other'],
    pages: [[{ id: 'other', cwd: CWD }]] })
  try {
    const { deliverToCodex, lastThreadFor } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('bound thread vanished')
    expect(srv.turns()).toEqual([])
    await expect(lastThreadFor(CWD, W1)).rejects.toThrow('bound thread vanished')
    expect(stored()[W1].thread_id).toBe('vanished')
  } finally { srv.restore() }
})

test('a root thread behind more than 100 child threads is found by following nextCursor', async () => {
  const children = Array.from({ length: 100 }, (_, i) =>
    ({ id: `child${i}`, cwd: CWD, source: { subAgent: {} }, parentThreadId: 'root' }))
  const pages = [children, [{ id: 'root', cwd: CWD, source: 'cli' }]]
  const threads = { root: { id: 'root', cwd: CWD, status: { type: 'notLoaded' }, source: 'cli' } }
  const srv = fakeServer({ threads, loaded: [], pages })
  try {
    const { lastThreadFor, deliverToCodex } = await import('./codex.ts')
    expect(await lastThreadFor(CWD)).toBe('root')
    expect(srv.sent.filter(m => m.method === 'thread/list').map(m => m.params.cursor ?? null)).toEqual([null, '1'])
    expect(await deliverToCodex(CWD, 'hi', W1)).toMatchObject({ ok: true, thread_id: 'root' })
    expect(stored()).toEqual({})
  } finally { srv.restore() }
})

test('resume refuses an ambiguous folder and a listing truncated by the page cap', async () => {
  const srv = fakeServer({ threads: {}, pages: [[{ id: 'a', cwd: CWD, source: 'cli' }], [{ id: 'b', cwd: CWD, source: 'cli' }]] })
  try {
    const { lastThreadFor } = await import('./codex.ts')
    await expect(lastThreadFor(CWD)).rejects.toThrow('ambiguous: 2 codex threads')
  } finally { srv.restore() }
  const endless = fakeServer({ threads: {}, endlessPages: true })
  try {
    const { lastThreadFor } = await import('./codex.ts')
    await expect(lastThreadFor(CWD)).rejects.toThrow('incomplete')
    expect(endless.sent.filter(m => m.method === 'thread/list').length).toBe(20)
  } finally { endless.restore() }
})

// ── review round: reload, resume ownership, incomplete reads, races, store ──

test('plugin reload: a new plugin id takes over its thread only when the old PROCESS is verifiably dead', async () => {
  // Gate (a)/(b): a reload or a pinned /restart puts a NEW plugin id (W2) into
  // the thread the previous id (W1) was bound to.
  seed({ [W1]: 'older' }, ALIVE)
  liveWindows([])                             // W1's registry row is gone (reaper, lost write) ...
  const srv = fakeServer({ threads: two(), loaded: ['older'], owners: { older: W2 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W2, S2, PID)
    expect(r.ok).toBe(false)                  // ... but its process is alive: refused
    expect(r.reason).toContain('ambiguous')
    expect(stored()[W1].thread_id).toBe('older')
    expect(stored()[W2]).toBeUndefined()
    seed({ [W1]: 'older' }, null)             // a row without a creator: unknown -> refused
    expect((await deliverToCodex(CWD, 'hi', W2, S2, PID)).ok).toBe(false)
    expect(stored()[W1].thread_id).toBe('older')
    seed({ [W1]: 'older' }, DEAD)             // the old plugin process is gone
    expect(await deliverToCodex(CWD, 'hi', W2, S2, PID)).toMatchObject({ ok: true, thread_id: 'older' })
    expect(stored()[W1]).toBeUndefined()
    expect(stored()[W2]).toMatchObject({ thread_id: 'older', source: 'probed', creator: ALIVE })
    expect(srv.turns()).toEqual(['older'])
  } finally { srv.restore() }
})

test('resume never returns a thread a live window owns and never writes a binding', async () => {
  // Gate (d): a second UI in the folder must not attach to the first's thread.
  seed({ [W1]: 'older' })
  const pages = [[two().older, two().newer]]
  const srv = fakeServer({ threads: two(), loaded: ['older'], pages, owners: { older: W1 } })
  process.env.TG_CODEX_RESERVE_MS = '0'      // reservations are tested separately
  try {
    const { lastThreadFor } = await import('./codex.ts')
    expect(await lastThreadFor(CWD)).toBe('newer')
    expect(await lastThreadFor(CWD, W2)).toBe('newer')
    expect(stored()[W2]).toBeUndefined()
  } finally { srv.restore() }
  seed({ [W1]: 'older' }, DEAD)              // W1's process is gone and nothing answers in its thread
  const free = fakeServer({ threads: two(), loaded: [], pages })
  try {
    const { lastThreadFor } = await import('./codex.ts')
    await expect(lastThreadFor(CWD)).rejects.toThrow('ambiguous: 2')
  } finally { free.restore(); delete process.env.TG_CODEX_RESERVE_MS }
})

test('a loaded thread that cannot be read makes the listing incomplete', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['older', 'newer'], readErrors: ['newer'], pages: [[two().older]] })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('incomplete')
    expect(srv.turns()).toEqual([])
  } finally { srv.restore() }
})

test('saved-but-unloaded threads count before a single candidate is declared', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['newer'], pages: [[two().newer, two().older]] })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1, S1, PID)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ambiguous: 2')
  } finally { srv.restore() }
})

test('two windows resolving at once cannot both bind one thread', async () => {
  // Gate (c): one thread whose probe answers different ids (two MCP managers).
  let calls = 0
  const threads = { only: { id: 'only', cwd: CWD, status: idle, source: 'cli' } }
  const srv = fakeServer({ threads, loaded: ['only'], pages: [[threads.only]], owners: () => (calls++ % 2 ? W2 : W1) })
  try {
    const { threadForWindow } = await import('./codex.ts')
    const [a, b] = await Promise.all([threadForWindow(CWD, W1, S1, PID), threadForWindow(CWD, W2, S2, PID)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const rows = stored()
    expect(Object.keys(rows)).toEqual([W1])
    expect(rows[W1].thread_id).toBe('only')
  } finally { srv.restore() }
})

test('the store locks, never rebinds a window, keeps live windows and refuses malformed rows', async () => {
  const { bind, BindingConflict, readBinding } = await import('./codex-bindings.ts')
  bind({ windowId: W1, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })
  expect(() => bind({ windowId: W1, threadId: 'b', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow(BindingConflict)
  expect(() => bind({ windowId: W2, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow(BindingConflict)
  expect(stored()[W1].thread_id).toBe('a')
  // A lock held by a live process blocks; the OS drops it when the holder dies.
  const holder = await holdLockInChild()
  process.env.TG_CODEX_BINDINGS_LOCK_WAIT_MS = '100'
  try {
    expect(() => bind({ windowId: W2, threadId: 'b', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow('locked')
  } finally { delete process.env.TG_CODEX_BINDINGS_LOCK_WAIT_MS }
  holder.kill(9)
  await holder.exited
  bind({ windowId: W2, threadId: 'b', cwd: CWD, source: 'probed', creator: ALIVE })
  // Eviction removes only long-unseen windows whose process is verifiably dead.
  const old = Date.now() - 3 * 24 * 3600 * 1000
  writeFileSync(process.env.TG_CODEX_BINDINGS!, JSON.stringify({
    'codex-live-window-01': { thread_id: 'l', cwd: CWD, bound_at: old, last_seen: old, source: 'probed', creator: ALIVE },
    'codex-dead-window-02': { thread_id: 'd', cwd: CWD, bound_at: old, last_seen: old, source: 'probed', creator: DEAD },
  }))
  process.env.TG_CODEX_BINDINGS_MAX = '2'
  try {
    bind({ windowId: W1, threadId: 'n', cwd: CWD, source: 'probed', creator: ALIVE })
    expect(Object.keys(stored()).sort()).toEqual([W1, 'codex-live-window-01'].sort())
    expect(() => bind({ windowId: W2, threadId: 'm', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow('not verifiably gone')
  } finally { delete process.env.TG_CODEX_BINDINGS_MAX }
  writeFileSync(process.env.TG_CODEX_BINDINGS!, JSON.stringify({ [W1]: { thread_id: 42 } }))
  expect(readBinding(W1).state).toBe('malformed')
  expect(() => bind({ windowId: W1, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow('malformed')
})

test('a malformed binding refuses delivery instead of being replaced', async () => {
  writeFileSync(process.env.TG_CODEX_BINDINGS!, JSON.stringify({ [W1]: { thread_id: 'older' } }))
  const srv = fakeServer({ threads: two(), loaded: ['older'], owners: { older: W1 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1, S1, PID)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('malformed')
    expect(stored()[W1]).toEqual({ thread_id: 'older' })
  } finally { srv.restore() }
})

test('a binding answers only to the secret of the plugin that created it', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['older'], owners: { older: W1 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect((await deliverToCodex(CWD, 'hi', W1, S1, PID)).ok).toBe(true)
    for (const secret of [undefined, S2]) {
      const r = await deliverToCodex(CWD, 'forged', W1, secret, PID)
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('secret')
    }
    expect(srv.turns()).toEqual(['older'])
  } finally { srv.restore() }
})

test('API error notices go to the window bound to the thread, never the freshest heartbeat', async () => {
  seed({ [W2]: 'older' })
  const rows = {
    one: { instance_name: 'binding-project-codex', cwd: CWD, host: '127.0.0.1', port: 3301, auth_token: 't',
      heartbeat_at: Date.now() / 1000 + 5, codex_window_id: W1 },
    two: { instance_name: 'binding-project-codex', cwd: CWD, host: '127.0.0.1', port: 3302, auth_token: 't',
      heartbeat_at: Date.now() / 1000, codex_window_id: W2 },
  }
  const spy = spyOn(registry, 'readRegistry').mockReturnValue(rows as any)
  const posts: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => { posts.push(String(url)); return Response.json({ status: 'ok' }) }) as typeof fetch
  const srv = fakeServer({ threads: two(), loaded: ['older', 'newer'] })
  try {
    const { notifyCodexError } = await import('./codex.ts')
    const error = { message: 'capacity' }
    await notifyCodexError('error', { threadId: 'older', turnId: 't1', error })
    expect(posts).toEqual(['http://127.0.0.1:3302/notify'])
    await notifyCodexError('error', { threadId: 'newer', turnId: 't2', error })   // unbound, two windows
    expect(posts).toHaveLength(1)
  } finally { srv.restore(); spy.mockRestore(); globalThis.fetch = originalFetch }
})

test('concurrent agentd processes do not lose each other\'s bindings', async () => {
  const script = join(dir, 'binder.ts')
  writeFileSync(script, `import { bind } from ${JSON.stringify(join(import.meta.dir, 'codex-bindings.ts'))}
import { processStartToken } from ${JSON.stringify(join(import.meta.dir, 'proc-token.ts'))}
const creator = { pid: process.pid, start: processStartToken(process.pid) }
const [prefix] = process.argv.slice(2)
for (let i = 0; i < 25; i++) bind({ windowId: \`codex-\${prefix}-window-\${i}\`, threadId: \`\${prefix}-t\${i}\`, cwd: '/w', source: 'probed', creator })
`)
  const env = { ...process.env, TG_CODEX_BINDINGS: process.env.TG_CODEX_BINDINGS! }
  const procs = ['a', 'b', 'c'].map(p => Bun.spawn([process.execPath, script, p], { env, stdout: 'ignore', stderr: 'pipe' }))
  const codes = await Promise.all(procs.map(p => p.exited))
  expect(codes).toEqual([0, 0, 0])
  expect(Object.keys(stored())).toHaveLength(75)
}, 20000)

// ── round 3: probe needs a complete listing, lock ownership, reservations ──

test('a positive probe does not bind while another loaded thread could not be read', async () => {
  const srv = fakeServer({ threads: two(), loaded: ['older', 'newer'], readErrors: ['newer'], owners: { older: W1 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const r = await deliverToCodex(CWD, 'hi', W1, S1, PID)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('incomplete')
    expect(stored()).toEqual({})
    expect(srv.turns()).toEqual([])
  } finally { srv.restore() }
  const twice = fakeServer({ threads: two(), loaded: ['older', 'newer'], owners: { older: W1, newer: W1 } })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect((await deliverToCodex(CWD, 'hi', W1, S1, PID)).reason).toContain('answer as this window')
    expect(stored()).toEqual({})
  } finally { twice.restore() }
})

test('the lock is an OS lock: a paused holder keeps it, nobody takes it over, death releases it', async () => {
  const { bind } = await import('./codex-bindings.ts')
  process.env.TG_CODEX_BINDINGS_LOCK_WAIT_MS = '200'
  const holder = await holdLockInChild()
  try {
    // A paused holder (SIGSTOP between taking the lock and writing) is still
    // the holder, however long it sleeps: no age or pid judgement breaks in.
    if (process.platform !== 'win32') holder.kill('SIGSTOP')
    expect(() => bind({ windowId: W1, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow('locked')
    expect(() => bind({ windowId: W1, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })).toThrow('locked')
    expect(stored()).toEqual({})
  } finally {
    holder.kill(9)
    await holder.exited
    delete process.env.TG_CODEX_BINDINGS_LOCK_WAIT_MS
  }
  bind({ windowId: W1, threadId: 'a', cwd: CWD, source: 'probed', creator: ALIVE })
  expect(stored()[W1].thread_id).toBe('a')
})

test('agentd imports the old store once at start and refuses when it changed afterwards', async () => {
  const { bind, readBinding, migrateBindingsStore } = await import('./codex-bindings.ts')
  const NONE = () => []
  const { join, dirname } = await import('node:path')
  const { utimesSync } = await import('node:fs')
  const v2 = process.env.TG_CODEX_BINDINGS!
  const legacy = join(dirname(v2), 'codex-bindings.json')
  const oldRows = { [W2]: { thread_id: 'old-t', cwd: CWD, bound_at: 1, last_seen: 1, source: 'probed', creator: ALIVE } }
  writeFileSync(legacy, JSON.stringify(oldRows))
  try {
    expect(migrateBindingsStore(NONE)).toBeNull()
    expect(readBinding(W2)).toEqual({ state: 'ok', row: oldRows[W2] as any })
    bind({ windowId: W1, threadId: 'new-t', cwd: CWD, source: 'probed', creator: ALIVE })
    expect(Object.keys(stored()).sort()).toEqual([W1, W2].sort())
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual(oldRows)          // never written
    expect(migrateBindingsStore(NONE)).toBeNull()                                    // restart: nothing to do
    // Same content with a newer mtime (touch, copy) is not a change.
    const later = new Date(Date.now() + 60_000)
    utimesSync(legacy, later, later)
    expect(migrateBindingsStore(NONE)).toBeNull()
    // An import interrupted after its pending marker is repeated when the old
    // file is the one it was importing; otherwise refused, never overwritten.
    writeFileSync(v2 + '.imported', 'pending:' + 'x'.repeat(64))
    expect(migrateBindingsStore(NONE)).toContain('interrupted')
    const { createHash } = await import('node:crypto')
    writeFileSync(v2 + '.imported', 'pending:' + createHash('sha256').update(readFileSync(legacy)).digest('hex'))
    expect(migrateBindingsStore(NONE)).toBeNull()
    expect(readBinding(W2).state).toBe('ok')
    // A store without any marker next to an old file proves nothing: refused,
    // and never overwritten (a binding made here survives).
    bind({ windowId: 'codex-made-here-4', threadId: 'here', cwd: CWD, source: 'probed', creator: ALIVE })
    rmSync(v2 + '.imported')
    expect(migrateBindingsStore(NONE)).toContain('marker')
    expect(stored()['codex-made-here-4'].thread_id).toBe('here')
    // The operator re-imports by deleting the v2 store.
    rmSync(v2)
    expect(migrateBindingsStore(NONE)).toBeNull()
    expect(readBinding(W2).state).toBe('ok')
    // A damaged marker refuses while there is an old file.
    writeFileSync(v2 + '.imported', 'damaged')
    expect(migrateBindingsStore(NONE)).toContain('Stop every old agentd')
    rmSync(v2 + '.imported'); rmSync(v2); expect(migrateBindingsStore(NONE)).toBeNull()   // operator re-imports
    // A failure inside the migration (marker cannot be written) refuses too.
    rmSync(v2 + '.imported'); rmSync(v2); mkdirSync(v2 + '.imported')
    expect(migrateBindingsStore(NONE)).toContain('migration failed')
    expect(() => readBinding(W2)).toThrow('migration failed')
    rmSync(v2 + '.imported', { recursive: true }); expect(migrateBindingsStore(NONE)).toBeNull()
    bind({ windowId: W1, threadId: 'new-t', cwd: CWD, source: 'probed', creator: ALIVE })
    // An old agentd ran meanwhile and changed its file (even keeping the old
    // mtime): every decision refuses, resume included.
    writeFileSync(legacy, JSON.stringify({ ...oldRows, 'codex-late-window-9': { ...oldRows[W2], thread_id: 'late' } }))
    utimesSync(legacy, later, later)
    expect(migrateBindingsStore(NONE)).toContain('Stop every old agentd')
    expect(() => readBinding(W1)).toThrow('Stop every old agentd')
    expect(() => bind({ windowId: 'codex-other-window-3', threadId: 'x', cwd: CWD, source: 'probed', creator: ALIVE }))
      .toThrow('Stop every old agentd')
    const { resumeThreadFor } = await import('./codex.ts')
    expect(await resumeThreadFor(CWD)).toMatchObject({ ok: false })
    // The operator keeps the new store by removing the old file, even with a
    // damaged or missing marker; our store is never overwritten by an empty import.
    rmSync(legacy)
    writeFileSync(v2 + '.imported', 'damaged')
    expect(migrateBindingsStore(NONE)).toBeNull()
    rmSync(v2 + '.imported')
    expect(migrateBindingsStore(NONE)).toBeNull()
    expect(readBinding(W1).state).toBe('ok')
    // No new store yet and a corrupt old one: refused, never "no bindings".
    rmSync(v2)
    writeFileSync(legacy, '{not json')
    expect(migrateBindingsStore(NONE)).toContain('unreadable')
    expect(() => readBinding(W2)).toThrow()
  } finally {
    for (const f of [legacy, v2, v2 + '.imported']) rmSync(f, { force: true })
    expect(migrateBindingsStore(NONE)).toBeNull()
  }
})

test('another agentd blocks binding decisions: an old one by its process, a new one by the instance lock', async () => {
  const { migrateBindingsStore, readBinding, otherAgentdProcesses } = await import('./codex-bindings.ts')
  // The filter: other processes running agentd, never this one.
  // A script named agentd counts; the name among other arguments does not; an
  // unreadable command line of this user's process is a possible agentd.
  expect(otherAgentdProcesses(() => [{ pid: 11, command: 'bun run lint.ts agent/agentd.ts' },
    { pid: 12, command: 'bun test --test-name-pattern agentd.ts' }, { pid: 13, command: null },
    { pid: 14, command: 'cat agent/agentd.ts' }, { pid: 15, command: '/usr/bin/bun --cwd /tmp run agent/agentd.ts' },
    { pid: 16, command: 'C:\\Users\\me\\bun.exe run C:\\Work\\x\\clients\\..\\agent\\agentd.ts' }]).map(p => p.pid))
    .toEqual([13, 15, 16])
  expect(otherAgentdProcesses(() => [{ pid: process.pid, command: 'bun run agent/agentd.ts' },
    { pid: 4242, command: 'bun run C:\\Work\\old\\agent\\agentd.ts' }, { pid: 7, command: 'bun run server.ts' }]))
    .toEqual([{ pid: 4242, command: 'bun run C:\\Work\\old\\agent\\agentd.ts' }])
  try {
    expect(migrateBindingsStore(() => [{ pid: 4242, command: 'bun run agent/agentd.ts' }])).toContain('another agentd is running')
    expect(() => readBinding(W1)).toThrow('another agentd is running')
    expect(migrateBindingsStore(() => { throw new Error('ps timed out') })).toContain('cannot check')
    expect(migrateBindingsStore(() => { throw new Error('ps failed') })).toContain('cannot check')
  } finally { expect(migrateBindingsStore(() => [])).toBeNull() }
  // A second NEW agentd process on the same store (other port, same home).
  const db = process.env.TG_CODEX_BINDINGS + '.instance.db'
  const code = `const { migrateBindingsStore } = await import(${JSON.stringify(import.meta.dir + '/codex-bindings.ts')});`
    + ` console.log(migrateBindingsStore(() => []) ?? 'ok')`
  const child = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env } })
  expect(child.stdout.toString()).toContain('another agentd already serves')
  expect(db.length).toBeGreaterThan(0)
})

test('a thread the replaced old agentd just reserved is not handed out again', async () => {
  const { reserveThread, isReserved, BindingConflict } = await import('./codex-bindings.ts')
  const { join, dirname } = await import('node:path')
  const legacyRes = join(dirname(process.env.TG_CODEX_BINDINGS!), 'codex-bindings.reservations.json')
  writeFileSync(legacyRes, JSON.stringify({ T: { until: Date.now() + 60_000, by: 'old-agentd' } }))
  try {
    expect(isReserved('T')).toBe(true)
    expect(() => reserveThread('T', 'new-launch')).toThrow(BindingConflict)
    // Once a window here binds T, the old reservation no longer counts.
    const { bind } = await import('./codex-bindings.ts')
    bind({ windowId: W1, threadId: 'T', cwd: CWD, source: 'probed', creator: ALIVE })
    expect(isReserved('T')).toBe(false)
  } finally { rmSync(legacyRes, { force: true }) }
})

test('a reservation re-checks bindings under the lock (another agentd bound the thread meanwhile)', async () => {
  const { bind, reserveThread, BindingConflict, isReserved } = await import('./codex-bindings.ts')
  // Launcher 1 reserved T, its window bound T (which clears the reservation);
  // launcher 2 had chosen T before that bind and now tries to reserve it.
  reserveThread('t-shared', 'launcher-1')
  bind({ windowId: W1, threadId: 't-shared', cwd: CWD, source: 'probed', creator: ALIVE })
  expect(isReserved('t-shared')).toBe(false)
  expect(() => reserveThread('t-shared', 'launcher-2')).toThrow(BindingConflict)
  // The window that holds the binding itself may still resume it.
  reserveThread('t-shared', 'launcher-1-relaunch', W1)
  // A binding whose creator is verifiably dead does not block.
  bind({ windowId: W2, threadId: 't-dead', cwd: CWD, source: 'probed', creator: ALIVE })
  const rows = stored(); rows[W2].creator = DEAD
  writeFileSync(process.env.TG_CODEX_BINDINGS!, JSON.stringify(rows))
  reserveThread('t-dead', 'launcher-3')
})

test('two automatic resumes cannot both get the same unloaded thread', async () => {
  const pages = [[{ id: 'only', cwd: CWD, source: 'cli' }]]
  const srv = fakeServer({ threads: {}, loaded: [], pages })
  try {
    const { lastThreadFor } = await import('./codex.ts')
    const results = await Promise.allSettled([lastThreadFor(CWD), lastThreadFor(CWD)])
    expect(results.filter(r => r.status === 'fulfilled').map(r => (r as any).value)).toEqual(['only'])
    expect(String((results.find(r => r.status === 'rejected') as any).reason)).toContain('just handed to another launch')
  } finally { srv.restore() }
})

test('a dry run (-Plan/-Check) reports the pick without reserving it', async () => {
  const pages = [[{ id: 'only', cwd: CWD, source: 'cli' }]]
  const srv = fakeServer({ threads: {}, loaded: [], pages })
  try {
    const { lastThreadFor } = await import('./codex.ts')
    const { isReserved } = await import('./codex-bindings.ts')
    expect(await lastThreadFor(CWD, undefined, false)).toBe('only')
    expect(await lastThreadFor(CWD, undefined, false)).toBe('only')
    expect(isReserved('only')).toBe(false)
    // The real launch that follows still gets it.
    expect(await lastThreadFor(CWD)).toBe('only')
    expect(isReserved('only')).toBe(true)
  } finally { srv.restore() }
})

test('the unsaved single-thread fallback needs complete listings and no other live owner', async () => {
  const threads = { only: { id: 'only', cwd: CWD, status: idle, source: 'cli' } }
  const pages = [[threads.only]]
  // Bound to another window whose process is alive: not this window's thread.
  seed({ [W2]: 'only' }, ALIVE)
  let srv = fakeServer({ threads, loaded: ['only'], pages })
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect((await deliverToCodex(CWD, 'hi', W1, S1, PID)).ok).toBe(false)
    expect((await deliverToCodex(CWD, 'hi')).ok).toBe(false)
    seed({ [W2]: 'only' }, null)             // owner unknown: refused as incomplete
    expect((await deliverToCodex(CWD, 'hi')).reason).toContain('incomplete')
    expect(srv.turns()).toEqual([])
  } finally { srv.restore() }
  seed({})
  srv = fakeServer({ threads, loaded: ['only'], endlessPages: true })   // saved listing never ends
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect((await deliverToCodex(CWD, 'hi')).reason).toContain('incomplete')
    expect(srv.turns()).toEqual([])
  } finally { srv.restore() }
})

test('on Linux a process command line keeps argument boundaries (ps would lose them)', async () => {
  if (process.platform !== 'linux') return
  const { argvCommandLine } = await import('./codex.ts')
  const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 5000)', 'help me'])
  try {
    await Bun.sleep(100)
    expect(argvCommandLine(child.pid)).toEndWith('"help me"')
  } finally { child.kill(9); await child.exited }
})
