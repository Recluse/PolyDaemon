import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

for (const agent of ['opencode', 'mimo']) test(`${agent} queue survives process death, stays scoped, and only exact head ack removes items`, async () => {
  const home = mkdtempSync(join(process.cwd(), '.queue-test-'))
  let row: any
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = reservation.port
  reservation.stop(true)
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json().catch(() => ({}))
    if (new URL(req.url).pathname === '/register') row = body
    return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123, message_thread_id: 456, title: 'Actual topic' },
      result: { id: 123, is_bot: true, first_name: 'Test', username: 'test' } })
  } })
  let client: Client
  let transport: StdioClientTransport
  async function connect(cwd = home, stateHome = home, kind = agent) {
    row = null
    client = new Client({ name: agent, version: 'test' })
    transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve(import.meta.dir, '../server.ts')], cwd, stderr: 'pipe',
      env: { HOME: stateHome, PATH: process.env.PATH!, TG_BOT_TOKEN: 'test', TG_BRIDGE_AUTH_TOKEN: 'test',
        TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_AGENT: kind, TG_WINDOW_UID: 'test-queue',
        TG_API_ROOT: fake.url.origin, TG_BRIDGE_BOT_URL: fake.url.origin, TG_BRIDGE_PORT: String(port) },
    })
    await client.connect(transport)
    for (let i = 0; i < 100 && !row; i++) await Bun.sleep(20)
    expect(row).toBeTruthy()
  }
  async function request(path: string, body?: any) {
    return fetch(`http://${row.host}:${row.port}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }
  try {
    await connect()
    expect(client.getServerVersion()?.name).toBe('PolyDaemon')
    for (let i = 0; i < 150 && !(await (await request('/status')).json()).topic; i++) await Bun.sleep(20)
    expect((await (await request('/status')).json()).topic).toEqual({ forum_chat_id: -100123, message_thread_id: 456, title: 'Actual topic' })
    expect((await request('/inject', { text: '/compact' })).status).toBe(501)
    await request('/message', { chat_id: 123, user_id: 123, message_id: 42, text: 'test queue' })
    const before = await (await request('/inbound')).json()
    expect(before.item.content).toBe('test queue')
    const receive = await client.callTool({ name: 'receive', arguments: { wait_seconds: 0 } })
    expect(receive.content).toEqual([{ type: 'text', text: '[]' }])
    expect(await (await request('/inbound')).json()).toEqual(before)
    for (let i = 0; i < 101; i++) {
      await request('/message', { chat_id: 123, user_id: 123, message_id: 100 + i, text: `pending ${i}` })
    }
    expect(await (await request('/inbound')).json()).toEqual(before)
    // SIGKILL skips the shutdown hook: this is recovery from committed disk state.
    process.kill(row.pid, 'SIGKILL')
    await client.close()
    await transport.close()
    await connect()
    expect(await (await request('/inbound')).json()).toEqual(before)
    await client.close()
    await transport.close()
    await connect(home, home, agent === 'mimo' ? 'opencode' : 'mimo')
    expect((await (await request('/inbound')).json()).item).toBeNull()
    expect((await request('/inbound-ack', { id: before.item.id })).status).toBe(409)
    await client.close()
    await transport.close()
    const sibling = join(home, 'sibling')
    mkdirSync(sibling)
    await connect(sibling)
    expect((await (await request('/inbound')).json()).item).toBeNull()
    expect((await request('/inbound-ack', { id: before.item.id })).status).toBe(409)
    await client.close()
    await transport.close()
    await connect()
    expect(await (await request('/inbound')).json()).toEqual(before)
    expect((await request('/inbound-ack', { id: 'wrong' })).status).toBe(409)
    await request('/inbound-ack', { id: before.item.id })
    expect((await (await request('/inbound')).json()).item.content).toBe('pending 0')
    await client.close()
    await transport.close()
    const failed = join(home, 'failed-storage')
    mkdirSync(join(failed, '.tg-bridge-channel', 'opencode-inbound.db'), { recursive: true })
    await connect(failed, failed)
    expect((await request('/message', { chat_id: 123, user_id: 123, message_id: 500, text: 'must not acknowledge' })).status).toBe(500)
    expect((await request('/inbound')).status).toBe(500)
  } finally {
    const closingAt = Date.now()
    await client.close()
    await transport.close()
    fake.stop(true)
    rmSync(home, { recursive: true })
    expect(Date.now() - closingAt).toBeLessThan(1800)
  }
}, 20000)
