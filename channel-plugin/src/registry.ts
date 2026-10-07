import { randomBytes } from 'crypto'
import { basename } from 'path'
import { AUTH_TOKEN, INSTANCE_NAME, setWorkspaceIdentity, canonicalCwd, BOT_URL, BIND_HOST, ADVERTISE_HOST } from './config.ts'
import { upsertInstance, deleteInstance, heartbeatInstance as dbHeartbeat, type InstanceRow } from './routes-db.ts'
import { registerRemote, heartbeatRemote, unregisterRemote } from './bot-rpc.ts'
import { upsertLocal, heartbeatLocal, removeLocal } from './local-registry.ts'
import { MY_PORT } from './state.ts'

// When BOT_URL is set the bot lives on another machine: register over HTTP and
// advertise our reachable (mesh) host. Otherwise keep the original same-machine
// path — write the shared bot.db directly and advertise loopback.
const REMOTE = BOT_URL !== ''

// ---------------------------------------------------------------------------
// Registry — a row in the shared bot.db `instances` table (see routes-db.ts).
// Replaces the old per-window ~/.tg-copilot-bridge/instances/{id}.json files:
// the upsert is atomic (no half-written read), reaping is a cheap query, and the
// heartbeat below means a hard-crashed window is detected without another window
// having to start and sweep for it.
// ---------------------------------------------------------------------------

// Per-process id (random). The window's DB row is keyed by this; a reload starts
// a fresh process → fresh id, and the old row is reaped by the bot (dead PID /
// stale heartbeat) or removed by unregisterInstance() on a clean exit.
export const REGISTRY_ID = randomBytes(8).toString('hex')

// Codex hosts rename themselves AFTER the MCP handshake (client identity is
// unknown at import time): "<basename>-codex" keeps a Codex window from
// colliding with the Claude window of the same workspace in the bot registry.
let nameOverride: string | null = null
export function setNameOverride(name: string): void {
  nameOverride = name
  setWorkspaceIdentity(name)
}
export function effectiveName(): string {
  return nameOverride ?? INSTANCE_NAME
}
export function effectiveWorkspaceName(): string {
  return nameOverride ?? basename(process.cwd())
}

function buildRow(port: number): InstanceRow {
  return {
    id: REGISTRY_ID,
    // Advertise the host the bot must dial. Loopback for same-machine; the
    // device's mesh IP (ADVERTISE_HOST) when remote.
    host: REMOTE ? ADVERTISE_HOST : '127.0.0.1',
    port,
    auth_token: AUTH_TOKEN,
    instance_name: effectiveName(),
    workspace_name: effectiveWorkspaceName(),
    cwd: canonicalCwd(process.cwd()),
    pid: process.pid,
    parent_pid: process.ppid,
    // Opaque OS-reported start-time of THIS process. Lets readers tell a live
    // instance apart from a stale one whose PID got recycled (Windows reuses
    // PIDs aggressively). Computed the same way both sides verify it, so the
    // tokens compare exactly. May be '' if the lookup fails — readers then
    // fall back to plain PID-liveness. See _procStartTime. (Remote rows can't
    // be PID-probed cross-host anyway — the bot uses heartbeat-only for those.)
    started_at: _procStartTime(process.pid) ?? '',
  }
}

export function registerInstance(port: number): void {
  const row = buildRow(port)
  if (REMOTE) void registerRemote(row)
  else upsertInstance(row)
  // ALWAYS mirror to the local registry so co-located hooks can find us without
  // touching bot.db (which a remote plugin never writes). The host the hook
  // dials is the SAME interface we bound — loopback locally, our mesh IP when
  // remote (same-machine connect to its own mesh IP works).
  upsertLocal(REGISTRY_ID, {
    host: row.host, port: row.port, auth_token: row.auth_token,
    instance_name: row.instance_name, workspace_name: row.workspace_name,
    cwd: row.cwd, pid: row.pid, parent_pid: row.parent_pid, started_at: row.started_at,
    // Per-window identity minted by the launcher (see clients/polydaemon-claude.sh) and
    // inherited by every hook. Empty for a window started outside the launcher —
    // Zed's external agent starts claude itself — so readers must keep a fallback.
    window_uid: process.env.TG_WINDOW_UID ?? '',
  })
}

// Keep this window's row fresh. The bot treats a row whose heartbeat is recent as
// live without probing the PID, and reaps rows whose heartbeat went stale AND
// whose PID is dead/reused. Call on an interval; see server.ts.
export function reRegister(): void {
  if (MY_PORT) registerInstance(MY_PORT)
}

export function heartbeatInstance(): void {
  if (REMOTE) {
    void heartbeatRemote(REGISTRY_ID).then((known) => {
      // Bot lost our row (it restarted) → re-register so routing resumes.
      if (!known && MY_PORT) registerInstance(MY_PORT)
    })
  } else {
    dbHeartbeat(REGISTRY_ID)
  }
  heartbeatLocal(REGISTRY_ID)  // keep the hooks' local view fresh too
}

export function unregisterInstance(): void {
  if (REMOTE) void unregisterRemote(REGISTRY_ID)
  else deleteInstance(REGISTRY_ID)
  removeLocal(REGISTRY_ID)
}

