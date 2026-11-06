import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LaunchBinding, bindingFilePublisher, launchProxy, contextUsage } from './codex-launch-proxy.ts'

test('ephemeral CLI work cannot steal the panel, its usage or a pending durable navigation', () => {
  const output: any[] = [], cwd = process.cwd()
  const b = new LaunchBinding(cwd, (id, context) => output.push({ id, context }))
  const start = (id: number, ephemeral?: boolean) => b.client(JSON.stringify({ id, method: 'thread/start', params: { ephemeral } }))
  const reply = (id: number, name: string, extra = {}) => b.server(JSON.stringify({ id, result: { thread: { id: name, cwd, ...extra } } }))
  start(1); reply(1, 'main', { ephemeral: false })
  b.server(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'main',
    tokenUsage: { last: { totalTokens: 500 }, modelContextWindow: 1000 } } }))
  const before = output.length
  start(2, true); reply(2, 'background', { ephemeral: true })
  b.server(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'background',
    tokenUsage: { last: { totalTokens: 900 }, modelContextWindow: 1000 } } }))
  expect(output).toHaveLength(before)
  expect(b.thread).toBe('main')
  start(3); reply(3, 'unexpected-ephemeral', { ephemeral: true })
  expect(output.at(-1)).toEqual({ id: 'main', context: { tokens: 500, window: 1000 } })
  start(4); start(5, true); reply(5, 'background-2', { ephemeral: true }); reply(4, 'new-main')
  expect(b.thread).toBe('new-main')
  start(6); start(7); reply(7, 'latest-main'); reply(6, 'late-background', { ephemeral: true })
  expect(b.thread).toBe('latest-main')
  start(8); reply(8, 'child', { parentThreadId: 'latest-main' })
  expect(b.thread).toBe('latest-main')
})

test('context observes only bound-thread last usage, never cumulative or foreign usage', () => {
  const output: any[] = []
  const b = new LaunchBinding(process.cwd(), (id, context) => output.push({ id, context }))
  const usage = { last: { totalTokens: 12000 }, total: { totalTokens: 900000 }, modelContextWindow: 128000 }
  const event = (id: string, u: any = usage) => b.server(JSON.stringify({ method: 'thread/tokenUsage/updated',
    params: { threadId: id, tokenUsage: u } }))
  event('root'); expect(output).toHaveLength(0)
  b.client(JSON.stringify({ id: 1, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'root', cwd: process.cwd() } } }))
  event('root')
  expect(output.at(-1)).toEqual({ id: 'root', context: { tokens: 12000, window: 128000 } })
  const length = output.length
  event('foreign'); expect(output).toHaveLength(length)
  b.client(JSON.stringify({ id: 2, method: 'thread/start' }))
  event('root'); expect(output.at(-1).id).toBeNull()
  expect(contextUsage({ last: { totalTokens: -1 }, modelContextWindow: 100 })).toBeNull()
  expect(contextUsage({ last: { totalTokens: 0 }, modelContextWindow: null })).toEqual({ tokens: 0, window: null })
  expect(contextUsage({ last: { totalTokens: 10 }, modelContextWindow: 0 })).toBeNull()
})

test('binding follows this CLI only, including new, resume, fork and response races', () => {
  const ids: (string | null)[] = [], cwd = process.cwd()
  const b = new LaunchBinding(cwd, id => ids.push(id))
  b.server(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'foreign', cwd } } }))
  expect(ids).toEqual([])
  b.client(JSON.stringify({ id: 1, method: 'thread/start' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'new', cwd } } }))
  expect(ids).toEqual([null, 'new'])
  b.client(JSON.stringify({ id: 2, method: 'thread/resume' }))
  b.client(JSON.stringify({ id: 3, method: 'thread/fork' }))
  b.server(JSON.stringify({ id: 2, result: { thread: { id: 'late', cwd } } }))
  expect(ids.at(-1)).toBeNull()
  b.server(JSON.stringify({ id: 3, result: { thread: { id: 'fork', cwd } } }))
  expect(ids.at(-1)).toBe('fork')
  b.client(JSON.stringify({ id: 4, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 4, result: { thread: { id: 'foreign', cwd: '/' } } }))
  expect(ids.at(-1)).toBeNull()
  b.client(JSON.stringify({ id: 5, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 5, error: { message: 'failed' } }))
  expect(ids.at(-1)).toBeNull()
})

