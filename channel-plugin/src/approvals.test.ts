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
  let taskMode = 'ok'
  const taskWindows: string[] = []
  const approvalCards: any[] = []
  const sentMessages: any[] = []
  const editedKeyboards: any[] = []
  let telegramId = 100
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
    if (path === '/my-tasks') {
      taskWindows.push(body.window)
      if (taskMode === 'error') return Response.json({ reason: 'secret fixture detail' }, { status: 503 })
      if (taskMode === 'invalid') return Response.json({ ok: true })
      return Response.json({ ok: true, tasks: [{ id: 7, from: 'Other', kind: 'tell', text: 'Fixture task', state: 'running', private_extra: 'must not escape' }] })
    }
    if (path === '/register' || path === '/heartbeat') {
      return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123, message_thread_id: 42 } })
    }
    if (path.endsWith('/getMe')) {
      return Response.json({ ok: true, result: { id: 123, is_bot: true, first_name: 'Fixture' } })
    }
    const question = body.reply_markup?.inline_keyboard?.flat().find((b: any) => /^ask:/.test(b.callback_data ?? ''))
    if (question && path.endsWith('/sendMessage')) {
      expect(String(body.chat_id)).toBe('-100123')
      expect(body.message_thread_id).toBe(42)
      id = question.callback_data.split(':')[1]
      card()
    }
    if (path.endsWith('/sendMessage')) sentMessages.push({ ...structuredClone(body), message_id: telegramId + 1 })
    if (path.endsWith('/editMessageReplyMarkup')) editedKeyboards.push(structuredClone(body))
    const button = body.reply_markup?.inline_keyboard?.flat().find((b: any) => /^(approve|plan):/.test(b.callback_data ?? ''))
    if (button) {
      approvalCards.push(structuredClone(body))
      const plan = button.callback_data.startsWith('plan:')
      if (!plan) expect(body.text).toContain('Repository: <code>project</code>\nBranch: <code>approval-probe</code>')
      id = button.callback_data.split(':')[1]
      if (phase === 'early') callbackStatuses.push((await post(plan ? '/plan-callback' : '/approve-callback', { id, action: plan ? 'apply' : 'once' })).status)
      card()
      if (phase === 'failure') return Response.json({ ok: false, error_code: 400, description: 'fixture send failure' })
    }
    return Response.json({ ok: true, result: { message_id: ++telegramId, chat: { id: -100123 }, date: 1, text: body.text,
      message_thread_id: body.message_thread_id } })
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
    expect((await fetch(`http://127.0.0.1:${port}/tasks`)).status).toBe(401)
    expect(taskWindows).toEqual([])
    const ownName = (await (await post('/status')).json()).instance_name
    const tasks = await (await post('/tasks?window=foreign')).json()
    expect(tasks).toEqual({ ok: true, tasks: [{ id: 7, from: 'Other', kind: 'tell', text: 'Fixture task', state: 'running' }] })
    expect(taskWindows).toEqual([ownName])
    for (const mode of ['error', 'invalid']) {
      taskMode = mode
      const unavailable = await post('/tasks')
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toEqual({ ok: false, tasks: null, reason: 'Tasks unavailable' })
    }
    const publishedQuestion = new Promise<void>(r => { card = r })
    let questionFinished = false
    const answer = post('/ask-question', { questions: [{ question: 'Which target?', options: [{ label: 'Fixture' }] }] })
      .then(r => r.json()).then(r => { questionFinished = true; return r })
    await Promise.race([publishedQuestion, answer.then(result => {
      throw new Error(`Question finished before publishing: ${JSON.stringify(result)}`)
    })])
    expect(questionFinished).toBe(false)
    expect((await post('/ask-callback', { id, idx: 0 })).status).toBe(200)
    const questionResult = await answer
    expect(questionResult.status).toBe('answered')
    expect(questionResult.answers[0].selectedLabels).toEqual(['Fixture'])
    const multiPublished = new Promise<void>(r => { card = r })
    const multiAnswer = post('/ask-question', { questions: [{ question: 'Choose targets',
      multiSelect: true, allowCustom: true, options: [{ label: 'Fixture' }] }] }).then(r => r.json())
    await multiPublished
    await Bun.sleep(20)
    const multiId = id
    async function bumpQuestion() {
      const count = sentMessages.length
      for (let i = 0; i < 3; i++) await post('/topic-activity', {
        chat_id: -100123, message_thread_id: 42, message_id: ++telegramId,
      })
      for (let i = 0; i < 100 && sentMessages.length === count; i++) await Bun.sleep(10)
      expect(sentMessages.length).toBe(count + 1)
      await Bun.sleep(20)
      return sentMessages.at(-1)
    }
    const repeated = await bumpQuestion()
    expect((await post('/ask-callback', { id: multiId, action: 'toggle', idx: 0 })).status).toBe(200)
    expect(editedKeyboards.at(-1).message_id).toBe(repeated.message_id)
    expect((await post('/ask-callback', { id: multiId, action: 'custom' })).status).toBe(200)
    const customReminder = await bumpQuestion()
    expect(customReminder.reply_markup).toEqual({ force_reply: true, selective: true })
    expect((await post('/ask-callback', { id: multiId, action: 'pick', idx: 0 })).status).toBe(409)
    expect((await post('/ask-callback', { id: multiId, action: 'text', text: 'Custom target' })).status).toBe(200)
    expect((await multiAnswer).answers[0].customText).toBe('Custom target')
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
          if (kind === 'http' || kind === 'mcp') {
            const count = approvalCards.length
            const originalId = id
            const originalCard = approvalCards.at(-1)
            if (kind === 'http') {
              expect((await fetch(`http://127.0.0.1:${port}/topic-activity`, { method: 'POST', body: '{}' })).status).toBe(401)
              expect((await post('/topic-activity', {})).status).toBe(400)
              const topic = { chat_id: -100123, message_thread_id: 42 }
              const baseline = telegramId
              for (const n of [1, 1, 2]) await post('/topic-activity', { ...topic, message_id: baseline + n })
              await post('/topic-activity', { ...topic, message_thread_id: 99, message_id: baseline + 3 })
              expect(approvalCards).toHaveLength(count)
              telegramId += 3
              await post('/topic-activity', { ...topic, message_id: telegramId })
            } else {
              for (let i = 0; i < 3; i++) {
                await client.callTool({ name: 'reply', arguments: { chat_id: '-100123', text: `Ordinary fixture ${i}` } })
                if (i < 2) expect(approvalCards).toHaveLength(count)
              }
            }
            for (let i = 0; i < 100 && approvalCards.length === count; i++) await Bun.sleep(10)
            expect(approvalCards).toHaveLength(count + 1)
            expect(id).toBe(originalId)
            expect(approvalCards.at(-1)).toEqual(originalCard)
            expect(finished).toBe(false)
          }
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
