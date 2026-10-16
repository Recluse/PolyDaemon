import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const { readClaudeStatus } = require('./claude-status.cjs')
const { findOwnPlugin } = require('../hooks/tg-bridge-locate.js')
export const clean = (v: unknown, n = 240) => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, n)
const idOK = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
export const parentID = (t: any) => t?.parentThreadId ?? t?.source?.subAgent?.thread_spawn?.parent_thread_id ?? null
const sameRoot = (a: string, b: string) => realpathSync(a) === realpathSync(b)
const status = (t: any) => clean(t?.status?.type ?? 'unknown')
const exec = promisify(execFile)

export async function gitBranch(cwd: string): Promise<string> {
  const git = async (args: string[]) => (await exec('git', ['--no-optional-locks', '-C', cwd, ...args], {
    timeout: 2000, maxBuffer: 8192, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  })).stdout.trim()
  try { return clean(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])) }
  catch {
    try { return 'detached ' + clean(await git(['rev-parse', '--short', 'HEAD'])) }
    catch { return 'unavailable' }
  }
}

// Deliberately narrower than app-server: no resume, turn, approval or config writes.
const READ_METHODS = new Set(['initialize', 'thread/read', 'thread/list', 'thread/turns/list',
  'account/rateLimits/read', 'mcpServerStatus/list', 'mcpServer/tool/call'])
export class SidebarRpc {
  socket: WebSocket
  next = 0
  pending = new Map<number, { ok: (v: any) => void; fail: () => void }>()
  ready: Promise<void>
  constructor(url: string, timeout = 8000) {
    const target = new URL(url)
    if (target.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(target.hostname)
        || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
      throw new Error('Use a loopback app-server WebSocket (SSH forwarding is supported)')
    }
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Connection timeout')) }, timeout)
      this.socket.onopen = () => { clearTimeout(timer); resolve() }
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('Connection unavailable')); this.close() }
      this.socket.onclose = () => {
        clearTimeout(timer); reject(new Error('Connection closed'))
        for (const p of this.pending.values()) p.fail()
        this.pending.clear()
      }
    })
    this.socket.onmessage = event => {
      try {
        const m = JSON.parse(String(event.data))
        // Server requests (including approval) are never answered by this observer.
        if (m.method || !this.pending.has(m.id)) return
        const p = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.error) p.fail(); else p.ok(m.result)
      } catch { /* malformed response cannot resolve a request */ }
    }
  }
  async initialize() {
    await this.ready
    await this.call('initialize', { clientInfo: { name: 'polydaemon-sidebar', version: '0.1.0' },
      capabilities: { experimentalApi: true } })
    this.socket.send(JSON.stringify({ method: 'initialized' }))
  }
  async call(method: string, params: any = {}, timeout = 8000): Promise<any> {
    if (!READ_METHODS.has(method) || (method === 'mcpServer/tool/call'
        && (!['project_status', 'bridge_status'].includes(params.tool) || JSON.stringify(params.arguments) !== '{}'))) throw new Error('Not a sidebar read')
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Disconnected')
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const fail = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error('Read unavailable')) }
      const timer = setTimeout(fail, timeout)
      this.pending.set(id, { ok: v => { clearTimeout(timer); resolve(v) }, fail })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch { fail() }
    })
  }
  close() { this.socket.close(); for (const p of this.pending.values()) p.fail(); this.pending.clear() }
}

export function limitsView(value: any) {
  const buckets = value?.rateLimitsByLimitId
    ? Object.values(value.rateLimitsByLimitId) : value?.rateLimits ? [value.rateLimits] : []
  return buckets.slice(0, 8).flatMap((b: any) => ['primary', 'secondary'].flatMap(key => {
    const w = b?.[key]
    if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
        || !count(w.windowDurationMins) || !count(w.resetsAt) || w.resetsAt > 253402300799) return []
    return [{ label: clean(b.limitName || b.limitId || 'Codex', 60), minutes: w.windowDurationMins,
      used: w.usedPercent, resetsAt: w.resetsAt }]
  }))
}

