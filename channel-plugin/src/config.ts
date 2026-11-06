import { chmodSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { log } from './logger.ts'
import { readTransportConfig } from './transport-config.ts'
import { EndpointChain, type Endpoint, type Lease } from './endpoint-chain.ts'

// ---------------------------------------------------------------------------
// Config — from env or ~/.tg-bridge-channel/.env
// ---------------------------------------------------------------------------

export const STATE_DIR = join(homedir(), '.tg-bridge-channel')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// A temporary host-level route survives cached MCP descriptors without changing
// credentials, window identity, or unrelated agent settings. Remove to revert.
const transport = readTransportConfig(join(STATE_DIR, 'transport.json'))

/** Canonical workspace key. Windows reports the cwd drive letter in mixed case
 * (`C:\…` vs `c:\…`); keyed raw, the bot treats one folder as two windows →
 * duplicate forum topics + a window reload that fails to resume. Uppercasing the
 * drive letter makes both sides agree. No-op on POSIX paths. MUST stay identical
 * to the Python bot's `canonical_cwd()` (bridge/registry.py). */
export function canonicalCwd(p: string): string {
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p
}

export const TOKEN = process.env.TG_BOT_TOKEN
export const AUTH_TOKEN = process.env.TG_BRIDGE_AUTH_TOKEN ?? ''
export let INSTANCE_NAME = process.env.TG_BRIDGE_INSTANCE_NAME ?? basename(process.cwd())
export const START_PORT = parseInt(process.env.TG_BRIDGE_PORT ?? '3100', 10)

// --- Networked registry (cross-machine) -----------------------------------
// When TG_BRIDGE_BOT_URL is set, this plugin runs on a DIFFERENT machine than
// the bot: it registers/heartbeats/unregisters over HTTP to the bot's registry
// server instead of writing the shared bot.db (which it can't reach). Unset =
// the original same-machine bot.db-direct path (default; nothing changes).
//
// transport.json v2 lists ordered failover endpoints (primary first). A network
// failure marks the current one down and the next request moves to the next;
// the marks expire, so a recovered primary is preferred again. Legacy v1 and
// the env vars below build a single-endpoint chain.
function buildChain(): Endpoint[] {
  if (transport.endpoints?.length) return transport.endpoints
  const bot_url = (transport.bot_url ?? process.env.TG_BRIDGE_BOT_URL ?? '').replace(/\/+$/, '')
  if (!bot_url) return []
  const api_root = (transport.api_root ?? process.env.TG_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
  return [{
    bot_url,
    api_root,
    botapi_ssh: transport.botapi_ssh ?? process.env.TG_BOTAPI_SSH ?? '',
    botapi_container: transport.botapi_container ?? process.env.TG_BOTAPI_CONTAINER ?? 'telegram-bot-api',
  }]
}

export const CHAIN = new EndpointChain(buildChain())
export const REMOTE_MODE = CHAIN.size > 0

// Live bindings: failover() reassigns them and every importer (ESM live
// bindings) sees the new values on its next read. Do not destructure at
// module top-level in call sites that must survive a failover.
export let BOT_URL = CHAIN.current()?.bot_url.replace(/\/+$/, '') ?? ''
export let API_ROOT = (CHAIN.current()?.api_root
  ?? process.env.TG_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
export let API_IS_LOCAL = API_ROOT !== 'https://api.telegram.org'
export let BOTAPI_CONTAINER = CHAIN.current()?.botapi_container
  ?? process.env.TG_BOTAPI_CONTAINER ?? 'telegram-bot-api'
export let BOTAPI_SSH = CHAIN.current()?.botapi_ssh ?? process.env.TG_BOTAPI_SSH ?? ''

/** Bumped whenever the bindings move to another endpoint. A caller that spans
 *  an await compares it to detect a move, including a move away and back. */
export let ENDPOINT_GENERATION = 0

function applyEndpoint(next: Endpoint, why: string): void {
  const before = BOT_URL
  const was = `${BOT_URL}|${API_ROOT}|${BOTAPI_SSH}|${BOTAPI_CONTAINER}`
  BOT_URL = next.bot_url.replace(/\/+$/, '')
  API_ROOT = next.api_root.replace(/\/+$/, '')
  API_IS_LOCAL = API_ROOT !== 'https://api.telegram.org'
  BOTAPI_CONTAINER = next.botapi_container
  BOTAPI_SSH = next.botapi_ssh
  if (`${BOT_URL}|${API_ROOT}|${BOTAPI_SSH}|${BOTAPI_CONTAINER}` !== was) ENDPOINT_GENERATION++
  if (BOT_URL !== before) log(`PolyDaemon: bot endpoint ${why} -> ${BOT_URL || '(none)'} (api ${API_ROOT})`)
}

function syncBindings(why: string): void {
  const active = CHAIN.current()
  if (active) applyEndpoint(active, why)
}

/** Lease the endpoint for one registry request; pass the lease back to
 *  failover() or endpointHealthy() when the request settles. The request must
 *  go to `bot_url` from the lease, not to BOT_URL: a probe of a recovered
 *  primary runs while the bindings still point at the active endpoint. */
export function useEndpoint(): (Lease & { bot_url: string }) | null {
  if (!REMOTE_MODE) return null
  const lease = CHAIN.acquire()
  return { ...lease, bot_url: CHAIN.endpoint(lease.index)!.bot_url.replace(/\/+$/, '') }
}

/** Transport failure on the leased endpoint. */
export function failover(lease: Lease | null): void {
  if (!REMOTE_MODE || !lease) return
  CHAIN.failed(lease)
  syncBindings('failover')
}

/** The leased endpoint answered. */
export function endpointHealthy(lease: Lease | null): void {
  if (!REMOTE_MODE || !lease) return
  CHAIN.succeeded(lease)
  syncBindings('recovered')
}
// Interface the local HTTP server binds. 127.0.0.1 for same-machine (default);
// on a roaming device set this to the device's mesh IP so the bot can dial it.
export const BIND_HOST = process.env.TG_BRIDGE_BIND_HOST ?? '127.0.0.1'
// Host advertised to the bot as where to reach this plugin. Defaults to the
// bind host; override if NAT/alias differs from the bind address.
export const ADVERTISE_HOST = process.env.TG_BRIDGE_ADVERTISE_HOST ?? BIND_HOST

// Bot API endpoint (API_ROOT/API_IS_LOCAL/BOTAPI_CONTAINER/BOTAPI_SSH above):
// cloud default caps files at 50MB, the local telegram-bot-api lifts that to
// ~1990MB.
// In --local mode getFile returns a path on the server's filesystem. The server
// runs in Docker with a named volume, so the host can't read it directly — we
// copy received files out of the container with `docker cp`.
// Default by platform: on Windows docker usually lives inside WSL, elsewhere it is
// just `docker`. A flat 'wsl docker' default meant a Mac or Linux user with the
// server on the same machine got "wsl: command not found" on the first file they
// sent to a window — only on receiving, only in local mode, so easy to miss.
export const BOTAPI_DOCKER = process.env.TG_BOTAPI_DOCKER
  ?? (process.platform === 'win32' ? 'wsl docker' : 'docker')
// When the --local bot-api server runs on ANOTHER host (reached over an SSH
// tunnel) AND in Docker there, getFile returns an IN-CONTAINER path that the
// remote host can't see and `docker cp`-from-here can't reach. Set this to an
// ssh target (e.g. "bot-host" from ~/.ssh/config) and download_attachment will
// stream the bytes with `ssh <host> docker exec <container> cat <path>` (ssh
// user must be in the remote `docker` group). Empty = server is local on this
// machine, use `docker cp` (BOTAPI_DOCKER) directly.
// The server's `--dir`. Newer telegram-bot-api builds return getFile.file_path
// RELATIVE to "<dir>/<bot-token>/" instead of as an absolute path, so we resolve
// relative paths against this base before handing them to `docker cp`.
export const BOTAPI_WORKDIR = (process.env.TG_BOTAPI_WORKDIR ?? '/var/lib/telegram-bot-api').replace(/\/+$/, '')

if (!TOKEN) {
  log(
    `PolyDaemon: TG_BOT_TOKEN required.\n` +
    `  Set in env or ${ENV_FILE}\n`,
  )
  process.exit(1)
}
if (!AUTH_TOKEN) {
  log('PolyDaemon: TG_BRIDGE_AUTH_TOKEN required.\n')
  process.exit(1)
}

// How long a permission/question/plan prompt stays live waiting for a Telegram
// answer before the plugin gives up (approve→deny, ask/plan→timeout). 24h ≈
// "no timer" for the async, phone-driven workflow (Claude Code has no truly
// infinite hook timeout — every command hook needs a finite ceiling). Ordering
// that MUST hold: this plugin timer < the hook's HTTP wait (+60s) < Claude's
// own hook `timeout` in settings.json (24h+5m) — so the plugin's resolution
// reaches the hook and the hook returns BEFORE Claude kills the process (a
// killed PreToolUse hook falls through to ALLOW, which we don't want).
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const BRIDGE_DIR = join(homedir(), '.tg-copilot-bridge')
export const ACTIVE_INSTANCES_PATH = join(BRIDGE_DIR, 'active-instances.json')
export const PERMISSION_OVERRIDES_PATH = join(BRIDGE_DIR, 'permission-overrides.json')
export const DB_PATH = join(BRIDGE_DIR, 'bot.db')

// Every Telegram message originated from a specific VSCode window. We prepend
// the workspace folder name as a bold first line so the user always knows
// which window is talking, even when several windows reply into the same chat.
// (Claude Code's default channel-progress prefix is the *agent* name "main",
// which says nothing useful — we strip/replace it.)
export let WORKSPACE_DISPLAY_NAME = basename(process.cwd())

// MCP client identity is only known after initialize. Keep every outbound
// consumer (headers, reply routes and inter-window RPC) on the registered name.
export function setWorkspaceIdentity(name: string): void {
  INSTANCE_NAME = name
  WORKSPACE_DISPLAY_NAME = name
}

// Must match Python resolve_workspace_id: Codex and Claude share a cwd,
// but their topics and inbound routing must remain distinct.
export function workspaceBindingKey(): string {
  const cwd = canonicalCwd(process.cwd())
  const agent = WORKSPACE_DISPLAY_NAME.match(/-(codex|opencode|mimo)$/)?.[1]
  return agent ? `${cwd}#${agent}` : cwd
}
