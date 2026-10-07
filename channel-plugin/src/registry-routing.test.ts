import { expect, test } from 'bun:test'
import { registerRemote, unregisterRemote, listWindowsRemote, myTasksRemote } from './bot-rpc.ts'
import { effectiveWorkspaceName, setNameOverride } from './registry.ts'
import { recordMessageRoute } from './routes-db.ts'
import { setMyPort } from './state.ts'

test('registration preserves the handshake rename and routes use that identity', async () => {
  const calls: { path: string; body: any }[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const firstStarted = new Promise<void>(resolve => { started = resolve })
  let routed!: () => void
  const routeSent = new Promise<void>(resolve => { routed = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { path: new URL(String(url)).pathname, body: JSON.parse(init.body) }
    calls.push(call)
    if (calls.length === 1) {
      started()
      await gate
    }
    if (call.path === '/route') routed()
    return Response.json({ ok: true, windows: [], tasks: [] })
  }) as typeof fetch
  try {
    const row = {
      id: 'same-plugin', host: '127.0.0.1', port: 3100, auth_token: 'test',
      instance_name: 'project', workspace_name: 'project', cwd: '/work/project',
      pid: 123, parent_pid: 122, started_at: '',
    }
    const first = registerRemote(row)
    await firstStarted
    const renamed = registerRemote({ ...row, instance_name: 'project-codex', workspace_name: 'project-codex' })
    const removed = unregisterRemote(row.id)
    await Promise.resolve()
    expect(calls.length).toBe(1)
    release()
    await Promise.all([first, renamed, removed])
    expect(calls.map(c => [c.path, c.body.workspace_name])).toEqual([
      ['/register', 'project'], ['/register', 'project-codex'], ['/unregister', undefined],
    ])
    setNameOverride('project-codex')
    expect(effectiveWorkspaceName()).toBe('project-codex')
    setMyPort(3100)
    recordMessageRoute(-100123, 456)
    await routeSent
    await listWindowsRemote()
    await myTasksRemote()
    expect(calls.find(c => c.path === '/route')!.body.instance).toBe('project-codex')
    expect(calls.find(c => c.path === '/windows')!.body.from).toBe('project-codex')
    expect(calls.find(c => c.path === '/my-tasks')!.body.window).toBe('project-codex')
  } finally {
    release()
    globalThis.fetch = originalFetch
    setMyPort(0)
  }
})
