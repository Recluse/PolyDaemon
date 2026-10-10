// Real MCP + HTTP handlers, fake Telegram only. No model, owner callbacks or production state.
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { createServer } from 'net'

test('approval waits for an explicit decision; fast taps work and bad callbacks fail closed', async () => {
  const root = resolve(import.meta.dir, '../..')
  const scratch = join(root, '.local-test-artifacts')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'approval-'))
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  expect(Bun.spawnSync(['git', '-C', workspace, 'init', '-b', 'approval-probe'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' },
  }).exitCode).toBe(0)
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(r => socket.close(() => r()))
  let phase = 'wait'
  let id = ''
  let card!: () => void
  const callbackStatuses: number[] = []
  async function post(path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
  }
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.json().catch(() => ({})) as any
    if (path === '/register' || path === '/heartbeat') {
      return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123, message_thread_id: 42 } })
    }
    if (path.endsWith('/getMe')) {
      return Response.json({ ok: true, result: { id: 123, is_bot: true, first_name: 'Fixture' } })
    }
    const button = body.reply_markup?.inline_keyboard?.flat().find((b: any) => /^(approve|plan):/.test(b.callback_data ?? ''))
    if (button) {
      const plan = button.callback_data.startsWith('plan:')
      if (!plan) expect(body.text).toContain('Repository: <code>project</code>\nBranch: <code>approval-probe</code>')
      id = button.callback_data.split(':')[1]
      if (phase === 'early') callbackStatuses.push((await post(plan ? '/plan-callback' : '/approve-callback', { id, action: plan ? 'apply' : 'once' })).status)
      card()
      if (phase === 'failure') return Response.json({ ok: false, error_code: 400, description: 'fixture send failure' })
    }
    return Response.json({ ok: true, result: { message_id: 100, chat: { id: -100123 }, date: 1, text: body.text } })
  } })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(TG_|CLAUDE_|CODEX_)/.test(k)) env[k] = v
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TG_BOT_TOKEN: '123:fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture',
    TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_PORT: String(port), TG_BRIDGE_BIND_HOST: '127.0.0.1',
    TG_BRIDGE_BOT_URL: fake.url.origin, TG_API_ROOT: fake.url.origin })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'channel-plugin/server.ts')],
    cwd: workspace, env, stderr: 'pipe' })
  const client = new Client({ name: 'codex', version: 'fixture' })
  let stderr = ''
  transport.stderr?.on('data', b => { stderr += b })
  try {
    await client.connect(transport)
    // The eager heartbeat supplies the owning topic before the first request.
    await Bun.sleep(3500)
    for (const kind of ['http', 'mcp', 'plan']) {
      const callback = kind === 'plan' ? '/plan-callback' : '/approve-callback'
      const allow = kind === 'plan' ? 'apply' : 'once'
      const deny = kind === 'plan' ? 'decline' : 'deny'
        const request = async () => kind === 'plan'
          ? (await post('/exit-plan', { plan: 'Review the fixture changes.' })).json()
          : kind === 'http'
        ? await (async () => {
          const response = await post('/approve-request', { tool_name: 'fixture', sensitive: true })
          expect(response.status).toBe(phase === 'failure' ? 503 : 200)
          return response.json()
        })()
        : await (async () => {
          const response = await client.callTool({ name: 'approve_action', arguments: { tool_name: 'fixture' } })
          expect(response.isError === true).toBe(phase === 'failure')
          return JSON.parse(response.content[0].text)
        })()
      for (const scenario of ['wait', 'early', 'failure']) {
        phase = scenario
        const published = new Promise<void>(r => { card = r })
        let finished = false
        const pending = request().then(r => { finished = true; return r })
        await Promise.race([published, pending.then(result => {
          throw new Error(`Request finished before publishing ${kind}/${scenario}: ${JSON.stringify(result)}`)
        })])
        if (scenario === 'wait') {
          for (const invalid of [{ id }, { id, action: null }, { id, action: 'accept' }, { id, action: true }, null, {}]) {
            expect((await post(callback, invalid)).status).toBe(400)
          }
          expect((await post(callback, { id: 'wrong', action: allow })).status).toBe(404)
          expect((await post('/status')).ok).toBe(true)
          expect(finished).toBe(false)
          expect((await post(callback, { id, action: deny })).status).toBe(200)
        }
        const result = await pending
        if (kind === 'plan') {
          expect(result.status).toBe(scenario === 'failure' ? 'fallback' : 'answered')
          expect(result.decision).toBe(scenario === 'failure' ? undefined : scenario === 'early' ? 'apply' : 'decline')
        } else if (scenario === 'failure') {
          expect(result.decision).toBeUndefined()
          expect(result.behavior).toBeUndefined()
          expect(result.error).toBe('approval_delivery_failed')
        } else expect(result.decision ?? result.behavior).toBe(scenario === 'early' ? 'allow' : 'deny')
        expect((await post(callback, { id, action: allow })).status).toBe(404)
        expect((await (await post('/status')).json())[kind === 'plan' ? 'pending_plan' : 'pending_approve']).toBe(false)
      }
    }
    expect(callbackStatuses).toEqual([200, 200, 200])
  } catch (e) {
    throw new Error(`${e}\n${stderr}`)
  } finally {
    await client.close()
    fake.stop(true)
    // The server removes its own registry entry during its one-second shutdown grace.
    await Bun.sleep(1200)
    rmSync(home, { recursive: true, force: true })
  }
}, 20000)
