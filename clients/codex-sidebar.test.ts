import { expect, test } from 'bun:test'
import { CodexSidebar, SidebarRpc, clean, limitsView, memoryView, transcriptView, gitBranch } from './codex-sidebar.ts'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

test('current Git branch is read even when thread gitInfo is missing; detached and no repo are distinct', async () => {
  mkdirSync('tmp', { recursive: true })
  const dir = mkdtempSync(join(process.cwd(), 'tmp/sidebar-git-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  try {
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', '-C', dir, ...args], { env })
      expect(p.exitCode).toBe(0)
    }
    git('init', '-b', 'sidebar-fixture')
    expect(await gitBranch(dir)).toBe('sidebar-fixture')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Fixture')
    git('checkout', '--detach')
    expect(await gitBranch(dir)).toStartWith('detached ')
    expect(await gitBranch(join(dir, 'absent'))).toBe('unavailable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const cwd = process.cwd()
test('unrelated hanging MCP discovery is never requested by either status poll', async () => {
  const calls: any[] = []
  const reader = new CodexSidebar({ call: async (method, p) => {
    calls.push({ method, params: p })
    if (method === 'thread/read') return { thread: { id: 'root', cwd, status: { type: 'idle' } } }
    if (method === 'mcpServerStatus/list') {
      if (!p.serverName) throw Error('Unfiltered discovery would hang')
      if (p.serverName === 'tg-bridge') return { data: [{ name: 'tg-bridge', runtimeStatus: 'connected', serverInfo: { name: 'PolyDaemon' } }] }
      if (p.serverName === 'agentmem') return { data: [{ name: 'agentmem', runtimeStatus: 'connected', tools: {
        project_status: { name: 'project_status', annotations: { readOnlyHint: true, destructiveHint: false } },
      } }] }
      return { data: [] }
    }
    expect(p.server).toBe('agentmem')
    expect(p.threadId).toBe('root')
    return { structuredContent: memory() }
  } }, 'root', cwd)
  expect((await reader.bridge()).state).toBe('connected')
  expect((await reader.memory()).docs).toBe(2)
  expect(calls.filter(c => c.method === 'mcpServerStatus/list').every(c => c.params.serverName && c.params.threadId === 'root')).toBe(true)
})
test('bridge details use only exact thread MCP and validate physical root', async () => {
  let root = cwd
  const reader = new CodexSidebar({ call: async (method, p) => {
    if (method === 'thread/read') return { thread: { id: 'root', cwd, status: { type: 'idle' } } }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'bridge', runtimeStatus: 'connected',
      serverInfo: { name: 'PolyDaemon' }, tools: { bridge_status: { name: 'bridge_status',
        annotations: { readOnlyHint: true, destructiveHint: false } } } }] }
    expect(p).toEqual({ threadId: 'root', server: 'bridge', tool: 'bridge_status', arguments: {} })
    return { structuredContent: { version: 1, root, state: 'connected', working: false,
      topic: { id: 42, title: 'Exact topic' }, pending: { approvals: 1, questions: 2, plans: 0 },
      tasks: { state: 'available', items: [] } } }
  } }, 'root', cwd, { bridge: 'bridge' })
  expect((await reader.bridge()).topic).toEqual({ id: 42, title: 'Exact topic' })
  root = '/'
  expect(await reader.bridge()).toEqual({ state: 'connected', details: false, detailError: true })
})
test('connected legacy memory and bridge are not reported offline; missing status never invents counts', async () => {
  const calls: string[] = []
  const reader = new CodexSidebar({ call: async (method, p) => {
    calls.push(method)
    if (method === 'thread/read') return { thread: { id: 'root', cwd, status: { type: 'idle' } } }
    if (method === 'mcpServerStatus/list') return { data: [
      { name: 'arbitrary-memory', runtimeStatus: 'connected', tools: {
        a: { name: 'get_project_map' }, b: { name: 'memory_search' },
      } },
      { name: 'arbitrary-bridge', serverInfo: { name: 'PolyDaemon' }, runtimeStatus: 'connected' },
    ].filter(s => s.name === p.serverName) }
    throw Error('Must not call tools')
  } }, 'root', cwd, { memory: 'arbitrary-memory', bridge: 'arbitrary-bridge' })
  expect(await reader.memory()).toEqual({ available: false, connection: 'connected', reason: 'project_status not exposed' })
  expect(await reader.bridge()).toEqual({ state: 'connected', details: false })
  expect(calls).not.toContain('mcpServer/tool/call')
})
test('scope is explicit; agent transcript never resumes or executes a turn', async () => {
  const calls: any[] = []
  const rpc = { call: async (method: string, p: any) => {
    calls.push([method, p])
    if (method === 'thread/read') return { thread: { id: p.threadId, cwd,
      parentThreadId: p.threadId === 'child' ? 'root' : null, status: { type: 'idle' }, model: 'fixture' } }
    if (method === 'thread/list') return { data: [
      { id: 'child', parentThreadId: 'root', agentNickname: 'Reviewer', status: { type: 'active' } },
      { id: 'foreign', parentThreadId: 'elsewhere' },
    ], nextCursor: 'more' }
    if (method === 'thread/turns/list') return { data: [{ items: [
      { type: 'agentMessage', text: 'visible' }, { type: 'reasoning', content: ['hidden'] },
    ] }] }
    throw Error('unexpected')
  } }
  const reader = new CodexSidebar(rpc, 'root', cwd)
  const state = await reader.session()
  expect(state.agents?.map(a => a.id)).toEqual(['child'])
  expect(state.more).toBe(true)
  expect((await reader.agent('child')).lines).toEqual(['Assistant: visible'])
  const before = calls.filter(c => c[0] === 'thread/turns/list').length
  await expect(reader.agent('foreign')).rejects.toThrow('Not a child')
  expect(calls.filter(c => c[0] === 'thread/turns/list')).toHaveLength(before)
  expect(calls.every(c => ['thread/read', 'thread/list', 'thread/turns/list'].includes(c[0]))).toBe(true)
  expect(calls.find(c => c[0] === 'thread/list')[1].useStateDbOnly).toBe(true)
  await expect(new CodexSidebar({ call: async () => ({ thread: { id: 'root', cwd: '/' } }) }, 'root', cwd).session()).rejects.toThrow()
  expect(() => new CodexSidebar(rpc, '', cwd)).toThrow()
})

test('unsupported agents and invalid quota stay unknown, not empty/zero', async () => {
  const reader = new CodexSidebar({ call: async method => {
    if (method === 'thread/read') return { thread: { id: 'root', cwd } }
    throw Error('unsupported')
  } }, 'root', cwd)
  expect((await reader.session()).agents).toBeNull()
  expect(limitsView({ rateLimits: { primary: { usedPercent: -1 } } })).toEqual([])
  expect(limitsView({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000000000 } } })[0].used).toBe(0)
  expect(limitsView({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: {
    usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } } } })[0].label).toBe('codex')
})

