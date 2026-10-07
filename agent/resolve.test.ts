import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'net'

test('daemon forwards only explicit approval and plan decisions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'polydaemon-resolve-'))
  const received: any[] = []
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(req, server) {
      if (req.headers.get('upgrade') === 'websocket' && server.upgrade(req)) return
      if (new URL(req.url).pathname === '/healthz') return Response.json({ ok: true })
      expect(req.headers.get('authorization')).toBe('Bearer fixture-plugin')
      received.push({ path: new URL(req.url).pathname, body: await req.json() })
      return Response.json({ ok: true })
    },
    websocket: { message(ws, raw) {
      const message = JSON.parse(String(raw))
      ws.send(JSON.stringify({ id: message.id, result: {} }))
    } },
  })
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(r => socket.close(() => r()))
  mkdirSync(join(home, '.tg-bridge'))
  mkdirSync(join(home, '.tg-bridge-channel'))
  writeFileSync(join(home, '.tg-bridge/agent.toml'), `port = ${port}\nauth_token = "fixture-daemon"\n`)
  writeFileSync(join(home, '.tg-bridge-channel/instances.json'), JSON.stringify({ fixture: {
    instance_name: 'fixture', host: '127.0.0.1', port: peer.port, auth_token: 'fixture-plugin',
    cwd: home, pid: process.pid, parent_pid: process.pid, heartbeat_at: Date.now() / 1000,
  } }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TG_|CLAUDE_|CODEX_)/.test(k)))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'agentd.ts')], {
    env: { ...env, HOME: home, USERPROFILE: home, TG_CODEX_WS_PORT: String(peer.port) },
    stdout: 'ignore', stderr: 'pipe',
  })
  const errors = new Response(child.stderr).text()
  const url = `http://127.0.0.1:${port}`
  try {
    let ready = false
    for (let n = 0; n < 100; n++) {
      ready = await fetch(url + '/v1/health').then(r => r.ok).catch(() => false)
      if (ready) break
      await Bun.sleep(20)
    }
    expect(ready).toBe(true)
    const post = (body: unknown, token = 'fixture-daemon') => fetch(url + '/v1/resolve', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    expect((await post({}, 'wrong')).status).toBe(401)
    expect((await post(null)).status).toBe(400)
    for (const kind of ['approval', 'plan']) {
      for (const action of [undefined, null, '', true, 'bogus']) {
        expect((await post({ window_key: 'fixture', kind, id: 'request', action })).status).toBe(400)
      }
    }
    expect(received).toHaveLength(0)
    for (const [kind, actions] of [['approval', ['once', 'always', 'deny']], ['plan', ['apply', 'decline']]] as const) {
      for (const action of actions) {
        expect((await post({ window_key: 'fixture', kind, id: 'request', action })).status).toBe(200)
        expect(received.at(-1)).toEqual({ path: kind === 'plan' ? '/plan-callback' : '/approve-callback', body: { id: 'request', action } })
      }
    }
  } finally {
    child.kill('SIGTERM')
    await child.exited
    await errors
    peer.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15000)
