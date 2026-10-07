import { readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve, posix as pathPosix } from 'path'
import { spawnSync } from 'child_process'
import {
  ACTIVE_INSTANCES_PATH,
  PERMISSION_OVERRIDES_PATH,
  WORKSPACE_DISPLAY_NAME,
} from './config.ts'
import { MY_PORT, lastUserId } from './state.ts'
import { htmlEscape } from './markdown.ts'
import { log } from './logger.ts'

// mtime-keyed memo for the two shared JSON files. Each is read on hot paths
// (per send / per keyboard rebuild / per /approve-request) — statSync is a
// single syscall and lets us skip the readFileSync+JSON.parse when the bot
// hasn't rewritten the file. Bot writes are external → mtime bumps → cache
// auto-invalidates on the next call.
type Json = unknown
const _cache = new Map<string, { key: string; data: Json }>()

function readJsonCached(path: string): Json | null {
  // Key on (mtime,size): mtime alone collides when the bot rewrites a file
  // twice within one ms (coarse FS timestamp), serving a stale read; the size
  // component catches the common case where the content length also changed.
  let key: string
  try {
    const st = statSync(path)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
  const hit = _cache.get(path)
  if (hit && hit.key === key) return hit.data
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    _cache.set(path, { key, data })
    return data
  } catch {
    return null
  }
}

export function getActiveInstanceForUser(userId: number): string | null {
  const obj = readJsonCached(ACTIVE_INSTANCES_PATH) as Record<string, string> | null
  return obj?.[String(userId)] ?? null
}

// Read THIS workspace's permission mode from the shared overrides file the bot
// writes. Canonical mode names match Claude Code's `permissionMode` setting
// values — see tg-bot/bot/permissions.py for the source of truth.
export function getWorkspacePermissionMode(): string {
  const obj = readJsonCached(PERMISSION_OVERRIDES_PATH) as Record<string, string> | null
  return obj?.[WORKSPACE_DISPLAY_NAME] ?? 'default'
}

export function buildReplyHereKeyboard(): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  if (!MY_PORT || lastUserId == null) return undefined
  // Identity is the workspace name (must match tg-bot/bridge/registry.py), not
  // host:port — ports rotate across restarts.
  const ownKey = WORKSPACE_DISPLAY_NAME
  const activeKey = getActiveInstanceForUser(lastUserId)
  if (!activeKey || activeKey === ownKey) return undefined
  return { inline_keyboard: [[{ text: '📩 Ответить здесь', callback_data: `reply_to:${ownKey}` }]] }
}

export function formatToolSummary(toolName: string, toolInput: unknown): string {
  const inp = (toolInput && typeof toolInput === 'object') ? toolInput as Record<string, unknown> : {}

  if (toolName === 'Bash' && typeof inp.command === 'string') {
    const desc = typeof inp.description === 'string' && inp.description
      ? `\n<i>${htmlEscape(String(inp.description))}</i>` : ''
    return `<b>Bash</b>${desc}\n<pre><code>${htmlEscape(String(inp.command).slice(0, 1500))}</code></pre>`
  }

  if (toolName === 'Edit' && typeof inp.file_path === 'string'
      && typeof inp.old_string === 'string' && typeof inp.new_string === 'string') {
    const oldS = String(inp.old_string).slice(0, 600)
    const newS = String(inp.new_string).slice(0, 600)
    return `<b>Edit</b> <code>${htmlEscape(inp.file_path)}</code>\n` +
      `<pre>- ${htmlEscape(oldS)}\n+ ${htmlEscape(newS)}</pre>`
  }

  if (toolName === 'Write' && typeof inp.file_path === 'string' && typeof inp.content === 'string') {
    return `<b>Write</b> <code>${htmlEscape(inp.file_path)}</code>\n` +
      `<pre>${htmlEscape(String(inp.content).slice(0, 800))}</pre>`
  }

  if (toolName === 'WebFetch' && typeof inp.url === 'string') {
    const prompt = typeof inp.prompt === 'string' && inp.prompt
      ? `\n<i>${htmlEscape(String(inp.prompt).slice(0, 300))}</i>` : ''
    return `<b>WebFetch</b> <code>${htmlEscape(inp.url)}</code>${prompt}`
  }

  const raw = JSON.stringify(inp)
  return `<b>${htmlEscape(toolName)}</b>\n<pre>${htmlEscape(raw.slice(0, 800))}${raw.length > 800 ? '…' : ''}</pre>`
}

export function formatApprovalContext(toolInput: unknown, cwd = process.cwd()): string {
  const inp = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {}
  const workdir = [inp.workdir, inp.cwd].find(p => typeof p === 'string' && p.trim())
  // ponytail: execution cwd only; do not evaluate arbitrary shell targets or variables.
  const directory = typeof workdir === 'string' ? resolve(cwd, workdir) : cwd
  const git = (...args: string[]) => {
    try {
      const r = spawnSync('git', ['-C', directory, ...args], {
        encoding: 'utf8', timeout: 1000, windowsHide: true,
      })
      return r.status === 0 ? r.stdout.trim() : ''
    } catch { return '' }
  }
  const root = git('rev-parse', '--show-toplevel')
  let branch = root ? git('symbolic-ref', '--quiet', '--short', 'HEAD') : ''
  if (root && !branch) {
    const sha = git('rev-parse', '--verify', '--short', 'HEAD')
    if (sha) branch = `detached HEAD (${sha})`
  }
  return `Repository: <code>${htmlEscape(root ? basename(root) : 'unavailable')}</code>\n` +
    `Branch: <code>${htmlEscape(branch || 'unavailable')}</code>`
}

export function buildAllowRule(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return toolName
  const inp = toolInput as Record<string, unknown>

  if (toolName === 'Bash' && typeof inp.command === 'string') {
    const tokens = inp.command.trim().split(/\s+/)
    const first = tokens[0] || ''
    if (!first) return toolName
    const second = tokens[1] || ''
    const secondIsSubcommand = /^[a-zA-Z0-9_-]+$/.test(second) && !second.startsWith('-')
    const prefix = secondIsSubcommand ? `${first} ${second}` : first
    return `${toolName}(${prefix}:*)`
  }

  if (toolName === 'WebFetch' && typeof inp.url === 'string') {
    try {
      const u = new URL(inp.url)
      return `${toolName}(domain:${u.host})`
    } catch { return toolName }
  }

  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && typeof inp.file_path === 'string') {
    const dir = pathPosix.dirname(inp.file_path.replace(/\\/g, '/'))
    return `${toolName}(${dir}/**)`
  }

  return toolName
}

export function persistAllowRule(toolName: string, toolInput: unknown): void {
  const rule = buildAllowRule(toolName, toolInput)
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  try {
    let s: { permissions?: { allow?: string[] } } = {}
    try { s = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch {}
    s.permissions ||= {}
    s.permissions.allow ||= []
    if (!s.permissions.allow.includes(rule)) {
      s.permissions.allow.push(rule)
      writeFileSync(settingsPath, JSON.stringify(s, null, 2))
      log(`PolyDaemon: persisted always-allow rule: ${rule}`)
    }
  } catch (e) {
    log(`PolyDaemon: failed to persist always-allow rule: ${e}`)
  }
}