/**
 * Opaque process start-time token for `procId`, used to detect PID reuse.
 *   - non-empty string → the process is alive; the string identifies *which*
 *     process (two processes that happened to share a PID will not match).
 *   - ''   → no process exists at this PID (it has exited).
 *   - null → the lookup itself failed (timeout / no permission); caller can't tell.
 *
 * Token format is per-OS but identical between the plugin and the Python bot
 * (which run on the same host), so a stored token compares exactly against a
 * freshly-computed one:
 *   - Windows: whole seconds of the kernel process-creation time since
 *     1601-01-01 UTC. The Python bot reads this via GetProcessTimes (ctypes);
 *     here we use .NET `Get-Process … StartTime.ToFileTimeUtc()`, which is the
 *     SAME kernel instant, floored to whole seconds — so the tokens match.
 *   - Linux:   `starttime` (field 22 of /proc/<pid>/stat), ticks since boot.
 *
 * IMPORTANT: this deliberately does NOT use `Get-CimInstance Win32_Process`.
 * WMI on a loaded box can wedge (provider host recycling, HRESULT 0x80041033),
 * making each query hang for *minutes* — which used to cascade into the bot's
 * liveness refresh piling up and every window flapping offline. `Get-Process`
 * is a native NtQuerySystemInformation call with no WMI dependency, and the
 * hard `timeout`+`SIGKILL` below guarantees a slow lookup degrades to `null`
 * (caller falls back to plain PID-liveness) instead of blocking startup.
 */
export function _procStartTime(procId: number): string | null {
  if (!procId || procId <= 1) return null
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process') as typeof import('child_process')
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `$p = Get-Process -Id ${procId} -ErrorAction SilentlyContinue;`
          + ` if ($p) { [long][Math]::Floor($p.StartTime.ToFileTimeUtc() / 10000000) }`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, killSignal: 'SIGKILL' },
      )
      if (r.error || r.status !== 0) return null   // exec failed / timed out → unknown
      return (r.stdout || '').trim()               // '' → no such process; else token
    } catch { return null }
  }
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const stat = readFileSync(`/proc/${procId}/stat`, 'utf8')
    // comm (field 2) can contain spaces/parens — parse after the last ')'.
    // Remaining tokens start at field 3 (state), so starttime (field 22) is index 19.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    return rest[19] ?? null
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null
  }
}

export function _parentCommandLine(): string {
  const ppid = process.ppid
  if (!ppid || ppid <= 1) return ''
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process') as typeof import('child_process')
      // This is the one remaining WMI call: a process command line isn't
      // available without WMI on Windows PowerShell 5.1. It is reached only when
      // TG_BRIDGE_FORCE_CHANNELS != '1' (see PARENT_CMD below) — set that env in
      // every launcher and this never runs. Hard-bounded + SIGKILL so even when
      // it IS reached on a wedged-WMI box it can't hang startup for minutes.
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, killSignal: 'SIGKILL' },
      )
      return (r.stdout || '').trim()
    }
    if (process.platform === 'darwin') {
      // No /proc on macOS. Without this branch a plain `claude
      // --dangerously-load-development-channels …` on a Mac read '' here, the
      // plugin concluded channels were off and never registered with the bot.
      const { spawnSync } = require('child_process') as typeof import('child_process')
      const r = spawnSync('ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 4000 })
      return (r.stdout || '').trim()
    }
    const { readFileSync } = require('fs') as typeof import('fs')
    return readFileSync(`/proc/${ppid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch { return '' }
}

// A Claude Code parent will only deliver `notifications/claude/channel` to us
// when it was started with `--dangerously-load-development-channels server:<name>`
// (channels are an opt-in research preview). Without that flag the plugin still
// connects fine, but inbound messages are silently dropped — so registering in
// the multi-window registry would only mislead the Python bot.
// TG_BRIDGE_FORCE_CHANNELS=1 bypasses the parent-cmdline probe for setups where
// the launcher always passes the flag but the WMI/CIM lookup is unreliable
// (cold-start PowerShell on Windows can blow past the timeout).
// When the launcher sets TG_BRIDGE_FORCE_CHANNELS=1 we trust it and skip the
// WMI parent-cmdline probe ENTIRELY — not just its result. (It used to run
// unconditionally at import, so the bypass env still paid the WMI cost and
// could hang startup on a wedged-WMI box.)
//
// The launchers EXPORT the variable, so every process a window starts inherits
// it — including a headless `claude -p` run from inside the window, whose own
// copy of this plugin then registered under the window's name and could take
// its messages. Claude Code marks such a run with CLAUDE_CODE_ENTRYPOINT=sdk-cli
// (an interactive window says `cli`); a headless run never has a channel.
const HEADLESS = process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli'
const FORCED = process.env.TG_BRIDGE_FORCE_CHANNELS === '1' && !HEADLESS
export const PARENT_CMD = FORCED || HEADLESS ? '' : _parentCommandLine()
export const CHANNELS_ENABLED = FORCED
  || /--dangerously-load-development-channels|--channels\b/.test(PARENT_CMD)
