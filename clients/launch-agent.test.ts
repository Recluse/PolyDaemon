import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

test('HTTP launch selects the exact agent/mode; shell dispatch never opens a real window', async () => {
  if (process.platform === 'win32') return // native PowerShell test covers Windows
  const root = mkdtempSync(join(tmpdir(), 'polydaemon-launch-'))
  const cwd = join(root, 'shared project')
  mkdirSync(cwd)
  const runner = join(root, 'runner.sh')
  const receipt = join(root, 'args.json')
  writeFileSync(runner, '#!/bin/bash\nbun -e \'require("fs").writeFileSync(process.env.LAUNCH_RECEIPT, JSON.stringify(process.argv.slice(1)))\' "$@"\n')
  for (const agent of ['claude', 'codex', 'opencode', 'mimo']) writeFileSync(join(cwd, `polydaemon-${agent}.sh`), '')
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = reservation.port
  reservation.stop(true)
  const child = spawn(process.execPath, ['run', resolve(import.meta.dir, 'launch-agent.ts')], {
    env: { ...process.env, TG_BRIDGE_AUTH_TOKEN: 'fixture', TG_LAUNCH_AGENT_BIND: '127.0.0.1', TG_LAUNCH_AGENT_PORT: String(port), TG_LAUNCH_SCRIPT: runner, LAUNCH_RECEIPT: receipt },
    stdio: 'ignore',
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const url = `http://127.0.0.1:${port}`
  async function post(body: unknown, token = 'fixture') {
    return fetch(`${url}/launch`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${url}/health`)).ok } catch {}
      if (ready) break
      await Bun.sleep(25)
    }
    expect(ready).toBe(true)
    expect((await (await fetch(`${url}/health`)).json()).agents).toEqual(['claude', 'codex', 'opencode', 'mimo'])
    expect((await post({ name: 'shared', cwd }, 'bad')).status).toBe(401)
    for (const body of [null, { name: 'shared', cwd: 'relative' }, { name: 'shared', agent: 'shell' }, { name: 'shared', new_session: 'false' }]) {
      expect((await post(body)).status).toBe(400)
    }
    expect((await post({ name: 'shared', cwd: join(root, 'missing'), agent: 'mimo' })).status).toBe(404)
    for (const agent of ['claude', 'codex', 'opencode', 'mimo']) {
      for (const fresh of [false, true]) {
        if (existsSync(receipt)) rmSync(receipt)
        expect((await post({ name: 'shared', cwd, agent, new_session: fresh })).status).toBe(200)
        for (let i = 0; i < 100 && !existsSync(receipt); i++) await Bun.sleep(25)
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual(['shared', cwd, agent, fresh ? 'new' : 'resume'])
      }
    }
    // Exercise the real Mac/Linux script with a fake tmux, not just its argv.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tmux'), '#!/bin/bash\n[ "$1" != has-session ] || exit 1\nprintf "%s\\n" "$@" > "$LAUNCH_RECEIPT"\n', { mode: 0o755 })
    for (const agent of ['claude', 'codex', 'opencode', 'mimo']) {
      const result = Bun.spawnSync(['bash', resolve(import.meta.dir, 'launch-ws.sh'), 'shared', cwd, agent, 'new'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TG_MAC_TERMINAL: 'tmux', TG_MAC_NUDGE: agent === 'claude' ? '0' : '1', LAUNCH_RECEIPT: receipt },
      })
      expect(result.exitCode).toBe(0)
      const args = readFileSync(receipt, 'utf8')
      expect(args).toContain(`bash ./polydaemon-${agent}.sh new`)
      if (agent !== 'claude') expect(args).toContain(`_project-${agent}`)
    }
  } finally {
    child.kill('SIGTERM')
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
