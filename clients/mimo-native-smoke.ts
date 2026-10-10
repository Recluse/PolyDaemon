// Optional native acceptance: MIMO_BIN=/path/to/mimo bun clients/mimo-native-smoke.ts
// Own temporary HOME and loopback provider; no Telegram credentials or real models.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { inboundTurn, inboundPartID, relayReplies } from './mimo-bridge.ts'

const root = realpathSync(mkdtempSync(join(process.cwd(), '.mimo-native-')))
const home = realpathSync(mkdtempSync(join(process.cwd(), '.mimo-native-home-')))
let approvalCards = 0
let approvalGate: Promise<void> | undefined
let releaseApproval: (() => void) | undefined
let approvalMode = 'unavailable'
let approvalErrors = 0
const bot = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json().catch(() => ({})) as any
  if (String(body.text ?? '').includes('ошибка передачи разрешения')) approvalErrors++
  if (body.reply_markup) {
    approvalCards++
    if (approvalGate) await approvalGate
    if (approvalMode === 'deny') {
      // Explicit callback only to our isolated fixture bridge, never a real card.
      const rows = Object.values(JSON.parse(readFileSync(join(home, '.tg-bridge-channel/instances.json'), 'utf8'))) as any[]
      const target = rows.find(r => r.window_uid === 'mimo-native-smoke')
      assert(target && target.cwd === root)
      const id = body.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1]
      const response = await fetch(`http://127.0.0.1:${target.port}/approve-callback`, { method: 'POST',
        headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'deny' }) })
      assert(response.ok)
    } else return Response.json({ ok: false, error_code: 403, description: 'Fixture transport unavailable' }, { status: 403 })
  }
  return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123, message_thread_id: 456, title: 'MiMo smoke' },
    result: { id: 123, message_id: 42, is_bot: true, first_name: 'Fixture', username: 'fixture' } })
} })
let calls = 0
let guardProbe = false, toolIssued = false
let denialProbe = false, denialIssued = false
let memoryProbe = '', memoryIssued = false
let inboxProbe = false, inboxIssued = false
const inbox = join(home, '.tg-bridge-channel/inbox')
mkdirSync(inbox, { recursive: true })
writeFileSync(join(inbox, 'attachment.txt'), 'INBOX_READ_OK')
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
  'tg-bridge': { command: process.execPath, args: [resolve('clients/opencode-memory-reader.test.ts'), '--fixture'] },
  OtherClaudeMCP: { command: process.execPath, args: [resolve('clients/opencode-memory-reader.test.ts'), '--fixture'] },
} }))
const summaries: any[] = []
let releaseGeneration: (() => void) | undefined
let generationGate: Promise<void> | undefined
const requests: any[] = []
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as any
  requests.push(body)
  if (generationGate) await generationGate
  calls++
  if (JSON.stringify(body.messages?.at(-1)).includes('Wrap your summary in <summary></summary> tags.')) summaries.push(body)
  let delta: any = { content: 'NATIVE_SMOKE_OK' }, finish = 'stop'
  if (denialProbe && !denialIssued) {
    denialIssued = true
    delta = { tool_calls: [{ index: 0, id: 'denial_probe', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf DENIAL_PROBE', description: 'Isolated native permission rejection test' }) } }] }
    finish = 'tool_calls'
  }
  if (inboxProbe && !inboxIssued && body.tools?.some((t: any) => t.function?.name === 'read')) {
    inboxIssued = true
    delta = { tool_calls: [{ index: 0, id: 'inbox_probe', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: join(inbox, 'attachment.txt') }) } }] }
    finish = 'tool_calls'
  }
  if (memoryProbe && !memoryIssued && body.tools?.some((t: any) => t.function?.name === 'write')) {
    memoryIssued = true
    delta = { tool_calls: [{ index: 0, id: 'memory_probe', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: memoryProbe, content: 'SESSION_MEMORY_OK\n' }) } }] }
    finish = 'tool_calls'
  }
  if (guardProbe && !toolIssued && body.tools?.some((t: any) => t.function?.name === 'bash')) {
    toolIssued = true
    delta = { tool_calls: [{ index: 0, id: 'guard_probe', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'git push -h', description: 'Harmless help, approval guard probe' }) } }] }
    finish = 'tool_calls'
  }
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }
  return body.stream ? new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    : Response.json({ ...chunk, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'NATIVE_SMOKE_OK' }, finish_reason: 'stop' }] })
} })
const password = randomUUID()
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), PWD: root,
  MIMOCODE_SERVER_PASSWORD: password, MIMOCODE_SERVER_USERNAME: 'smoke',
  TG_MIMO_ROOT: root, TG_MIMO_BINDING: join(root, 'binding.json'),
  TG_WINDOW_UID: 'mimo-native-smoke', TG_BRIDGE_AGENT: 'mimo',
  TG_MIMO_MEMORY: JSON.stringify({ type: 'local', command: [process.execPath, resolve('clients/opencode-memory-reader.test.ts'), '--fixture'], enabled: true }),
  MIMOCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(resolve('clients/mimo-plugin.ts')).href],
    mcp: { 'tg-bridge': { enabled: false }, PolyDaemon: { type: 'local', command: [process.execPath, resolve('channel-plugin/server.ts')],
      environment: { HOME: home, PATH: process.env.PATH, TG_BOT_TOKEN: 'fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture',
        TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_AGENT: 'mimo', TG_WINDOW_UID: 'mimo-native-smoke',
        TG_API_ROOT: bot.url.origin, TG_BRIDGE_BOT_URL: bot.url.origin } } },
    permission: { bash: { 'printf DENIAL_PROBE': 'ask' }, external_directory: { [inbox + '/*']: 'allow', [join(home, '.local/share/mimocode/*')]: 'allow' }, read: { [inbox + '/*']: 'allow', [join(home, '.local/share/mimocode/*')]: 'allow' }, edit: { [inbox + '/*']: 'deny', [join(home, '.local/share/mimocode/*')]: 'allow' } },
    model: 'fixture/fixture', small_model: 'fixture/fixture',
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'fixture', options: { apiKey: 'fake', baseURL: `${provider.url.origin}/v1` },
      models: { fixture: { name: 'fixture', limit: { context: 32000, output: 512 } } } } } }),
}
const server = Bun.spawn([process.env.MIMO_BIN!, '--print-logs', '--log-level', 'DEBUG', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, stdout: 'pipe', stderr: Bun.file(join(root, 'stderr')) })
const timeout = setTimeout(() => server.kill(), 90000)
try {
  let base = '', buffer = ''
  for await (const chunk of server.stdout) {
    buffer += new TextDecoder().decode(chunk)
    const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/)
    if (match) { base = match[0]; break }
  }
  assert(base, readFileSync(join(root, 'stderr'), 'utf8').slice(-3000))
  const api = async (path: string, body?: any, method?: string) => {
    const url = new URL(path, base); url.searchParams.set('directory', root)
    const res = await fetch(url, { method: method ?? (body ? 'POST' : 'GET'), headers: { Authorization: `Basic ${Buffer.from(`smoke:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) })
    assert(res.ok, `${res.status}: ${await res.clone().text()}`)
    const text = await res.text()
    return text.trim() ? JSON.parse(text) : null
  }
  const session = await api('/session', { title: 'smoke' })
  writeFileSync(env.TG_MIMO_BINDING, JSON.stringify({ root, sessionID: session.id }))
  const config = await api('/config')
  assert(config.plugin.some((s: any) => JSON.stringify(s).includes('mimo-plugin')))
  await api('/mcp')
  assert.equal(JSON.parse(readFileSync(`${env.TG_MIMO_BINDING}.ready`, 'utf8')).root, root)
  const answer = await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Return NATIVE_SMOKE_OK. No tools.' }] })
  assert(!answer.info?.error, JSON.stringify(answer.info?.error))
  assert(calls > 0)
  assert(answer.parts.some((p: any) => p.type === 'text' && p.text.includes('NATIVE_SMOKE_OK')))
  const mcp = await api('/mcp')
  assert.equal(mcp.PolyDaemon?.status, 'connected')
  assert.equal(mcp.HyperMnesia?.status, 'connected')
  assert.equal(mcp.OtherClaudeMCP?.status, 'connected', 'Unrelated Claude MCP import was lost')
  assert(!mcp['tg-bridge'], 'Legacy bridge was imported despite native override')
  console.log('Native single PolyDaemon connection + other Claude MCP preserved PASS')
  const globalBefore = await api('/global/config')
  const globalAfter = await api('/global/config', { mcp: { 'tg-bridge': { enabled: false } } }, 'PATCH')
  assert.deepEqual(globalAfter.permission, globalBefore.permission)
  await Bun.sleep(1200)
  const resumed = await api(`/session/${session.id}/message`)
  assert(resumed.some((m: any) => m.info.id === answer.info.id), 'Config refresh lost session history')
  console.log('Native idle config refresh preserves session history PASS')
  // A continued session already has an assistant; hash-based message IDs made
  // MiMo mistake that previous answer for the result of the new Telegram turn.
  const incoming = { id: 'native-telegram', content: 'Return NATIVE_SMOKE_OK. No tools.', meta: { source: 'telegram' }, queued_at: new Date().toISOString() }
  const continued = await inboundTurn(api, session.id, incoming)
  assert(continued.id > answer.info.id, 'Incoming message does not sort after previous assistant')
  assert.equal(continued.final?.text, 'NATIVE_SMOKE_OK')
  const deliveredCalls = calls
  assert.equal((await inboundTurn(api, session.id, incoming)).id, continued.id)
  assert.equal(calls, deliveredCalls, 'Retry executed the model again')
  const legacyID = inboundPartID('legacy-telegram').replace('prt_', 'msg_')
  await api(`/session/${session.id}/message`, { messageID: legacyID, parts: [{ type: 'text', text: 'Return NATIVE_SMOKE_OK. No tools.' }] })
  let legacyMessages = await api(`/session/${session.id}/message`)
  assert(!legacyMessages.some((m: any) => m.info.parentID === legacyID), 'Legacy ID regression did not reproduce')
  await api(`/session/${session.id}/resume`, { userMessageID: legacyID })
  for (let i = 0; i < 100; i++) {
    legacyMessages = await api(`/session/${session.id}/message`)
    if (legacyMessages.some((m: any) => m.info.parentID === legacyID && m.info.time.completed)) break
    await Bun.sleep(100)
  }
  assert(legacyMessages.some((m: any) => m.info.parentID === legacyID && m.info.time.completed), 'Native trailing-user recovery failed')
  await api(`/session/${session.id}/message`, { model: { providerID: 'missing', modelID: 'missing' },
    parts: [{ id: inboundPartID('missing-model'), type: 'text', text: 'Missing model fixture' }] })
  const failedMessages = await api(`/session/${session.id}/message`)
  assert.equal(failedMessages.findLast((m: any) => m.info.role === 'user').info.model.providerID, 'missing')
  const recovered = await inboundTurn(api, session.id, { ...incoming, id: 'after-missing-model' })
  assert.equal(recovered.final?.text, 'NATIVE_SMOKE_OK', 'Telegram inherited unavailable model from history')
  const recoveredMessages = await api(`/session/${session.id}/message`)
  assert.deepEqual(recoveredMessages.find((m: any) => m.info.id === recovered.id).info.model, { providerID: 'fixture', modelID: 'fixture' })
  const effective = await api('/config')
  assert(effective.mcp.HyperMnesia)
  assert.equal(effective.permission.HyperMnesia_memory_write, 'deny')
  assert.equal((await api('/mcp')).HyperMnesia.status, 'connected')
  memoryProbe = join(home, '.local/share/mimocode/memory/sessions', session.id, 'notes.md')
  const cardsBefore = approvalCards
  await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Write the diagnostic session note with the native write tool.' }] })
  assert(memoryIssued, 'Native write tool absent')
  const memoryMessages = await api(`/session/${session.id}/message`)
  const memoryWrite = memoryMessages.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool' && p.callID === 'memory_probe')
  assert.equal(memoryWrite?.state.status, 'completed', JSON.stringify(memoryWrite))
  assert.equal(readFileSync(memoryProbe, 'utf8'), 'SESSION_MEMORY_OK\n')
  assert.equal(approvalCards, cardsBefore, 'Session memory unexpectedly requested approval')
  const project = await api('/project/current')
  for (const scope of [`memory/projects/${project.id}`, 'memory/global', 'log']) {
    memoryProbe = join(home, '.local/share/mimocode', scope, 'native-smoke.md')
    memoryIssued = false
    await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Write the diagnostic memory note with the native write tool.' }] })
    assert.equal(readFileSync(memoryProbe, 'utf8'), 'SESSION_MEMORY_OK\n')
    assert.equal(approvalCards, cardsBefore, `${scope} memory unexpectedly requested approval`)
  }
  inboxProbe = true
  await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Read the fixture Telegram attachment.' }] })
  const inboxMessages = await api(`/session/${session.id}/message`)
  const inboxRead = inboxMessages.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool' && p.callID === 'inbox_probe')
  assert.equal(inboxRead?.state.status, 'completed', JSON.stringify(inboxRead))
  assert(inboxRead.state.output.includes('INBOX_READ_OK'))
  assert.equal(approvalCards, cardsBefore, 'Inbox read unexpectedly requested approval')
  const before = calls
  writeFileSync(env.TG_MIMO_BINDING, JSON.stringify({ root, sessionID: 'ses_foreign' }))
  await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Must not reach provider' }] })
  assert.equal(calls, before, 'Unbound turn reached provider')
  writeFileSync(env.TG_MIMO_BINDING, JSON.stringify({ root, sessionID: session.id }))
  guardProbe = true
  await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Guard probe: git push help. No approval exists.' }] })
  assert(toolIssued, 'Native bash tool absent')
  const messages = await api(`/session/${session.id}/message`)
  const blocked = messages.flatMap((m: any) => m.parts).find((p: any) => p.type === 'tool' && p.callID === 'guard_probe')
  assert(blocked && /not approved|guard unavailable/.test(JSON.stringify(blocked.state)), JSON.stringify(blocked))
  denialProbe = true
  approvalMode = 'deny'
  const deniedItem = { ...incoming, id: 'permission-rejection', content: 'Use the diagnostic bash tool.' }
  // An explicit fixture callback rejects the native ask, not a network failure.
  assert.equal((await inboundTurn(api, session.id, deniedItem)).final?.error, true, 'Permission rejection left Telegram queue blocked')
  const deniedCalls = calls
  assert.equal((await inboundTurn(api, session.id, deniedItem)).final?.error, true)
  assert.equal(calls, deniedCalls, 'Rejected turn was replayed')
  assert.equal((await inboundTurn(api, session.id, { ...incoming, id: 'after-rejection' })).final?.text, 'NATIVE_SMOKE_OK')
  console.log('Native permission rejection + no replay + next Telegram turn PASS')
  const orphan = { ...incoming, id: 'idle-orphan' }
  await api(`/session/${session.id}/message`, { noReply: true, parts: [{ id: inboundPartID(orphan.id), type: 'text', text: 'Persisted turn without an answer' }] })
  const orphanCalls = calls
  assert.equal((await inboundTurn(api, session.id, orphan)).final?.error, true, 'Idle orphan blocked the queue')
  assert.equal(calls, orphanCalls, 'Idle orphan was executed again')
  assert.equal((await inboundTurn(api, session.id, { ...incoming, id: 'after-orphan' })).final?.text, 'NATIVE_SMOKE_OK')
  console.log('Native idle orphan + no replay + next Telegram turn PASS')
  generationGate = new Promise<void>(resolve => { releaseGeneration = resolve })
  const admit = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      try { return await inboundTurn(api, session.id, { ...incoming, id, content: id, meta: { chat_id: '-100123' } }, undefined, true) }
      catch (error) { if ((error as Error).message !== 'MiMo did not persist the incoming message') throw error }
      await Bun.sleep(50)
    }
    throw new Error('Async admission timed out')
  }
  const first = await admit('ASYNC_PROBE_A')
  const second = await admit('ASYNC_PROBE_B')
  const admitted = await api(`/session/${session.id}/message`)
  assert(admitted.some((m: any) => m.info.id === first.id))
  assert(admitted.some((m: any) => m.info.id === second.id), 'Second input waited for first generation')
  assert(!admitted.some((m: any) => m.info.parentID === first.id && m.info.time.completed), 'Generation gate was not held')
  releaseGeneration!(); generationGate = undefined
  const relayed: string[] = []
  for (let i = 0; i < 100; i++) {
    await relayReplies(api, session.id, async (_text, chat, id) => { assert.equal(chat, '-100123'); relayed.push(id) })
    const history = await api(`/session/${session.id}/message`)
    const receipts = history.flatMap((m: any) => m.parts).filter((p: any) => p.metadata?.polydaemonInbound)
    if (receipts.length === 2 && receipts.every((p: any) => p.metadata.polydaemonInbound.delivered)) break
    await Bun.sleep(100)
  }
  assert(relayed.includes(second.id), 'Latest input did not get a reply')
  assert(requests.some(body => JSON.stringify(body.messages).includes('ASYNC_PROBE_B')), 'Latest input did not reach the model')
  const sentCount = relayed.length
  await relayReplies(api, session.id, async () => { throw new Error('Delivered reply repeated') })
  assert(sentCount > 0)
  console.log('Native immediate input during generation + durable reply relay PASS')
  denialIssued = false
  approvalMode = 'unavailable'
  approvalGate = new Promise<void>(resolve => { releaseApproval = resolve })
  await admit('ASYNC_PERMISSION_A')
  let permission: any
  for (let i = 0; i < 100; i++) {
    permission = (await api('/permission')).find((p: any) => p.sessionID === session.id)
    if (permission) break
    await Bun.sleep(100)
  }
  assert(permission, 'Held native permission request missing')
  const duringAsk = await admit('ASYNC_PERMISSION_B')
  assert((await api(`/session/${session.id}/message`)).some((m: any) => m.info.id === duringAsk.id), 'Input blocked behind permission')
  assert((await api('/permission')).some((p: any) => p.id === permission.id), 'Permission was resolved implicitly')
  releaseApproval!(); approvalGate = undefined
  for (let i = 0; i < 100 && approvalErrors === 0; i++) await Bun.sleep(100)
  assert(approvalErrors > 0, 'Transport failure was not reported')
  assert((await api('/permission')).some((p: any) => p.id === permission.id), 'Transport failure changed the native permission')
  console.log('Native approval transport error preserves pending permission PASS')
  // End only this isolated fixture ask explicitly so cleanup/compaction can run.
  await api(`/permission/${permission.id}/reply`, { reply: 'reject' })
  console.log('Native immediate input during pending permission, without resolving it PASS')
  if (process.argv.includes('--compaction')) {
    await api(`/session/${session.id}/summarize`, { providerID: 'fixture', modelID: 'fixture', auto: false })
    assert.equal(summaries.length, 1, 'Compaction should make one summary request')
    assert.equal(summaries[0].tool_choice, 'none', 'Compaction advertised executable tools')
    const compacted = await api(`/session/${session.id}/message`)
    assert(compacted.some((m: any) => m.info.summary && m.info.time.completed && !m.info.error), 'Compaction did not finish')
    console.log('Native compaction tool_choice=none + completed summary PASS')
  }
  if (process.argv.includes('--tui')) {
    const tuiConfig = join(root, 'tui.json')
    writeFileSync(tuiConfig, JSON.stringify({ plugin: [pathToFileURL(resolve('clients/mimo-tui.tsx')).href] }))
    const capture = Bun.spawn([process.env.PYTHON_BIN || 'python3', '-c', `
import os,pty,subprocess,fcntl,termios,struct,time,select,sys,pyte
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',45,150,0,0))
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
data=b''
try:
 end=time.time()+15
 while time.time()<end:
  if select.select([master],[],[],0.2)[0]:
   try: data+=os.read(master,65536)
   except OSError: break
finally:
 p.terminate()
 try: p.wait(timeout=5)
 except subprocess.TimeoutExpired: p.kill();p.wait()
 os.close(master)
open('tui.capture','wb').write(data)
assert b'HyperMnesia' in data and b'PolyDaemon' in data, data[-3000:]
screen=pyte.Screen(150,45)
screen.report_device_status=lambda *a,**kw: None
screen.report_device_attributes=lambda *a,**kw: None
pyte.Stream(screen).feed(data.decode('utf-8','replace'))
clean='\\n'.join(screen.display)
assert 'Docs 12 / chunks 34' in clean and 'Freshness: stale' in clean, clean
assert 'MiMo smoke (#456)' in clean, '\\n'.join(line[103:] for line in screen.display)
print('Native TUI project counts + freshness PASS')
`, process.env.MIMO_BIN!, 'attach', base, '--dir', root, '--session', session.id], {
      cwd: root, env: { ...env, MIMOCODE_TUI_CONFIG: tuiConfig, TERM: 'xterm-256color' }, stdout: 'pipe', stderr: 'pipe',
    })
    const output = await new Response(capture.stdout).text()
    const error = await new Response(capture.stderr).text()
    assert.equal(await capture.exited, 0, error)
    console.log(output.trim())
  }
  console.log('Native MiMo plugin + authenticated API + bound turn PASS')
} catch (error) {
  console.error(readFileSync(join(root, 'stderr'), 'utf8').split('\n').filter(s => /plugin|error|failed|trust/i.test(s)).join('\n').slice(-9000))
  throw error
} finally {
  clearTimeout(timeout)
  server.kill(); await server.exited
  provider.stop(true)
  bot.stop(true)
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
