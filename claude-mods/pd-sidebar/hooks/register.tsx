import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'
import { plain, projectStatus, transcript } from './content'

import type { AgentRow, BridgeStatus, BridgeWindow, ChangedFile, GitFile, MemoryStatus, SessionTask, Snapshot, Todo } from '../types'

const PANE = 'pd-sidebar'
const PANE_COLUMNS = 44
const AGENT_PANE = 'pd-agent'
const TITLE = 'PolyDaemon'
const SESSION_MS = 5000
const BRIDGE_MS = 5000
const MEMORY_MS = 60000
const STALE_SEC = 60
const LIST_MAX = 8
const HELPER = 'assets/clients/claude-status.cjs'
const STATUS_TOOL = /^mcp__(.+)__project_status$/

const todos = atom({ plugin: 'pd-sidebar', key: 'todos' } as const, [] as Todo[])
const tasks = atom({ plugin: 'pd-sidebar', key: 'tasks' } as const, [] as SessionTask[])
const agentsRunning = atom({ plugin: 'pd-sidebar', key: 'agentsRunning' } as const, 0)
const files = atom({ plugin: 'pd-sidebar', key: 'files' } as const, [] as ChangedFile[])
const snapshot = atom({ plugin: 'pd-sidebar', key: 'snapshot' } as const, null as Snapshot | null)
const sessionError = atom({ plugin: 'pd-sidebar', key: 'sessionError' } as const, false)
const bridge = atom({ plugin: 'pd-sidebar', key: 'bridge' } as const, null as BridgeStatus | null)
const memory = atom({ plugin: 'pd-sidebar', key: 'memory' } as const, null as MemoryStatus | null)
const agentList = atom({ plugin: 'pd-sidebar', key: 'agentList' } as const, null as AgentRow[] | null)
type AgentView = { id: string; title: string; text: string; state: 'loading' | 'ready' | 'unavailable' }
const agentView = atom({ plugin: 'pd-sidebar', key: 'agentView' } as const, null as AgentView | null)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

type Source = 'session' | 'bridge' | 'memory'
type Poll = { source: Source; epoch: number; active: boolean }
const POLL_TIMEOUT: Record<Source, number> = { session: 8000, bridge: 10000, memory: 15000 }

// A poll that is still running is not started again (clock.every does not wait
// for an async callback), and an answer that lands after the pane closed or the
// cwd moved belongs to an older epoch and is dropped. Module state: a reload
// starts both over, as it drops the timers too.
const inFlight: Record<Source, boolean> = { session: false, bridge: false, memory: false }
const latestPoll: Partial<Record<Source, Poll>> = {}
const attemptedEpoch: Record<Source, number> = { session: -1, bridge: -1, memory: -1 }
let epoch = 0
let epochCwd = ''
let viewerEpoch = 0
let viewerBusy = false
let viewerAgain = false
let agentPage = 0

function relative(path: string, cwd: string): string {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

function tokens(n: number | undefined): string {
  if (n === undefined) return '?'
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// `git status --porcelain=v1 -z`: NUL-separated `XY path`, a rename or copy
// followed by one more field, its origin; names may hold any byte but NUL.
function parseGit(out: string): GitFile[] {
  const fields = out.split('\0')
  const list: GitFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const code = field.slice(0, 2)
    list.push({ code: code.trim() || '?', path: field.slice(3) })
    if (/[RC]/.test(code)) i++
  }
  return list
}

async function gitState($: EngineInterface, cwd: string): Promise<{ branch: string | null; git: GitFile[] | null }> {
  if ((await $.session.repo()) === null) return { branch: null, git: null }
  const [branch, status] = await Promise.all([
    $.process.run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 }),
    $.process.run(['git', '-C', cwd, 'status', '--porcelain=v1', '-z'], { timeoutMs: 3000 }),
  ])
  return {
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    // A cut-off listing is no proof of a clean tree: unknown rather than short.
    git: status.exitCode === 0 && !status.isStdoutTruncated ? parseGit(status.stdout) : null,
  }
}

type RegistryRow = { instance_name?: string; workspace_name?: string; port?: number; window_uid?: string; heartbeat_at?: number }