export function memoryView(v: any, cwd: string) {
  if (v?.version !== 1 || typeof v.root !== 'string' || !sameRoot(v.root, cwd)
      || typeof v.repo !== 'string' || !/^[A-Za-z0-9._-]+$/.test(v.repo) || !stamp(v.checked_at)
      || !['fresh', 'stale', 'unknown', 'error'].includes(v.freshness?.state)
      || !['available', 'missing', 'unknown'].includes(v.map?.state)
      || ![v.documents?.indexed, v.chunks?.indexed, v.map?.components,
        v.freshness.stale, v.freshness.unindexed, v.freshness.missing].every(x => x === null || count(x))
      || ![v.freshness.checked_at, v.map.checked_at].every(x => x === null || stamp(x))) throw new Error('Invalid project status')
  if (v.freshness.state === 'fresh' && (v.documents.indexed === null || v.chunks.indexed === null
      || v.freshness.checked_at === null || ['stale', 'unindexed', 'missing'].some(k => v.freshness[k] !== 0))) throw new Error('Incomplete freshness')
  return { repo: v.repo, docs: v.documents.indexed, chunks: v.chunks.indexed, state: v.freshness.state,
    stale: v.freshness.stale, unindexed: v.freshness.unindexed, missing: v.freshness.missing,
    map: v.map.state, checked: v.checked_at }
}

export function transcriptView(turns: any[]) {
  // Only visible messages and tool summaries; never reasoning content or hidden prompts.
  return turns.slice(0, 8).reverse().flatMap(t => (Array.isArray(t.items) ? t.items : []).flatMap((i: any) => {
    if (i.type === 'agentMessage') return [`Assistant: ${clean(i.text, 2500)}`]
    if (i.type === 'userMessage') return [`User: ${clean(i.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'), 2500)}`]
    if (i.type === 'commandExecution') return [`Shell [${clean(i.status)}]: ${clean(i.command, 600)}`, clean(i.aggregatedOutput, 1500)]
    if (i.type === 'mcpToolCall') return [`Tool: ${clean(i.server)} / ${clean(i.tool)} [${clean(i.status)}]`]
    if (i.type === 'plan') return [`Plan: ${clean(i.text, 1500)}`]
    return []
  })).slice(-30)
}

