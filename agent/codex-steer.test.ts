import { expect, spyOn, test } from 'bun:test'

// codex.ts keeps one module-level connection; close every fake socket a test
// opened so the next test (in this or another file) starts disconnected.
function closeAll(sockets: any[]) {
  for (const s of sockets) { if (s.readyState !== 3) { s.readyState = 3; s.onclose?.() } }
}

// A steer whose answer never comes may already be in the running turn: the
// adapter must not start another turn with the same text. A steer the server
// refuses outright was not applied, so starting a turn is still right.
test('an unanswered steer is reported as uncertain and never followed by turn/start', async () => {
  const originalWebSocket = globalThis.WebSocket
  const sent: { method: string; params: any }[] = []
  let steer: 'refuse' | 'drop' = 'refuse'
  const processes = spyOn(Bun, 'spawnSync').mockImplementation(() => ({ stdout: Buffer.from(''), exitCode: 0 } as any))
  const thread = { id: 'live', cwd: '/work/steer-project', updatedAt: 10, source: 'vscode', status: { type: 'active' } }
  const opened: any[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: any
    onmessage: any
    onclose: any
    constructor() { opened.push(this); queueMicrotask(() => this.onopen?.()) }
    send(raw: string) {
      const m = JSON.parse(raw)
      sent.push(m)
      if (m.method === 'turn/steer' && steer === 'drop') {
        // The connection dies after the request went out: no answer, ever.
        queueMicrotask(() => { this.readyState = 3; this.onclose?.() })
        return
      }
      const reply: any = { id: m.id }
      if (m.method === 'turn/steer') reply.error = { message: 'no active turn' }
      else if (m.method === 'thread/loaded/list') reply.result = { data: ['live'], nextCursor: null }
      else if (m.method === 'thread/read') reply.result = { thread }
      else if (m.method === 'thread/list') reply.result = { data: [], nextCursor: null }
      else reply.result = {}
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    const { deliverToCodex } = await import('./codex.ts')
    const refused = await deliverToCodex('/work/steer-project', 'first')
    expect(refused).toMatchObject({ ok: true, mode: 'turn', thread_id: 'live' })
    expect(sent.filter(m => m.method === 'turn/start')).toHaveLength(1)

    steer = 'drop'
    sent.length = 0
    const dropped = await deliverToCodex('/work/steer-project', 'second')
    expect(dropped).toMatchObject({ ok: false, uncertain: true, mode: 'steer', thread_id: 'live' })
    expect(sent.map(m => m.method)).toContain('turn/steer')
    expect(sent.filter(m => m.method === 'turn/start')).toHaveLength(0)
  } finally {
    closeAll(opened)
    globalThis.WebSocket = originalWebSocket
    processes.mockRestore()
  }
})

test('a late close of an old socket does not fail a request on the new one', async () => {
  const originalWebSocket = globalThis.WebSocket
  const processes = spyOn(Bun, 'spawnSync').mockImplementation(() => ({ stdout: Buffer.from(''), exitCode: 0 } as any))
  const thread = { id: 'idle', cwd: '/work/socket-project', updatedAt: 10, source: 'vscode', status: { type: 'idle' } }
  const sockets: any[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: any
    onmessage: any
    onclose: any
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()) }
    send(raw: string) {
      const m = JSON.parse(raw)
      if (m.method === 'turn/start' && sockets.length > 1 && this === sockets.at(-1)) {
        // The previous socket's close event arrives while this request is in flight.
        for (const old of sockets.slice(0, -1)) old.onclose?.()
      }
      const reply: any = { id: m.id, result: {} }
      if (m.method === 'thread/loaded/list') reply.result = { data: ['idle'], nextCursor: null }
      if (m.method === 'thread/read') reply.result = { thread }
      if (m.method === 'thread/list') reply.result = { data: [], nextCursor: null }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    const { deliverToCodex } = await import('./codex.ts')
    expect((await deliverToCodex('/work/socket-project', 'one')).ok).toBe(true)
    for (const s of sockets) s.readyState = 3          // the connection drops (close event not yet delivered)
    const second = await deliverToCodex('/work/socket-project', 'two')
    expect(second).toMatchObject({ ok: true, mode: 'turn' })
  } finally {
    closeAll(sockets)
    globalThis.WebSocket = originalWebSocket
    processes.mockRestore()
  }
})
