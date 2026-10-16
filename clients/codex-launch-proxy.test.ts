import { expect, test } from 'bun:test'
import { LaunchBinding, launchProxy, contextUsage } from './codex-launch-proxy.ts'

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