// The local bridge registry, names and heartbeats only: tokens are never read out of it.
async function bridgeWindows($: EngineInterface, now: number): Promise<BridgeWindow[] | null> {
  const home = await $.env.get('HOME') || await $.env.get('USERPROFILE')
  if (!home) return null
  const path = `${home}/.tg-bridge-channel/instances.json`
  if (!(await $.fs.exists(path))) return null
  const me = await $.env.get('TG_WINDOW_UID')
  const rows = Object.values(JSON.parse(await $.fs.read(path)) as Record<string, RegistryRow>)
  return rows
    .map(row => ({
      name: String(row.instance_name || row.workspace_name || '?'),
      port: typeof row.port === 'number' ? row.port : null,
      ageSec: Math.max(0, Math.round(now / 1000 - Number(row.heartbeat_at || 0))),
      isMe: !!me && row.window_uid === me,
    }))
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))
}

async function paneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
}

// The epoch a poll started in; a cwd change opens a new one.
async function currentEpoch($: EngineInterface): Promise<number> {
  const cwd = await $.session.cwd()
  if (cwd !== epochCwd) {
    epochCwd = cwd
    epoch++
    viewerEpoch++
    agentPage = 0
    await update($, snapshot, () => null)
    await update($, sessionError, () => false)
    await update($, bridge, () => null)
    await update($, memory, () => null)
    await update($, agentList, () => null)
    await update($, agentView, () => null)
  }
  return epoch
}

async function mayPublish($: EngineInterface, started: Poll, failed = false): Promise<boolean> {
  const current = () => (started.active || failed) && latestPoll[started.source] === started && started.epoch === epoch
  return current() && started.epoch === await currentEpoch($) && await paneShown($) && current()
}

async function refreshSession($: EngineInterface, started: Poll): Promise<void> {
  const [model, cwd, usage, now, tools] = await Promise.all([
    $.session.model(),
    $.session.cwd(),
    $.session.usage(),
    $.clock.now(),
    $.tool.list().catch(() => []),
  ])
  const [repo, windows, agents] = await Promise.all([
    gitState($, cwd).catch(() => ({ branch: null, git: null })),
    bridgeWindows($, now).catch(() => null),
    $.agent.list().catch(() => null),
  ])
  const servers = new Set<string>()
  for (const tool of tools) {
    const parts = tool.mcp ? tool.name.split('__') : []
    if (parts.length >= 3 && parts[1]) servers.add(parts[1])
  }
  const next: Snapshot = {
    model,
    cwd,
    contextPercent: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    costUsd: usage.cost?.usd,
    limits: usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    branch: repo.branch,
    git: repo.git,
    windows,
    mcpServers: [...servers].sort(),
    hasLspTool: tools.some(t => t.name === 'LSP'),
    updatedAt: now,
  }
  if (await mayPublish($, started)) {
    await update($, sessionError, () => false)
    await update($, snapshot, () => next)
    await update($, agentList, () => agents)
  }
}

function bridgeFailed(error: string, now: number): BridgeStatus {
  return { topic: null, threadId: null, isWorking: false, approvals: 0, asks: 0, plans: 0, tasks: null, error, checkedAt: now }
}

// PolyDaemon's bundled helper reads this window's own bridge (GET /status and
// /tasks, its own scope only) and prints JSON without the token. The mod keeps
// no bridge client of its own.
async function refreshBridge($: EngineInterface, started: Poll): Promise<void> {
  const now = await $.clock.now()
  const helper = `${$.plugin.root}/${HELPER}`
  let next: BridgeStatus
  if (!(await $.fs.exists(helper))) {
    next = bridgeFailed('status helper not installed', now)
  } else {
    const run = await $.process.run(['node', helper, await $.session.cwd()], { timeoutMs: 8000 })
    let s: any
    try {
      s = run.exitCode === 0 ? JSON.parse(run.stdout) : undefined
    } catch {
      s = undefined
    }
    if (s === undefined) next = bridgeFailed('status unavailable', now)
    else if (s.state !== 'connected') next = bridgeFailed(s.state === 'unbound' ? 'window not bound' : 'bridge unavailable', now)
    else
      next = {
        topic: typeof s.topic?.title === 'string' ? s.topic.title : null,
        threadId: typeof s.topic?.id === 'number' ? s.topic.id : null,
        isWorking: s.working === true,
        approvals: count(s.pending?.approvals),
        asks: count(s.pending?.questions),
        plans: count(s.pending?.plans),
        tasks: s.tasks?.state === 'available' && Array.isArray(s.tasks.items) ? s.tasks.items : null,
        tasksReason: s.tasks?.state === 'available' ? undefined : 'unavailable',
        checkedAt: now,
      }
  }
  if (await mayPublish($, started)) await update($, bridge, () => next)
}

