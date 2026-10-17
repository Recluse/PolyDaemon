import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

for (const kind of ['codex', 'claude', 'opencode', 'mimo', 'rootless'] as const) {
  test(`registration waits for the final ${kind} identity`, async () => {
    mkdirSync('tmp', { recursive: true })
    const home = mkdtempSync(resolve('tmp/registration-handshake-'))
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const calls: { path: string; body: any }[] = []
    let registered!: () => void
    const registration = new Promise<void>(r => { registered = r })
    const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname
      const body = await req.json().catch(() => ({}))
      calls.push({ path, body })
      if (path === '/register') registered()
      return Response.json({ ok: true })
    } })
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = reservation.port!
    reservation.stop(true)
    const client = new Client({ name: kind === 'rootless' ? 'codex' : kind, version: 'fixture' })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve(import.meta.dir, '../server.ts')], cwd: kind === 'rootless' ? home : workspace,
      stderr: 'pipe', env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH!,
        TG_BOT_TOKEN: 'fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture', TG_BRIDGE_FORCE_CHANNELS: '1',
        TG_BRIDGE_PORT: String(port), TG_API_ROOT: fake.url.origin, TG_BRIDGE_BOT_URL: fake.url.origin,
        ...(kind === 'opencode' || kind === 'mimo' ? { TG_BRIDGE_AGENT: kind } : {}),
      },
    })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const send = transport.send.bind(transport)
    transport.send = async message => {
      if ('method' in message && message.method === 'initialize') await gate
      return send(message)
    }
    let ready!: () => void
    const readyPromise = new Promise<void>(r => { ready = r })
    const logDir = join(home, '.tg-bridge-channel')
    mkdirSync(logDir)
    const watcher = watch(logDir, () => {
      try {
        if (readFileSync(join(logDir, 'debug.log'), 'utf8').includes('connecting MCP transport')) ready()
      } catch { /* The first directory event can precede the log file. */ }
    })
    let stderr = ''
    transport.stderr!.on('data', data => {
      stderr += data.toString()
    })
    let deadline!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`MCP startup timeout: ${stderr}`)), 12000)
    })
    const connection = client.connect(transport)
    // Keep a failed startup observed while the test waits for its readiness log.
    void connection.catch(() => {})
    try {
      await Promise.race([readyPromise, timeout])
      // Cross the old eager-heartbeat deadline before releasing initialize.
      if (kind === 'codex') await Bun.sleep(3200)
      expect(calls.filter(c => ['/register', '/heartbeat'].includes(c.path))).toEqual([])
      release()
      await Promise.race([connection, timeout])
      await client.listTools()
      if (kind === 'rootless') {
        await Bun.sleep(3200)
        expect(calls.filter(c => ['/register', '/heartbeat'].includes(c.path))).toEqual([])
      } else {
        await Promise.race([registration, timeout])
        const rows = calls.filter(c => c.path === '/register').map(c => c.body)
        expect(rows).toHaveLength(1)
        const name = kind === 'claude' ? 'workspace' : `workspace-${kind}`
        expect(rows[0].instance_name).toBe(name)
        expect(rows[0].workspace_name).toBe(name)
      }
    } finally {
      release()
      clearTimeout(deadline)
      watcher.close()
      await client.close()
      await transport.close()
      fake.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 20000)
}
