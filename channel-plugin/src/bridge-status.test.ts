import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('native bridge_status is scoped, read-only and retains topic when tasks fail', async () => {
  mkdirSync('tmp', { recursive: true })
  const home = mkdtempSync(resolve('tmp/bridge-status-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  let taskFailure = false, taskWindow = '', row: any
  const paths: string[] = []
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.json().catch(() => ({})) as any
    paths.push(path)
    if (path === '/register') row = body
    if (path === '/my-tasks') {
      taskWindow = body.window
      return taskFailure ? new Response('unavailable', { status: 503 }) : Response.json({ ok: true,
        tasks: [{ id: 1, from: 'Fixture', kind: 'tell', text: 'Test task secret-fixture', state: 'open' }] })
    }
    return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123,
      message_thread_id: 456, title: 'Fixture topic' }, result: { id: 123, is_bot: true, first_name: 'Test' } })
  } })
  // A fake agentd: records the window id the plugin sends with its requests.
  const agentd: { binding: string[]; deliver: any[]; secrets: string[]; pids: string[] } = { binding: [], deliver: [], secrets: [], pids: [] }
  const daemon = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    if (req.headers.get('authorization') !== 'Bearer agentd-fixture') return new Response('no', { status: 401 })
    agentd.secrets.push(req.headers.get('x-codex-window-secret') ?? '')
    agentd.pids.push(req.headers.get('x-codex-window-pid') ?? '')
    if (url.pathname === '/v1/codex/binding') {
      agentd.binding.push(url.searchParams.get('window_id') ?? '')
      return Response.json({ ok: true, thread_id: 'thr-own', binding: 'probed' })
    }
    if (url.pathname === '/v1/codex/deliver') { agentd.deliver.push(await req.json()); return Response.json({ ok: true }) }
    return new Response('?', { status: 404 })
  } })
  mkdirSync(join(home, '.tg-bridge'))
  writeFileSync(join(home, '.tg-bridge', 'agent.toml'), `port = ${daemon.port}\nauth_token = "agentd-fixture"\n`)
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = reservation.port; reservation.stop(true)
  const client = new Client({ name: 'codex', version: 'test' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dir, '../server.ts')], cwd: workspace, stderr: 'pipe',
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH!, TG_BOT_TOKEN: 'fixture',
      TG_BRIDGE_AUTH_TOKEN: 'secret-fixture', TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_AGENT: 'codex',
      TG_API_ROOT: fake.url.origin, TG_BRIDGE_BOT_URL: fake.url.origin, TG_BRIDGE_PORT: String(port) },
  })
  try {
    await client.connect(transport)
    const catalog = await client.listTools()
    expect(catalog.tools.find(t => t.name === 'bridge_status')?.annotations?.readOnlyHint).toBe(true)
    let result: any
    for (let i = 0; i < 100; i++) {
      result = await client.callTool({ name: 'bridge_status', arguments: {} })
      if (result.structuredContent?.topic) break
      await Bun.sleep(30)
    }
    expect(result.isError).toBe(false)
    expect(result.structuredContent.root).toBe(realpathSync(workspace))
    expect(result.structuredContent.topic).toEqual({ id: 456, title: 'Fixture topic' })
    expect(result.structuredContent.pending).toEqual({ approvals: 0, questions: 0, plans: 0 })
    expect(result.structuredContent.tasks.items).toHaveLength(1)
    expect(taskWindow).toBe(row.instance_name)
    expect(taskWindow).toEndWith('-codex')
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
    const before = paths.filter(p => p === '/my-tasks').length
    expect((await client.callTool({ name: 'bridge_status', arguments: { root: '/' } })).isError).toBe(true)
    expect(paths.filter(p => p === '/my-tasks')).toHaveLength(before)
    taskFailure = true
    result = await client.callTool({ name: 'bridge_status', arguments: {} })
    expect(result.structuredContent.state).toBe('connected')
    expect(result.structuredContent.topic.id).toBe(456)
    expect(result.structuredContent.tasks).toEqual({ state: 'unavailable', items: null })
    expect(paths.some(p => /sendMessage|callback|resolve|route-window/.test(p))).toBe(false)

    // Window identity: a per-process id (not the display name, not an
    // inherited TG_WINDOW_UID), the same in bridge_status, the binding lookup
    // and every delivery — agentd keys the window → thread binding by it.
    const windowId = result.structuredContent.window_id
    expect(windowId).toMatch(/^codex-[0-9a-f]{32}$/)
    expect((await client.callTool({ name: 'bridge_status', arguments: {} }) as any).structuredContent.window_id).toBe(windowId)
    const auth = { Authorization: 'Bearer secret-fixture' }
    const own = await fetch(`http://127.0.0.1:${row.port}/codex-thread`, { headers: auth })
    expect(await own.json()).toEqual({ ok: true, thread_id: 'thr-own' })
    expect(agentd.binding).toEqual([windowId])
    const inbound = await fetch(`http://127.0.0.1:${row.port}/message`, { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: 'r1', chat_id: 1, user_id: 1, message_id: 7, text: 'hello' }) })
    expect(inbound.status).toBe(202)
    for (let i = 0; i < 100 && !agentd.deliver.length; i++) await Bun.sleep(30)
    expect(agentd.deliver).toHaveLength(1)
    expect(agentd.deliver[0].window_id).toBe(windowId)
    expect(agentd.deliver[0].cwd).toBe(realpathSync(workspace))
    // The per-process secret goes in a header, the same on every request, and
    // never appears in the public bridge_status answer.
    expect(agentd.secrets[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(agentd.secrets).size).toBe(1)
    // agentd records the plugin process (pid + its own start-token lookup).
    expect(new Set(agentd.pids)).toEqual(new Set([String(row.pid)]))
    expect(JSON.stringify(result)).not.toContain(agentd.secrets[0])
    expect(JSON.stringify(agentd.deliver[0])).not.toContain(agentd.secrets[0])
    // agentd proves the window alive by the codex_window_id of its local row.
    const local = JSON.parse(readFileSync(join(home, '.tg-bridge-channel', 'instances.json'), 'utf8'))
    expect(Object.values(local).map((r: any) => r.codex_window_id)).toEqual([windowId])
  } finally {
    await client.close(); await transport.close(); fake.stop(true); daemon.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15000)