function memoryUnknown(error: string, now: number): MemoryStatus {
  return { server: null, repo: null, state: 'unknown', stale: null, unindexed: null, missing: null, documents: null, chunks: null, map: 'unknown', error, checkedAt: now }
}

// The one connected MCP server that serves `project_status`, asked over the
// engine's own connection; its answer must be for this cwd, or it is unknown.
async function refreshMemory($: EngineInterface, started: Poll): Promise<void> {
  const [now, cwd, tools] = await Promise.all([$.clock.now(), $.session.cwd(), $.tool.list()])
  const servers = tools.flatMap(t => {
    const m = t.mcp ? STATUS_TOOL.exec(t.name) : null
    return m?.[1] ? [m[1]] : []
  })
  let next: MemoryStatus
  if (servers.length !== 1 || !servers[0]) {
    next = memoryUnknown(servers.length ? 'several memory servers' : 'no memory server', now)
  } else {
    const server = servers[0]
    const result = await $.mcp.call(server, 'project_status').catch(() => null)
    const block = result?.content.find(b => b.type === 'text') as { text?: string } | undefined
    let p: any = result?.structuredContent
    if (p === undefined && block?.text) {
      try {
        p = JSON.parse(block.text)
      } catch {
        p = undefined
      }
    }
    const status = result && !result.isError ? projectStatus(p, cwd) : null
    next = status ? { server, ...status } : memoryUnknown('status unavailable or other scope', now)
  }
  if (await mayPublish($, started)) await update($, memory, () => next)
}

async function pollFailure($: EngineInterface, started: Poll): Promise<void> {
  const now = await $.clock.now()
  if (!(await mayPublish($, started, true))) return
  if (started.source === 'memory') await update($, memory, () => memoryUnknown('status unavailable', now))
  else if (started.source === 'bridge') await update($, bridge, () => bridgeFailed('status unavailable', now))
  else {
    await update($, sessionError, () => true)
    await update($, snapshot, () => null)
    await update($, agentList, () => null)
  }
}

async function poll($: EngineInterface, source: Source, initial = false): Promise<void> {
  if (inFlight[source] || (initial && attemptedEpoch[source] === epoch)) return
  inFlight[source] = true
  const started: Poll = { source, epoch, active: true }
  latestPoll[source] = started
  let hidden = false
  let finish!: (ok: boolean) => void
  const deadline = new Promise<boolean>(resolve => { finish = resolve })
  const timer = $.clock.after(POLL_TIMEOUT[source], () => {
    started.active = false
    finish(false)
  })
  const work = async () => {
    hidden = !(await paneShown($))
    if (hidden || !started.active) return
    started.epoch = await currentEpoch($)
    if (!started.active) return
    attemptedEpoch[source] = started.epoch
    if (source === 'session') await refreshSession($, started)
    else if (source === 'bridge') await refreshBridge($, started)
    else await refreshMemory($, started)
  }
  try {
    const ok = await Promise.race([work().then(() => true, () => false), deadline])
    started.active = false
    if (!ok) void pollFailure($, started).catch(() => undefined)
  } finally {
    timer.cancel()
    started.active = false
    inFlight[source] = false
    // A hidden or superseded attempt must not consume the next visible bootstrap.
    const shown = await paneShown($)
    if (!shown || hidden || started.epoch !== epoch) {
      attemptedEpoch[source] = -1
      if (shown) $.ui.invalidate('ui.render')
    }
  }
}

