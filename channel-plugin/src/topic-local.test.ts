import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('local mode broadcasts once to live siblings without changing their registry', async () => {
  const scratch = resolve(import.meta.dir, '../../tmp')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'topic-local-'))
  mkdirSync(join(home, '.tg-bridge-channel'))
  const received: any[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe('/topic-activity')
    expect(req.headers.get('Authorization')).toBe('Bearer fixture')
    received.push(await req.json())
    return Response.json({ ok: true })
  } })
  const row = { host: '127.0.0.1', port: server.port, pid: process.pid, parent_pid: process.pid,
    heartbeat_at: Date.now() / 1000, auth_token: 'fixture' }
  const registry = JSON.stringify({ live: row, stale: { ...row, heartbeat_at: 0 }, orphan: { ...row, parent_pid: 1 } })
  const file = join(home, '.tg-bridge-channel/instances.json')
  writeFileSync(file, registry)
  const event = { chat_id: -100123, message_thread_id: 42, message_id: 10 }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TG_|CLAUDE|CODEX|TMUX)/.test(key)))
  try {
    const module = pathToFileURL(join(import.meta.dir, 'local-registry.ts')).href
    const child = Bun.spawn([process.execPath, '-e', `const m=await import(${JSON.stringify(module)}); await m.notifyLocalTopic(${JSON.stringify(event)});`], {
      env: { ...env, HOME: home, USERPROFILE: home, TG_BOT_TOKEN: '123:fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture' }, stdout: 'pipe', stderr: 'pipe',
    })
    const code = await child.exited
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(received).toEqual([event])
    expect(await Bun.file(file).text()).toBe(registry)
  } finally {
    server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
})
