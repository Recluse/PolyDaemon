import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A new plugin on the same host as an OLD bot: the bot.db has no identity
// columns. The plugin adds them, registers with its window id and records a
// route that carries its identity; nothing fails.
test('a new plugin upgrades an old bot.db in place and records identity', async () => {
  mkdirSync('tmp', { recursive: true })
  const home = mkdtempSync(resolve('tmp/mixed-'))
  const ws = join(home, 'infra')
  mkdirSync(ws)
  try {
    const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, 'routes-db-mixed.fixture.ts')], {
      cwd: ws, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH!, TG_BOT_TOKEN: 'fixture',
        TG_BRIDGE_AUTH_TOKEN: 'fixture', TG_WINDOW_UID: 'U1' } })
    expect(child.exitCode).toBe(0)
    const out = JSON.parse(child.stdout.toString().trim().split('\n').pop()!)
    expect(out.row).toEqual({ id: out.rowId, window_uid: 'U1', agent: 'claude' })
    expect(out.route).toEqual({ instance: 'infra', row_id: out.rowId, window_uid: 'U1', scope_host: '127.0.0.1',
      scope_cwd: realpathSync(ws), scope_agent: 'claude' })
    expect(out.foreign).toEqual({ instance: 'other', row_id: 'other-row' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
