import { chmodSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { log } from './logger.ts'

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
export const BOT_URL = (process.env.TG_BRIDGE_BOT_URL ?? '').replace(/\/+$/, '')
// Interface the local HTTP server binds. 127.0.0.1 for same-machine (default);
// on a roaming device set this to the device's mesh IP so the bot can dial it.
export const BIND_HOST = process.env.TG_BRIDGE_BIND_HOST ?? '127.0.0.1'
// Host advertised to the bot as where to reach this plugin. Defaults to the
// bind host; override if NAT/alias differs from the bind address.
export const ADVERTISE_HOST = process.env.TG_BRIDGE_ADVERTISE_HOST ?? BIND_HOST

// Bot API endpoint. Cloud default caps files at 50MB; the local
// telegram-bot-api server lifts that to ~1990MB.
export const API_ROOT = (process.env.TG_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
export const API_IS_LOCAL = API_ROOT !== 'https://api.telegram.org'
// In --local mode getFile returns a path on the server's filesystem. The server
// runs in Docker with a named volume, so the host can't read it directly — we
// copy received files out of the container with `docker cp`.
// Default by platform: on Windows docker usually lives inside WSL, elsewhere it is
// just `docker`. A flat 'wsl docker' default meant a Mac or Linux user with the
// server on the same machine got "wsl: command not found" on the first file they
// sent to a window — only on receiving, only in local mode, so easy to miss.
export const BOTAPI_DOCKER = process.env.TG_BOTAPI_DOCKER
  ?? (process.platform === 'win32' ? 'wsl docker' : 'docker')
export const BOTAPI_CONTAINER = process.env.TG_BOTAPI_CONTAINER ?? 'telegram-bot-api'
// When the --local bot-api server runs on ANOTHER host (reached over an SSH
// tunnel) AND in Docker there, getFile returns an IN-CONTAINER path that the
// remote host can't see and `docker cp`-from-here can't reach. Set this to an
// ssh target (e.g. "bot-host" from ~/.ssh/config) and download_attachment will
// stream the bytes with `ssh <host> docker exec <container> cat <path>` (ssh
// user must be in the remote `docker` group). Empty = server is local on this
// machine, use `docker cp` (BOTAPI_DOCKER) directly.
export const BOTAPI_SSH = process.env.TG_BOTAPI_SSH ?? ''
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
