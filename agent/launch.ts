import { existsSync, statSync } from 'fs'
import { basename, isAbsolute, join } from 'path'
import { spawn } from 'child_process'
import { log } from './log.ts'

// ---------------------------------------------------------------------------
// POST /v1/launch — macOS branch only (v0): open Terminal.app running claude
// with the tg-bridge channel in the given workspace.
//
// If the workspace ships its own clients/tg-claude.sh copy, we run THAT (it
// carries the canonical flag set and the TG_BRIDGE_INSTANCE_NAME export);
// otherwise we inline the same command. Windows (launch-ws.ps1 via
// clients/launch-agent.ts) and Linux branches come later.
// ---------------------------------------------------------------------------

// Mirrors launch-agent.ts SAFE_NAME (launcher.py _SAFE_NAME): letters/digits/
// space/dot/dash/underscore, never leading '-'.
const SAFE_NAME = /^[\w.][\w .\-]*$/

export interface LaunchRequest { workspace_path?: string; name?: string }
export interface LaunchResult { ok: boolean; reason?: string; name?: string; method?: string }

/** POSIX single-quote — the string becomes one shell word, no expansions. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Escape for embedding inside an AppleScript double-quoted string literal. */
function asq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function launchWindow(body: LaunchRequest): LaunchResult {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'v0 only implements the macOS branch (Terminal.app)' }
  }
  const wsPath = String(body.workspace_path ?? '')
  if (!isAbsolute(wsPath)) return { ok: false, reason: 'workspace_path must be an absolute path' }
  try {
    if (!statSync(wsPath).isDirectory()) return { ok: false, reason: 'workspace_path is not a directory' }
  } catch {
    return { ok: false, reason: 'workspace_path does not exist' }
  }
  // Default the window name to the folder basename, sanitized the same way
  // tg-claude.sh does (tr -cs '[:alnum:]._-' '_').
  const name = String(body.name ?? '') || basename(wsPath).replace(/[^a-zA-Z0-9._-]+/g, '_')
  if (!SAFE_NAME.test(name)) return { ok: false, reason: 'unsafe or empty name' }

  const script = join(wsPath, 'tg-claude.sh')
  let cmd: string
  let method: string
  if (existsSync(script)) {
    // TG_WS_NAME overrides the name inside tg-claude.sh; bash avoids relying
    // on the exec bit.
    cmd = `cd ${sq(wsPath)} && TG_WS_NAME=${sq(name)} exec bash ./tg-claude.sh`
    method = 'tg-claude.sh'
  } else {
    // Inline clone of clients/tg-claude.sh: same flags, same identity export
    // (claude --name never reaches the plugin — TG_BRIDGE_INSTANCE_NAME does).
    cmd = `cd ${sq(wsPath)} && export TG_BRIDGE_INSTANCE_NAME=${sq(name)} && `
      + `exec claude --dangerously-load-development-channels server:tg-bridge `
      + `--continue --name ${sq(name)} --permission-mode bypassPermissions`
    method = 'inline'
  }

  const osa = `tell application "Terminal"\nactivate\ndo script "${asq(cmd)}"\nend tell`
  // Fire-and-forget, like launch-agent.ts: osascript returns as soon as
  // Terminal accepts the script; launches are rare.
  const child = spawn('osascript', ['-e', osa], { stdio: 'ignore' })
  child.on('error', e => log(`launch: osascript spawn failed for ${name}: ${e}`))
  log(`launch: ${name} in ${wsPath} (${method})`)
  return { ok: true, name, method }
}
