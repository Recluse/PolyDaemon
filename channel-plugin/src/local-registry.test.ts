import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('concurrent registry writers preserve siblings and keep tokens private', async () => {
  const home = mkdtempSync(join(tmpdir(), 'polydaemon-registry-'))
  const path = join(home, '.tg-bridge-channel/instances.json')
  const module = join(import.meta.dir, 'local-registry.ts')
  const code = `import { upsertLocal, heartbeatLocal, removeLocal } from ${JSON.stringify(module)};
    const id = process.env.FIXTURE_ID;
    for (let n = 0; n < 30; n++) {
      upsertLocal(id, { host: '127.0.0.1', port: 3100, auth_token: 'fixture',
        instance_name: id, workspace_name: id, cwd: process.cwd(), pid: process.pid,
        parent_pid: process.ppid, started_at: '' });
      heartbeatLocal(id);
      await Bun.sleep(1);
    }
    if (id === 'removed') removeLocal(id);`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TG_|CLAUDE_|CODEX_)/.test(k)))
  const children: ReturnType<typeof Bun.spawn>[] = []
  try {
    for (const id of ['one', 'two', 'three', 'four', 'removed']) {
      children.push(Bun.spawn([process.execPath, '--eval', code], {
        env: { ...env, HOME: home, USERPROFILE: home, TG_BOT_TOKEN: 'fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture', FIXTURE_ID: id },
        stdout: 'pipe', stderr: 'pipe',
      }))
    }
    for (const child of children) {
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).not.toContain('failed')
    }
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort()).toEqual(['four', 'one', 'three', 'two'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited }
    rmSync(home, { recursive: true, force: true })
  }
}, 15000)
