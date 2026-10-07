import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function bridgeEntry(repo: string) {
  const machine = join(homedir(), '.config/polydaemon/machine.env')
  if (existsSync(machine)) {
    const call = Bun.spawnSync(['python3', '-c',
      'import sys,json,pathlib;sys.path.insert(0,sys.argv[1]);import mcp_entry as m;r=pathlib.Path(sys.argv[1]).parent;print(json.dumps(m.build_entry(m.parse_env(m.MACHINE_ENV.read_text(encoding="utf-8-sig")),r,m.plugin_env_keys(r))))',
      join(repo, 'hooks')])
    if (call.exitCode) throw new Error('Invalid bridge machine.env; run hooks/install.py --mcp --dry-run')
    return JSON.parse(call.stdout.toString())
  }
  // Existing installations already keep the same credentials in Codex's MCP entry.
  const config = Bun.TOML.parse(readFileSync(join(homedir(), '.codex/config.toml'), 'utf8')) as any
  const source = config.mcp_servers?.['tg-bridge']?.env
  if (!source?.TG_BOT_TOKEN || !source?.TG_BRIDGE_AUTH_TOKEN) throw new Error('No configured tg-bridge MCP credentials')
  return { command: process.execPath, args: ['run', join(repo, 'channel-plugin/server.ts')],
    env: Object.fromEntries(Object.entries(source).filter(([key]) => key.startsWith('TG_') && !['TG_WINDOW_UID', 'TG_BRIDGE_INSTANCE_NAME'].includes(key))) }
}