async function pollAll($: EngineInterface): Promise<void> {
  await Promise.all([
    poll($, 'session').catch(() => undefined),
    poll($, 'bridge').catch(() => undefined),
    poll($, 'memory').catch(() => undefined),
  ])
}

function open($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
}

async function refreshAgent($: EngineInterface): Promise<void> {
  if (viewerBusy) { viewerAgain = true; return }
  viewerBusy = true
  viewerAgain = false
  const started = viewerEpoch
  try {
    const selected = await read($, agentView)
    if (!selected || !(await $.ui.panes()).some(p => p.id === AGENT_PANE && p.isShown)) return
    const cwd = await $.session.cwd()
    const messages = await $.session.messages({ agentId: selected.id }).catch(() => null)
    const result = transcript(messages)
    if (started !== viewerEpoch || cwd !== await $.session.cwd() ||
        !(await $.ui.panes()).some(p => p.id === AGENT_PANE && p.isShown) || started !== viewerEpoch) return
    await update($, agentView, current => current?.id === selected.id ? { ...current, ...result } : current)
  } catch {
    if (started === viewerEpoch) await update($, agentView, current => current ?
      { ...current, state: 'unavailable' as const, text: 'Agent messages unavailable' } : null).catch(() => undefined)
  } finally {
    viewerBusy = false
    if (viewerAgain) {
      viewerAgain = false
      $.clock.after(150, () => void refreshAgent($).catch(() => undefined))
    }
  }
}

async function selectAgent($: EngineInterface, agent: AgentRow): Promise<void> {
  viewerEpoch++
  const title = plain(agent.name || agent.description || agent.type, 100)
  await update($, agentView, () => ({ id: agent.id, title, text: '', state: 'loading' }))
  await $.ui.open({ id: AGENT_PANE, title, focus: true, closeOnEscape: true })
  await refreshAgent($)
}

async function closeAgent($: EngineInterface): Promise<void> {
  // The engine skips this mod's ui.close hook on its own nested API call.
  viewerEpoch++
  await update($, agentView, () => null)
  await $.ui.close({ id: AGENT_PANE })
}

async function agentChanged($: EngineInterface, agentId?: string): Promise<void> {
  const selected = await read($, agentView)
  if (agentId && selected?.id === agentId) void refreshAgent($).catch(() => undefined)
  void poll($, 'session').catch(() => undefined)
}

