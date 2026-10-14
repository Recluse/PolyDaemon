import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { readClaudeStatus } = createRequire(import.meta.url)('./claude-status.cjs')
const scratch = fileURLToPath(new URL('../tmp/', import.meta.url))
mkdirSync(scratch, { recursive: true })

test('Claude sidebar reads only its bound status and tasks; errors remain unknown', async () => {
  const home = mkdtempSync(join(scratch, 'claude-status-'))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  const previous = process.env.TG_WINDOW_UID
  process.env.TG_WINDOW_UID = 'fixture'
  const paths: string[] = []
  let failTasks = false, failStatus = false
  const locate = (root: string, agent: string) => {
    expect(root).toBe(cwd)
    expect(agent).toBe('claude')
    return { host: '127.0.0.1', port: 1, auth_token: 'secret', cwd }
  }
  const fetch = async (url: string, init: any) => {
    expect(init.headers.Authorization).toBe('Bearer secret')
    expect(init.method).toBeUndefined()
    const path = new URL(url).pathname
    paths.push(path)
    if ((path === '/tasks' && failTasks) || (path === '/status' && failStatus)) {
      throw new Error('credentials must not appear: secret')
    }
    return Response.json(path === '/status' ? {
      is_working: true, topic: { title: 'Example\nproject', message_thread_id: 42 },
      pending: { approvals: [{}], asks: [], plans: [] }, private_extra: 'secret',
    } : { ok: true, tasks: [{ id: 3, from: 'other', kind: 'tell', text: 'Check\u001b[31m', state: 'running', auth: 'secret' }] })
  }
  try {
    const good = await readClaudeStatus(cwd, { locate, fetch })
    expect(good.state).toBe('connected')
    expect(good.topic).toEqual({ id: 42, title: 'Example project' })
    expect(good.pending).toEqual({ approvals: 1, questions: 0, plans: 0 })
    expect(good.tasks.items).toHaveLength(1)
    expect(JSON.stringify(good)).not.toContain('secret')
    expect(JSON.stringify(good)).not.toContain('\\u001b')
    expect(paths.sort()).toEqual(['/status', '/tasks'])
    failTasks = true
    expect((await readClaudeStatus(cwd, { locate, fetch })).tasks).toEqual({ state: 'unavailable', items: null })
    failStatus = true
    expect((await readClaudeStatus(cwd, { locate, fetch })).state).toBe('unavailable')
    const invalid = await readClaudeStatus(cwd, { locate, fetch: async () => Response.json({}) })
    expect(invalid.state).toBe('unavailable')
    expect(invalid.tasks.items).toBeNull()
    paths.length = 0
    expect((await readClaudeStatus(cwd, { locate: () => ({ cwd: home }), fetch })).state).toBe('unbound')
    delete process.env.TG_WINDOW_UID
    expect((await readClaudeStatus(cwd, { locate, fetch })).state).toBe('unbound')
    expect(paths).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.TG_WINDOW_UID
    else process.env.TG_WINDOW_UID = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('packaged Node helper discovers only its own live Claude registry row', async () => {
  const home = mkdtempSync(join(scratch, 'claude-status-native-'))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  mkdirSync(join(home, '.tg-bridge-channel'))
  const requests: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    expect(request.headers.get('Authorization')).toBe('Bearer fixture')
    const path = new URL(request.url).pathname
    requests.push(path)
    return Response.json(path === '/tasks' ? { ok: true, tasks: [] } : {
      is_working: false, topic: null, pending: { approvals: [], asks: [], plans: [] },
    })
  } })
  const row = { instance_name: 'Example', cwd, host: '127.0.0.1', port: server.port,
    auth_token: 'fixture', window_uid: 'own', heartbeat_at: Date.now() / 1000,
    pid: process.pid, parent_pid: process.pid }
  writeFileSync(join(home, '.tg-bridge-channel/instances.json'), JSON.stringify({ own: row }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TG_|CLAUDE|CODEX|MIMOCODE|TMUX)/.test(k)))
  const run = async (uid: string) => {
    const child = Bun.spawn(['node', fileURLToPath(new URL('./claude-status.cjs', import.meta.url)), cwd], {
      env: { ...env, HOME: home, USERPROFILE: home, TG_WINDOW_UID: uid }, stdout: 'pipe', stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe('')
    return JSON.parse(output)
  }
  try {
    expect((await run('foreign')).state).toBe('unbound')
    expect(requests).toEqual([])
    const own = await run('own')
    expect(own.state).toBe('connected')
    expect(own.topic).toBeNull()
    expect(own.tasks).toEqual({ state: 'available', items: [] })
    expect(requests.sort()).toEqual(['/status', '/tasks'])
  } finally {
    server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
})
