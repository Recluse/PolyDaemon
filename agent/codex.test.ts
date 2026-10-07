import { expect, spyOn, test } from 'bun:test'
import * as registry from './registry.ts'

test('resume uses saved sessions; delivery still reaches unpersisted windows', async () => {
  const originalWebSocket = globalThis.WebSocket
  const calls: { method: string; params: any }[] = []
  let loaded = ['child', 'project']
  let saved: any[] = [{ id: 'saved', cwd: '/work/sample-project' }]
  const processes = spyOn(Bun, 'spawnSync').mockImplementation((args: any) => ({
    stdout: Buffer.from(args[0] === 'ps'
      ? '239 /Applications/ChatGPT.app/Contents/Resources/codex sandbox -c default_permissions="node_repl" -- node kernel.js\n'
      : 'p239\nn/work/sample-project\n'),
    exitCode: 0,
  } as any))
  const threads: Record<string, any> = {
    child: { id: 'child', cwd: '/work/sample-project', updatedAt: 20, source: { subAgent: {} } },
    project: { id: 'project', cwd: '/work/sample-project', updatedAt: 10, source: 'vscode', status: { type: 'idle' } },
  }
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: any
    onmessage: any
    constructor() { queueMicrotask(() => this.onopen?.()) }
    send(raw: string) {
      const m = JSON.parse(raw)
      calls.push(m)
      let result: any = {}
      if (m.method === 'thread/loaded/list') result = { data: loaded }
      if (m.method === 'thread/read') result = { thread: threads[m.params.threadId] }
      if (m.method === 'thread/list') result = { data: saved, nextCursor: null }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) }))
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    const { lastThreadFor, deliverToCodex, notifyCodexError } = await import('./codex.ts')
    expect(await lastThreadFor('/work/sample-project')).toBe('saved')
    expect(calls.some(c => c.method === 'thread/loaded/list')).toBe(false)
    expect((await deliverToCodex('/work/sample-project', 'ping')).thread_id).toBe('project')
    loaded = ['child']
    expect((await deliverToCodex('/work/sample-project', 'ping')).thread_id).toBe('saved')
    expect(calls.find(c => c.method === 'thread/list')!.params.cwd).toBe('/work/sample-project')
    loaded = ['project']
    threads.project.ephemeral = true
    expect(await lastThreadFor('/work/sample-project')).toBe('saved')
    saved = []
    threads.project.ephemeral = false
    expect(await lastThreadFor('/work/sample-project')).toBeNull()
    expect((await deliverToCodex('/work/sample-project', 'ping')).thread_id).toBe('project')
    saved = [threads.child, { id: 'temp', cwd: '/work/sample-project', ephemeral: true }]
    expect(await lastThreadFor('/work/sample-project')).toBeNull()
    saved = []
    loaded = []
    expect(await lastThreadFor('/work/sample-project')).toBeNull()
    const rows = spyOn(registry, 'readRegistry').mockReturnValue({
      owner: { instance_name: 'sample-project-codex', cwd: '/work/sample-project', host: '127.0.0.1', port: 3180,
        auth_token: 'test-only', heartbeat_at: Date.now() / 1000 } as any,
      wrong: { instance_name: 'other-codex', cwd: '/work/other', host: '127.0.0.1', port: 3181,
        heartbeat_at: Date.now() / 1000 + 1 } as any,
    })
    const posts: any[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, options: any) => {
      posts.push({ url: String(url), body: JSON.parse(options.body) })
      return Response.json({ status: 'ok' })
    }) as typeof fetch
    try {
      const error = { message: 'Selected model is at capacity. Please try a different model.' }
      await Promise.all([
        notifyCodexError('error', { threadId: 'project', turnId: 'failed-turn', error, willRetry: false }),
        notifyCodexError('turn/completed', { threadId: 'project', turn: { id: 'failed-turn', error } }),
      ])
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toBe('http://127.0.0.1:3180/notify')
      expect(posts[0].body.message).toBe(error.message)
      expect(posts[0].body.kind).toBe('api_error')
      await notifyCodexError('error', { threadId: 'child', turnId: 'child-turn', error })
      expect(posts).toHaveLength(1)
      await notifyCodexError('turn/completed', { threadId: 'project', turn: { id: 'success' } })
      expect(posts).toHaveLength(1)
    } finally { rows.mockRestore(); globalThis.fetch = originalFetch }
  } finally {
    processes.mockRestore()
    globalThis.WebSocket = originalWebSocket
  }
})