// What a finished tool call means for the sidebar: the todo list, this
// session's task list, and the files edited. Read from the calls the model made;
// the mod never calls a tool itself to find out.
async function track($: EngineInterface, e: ToolCallInput, result: unknown, isError: boolean): Promise<void> {
  if (isError) return
  if (e.tool === 'TodoWrite') {
    const list: Todo[] = e.todos.map(t => ({ ...t }))
    await update($, todos, () => list)
    return
  }
  if (e.tool === 'TaskCreate') {
    const made = (result as { task?: { id?: unknown } } | undefined)?.task
    if (typeof made?.id !== 'string') return
    const task: SessionTask = { id: made.id, subject: e.subject, status: 'pending', activeForm: e.activeForm }
    await update($, tasks, list => [...list.filter(t => t.id !== task.id), task].slice(-50))
    return
  }
  if (e.tool === 'TaskUpdate') {
    if ((result as { success?: unknown } | undefined)?.success !== true) return
    const status = e.status
    await update($, tasks, list =>
      status === 'deleted'
        ? list.filter(t => t.id !== e.taskId)
        : list.map(t =>
            t.id === e.taskId
              ? { ...t, subject: e.subject ?? t.subject, activeForm: e.activeForm ?? t.activeForm, status: status ?? t.status }
              : t,
          ),
    )
    return
  }
  if (!EDIT_TOOLS.has(String(e.tool))) return
  const input = e as { file_path?: string; notebook_path?: string }
  const path = input.file_path ?? input.notebook_path
  if (!path) return
  await update($, files, list => {
    const found = list.find(f => f.path === path)
    return found
      ? list.map(f => (f.path === path ? { ...f, edits: f.edits + 1 } : f))
      : [...list, { path, edits: 1 }].slice(-100)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sidebar', description: 'Toggle the PolyDaemon sidebar' })
    // Three independent loops, each skipped while the pane is closed or hidden.
    $.clock.every(SESSION_MS, () => void poll($, 'session').catch(() => undefined))
    $.clock.every(BRIDGE_MS, () => void poll($, 'bridge').catch(() => undefined))
    $.clock.every(MEMORY_MS, () => void poll($, 'memory').catch(() => undefined))
    await open($)
    void pollAll($)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) epoch++
    if (e.id === AGENT_PANE) {
      viewerEpoch++
      await update($, agentView, () => null)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    epoch++
    viewerEpoch++
    agentPage = 0
    await update($, agentView, () => null)
    await update($, agentList, () => null)
    await update($, todos, () => [])
    await update($, tasks, () => [])
    await update($, files, () => [])
    await update($, agentsRunning, () => 0)
    await update($, snapshot, () => null)
    await update($, sessionError, () => false)
    await update($, bridge, () => null)
    await update($, memory, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sidebar' }, async $ => {
    const shown = (await $.ui.panes()).some(p => p.id === PANE)
    if (shown) {
      epoch++ // whatever is still in flight answers a closed pane
      await $.ui.close({ id: PANE })
      return { text: 'PolyDaemon sidebar closed.' }
    }
    const placed = await open($)
    void pollAll($)
    return { text: placed.isPlaced ? 'PolyDaemon sidebar opened.' : `PolyDaemon sidebar waits: ${placed.reason}` }
  })

  // Observes only: the call runs first and its result goes back unchanged.
  on('tool.call', async ($, e, next) => {
    const isAgent = e.tool === 'Agent'
    if (isAgent) await update($, agentsRunning, n => n + 1).catch(() => undefined)
    let ran
    try {
      ran = await next(e)
    } finally {
      if (isAgent) await update($, agentsRunning, n => Math.max(0, n - 1)).catch(() => undefined)
    }
    if ('deny' in ran && ran.deny) return ran
    try {
      await track($, e, ran.result, ran.isError === true)
      await agentChanged($, e.agentId)
    } catch {
      // Bookkeeping never touches the call's own result.
    }
    return ran
  }).catch(($, e, next) => next(e)) // after next: replays the settled result, runs nothing twice

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await agentChanged($, e.agentId).catch(() => undefined)
    return done
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    await agentChanged($, e.agentId).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: AGENT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const selected = await read($, agentView)
    return <Box flexDirection="column">
      <Button key="close-agent" plain label="Back" hotkey="b" onPress={() => closeAgent($)} />
      <Text bold>{selected?.title ?? 'Agent'}</Text>
      <Text>{selected?.state === 'loading' ? 'Loading...' : selected?.text || 'Agent messages unavailable'}</Text>
    </Box>
  })

  // Order by what the person reads first: session, the bridge, memory, the
  // work lists, tools; the long lists (edited, git, windows) last and bounded.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const sessionFailed = await read($, sessionError)
    const todoList = await read($, todos)
    const taskList = await read($, tasks)
    const agents = await read($, agentsRunning)
    const listedAgents = await read($, agentList)
    const page = Math.min(agentPage, Math.max(0, Math.ceil((listedAgents?.length ?? 0) / 9) - 1))
    const changed = await read($, files)
    const own = await read($, bridge)
    const mem = await read($, memory)
    // Placement may happen after session.start (including narrow terminals).
    // Bootstrap once per epoch; failures retry on the normal timer, not on repaint.
    if (snap === null && !sessionFailed) void poll($, 'session', true).catch(() => undefined)
    if (own === null) void poll($, 'bridge', true).catch(() => undefined)
    if (mem === null) void poll($, 'memory', true).catch(() => undefined)
    const cwd = snap?.cwd ?? ''

    const heading = (label: string) => (
      <Text bold color="claude">
        {label}
      </Text>
    )
    const gap = <Text> </Text>
    const more = (n: number) => (n > LIST_MAX ? <Text dimColor>+{n - LIST_MAX} more</Text> : null)
    const mark = (status: string) => (status === 'completed' ? '✓ ' : status === 'in_progress' ? '▸ ' : '○ ')
    const pending = own ? own.approvals + own.asks + own.plans : 0
    const memoryIssues = mem ? (mem.stale ?? 0) + (mem.missing ?? 0) + (mem.unindexed ?? 0) : 0
    const openTasks = taskList.filter(t => t.status !== 'completed').length
    const doneTodos = todoList.filter(t => t.status === 'completed').length

    return (
      <Box flexDirection="column">
        {heading('Session')}
        {snap === null ? (
          <Text dimColor>{sessionFailed ? 'Session status unavailable' : 'loading…'}</Text>
        ) : (
          <Box flexDirection="column">
            <Text wrap="truncate-end">{snap.model}</Text>
            <Text wrap="truncate-end">
              ctx {snap.contextPercent === undefined ? 'unknown' : `${Math.round(snap.contextPercent)}%`}{' '}
              <Text dimColor>
                {tokens(snap.contextTokens)}/{tokens(snap.contextWindow)}
              </Text>
              {snap.costUsd !== undefined && <Text dimColor> · ${snap.costUsd.toFixed(2)}</Text>}
            </Text>
            {snap.limits.length === 0 && <Text dimColor>limits unknown</Text>}
            {snap.limits.map(l => (
              <Text wrap="truncate-end" color={l.percentUsed >= 80 ? 'error' : undefined}>
                {l.kind} {Math.round(l.percentUsed)}%
                {l.resetsAt && <Text dimColor> → {l.resetsAt.slice(5, 16).replace('T', ' ')}</Text>}
              </Text>
            ))}
          </Box>
        )}

        {gap}
        {heading('PolyDaemon')}
        {own === null && <Text dimColor>loading…</Text>}
        {own?.error && (
          <Text wrap="truncate-end" dimColor>
            {own.error}
          </Text>
        )}
        {own && !own.error && (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={own.isWorking ? 'warning' : 'success'}>● </Text>
              {own.topic ?? 'no topic'}
              {own.threadId !== null && <Text dimColor> #{own.threadId}</Text>}
            </Text>
            <Text wrap="truncate-end" color={pending ? 'warning' : undefined} dimColor={!pending}>
              pending: {own.approvals} approve · {own.asks} ask · {own.plans} plan
            </Text>
            {own.tasks === null ? (
              <Text dimColor>tasks: unknown</Text>
            ) : own.tasks.length === 0 ? (
              <Text dimColor>tasks: none</Text>
            ) : (
              <Box flexDirection="column">
                {own.tasks.slice(0, LIST_MAX).map(t => (
                  <Text wrap="truncate-end">
                    <Text dimColor>
                      #{t.id} {t.state}{' '}
                    </Text>
                    {t.text}
                  </Text>
                ))}
                {more(own.tasks.length)}
              </Box>
            )}
          </Box>
        )}

        {gap}
        {heading('HyperMnesia')}
        {mem === null && <Text dimColor>loading…</Text>}
        {mem?.error && <Text dimColor>unknown ({mem.error})</Text>}
        {mem && !mem.error && (
          <Box flexDirection="column">
            <Text wrap="truncate-end" color={memoryIssues ? 'warning' : undefined}>
              {mem.state}
              <Text dimColor>
                {' '}
                · {mem.documents ?? '?'} docs · {mem.chunks ?? '?'} chunks · map {mem.map}
              </Text>
            </Text>
            {memoryIssues > 0 && (
              <Text wrap="truncate-end" color="warning">
                stale {mem.stale ?? '?'} · unindexed {mem.unindexed ?? '?'} · missing {mem.missing ?? '?'}
              </Text>
            )}
            <Text dimColor wrap="truncate-end">
              {mem.repo} · checked {new Date(mem.checkedAt).toISOString().slice(11, 19)}
            </Text>
          </Box>
        )}

        {gap}
        {heading(`Tasks${taskList.length ? ` ${openTasks} open` : ''}${agents ? ` · ${agents} agent${agents > 1 ? 's' : ''}` : ''}`)}
        {taskList.length === 0 && <Text dimColor>none this session</Text>}
        {taskList.slice(0, LIST_MAX).map(t => (
          <Text
            wrap="truncate-end"
            dimColor={t.status === 'completed'}
            color={t.status === 'in_progress' ? 'warning' : undefined}
          >
            {mark(t.status)}
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
          </Text>
        ))}
        {more(taskList.length)}

        {gap}
        {heading('Agents')}
        {listedAgents === null && <Text dimColor>unknown</Text>}
        {listedAgents?.length === 0 && <Text dimColor>none this session</Text>}
        {listedAgents?.slice(page * 9, page * 9 + 9).map((agent, index) => (
          <Button key={`agent:${agent.id}`} plain hotkey={String(index + 1)}
            dimColor={agent.status === 'completed'}
            label={`${e.props.view?.agentId === agent.id ? '> ' : ''}${plain(agent.name || agent.description || agent.type, 80)} · ${agent.status}`}
            onPress={() => selectAgent($, agent)} />
        ))}
        {(listedAgents?.length ?? 0) > 9 && <Box flexDirection="row">
          {page > 0 && <Button key="agents-prev" plain label="Previous" onPress={() => {
            agentPage = page - 1; $.ui.invalidate('ui.render')
          }} />}
          {(page + 1) * 9 < listedAgents!.length && <Button key="agents-next" plain label="Next" onPress={() => {
            agentPage = page + 1; $.ui.invalidate('ui.render')
          }} />}
        </Box>}

        {todoList.length > 0 && (
          <Box flexDirection="column">
            {gap}
            {heading(`Todo ${doneTodos}/${todoList.length}`)}
            {todoList.slice(0, LIST_MAX).map(t => (
              <Text
                wrap="truncate-end"
                dimColor={t.status === 'completed'}
                strikethrough={t.status === 'completed'}
                color={t.status === 'in_progress' ? 'warning' : undefined}
              >
                {mark(t.status)}
                {t.status === 'in_progress' ? t.activeForm : t.content}
              </Text>
            ))}
            {more(todoList.length)}
          </Box>
        )}

        {gap}
        {heading('Tools')}
        <Text dimColor>LSP: {snap?.hasLspTool ? 'tool on, servers unknown' : 'unknown'}</Text>
        <Text wrap="truncate-end" dimColor>
          MCP: {snap?.mcpServers.length ? snap.mcpServers.join(', ') : 'none'}
        </Text>

        {gap}
        {heading(`Edited${changed.length ? ` ${changed.length}` : ''}`)}
        {changed.length === 0 && <Text dimColor>none this session</Text>}
        {changed
          .slice(-LIST_MAX)
          .reverse()
          .map(f => (
            <Text wrap="truncate-start">
              {relative(f.path, cwd)}
              {f.edits > 1 && <Text dimColor> ×{f.edits}</Text>}
            </Text>
          ))}
        {more(changed.length)}

        {snap && snap.git !== null && (
          <Box flexDirection="column">
            {gap}
            {heading(`Git ${snap.branch ?? ''}${snap.git.length ? ` · ${snap.git.length}` : ' · clean'}`)}
            {snap.git.slice(0, LIST_MAX).map(g => (
              <Text wrap="truncate-start">
                <Text color={g.code === '??' ? 'inactive' : 'warning'}>{g.code.padEnd(2)} </Text>
                {g.path}
              </Text>
            ))}
            {more(snap.git.length)}
          </Box>
        )}

        {gap}
        {heading('Windows')}
        {snap?.windows == null && <Text dimColor>bridge registry not found</Text>}
        {snap?.windows?.slice(0, LIST_MAX).map(w => (
          <Text wrap="truncate-end" dimColor={w.ageSec > STALE_SEC}>
            <Text color={w.ageSec > STALE_SEC ? 'inactive' : 'success'}>{w.ageSec > STALE_SEC ? '○ ' : '● '}</Text>
            {w.isMe ? <Text bold>{w.name}</Text> : w.name}
            <Text dimColor>
              {w.port !== null ? ` :${w.port}` : ''}
              {w.ageSec > STALE_SEC ? ` unknown (${w.ageSec}s)` : ''}
              {w.isMe ? ' (this)' : ''}
            </Text>
          </Text>
        ))}
        {more(snap?.windows?.length ?? 0)}
      </Box>
    )
  })
}
