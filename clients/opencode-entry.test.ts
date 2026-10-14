import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('machine.env loads through the native Python command with an isolated home', () => {
  const home = mkdtempSync(join(process.cwd(), '.entry-test-'))
  const config = join(home, '.config/polydaemon')
  mkdirSync(config, { recursive: true })
  const repo = resolve(import.meta.dir, '..')
  const module = pathToFileURL(join(repo, 'clients/opencode-entry.ts')).href
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(TG_|CLAUDE|CODEX|MIMOCODE|PYTHONHOME|PYTHONPATH)/.test(key)))
  const invoke = () => Bun.spawnSync([process.execPath, '-e',
    `import { bridgeEntry } from ${JSON.stringify(module)}; console.log(JSON.stringify(bridgeEntry(${JSON.stringify(repo)})));`],
    { env: { ...env, HOME: home, USERPROFILE: home } })
  try {
    writeFileSync(join(config, 'machine.env'), 'TG_BOT_TOKEN=fixture\nTG_BRIDGE_AUTH_TOKEN=fixture\n')
    const result = invoke()
    expect(result.exitCode).toBe(0)
    const entry = JSON.parse(result.stdout.toString())
    expect(entry.command).toBe('bun')
    expect(entry.args).toEqual(['run', join(repo, 'channel-plugin/server.ts')])
    expect(entry.env).toEqual({ TG_BOT_TOKEN: 'fixture', TG_BRIDGE_AUTH_TOKEN: 'fixture' })
    writeFileSync(join(config, 'machine.env'), 'TG_BOT_TOKEN=fixture\n')
    expect(invoke().exitCode).not.toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 20000)