const memory = () => ({ version: 1, repo: 'fixture', root: cwd, checked_at: '2026-10-15T18:00:00Z',
  documents: { indexed: 2 }, chunks: { indexed: 4 },
  freshness: { state: 'stale', checked_at: null, stale: 1, unindexed: 0, missing: 0 },
  map: { state: 'missing', components: 0, checked_at: null } })
test('memory uses existing thread catalog and only exact readonly project_status', async () => {
  let allowed = true, count = 0
  const reader = new CodexSidebar({ call: async (method, p) => {
    if (method === 'thread/read') return { thread: { id: 'root', cwd, status: { type: 'idle' } } }
    if (method === 'mcpServerStatus/list') {
      expect(p.threadId).toBe('root')
      expect(p.serverName).toBe('Memory')
      return { data: [{ name: 'Memory', runtimeStatus: 'connected', tools: {
        project_status: { name: 'project_status', annotations: { readOnlyHint: allowed, destructiveHint: false } },
      } }] }
    }
    expect(method).toBe('mcpServer/tool/call')
    expect(p).toEqual({ threadId: 'root', server: 'Memory', tool: 'project_status', arguments: {} })
    count++
    return { structuredContent: memory() }
  } }, 'root', cwd, { memory: 'Memory' })
  expect((await reader.memory()).docs).toBe(2)
  allowed = false
  await expect(reader.memory()).rejects.toThrow()
  expect(count).toBe(1)
  expect(() => memoryView({ ...memory(), root: '/' }, cwd)).toThrow()
  const bad = memory(); bad.freshness.state = 'fresh'
  expect(() => memoryView(bad, cwd)).toThrow()
})

test('display sanitizes control sequences and bounds visible transcript', () => {
  expect(clean('\x1b]52;c;unsafe\x07\u202e')).not.toContain('\x1b')
  expect(transcriptView([{ items: Array.from({ length: 100 }, () => ({ type: 'agentMessage', text: 'x'.repeat(8000) })) }])).toHaveLength(30)
  expect(transcriptView([{ items: [{ type: 'reasoning', summary: ['private'] }, { type: 'hookPrompt' }] }])).toEqual([])
})

test('loopback protocol handles deadlines, ignores server approval requests and allows no writes', async () => {
  const calls: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, s) { if (s.upgrade(req)) return; return new Response('upgrade', { status: 400 }) },
    websocket: { message(ws, raw) {
      const m = JSON.parse(String(raw)); calls.push(m)
      if (m.method === 'initialize') {
        ws.send(JSON.stringify({ id: 900, method: 'item/commandExecution/requestApproval', params: {} }))
        ws.send(JSON.stringify({ id: m.id, result: {} }))
      } else if (m.method === 'thread/read' && m.params.threadId !== 'hang') ws.send(JSON.stringify({ id: m.id, result: { thread: {} } }))
    } },
  })
  const rpc = new SidebarRpc(`ws://127.0.0.1:${server.port}`)
  try {
    await rpc.initialize()
    await expect(rpc.call('turn/start')).rejects.toThrow('Not a sidebar')
    await expect(rpc.call('mcpServer/tool/call', { tool: 'memory_write', arguments: {} })).rejects.toThrow()
    await expect(rpc.call('thread/read', { threadId: 'hang' }, 20)).rejects.toThrow()
    expect(await rpc.call('thread/read', { threadId: 'root' })).toEqual({ thread: {} })
    expect(rpc.pending.size).toBe(0)
    expect(calls.some(c => c.id === 900 || 'result' in c)).toBe(false)
  } finally { rpc.close(); server.stop(true) }
  expect(() => new SidebarRpc('ws://example.com:3210')).toThrow()
})