test('proxy preserves requests and approval payloads byte-for-byte; it makes no decisions', async () => {
  const seen: string[] = [], received: string[] = [], ids: (string | null)[] = []
  const approval = '{"id":41,"method":"item/commandExecution/requestApproval","params":{"command":"fixture"}}'
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, s) { if (s.upgrade(req)) return; return new Response('no', { status: 400 }) },
    websocket: { message(ws, raw) {
      seen.push(String(raw))
      const m = JSON.parse(String(raw))
      if (m.method === 'thread/start') {
        ws.send(JSON.stringify({ id: m.id, result: { thread: { id: 'exact', cwd: process.cwd() } } }))
        ws.send(approval)
      }
    } },
  })
  const proxy = launchProxy(`ws://127.0.0.1:${upstream.port}`, process.cwd(), id => ids.push(id))
  const cli = new WebSocket(`ws://127.0.0.1:${proxy.port}`)
  try {
    await new Promise<void>((ok, fail) => { cli.onopen = () => ok(); cli.onerror = fail })
    cli.onmessage = e => received.push(String(e.data))
    const start = '{ "id": 1, "method": "thread/start", "params": {"fixture":true} }'
    cli.send(start)
    for (let i = 0; received.length < 2 && i < 50; i++) await Bun.sleep(10)
    expect(seen).toEqual([start])
    expect(received[1]).toBe(approval)
    expect(ids.at(-1)).toBe('exact')
    const human = '{ "id": 41, "result": {"decision":"decline"} }'
    cli.send(human)
    for (let i = 0; seen.length < 2 && i < 50; i++) await Bun.sleep(10)
    expect(seen).toEqual([start, human])
  } finally { cli.close(); proxy.stop(); upstream.stop(true) }
})

test('a failed thread switch leaves the panel on the thread the CLI is still on', () => {
  const output: any[] = [], cwd = process.cwd()
  const b = new LaunchBinding(cwd, (id, context) => output.push({ id, context }))
  b.client(JSON.stringify({ id: 1, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'main', cwd } } }))
  b.client(JSON.stringify({ id: 2, method: 'thread/resume' }))
  expect(b.thread).toBeNull()                       // navigation in flight
  b.server(JSON.stringify({ id: 2, error: { code: -32600, message: 'no such thread' } }))
  expect(b.thread).toBe('main')
  expect(output.at(-1)).toEqual({ id: 'main', context: null })
})

test('the binding file is rewritten after its folder was deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-binding-'))
  try {
    const folder = join(root, 'tmp', '.polydaemon-codex-x')
    const file = join(folder, 'binding.json')
    const publish = bindingFilePublisher(file, '/work/project')
    publish('first')
    rmSync(join(root, 'tmp'), { recursive: true, force: true })   // workspace cleanup
    publish('second')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ thread: 'second', cwd: '/work/project', context: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('overlapping failed switches return to the confirmed thread', () => {
  const output: any[] = [], cwd = process.cwd()
  const b = new LaunchBinding(cwd, (id, context) => output.push({ id, context }))
  b.client(JSON.stringify({ id: 1, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'main', cwd } } }))
  b.client(JSON.stringify({ id: 2, method: 'thread/resume' }))
  b.client(JSON.stringify({ id: 3, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 2, error: { message: 'no such thread' } }))
  b.server(JSON.stringify({ id: 3, error: { message: 'no such thread' } }))
  expect(b.thread).toBe('main')
})

test('a symlinked tmp/ is not followed when the binding folder is recreated', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-binding-'))
  try {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const file = join(root, 'ws', 'tmp', '.polydaemon-codex-x', 'binding.json')
    const publish = bindingFilePublisher(file, '/work/project')
    publish('first')
    rmSync(join(root, 'ws', 'tmp'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(root, 'ws', 'tmp'))
    expect(() => publish('second')).toThrow(/symlink/)
    expect(existsSync(join(elsewhere, '.polydaemon-codex-x'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a planted .next symlink does not redirect the write', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-binding-'))
  try {
    const folder = join(root, 'tmp', '.polydaemon-codex-x')
    mkdirSync(folder, { recursive: true })
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(folder, 'binding.json.next'))
    const publish = bindingFilePublisher(join(folder, 'binding.json'), '/work/project')
    expect(() => publish('x')).toThrow()
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlinked tmp/ is refused even when the target folder already exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-binding-'))
  try {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(join(elsewhere, '.polydaemon-codex-x'), { recursive: true })
    const file = join(root, 'ws', 'tmp', '.polydaemon-codex-x', 'binding.json')
    const publish = bindingFilePublisher(file, '/work/project')
    publish('first')
    rmSync(join(root, 'ws', 'tmp'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(root, 'ws', 'tmp'))
    expect(() => publish('second')).toThrow(/symlink/)
    expect(existsSync(join(elsewhere, '.polydaemon-codex-x', 'binding.json'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a switch to a thread whose folder cannot be read clears the confirmation', () => {
  const cwd = process.cwd()
  const b = new LaunchBinding(cwd, () => {})
  b.client(JSON.stringify({ id: 1, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'main', cwd } } }))
  b.client(JSON.stringify({ id: 2, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 2, result: { thread: { id: 'gone', cwd: '/no/such/folder/anywhere' } } }))
  b.client(JSON.stringify({ id: 3, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 3, error: { message: 'failed' } }))
  expect(b.thread).toBeNull()
})

test('a failure after an older successful switch falls back to that switch', () => {
  const cwd = process.cwd()
  const b = new LaunchBinding(cwd, () => {})
  b.client(JSON.stringify({ id: 1, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 1, result: { thread: { id: 'main', cwd } } }))
  b.client(JSON.stringify({ id: 2, method: 'thread/resume' }))
  b.client(JSON.stringify({ id: 3, method: 'thread/resume' }))
  b.server(JSON.stringify({ id: 2, result: { thread: { id: 'second', cwd } } }))
  b.server(JSON.stringify({ id: 3, error: { message: 'failed' } }))
  expect(b.thread).toBe('second')
})