type Rpc = { call: (method: string, params?: any, timeout?: number) => Promise<any> }
export class CodexSidebar {
  constructor(readonly rpc: Rpc, readonly threadID: string, readonly cwd: string,
    readonly servers: { bridge?: string; memory?: string } = {}) {
    if (!idOK(threadID)) throw new Error('Explicit thread ID required')
  }
  async root() {
    const { thread } = await this.rpc.call('thread/read', { threadId: this.threadID })
    if (thread?.id !== this.threadID || !sameRoot(thread.cwd, this.cwd)) throw new Error('Thread scope mismatch')
    return thread
  }
  async session() {
    const thread = await this.root()
    let agents: any[] | null = null, more = false
    try {
      const page = await this.rpc.call('thread/list', { parentThreadId: this.threadID,
        sourceKinds: ['subAgentThreadSpawn'], useStateDbOnly: true, limit: 50 })
      if (!Array.isArray(page.data)) throw new Error('Invalid agents')
      agents = page.data.filter((t: any) => idOK(t?.id) && parentID(t) === this.threadID)
        .map((t: any) => ({ id: t.id, name: clean(t.agentNickname || t.name || t.id, 80),
          role: clean(t.agentRole, 60), status: status(t) }))
      more = !!page.nextCursor
    } catch { /* unsupported server is unknown, not zero agents */ }
    return { thread: this.threadID, model: clean(thread.model || 'unknown'), provider: clean(thread.modelProvider),
      status: status(thread), branch: await gitBranch(this.cwd), agents, more }
  }
  async catalog(kind: 'bridge' | 'memory') {
    const thread = await this.root()
    if (!['active', 'idle'].includes(status(thread))) throw new Error('Thread not loaded')
    const names = this.servers[kind] ? [this.servers[kind]!]
      : kind === 'bridge' ? ['tg-bridge', 'PolyDaemon', 'polydaemon'] : ['agentmem', 'HyperMnesia', 'hypermnesia']
    // serverName is essential: unfiltered discovery may start/probe unrelated
    // servers instead of reusing this thread's already connected transport.
    const pages = await Promise.all(names.map(async serverName => {
      const page = await this.rpc.call('mcpServerStatus/list', {
        threadId: this.threadID, serverName, detail: 'full', limit: 100,
      })
      if (!Array.isArray(page.data) || page.nextCursor || page.data.some((s: any) => s.name !== serverName)) {
        throw new Error('Incomplete scoped catalog')
      }
      return page.data
    }))
    return { data: pages.flat() }
  }
  async bridge(uid?: string) {
    const catalog = await this.catalog('bridge')
    const servers = catalog.data.filter((s: any) => s.serverInfo?.name === 'PolyDaemon')
    if (servers.length !== 1) return { state: 'unavailable' }
    if (servers[0].runtimeStatus !== 'connected') return { state: 'unavailable' }
    if (!servers[0].toolsError && Object.values(servers[0].tools ?? {}).some((t: any) => t.name === 'bridge_status'
        && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)) {
      try {
        const result = await this.rpc.call('mcpServer/tool/call', { threadId: this.threadID,
          server: servers[0].name, tool: 'bridge_status', arguments: {} })
        if (result.isError) throw new Error('Bridge details unavailable')
        const v = result.structuredContent ?? JSON.parse(result.content?.find((p: any) => p.type === 'text')?.text ?? '')
        if (v?.version !== 1 || !sameRoot(v.root, this.cwd) || v.state !== 'connected'
            || typeof v.working !== 'boolean' || !['approvals', 'questions', 'plans'].every(k => count(v.pending?.[k]))
            || (v.topic !== null && (!count(v.topic?.id) || v.topic.id === 0 || typeof v.topic.title !== 'string'))
            || !['available', 'unavailable'].includes(v.tasks?.state)
            || (v.tasks.state === 'available' && (!Array.isArray(v.tasks.items) || !v.tasks.items.every((t: any) =>
              count(t?.id) && t.id > 0 && ['from', 'kind', 'text', 'state'].every(k => typeof t[k] === 'string'))))) {
          throw new Error('Invalid bridge status')
        }
        return { state: 'connected', details: true, working: v.working, pending: v.pending,
          topic: v.topic ? { id: v.topic.id, title: clean(v.topic.title) } : null,
          tasks: { state: v.tasks.state, items: v.tasks.state === 'available'
            ? v.tasks.items.map((t: any) => ({ id: t.id, from: clean(t.from), kind: clean(t.kind), text: clean(t.text), state: clean(t.state) })) : null } }
      } catch {
        return { state: 'connected', details: false, detailError: true }
      }
    }
    if (uid) {
      const detail = await readClaudeStatus(this.cwd, { locate: (dir: string) => findOwnPlugin(dir, 'codex') })
      if (detail.state === 'connected') return { ...detail, details: true }
    }
    // The MCP catalog proves connection, not the topic identity of a local registry row.
    return { state: 'connected', details: false }
  }
  async memory() {
    const catalog = await this.catalog('memory')
    const candidates = catalog.data.filter((s: any) => s.runtimeStatus === 'connected' && !s.toolsError
      && Object.values(s.tools ?? {}).some((t: any) => t.name === 'project_status'
        && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false))
    if (candidates.length !== 1) {
      const legacy = catalog.data.filter((s: any) => s.runtimeStatus === 'connected' && !s.toolsError
        && ['get_project_map', 'memory_search'].every(name => Object.values(s.tools ?? {}).some((t: any) => t.name === name)))
      if (candidates.length === 0 && legacy.length === 1) return { available: false,
        connection: 'connected', reason: 'project_status not exposed' }
      throw new Error('Ambiguous or unavailable memory')
    }
    const result = await this.rpc.call('mcpServer/tool/call', { threadId: this.threadID,
      server: candidates[0].name, tool: 'project_status', arguments: {} }, 15000)
    if (result.isError) throw new Error('Memory unavailable')
    const v = result.structuredContent ?? JSON.parse(result.content?.find((p: any) => p.type === 'text')?.text ?? '')
    return { ...memoryView(v, this.cwd), available: true, connection: 'connected' }
  }
  async agent(id: string) {
    await this.root()
    if (!idOK(id)) throw new Error('Invalid agent')
    const { thread } = await this.rpc.call('thread/read', { threadId: id })
    // Do not trust a stale list or a caller-provided id to grant transcript access.
    if (thread?.id !== id || parentID(thread) !== this.threadID) throw new Error('Not a child agent')
    const page = await this.rpc.call('thread/turns/list', { threadId: id, limit: 8,
      sortDirection: 'desc', itemsView: 'full' })
    if (!Array.isArray(page.data)) throw new Error('Transcript unavailable')
    return { id, lines: transcriptView(page.data) }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  const cwd = realpathSync(option('--cwd') || process.cwd())
  const fixedThread = option('--thread'), binding = option('--binding')
  if (!binding && !idOK(fixedThread)) throw new Error('Pass --thread ID (no latest-session guessing)')
  const boundThread = () => {
    if (!binding) return fixedThread
    try {
      const value = JSON.parse(readFileSync(binding, 'utf8'))
      return sameRoot(value.cwd, cwd) && idOK(value.thread) ? value.thread : null
    } catch { return null }
  }
  const url = option('--url') || `ws://127.0.0.1:${process.env.TG_CODEX_WS_PORT || 3210}`
  const uid = option('--window-uid')
  // No inherited window identity from whichever agent happened to launch this UI.
  if (uid) process.env.TG_WINDOW_UID = uid; else delete process.env.TG_WINDOW_UID
  let rpc: SidebarRpc | null = null, stopped = false, selected: string | null = null, selection = 0
  const emit = (source: string, data: unknown) => { if (!stopped) process.stdout.write(JSON.stringify({ source, data }) + '\n') }
  const stop = () => { stopped = true; rpc?.close(); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const input = createInterface({ input: process.stdin })
  input.on('close', stop)
  input.on('line', line => {
    try { const m = JSON.parse(line); selected = idOK(m.agent) ? m.agent : null; selection++; emit('viewer', null) } catch { /* ignore malformed input */ }
  })
  // Each source has an independent serial loop and bounded RPCs. Reconnect never resumes a thread.
  while (!stopped) {
    const thread = boundThread()
    if (!thread) { await new Promise(r => setTimeout(r, 250)); continue }
    let watch: ReturnType<typeof setInterval> | undefined
    try {
      rpc = new SidebarRpc(url)
      await rpc.initialize()
      const view = new CodexSidebar(rpc, thread, cwd, {
        bridge: option('--bridge-server'), memory: option('--memory-server'),
      })
      await view.root()
      const connection = rpc
      const clear = () => {
        for (const source of ['session', 'limits', 'memory', 'bridge', 'viewer', 'context']) emit(source, null)
      }
      connection.socket.addEventListener('close', clear, { once: true })
      watch = setInterval(() => {
        if (connection.socket.readyState !== WebSocket.OPEN) return
        if (boundThread() !== thread) {
          selected = null; selection++; clear(); connection.close()
        } else if (binding) {
          try {
            const value = JSON.parse(readFileSync(binding, 'utf8'))
            const c = value.context
            emit('context', value.thread === thread && sameRoot(value.cwd, cwd) && count(c?.tokens)
              && (c.window === null || (count(c.window) && c.window > 0)) ? c : null)
          } catch { emit('context', null) }
        }
      }, 250)
      async function loop(source: string, delay: number, read: () => Promise<any>) {
        while (!stopped && connection.socket.readyState === WebSocket.OPEN) {
          try {
            const data = await read()
            if (connection.socket.readyState === WebSocket.OPEN && boundThread() === thread) emit(source, data)
          } catch {
            if (connection.socket.readyState === WebSocket.OPEN && boundThread() === thread) emit(source, null)
          }
          if (connection.socket.readyState !== WebSocket.OPEN) break
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); connection.socket.removeEventListener('close', done); resolve() }
            const timer = setTimeout(done, delay)
            connection.socket.addEventListener('close', done, { once: true })
          })
        }
      }
      await Promise.all([
        loop('session', 5000, () => view.session()),
        loop('limits', 60000, async () => limitsView(await connection.call('account/rateLimits/read'))),
        loop('memory', 60000, () => view.memory()),
        loop('bridge', 5000, () => view.bridge(uid)),
        loop('viewer', 3000, async () => {
          const id = selected, epoch = selection
          if (!id) return null
          const data = await view.agent(id)
          return selected === id && selection === epoch ? data : null
        }),
      ])
    } catch { /* reconnect below, with cleared snapshots */ }
    clearInterval(watch)
    rpc?.close()
    for (const source of ['session', 'limits', 'memory', 'bridge', 'viewer', 'context']) emit(source, null)
    await new Promise(r => setTimeout(r, binding ? 250 : 3000))
  }
}
if (import.meta.main) main().catch(() => { console.error('Codex sidebar unavailable: check --thread, --cwd and loopback --url'); process.exitCode = 1 })
