import { expect, test, mock } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

test('OpenCode owns one root; durable admission, permissions and reply fallback', async () => {
  const oldEnv = { ...process.env }
  const oldFetch = globalThis.fetch
  const cwd = process.cwd()
  Object.assign(process.env, { TG_OPENCODE_BRIDGE: '1', TG_OPENCODE_ROOT: cwd,
    TG_OPENCODE_SESSION: 'ses_own', TG_BRIDGE_AGENT: 'opencode', TG_WINDOW_UID: 'test-uid',
    TG_BRIDGE_INSTANCE_NAME: 'test-opencode', TG_OPENCODE_ENTRY: JSON.stringify({ command: 'bun', args: ['server.ts'], env: {} }) })
  delete process.env.CODEX_THREAD_ID
  mock.module('../hooks/tg-bridge-locate.js', () => ({ findOwnPlugin: () => ({ host: '127.0.0.1', port: 3999, auth_token: 'test' }) }))
  const hooks: Record<string, any> = {}
  const calls: { path: string; body: any }[] = []
  const items = [
    { id: 'reaction', content: 'emoji', meta: { event: 'reaction', chat_id: '123' } },
    { id: 'message', content: 'ping', meta: { source: 'telegram', chat_id: '123', message_id: '42' } },
  ]
  let attempts = 0
  let admitted: any = null
  let decision = 'deny'
  let repliedWithTool = false
  let mcp: any
  let mcpName: string
  let ready = false
  let readinessChecks = 0
  let rpc: any
  globalThis.fetch = (async (url: any, options: any) => {
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, body })
    if (path === '/inbound-ack') items.shift()
    return Response.json(path === '/inbound' ? { item: items[0] ?? null }
      : path === '/approve-request' ? { decision, reason: 'owner test decision' }
      : path === '/status' ? { topic: { forum_chat_id: -100123, message_thread_id: 456, title: 'Actual registered topic' } } : { status: 'ok' })
  }) as typeof fetch
  const register = (domain: string) => async (name: string, fn: any) => { hooks[`${domain}:${name}`] = fn }
  const ctx = {
    location: { directory: cwd },
    rpc: { register: async (_: any, methods: any) => { rpc = methods } },
    mcp: {
      transform: async (fn: any) => fn({ set: (name: string, entry: any) => { mcpName = name; mcp = entry }, list: () => [[mcpName, mcp]] }),
      list: async () => { readinessChecks++; return { data: [{ name: mcpName, status: { status: ready ? 'connected' : 'pending' } }] } },
    },
    tool: { hook: register('tool'), list: async () => [{ id: 'PolyDaemon_reply' }] }, permission: { hook: register('permission') },
    session: {
      hook: register('session'), get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: cwd }, ...(sessionID === 'ses_child' ? { parentID: 'ses_own' } : {}) }),
      prompt: async (input: any) => {
        attempts++
        if (attempts === 1) throw new Error('test admission failure')
        admitted = input; return { id: input.id }
      },
      wait: async () => {},
      context: async () => [{ id: admitted.id, type: 'user' }, { id: 'answer', type: 'assistant', content: [
        { type: 'text', text: 'pong' }, ...(repliedWithTool ? [{ type: 'tool', name: 'PolyDaemon_reply', state: { status: 'completed' } }] : [])] }],
    },
  }
  let cleanup: any
  try {
    const { default: plugin } = await import('./opencode-plugin.ts')
    cleanup = await plugin.setup(ctx)
    expect(mcp.codemode).toBe(false)
    expect(mcpName!).toBe('PolyDaemon')
    expect(mcp.environment.TG_WINDOW_UID).toBe('test-uid')
    expect(await rpc.bridge({ sessionID: 'ses_own' })).toEqual({ state: 'registered', topic: { id: 456, title: 'Actual registered topic' } })
    expect(await rpc.bridge({ sessionID: 'ses_other' })).toEqual({ state: 'unbound', topic: null })
    expect((await rpc.bridge({ sessionID: 'ses_child' })).topic.id).toBe(456)
    let admittedReady = false
    const readiness = hooks['session:prompt']({ sessionID: 'ses_own' }).then(() => { admittedReady = true })
    await sleep(150)
    expect(admittedReady).toBe(false)
    ready = true
    await readiness
    expect(readinessChecks).toBeGreaterThan(1)
    const action = { sessionID: 'ses_own', id: 'push', tool: 'shell', input: { command: 'git push origin main' } }
    await expect(hooks['tool:execute.before'](action)).rejects.toThrow('owner test decision')
    await expect(hooks['tool:execute.before']({ ...action, tool: 'github_push_files', input: {} })).rejects.toThrow('owner test decision')
    decision = 'allow'
    await hooks['tool:execute.before'](action)
    expect(calls.at(-1)!.body.summary).toBe('shell: git push origin main')
    await hooks['tool:execute.before']({ ...action, id: 'status', input: { command: 'git status\n --short' } })
    expect(calls.at(-1)!.body.summary).toBe('shell: git status --short')
    const count = calls.filter(c => c.path === '/approve-request').length
    await hooks['tool:execute.before']({ ...action, id: 'reply', tool: 'PolyDaemon_reply', input: { text: 'pong' } })
    expect(calls.filter(c => c.path === '/approve-request').length).toBe(count)
    const permission = { sessionID: 'ses_own', effect: 'ask', source: { id: 'push' } }
    await hooks['permission:evaluate'](permission)
    expect(permission.effect).toBe('allow')
    expect(calls.filter(c => c.path === '/approve-request').length).toBe(count)
    await hooks['tool:execute.before']({ ...action, id: 'bridge-read', tool: 'read', input: { path: `${cwd}/clients/README.md` } })
    expect(calls.at(-1)!.body.summary).toBe(`read: ${cwd}/clients/README.md`)
    const bridgePermission = { sessionID: 'ses_own', effect: 'ask', source: { id: 'bridge-read' } }
    await hooks['permission:evaluate'](bridgePermission)
    expect(bridgePermission.effect).toBe('allow')
    expect(calls.filter(c => c.path === '/approve-request').length).toBe(count)
    await hooks['tool:execute.before']({ ...action, sessionID: 'ses_other' })
    expect(calls.filter(c => c.path === '/approve-request').length).toBe(count)
    const denied = { sessionID: 'ses_own', effect: 'deny' }
    await hooks['permission:evaluate'](denied)
    expect(denied.effect).toBe('deny')
    for (let n = 0; n < 40 && !calls.some(c => c.path === '/auto-reply'); n++) await sleep(100)
    expect(attempts).toBe(2)
    expect(admitted.id).toBe('msg_tg_message')
    expect(admitted.text).toContain('"message_id": "42"')
    expect(calls.filter(c => c.path === '/inbound-ack').map(c => c.body.id)).toEqual(['reaction', 'message'])
    expect(calls.find(c => c.path === '/auto-reply')!.body.text).toBe('pong')
    repliedWithTool = true
    items.push({ id: 'answered', content: 'next ping', meta: { source: 'telegram', chat_id: '123', message_id: '43' } })
    for (let n = 0; n < 40 && attempts < 3; n++) await sleep(100)
    expect(attempts).toBe(3)
    await sleep(100)
    expect(calls.filter(c => c.path === '/auto-reply').length).toBe(1)
    await hooks['session:retry']({ sessionID: 'ses_own', error: { message: 'at capacity' }, decision: { retry: false } })
    expect(calls.at(-1)!.body.kind).toBe('api_error')
  } finally {
    cleanup?.()
    globalThis.fetch = oldFetch
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
    Object.assign(process.env, oldEnv)
    mock.restore()
  }
})
