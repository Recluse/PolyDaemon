// Real MCP + HTTP handlers, fake Telegram only. A message the plugin has already
// acknowledged (202) but then fails to hand to the agent must be reported in the
// chat, without the bot token, and must not be retried.
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { createServer } from 'net'

test('an acknowledged message that cannot be handed over is reported in the chat', async () => {
  const root = resolve(import.meta.dir, '../..')
  const scratch = join(root, '.local-test-artifacts')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'undelivered-'))
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  // The inbox cannot be written (as on a full disk): saving the photo throws.
  const inbox = join(home, '.tg-bridge-channel', 'inbox')
  mkdirSync(inbox, { recursive: true })
  chmodSync(inbox, 0o500)
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(r => socket.close(() => r()))
  const sent: any[] = []
  const notified: any[] = []
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.json().catch(() => ({})) as any
    if (path === '/register' || path === '/heartbeat') {
      return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123, message_thread_id: 42 } })
    }
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123, is_bot: true, first_name: 'F' } })
    if (path.endsWith('/sendMessage')) sent.push(structuredClone(body))
    return Response.json({ ok: true, result: { message_id: 500 + sent.length, chat: { id: -100123 }, date: 1, text: body.text } })
  } })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(TG_|CLAUDE_|CODEX_)/.test(k)) env[k] = v
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TG_BOT_TOKEN: '123:secret-fixture-token',
    TG_BRIDGE_AUTH_TOKEN: 'fixture', TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_PORT: String(port),
    TG_BRIDGE_BIND_HOST: '127.0.0.1', TG_BRIDGE_BOT_URL: fake.url.origin, TG_API_ROOT: fake.url.origin })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'channel-plugin/server.ts')],
    cwd: workspace, env, stderr: 'pipe' })
  const client = new Client({ name: 'claude-code', version: 'fixture' })
  client.fallbackNotificationHandler = async n => { notified.push(n) }
  try {
    await client.connect(transport)
    await Bun.sleep(1500)
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    const photo = { chat_id: '-100123', message_id: 77, user_id: 42, text: 'see photo', request_id: 'r1',
      image: { data: Buffer.from('fixture').toString('base64'), mime_type: 'image/png' } }
    expect((await post(photo)).status).toBe(202)
    let report: any
    for (let i = 0; i < 100 && !report; i++) {
      await Bun.sleep(30)
      report = sent.find(m => /не приняло/.test(m.text ?? ''))
    }
    expect(report).toBeDefined()
    expect(String(report.chat_id)).toBe('-100123')
    expect(report.reply_parameters?.message_id).toBe(77)
    expect(report.message_thread_id).toBe(42)
    expect(report.text).toContain('не дошло')            // failed before the pull queue: definitely lost
    expect(JSON.stringify(sent)).not.toContain('secret-fixture-token')
    expect(JSON.stringify(sent)).not.toContain(home)    // no local account paths in the chat
    // Nothing reached the agent and nothing was retried.
    expect(notified.filter(n => n.method === 'notifications/claude/channel')).toHaveLength(0)
    expect(sent.filter(m => /не приняло/.test(m.text ?? ''))).toHaveLength(1)
    // A plain message still goes through and produces no report.
    expect((await post({ chat_id: '-100123', message_id: 78, user_id: 42, text: 'plain' })).status).toBe(202)
    for (let i = 0; i < 100 && !notified.length; i++) await Bun.sleep(30)
    expect(notified.map(n => n.params?.content)).toEqual(['plain'])
    expect(sent.filter(m => /не приняло/.test(m.text ?? ''))).toHaveLength(1)
  } finally {
    await client.close().catch(() => {})
    fake.stop(true)
    chmodSync(inbox, 0o700)
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
