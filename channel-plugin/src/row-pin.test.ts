// A pinned request names the registry row the bot chose; a different process
// on that port (a new window on a reused port) refuses it.
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { createServer } from 'net'

test('a request pinned to another registry row is refused', async () => {
  const root = resolve(import.meta.dir, '../..')
  const scratch = join(root, '.local-test-artifacts')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'rowpin-'))
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(r => socket.close(() => r()))
  let ownRow = ''
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.json().catch(() => ({})) as any
    if (path === '/register') ownRow = body.id
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'F' } })
    return Response.json({ ok: true, topic_binding: null, result: { message_id: 1, chat: { id: 1 }, date: 1 } })
  } })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TG_|CLAUDE_|CODEX_)/.test(k)) env[k] = v
  Object.assign(env, { HOME: home, USERPROFILE: home, TG_BOT_TOKEN: '123:fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture',
    TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_PORT: String(port), TG_BRIDGE_BIND_HOST: '127.0.0.1',
    TG_BRIDGE_BOT_URL: fake.url.origin, TG_API_ROOT: fake.url.origin })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'channel-plugin/server.ts')],
    cwd: workspace, env, stderr: 'pipe' })
  const client = new Client({ name: 'claude-code', version: 'fixture' })
  try {
    await client.connect(transport)
    for (let i = 0; i < 100 && !ownRow; i++) await Bun.sleep(30)
    expect(ownRow).not.toBe('')
    const post = (row: string | null) => fetch(`http://127.0.0.1:${port}/message`, { method: 'POST',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json',
        ...(row === null ? {} : { 'X-PolyDaemon-Row': row }) },
      body: JSON.stringify({ chat_id: '1', message_id: 1, user_id: 1, text: 'hi' }) })
    expect((await post('someone-else')).status).toBe(409)
    expect((await post(ownRow)).status).toBe(202)
    expect((await post(null)).status).toBe(202)        // older bots send no header
  } finally {
    await client.close().catch(() => {})
    fake.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
