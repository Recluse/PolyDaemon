import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { log } from './log.ts'

// ---------------------------------------------------------------------------
// Config — ~/.tg-bridge/agent.toml
//
// First run creates the file with safe defaults (machine_id = hostname, bind
// 127.0.0.1, a freshly generated auth token) and warns, so `bun run agentd.ts`
// works out of the box. Parsed with Bun.TOML (built into Bun ≥1.1) — no
// dependency needed.
// ---------------------------------------------------------------------------

export const CONFIG_DIR = join(homedir(), '.tg-bridge')
export const CONFIG_PATH = join(CONFIG_DIR, 'agent.toml')

export interface AgentConfig {
  machine_id: string
  bind_host: string
  port: number
  auth_token: string
  /** Telegram forum chat id used as chat_id for board-originated /v1/send.
   *  Empty → the literal 'board' marker (replies then have nowhere to go —
   *  set this to the bridge's forum_chat_id so window replies land in their
   *  own topics and the board reads them back from transcripts). */
  forum_chat_id: string
  /** Reserved: the board's public key, for verifying signed commands (kill,
   *  preset apply) in a later phase. Unused in v0. */
  board_pubkey: string
}

function defaults(): AgentConfig {
  return {
    machine_id: hostname(),
    bind_host: '127.0.0.1',
    port: 3200,
    auth_token: randomBytes(32).toString('hex'),
    forum_chat_id: '',
    board_pubkey: '',
  }
}

function render(cfg: AgentConfig): string {
  return [
    '# tg-bridge agent daemon (agentd) — per-machine config',
    '# machine_id identifies this machine to the board; bind_host should be',
    '# 127.0.0.1 (local only) or this machine\'s mesh IP — NEVER 0.0.0.0.',
    `machine_id = "${cfg.machine_id}"`,
    `bind_host = "${cfg.bind_host}"`,
    `port = ${cfg.port}`,
    `auth_token = "${cfg.auth_token}"`,
    '# Forum chat id for board-originated sends (see AgentConfig docs).',
    `forum_chat_id = "${cfg.forum_chat_id}"`,
    '# Reserved for a future phase (board command signatures). Leave empty.',
    `board_pubkey = "${cfg.board_pubkey}"`,
    '',
  ].join('\n')
}

export function loadConfig(): AgentConfig {
  if (!existsSync(CONFIG_PATH)) {
    const cfg = defaults()
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, render(cfg))
    try { chmodSync(CONFIG_PATH, 0o600) } catch {}
    log(`no config found — created ${CONFIG_PATH} with defaults `
      + `(machine_id=${cfg.machine_id}, bind=${cfg.bind_host}:${cfg.port}, fresh auth_token). `
      + `Review it before exposing the daemon on the mesh.`)
    return cfg
  }

  let parsed: Record<string, unknown>
  try {
    // Bun.TOML.parse exists in current Bun but isn't in bun-types yet.
    parsed = (Bun as unknown as { TOML: { parse(s: string): Record<string, unknown> } })
      .TOML.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    log(`cannot parse ${CONFIG_PATH}: ${e}`)
    process.exit(1)
  }

  const d = defaults()
  const cfg: AgentConfig = {
    machine_id: typeof parsed.machine_id === 'string' && parsed.machine_id ? parsed.machine_id : d.machine_id,
    bind_host: typeof parsed.bind_host === 'string' && parsed.bind_host ? parsed.bind_host : d.bind_host,
    port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : d.port,
    auth_token: typeof parsed.auth_token === 'string' ? parsed.auth_token : '',
    forum_chat_id: typeof parsed.forum_chat_id === 'string' ? parsed.forum_chat_id : '',
    board_pubkey: typeof parsed.board_pubkey === 'string' ? parsed.board_pubkey : '',
  }
  if (!cfg.auth_token) {
    log(`auth_token is empty in ${CONFIG_PATH} — refusing to serve without auth.`)
    process.exit(1)
  }
  try { chmodSync(CONFIG_PATH, 0o600) } catch {}
  return cfg
}
