import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
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
        tasks: [{ id: 1, from: 'Fixture', kind: 'tell', text: 'Test task', state: 'open' }] })
    }
    return Response.json({ ok: true, topic_binding: { forum_chat_id: -100123,
      message_thread_id: 456, title: 'Fixture topic' }, result: { id: 123, is_bot: true, first_name: 'Test' } })
  } })
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
  } finally {
    await client.close(); await transport.close(); fake.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15000)
