import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { guardInput } from './bridge-tool-input.ts'
import { join } from 'node:path'
import { availableModel, binding, finalReply, inboundPartID, inboundTurn, isInboundMessage, modelError, relayReplies } from './mimo-bridge.ts'
import plugin from './mimo-plugin.ts'

test('MiMo transport failures never submit a denial, including a lost allow acknowledgement', async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.mimo-test-')))
  const saved = { ...process.env }
  let mode = 'offline'
  const replies: string[] = []
  let notified!: () => void
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/approve-request') {
      if (mode === 'offline') return new Response('offline', { status: 503 })
      return Response.json(mode === 'invalid' ? { error: 'approval_expired' } : { decision: mode === 'deny' ? 'deny' : 'allow' })
    }
    if (path === '/permission/fixture/reply') {
      replies.push((await req.json() as any).reply)
      if (mode === 'lost-ack') return new Response('lost acknowledgement', { status: 503 })
    }
    if (path === '/notify') notified()
    return Response.json({})
  } })
  try {
    Object.assign(process.env, { HOME: root, USERPROFILE: root, TG_MIMO_ROOT: root,
      TG_WINDOW_UID: 'permission-fixture', TG_BRIDGE_AGENT: 'mimo', TG_MIMO_BINDING: join(root, 'binding.json') })
    writeFileSync(process.env.TG_MIMO_BINDING!, JSON.stringify({ root, sessionID: 'ses_test' }))
    mkdirSync(join(root, '.tg-bridge-channel'))
    writeFileSync(join(root, '.tg-bridge-channel/instances.json'), JSON.stringify({ fixture: {
      cwd: root, instance_name: 'fixture-mimo', window_uid: 'permission-fixture',
      parent_pid: process.pid, pid: process.pid, heartbeat_at: Date.now() / 1000,
      host: '127.0.0.1', port: server.port, auth_token: 'fixture',
    } }))
    const hooks = await plugin.server({ directory: root, serverUrl: server.url })
    for (const scenario of ['offline', 'invalid', 'lost-ack', 'deny', 'allow']) {
      mode = scenario
      replies.length = 0
      let notification = false
      notified = () => { notification = true }
      await hooks.event!({ event: { type: 'permission.asked', properties: {
        id: 'fixture', sessionID: 'ses_test', permission: 'external_directory', patterns: ['/fixture/*'],
      } } })
      for (let n = 0; n < 100 && !(scenario === 'deny' || scenario === 'allow' ? replies.length : notification); n++) await Bun.sleep(10)
      expect(replies).toEqual(scenario === 'lost-ack' || scenario === 'allow' ? ['once'] : scenario === 'deny' ? ['reject'] : [])
      expect(notification).toBe(scenario !== 'deny' && scenario !== 'allow')
      await Bun.sleep(20)
      expect(replies.length).toBe(scenario === 'offline' || scenario === 'invalid' ? 0 : 1)
    }
  } finally {
    server.stop(true)
    process.env = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('MiMo data grant covers all windows without project config and stays inside its physical subtree', () => {
  const home = realpathSync(mkdtempSync(join(process.cwd(), '.mimo-test-')))
  const root = join(home, '.local/share/mimocode')
  mkdirSync(root, { recursive: true })
  symlinkSync(home, join(root, 'escape'), 'dir')
  const file = join(root, 'memory/sessions/ses_test/notes.md')
  const classify = (tool: string, args: any, agent = 'mimo') => {
    const result = spawnSync('node', ['hooks/tg-approve.js', '--classify'], {
      input: JSON.stringify(guardInput(tool, args, join(home, 'workspace'), agent)), encoding: 'utf8',
      env: { ...process.env, HOME: home, TG_BRIDGE_AGENT: agent, CODEX_THREAD_ID: '', CLAUDE_PROJECT_DIR: '' },
    })
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    for (const tool of ['read', 'write', 'edit']) expect(classify(tool, { filePath: file }).sessionMemory).toBe(true)
    expect(classify('write', { filePath: file }).sensitive).toBe(false)
    expect(classify('write', { filePath: file, file_path: join(home, 'outside') }).sensitive).toBe(true)
    for (const path of [root, root + '-other/x', join(root, '../outside/x'), join(root, 'escape/outside')]) {
      expect(classify('write', { filePath: path }).sensitive).toBe(true)
    }
    expect(classify('write', { filePath: file }, 'opencode').sensitive).toBe(true)
    expect(classify('bash', { command: 'git push origin main' }).sensitive).toBe(true)
    const patch = `*** Begin Patch\n*** Add File: ${file}\n+note\n*** End Patch`
    expect(classify('apply_patch', { patch_text: patch }).sensitive).toBe(false)
    expect(classify('apply_patch', { unknown: patch }).sensitive).toBe(true)
    const mixedPatch = patch.replace('*** End Patch', `*** Add File: ${home}/outside\n+bad\n*** End Patch`)
    expect(classify('apply_patch', { patch_text: mixedPatch, patchText: patch }).sensitive).toBe(true)
    expect(classify('apply_patch', { patch_text: `*** Begin Patch\n*** Delete File: ${file}\n*** End Patch` }).sensitive).toBe(true)
    for (const scope of ['memory/projects/own', 'memory/projects/another', 'memory/global', 'log', 'cache']) {
      for (const tool of ['read', 'write', 'edit']) expect(classify(tool, { file_path: join(root, scope, 'notes.md') }).sensitive).toBe(false)
    }
    for (const tool of ['glob', 'grep']) expect(classify(tool, { path: root, pattern: '**/*.md' }).sensitive).toBe(false)
    expect(classify('bash', { command: `cat ${file}`, cwd: root }).sensitive).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('MiMo admits while busy and retries output without blocking or repeating input', async () => {
  const messages: any[] = []
  let posts = 0, reject = true, writes = 0
  const api = async (path: string, body?: any, method?: string): Promise<any> => {
    if (path === '/provider') return { connected: ['fixture'], all: [{ id: 'fixture', models: { fixture: {} } }] }
    if (path === '/config') return { model: 'fixture/fixture' }
    if (path === '/session/status') return { ses_test: { type: 'busy' } }
    if (method === 'PATCH') {
      writes++
      messages.find(m => m.info.id === body.messageID).parts = [body]
      return body
    }
    if (body) {
      expect(path).toBe('/session/ses_test/prompt_async')
      if (reject) { reject = false; throw new Error('MiMo HTTP 429') }
      posts++
      const id = `msg_${posts}`
      messages.push({ info: { id, role: 'user' }, parts: body.parts.map((p: any) => ({ ...p, messageID: id, sessionID: 'ses_test' })) })
      return null
    }
    return messages
  }
  const item = { id: 'first', content: 'first', meta: { chat_id: '-100123' }, queued_at: '' }
  await expect(inboundTurn(api, 'ses_test', item, undefined, true)).rejects.toThrow('429')
  const first = await inboundTurn(api, 'ses_test', item, undefined, true)
  const second = await inboundTurn(api, 'ses_test', { ...item, id: 'second' }, undefined, true)
  expect(posts).toBe(2)
  expect(first.final).toBeNull()
  await inboundTurn(api, 'ses_test', item, undefined, true)
  expect(posts).toBe(2)
  messages.push({ info: { role: 'assistant', parentID: first.id, finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: 'first answer' }] })
  expect(finalReply(messages, second.id)).toBeNull()
  await expect(relayReplies(api, 'ses_test', async () => { throw new Error('Telegram unavailable') })).rejects.toThrow('Telegram unavailable')
  expect(writes).toBe(0)
  await inboundTurn(api, 'ses_test', { ...item, id: 'third' }, undefined, true)
  expect(posts).toBe(3)
  const sent: string[] = []
  await relayReplies(api, 'ses_test', async (text, chat, id) => { expect(chat).toBe('-100123'); expect(id).toBe(first.id); sent.push(text) })
  expect(sent).toEqual(['first answer'])
  await relayReplies(api, 'ses_test', async () => { throw new Error('Duplicate reply') })
  expect(writes).toBe(1)
})

test('MiMo keeps session scope, missing approvals closed, and reply dedup per incoming turn', async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.mimo-test-')))
  const saved = { ...process.env }
  try {
    process.env.TG_MIMO_ROOT = root
    process.env.TG_MIMO_BINDING = join(root, 'binding.json')
    writeFileSync(process.env.TG_MIMO_BINDING, JSON.stringify({ root, sessionID: 'ses_test' }))
    expect(binding(root).sessionID).toBe('ses_test')
    expect(() => binding(process.cwd())).toThrow('scope mismatch')
    const hooks = await plugin.server({ directory: root, serverUrl: new URL('http://127.0.0.1:1') })
    process.env.TG_WINDOW_UID = 'no-such-window'
    for (const tool of ['bash', 'shell']) {
      const output: any = { args: { command: 'git push origin main' } }
      await hooks['tool.execute.before']!({ sessionID: 'ses_test', callID: 'call', tool }, output)
      expect(output.cancel).toBe(true)
    }
    const id = 'msg_native'
    expect(inboundPartID('telegram-42')).toBe(inboundPartID('telegram-42'))
    expect(inboundPartID('telegram-43')).not.toBe(inboundPartID('telegram-42'))
    const user = { info: { id, role: 'user' } }
    const assistant = { info: { role: 'assistant', finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Answer' }] }
    expect(finalReply([user, { ...assistant, info: { ...assistant.info, finish: 'tool-calls' } }], id)).toBeNull()
    expect(finalReply([user], id)).toBeNull()
    const denied = { info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } }] }
    expect(finalReply([user, denied], id)?.error).toBe(true)
    expect(finalReply([user, denied], id)?.message).toContain('1970-01-01T00:00:00.001Z')
    expect(finalReply([user, denied], id)?.message).toContain('Источник отказа не установлен')
    expect(finalReply([user, denied, { info: { role: 'user' } }, assistant], id)?.error).toBe(true)
    expect(finalReply([user, { ...denied, info: { role: 'assistant', time: {} } }], id)).toBeNull()
    expect(finalReply([user, { ...denied, info: { ...denied.info, finish: 'tool-calls' } }], id)).toBeNull()
    expect(finalReply([user, { ...denied, parts: [] }], id)).toBeNull()
    expect(finalReply([user, { info: { role: 'assistant', error: { name: 'MessageAbortedError' }, time: {} }, parts: [] }], id)?.error).toBe(true)
    expect(finalReply([assistant, user], id)).toBeNull()
    expect(finalReply([user, assistant], id)).toEqual({ error: false, replied: false, text: 'Answer' })
    const reply = { ...assistant, parts: [{ type: 'tool', tool: 'PolyDaemon_reply', state: { status: 'completed', output: 'sent (id: 42)' } }] }
    expect(finalReply([user, reply, assistant], id)?.replied).toBe(true)
    expect(finalReply([reply, user, assistant], id)?.replied).toBe(false)
    reply.parts[0].state.output = 'sent 2 parts (ids: 42, 43)'
    expect(finalReply([user, reply, assistant], id)?.replied).toBe(true)
    reply.parts[0].state.output = 'sent 0 parts (ids: )'
    expect(finalReply([user, reply, assistant], id)?.replied).toBe(false)
    expect(finalReply([user, { info: { role: 'user' } }, reply], id)).toBeNull()
    const item = { id: 'telegram-42', content: 'Hello', meta: {}, queued_at: new Date().toISOString() }
    let persisted: any[] = [], posts = 0
    let status: any = { ses_test: { type: 'busy' } }, pending: any[] = [], questions: any[] = []
    const model = { providerID: 'fixture', modelID: 'fixture' }
    const catalog = { connected: ['fixture'], all: [{ id: 'fixture', models: { fixture: {} } }, { id: 'anthropic', models: { old: {} } }] }
    expect(availableModel(catalog, [{ providerID: 'anthropic', modelID: 'old' }, model])).toEqual(model)
    expect(availableModel(catalog, [{ providerID: 'fixture', modelID: 'gone' }])).toBeUndefined()
    expect(modelError({ data: { message: 'Model not found: anthropic/claude-opus-4-8.' } })).toContain('anthropic/claude-opus-4-8')
    expect(modelError({ data: { message: 'Credential: secret' } })).not.toContain('secret')
    const api = async (_path: string, body?: any) => {
      if (_path === '/provider') return catalog
      if (_path === '/config') return { model: 'fixture/fixture' }
      if (_path === '/session/status') return status
      if (_path === '/permission') return pending
      if (_path === '/question') return questions
      if (body) {
        expect(body.messageID).toBeUndefined()
        expect(body.model).toEqual(model)
        posts++
        persisted = [{ info: { id, role: 'user' }, parts: body.parts }]
        throw new Error('Response lost after persistence')
      }
      return persisted
    }
    await expect(inboundTurn(api, 'ses_test', item)).rejects.toThrow('Response lost')
    expect(isInboundMessage(persisted[0])).toBe(true)
    expect(isInboundMessage(user)).not.toBe(true)
    expect((await inboundTurn(api, 'ses_test', item)).final).toBeNull()
    persisted.push(assistant)
    expect((await inboundTurn(api, 'ses_test', item)).final?.text).toBe('Answer')
    persisted[persisted.length - 1] = denied
    expect((await inboundTurn(api, 'ses_test', item)).final?.error).toBe(true)
    persisted = [{ info: { id: inboundPartID(item.id).replace('prt_', 'msg_'), role: 'user' }, parts: [] }]
    expect((await inboundTurn(api, 'ses_test', item)).final).toBeNull()
    status = {}
    pending = [{ sessionID: 'ses_test' }]
    expect((await inboundTurn(api, 'ses_test', item)).final).toBeNull()
    pending = []
    questions = [{ sessionID: 'ses_test' }]
    expect((await inboundTurn(api, 'ses_test', item)).final).toBeNull()
    questions = []
    for (const tail of [[], [{ ...assistant, parts: [] }], [{ ...assistant, info: { ...assistant.info, finish: 'tool-calls' } }], [{ info: { role: 'assistant', time: {} }, parts: [] }]]) {
      persisted = [persisted[0], ...tail]
      expect((await inboundTurn(api, 'ses_test', item)).final?.error).toBe(true)
    }
    status = { ses_test: { type: 'retry' } }
    expect((await inboundTurn(api, 'ses_test', item)).final).toBeNull()
    status = null
    await expect(inboundTurn(api, 'ses_test', item)).rejects.toThrow('Invalid MiMo session status')
    expect(posts).toBe(1)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    rmSync(root, { recursive: true, force: true })
  }
})
