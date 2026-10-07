#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook — posts a short tool-call summary to the local
 * channel-plugin so it can edit the user's "⏳ Работаю..." status message in
 * Telegram. Must finish fast (timeouts hard) and must never block Claude.
 *
 * Stdin is the Claude hook event JSON; we route by `cwd` against the `instances`
 * table in the shared ~/.tg-copilot-bridge/bot.db that the channel-plugin writes.
 */

import { Database } from 'bun:sqlite'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// No VS Code-specific gate here — `findInstance` below does the right thing
// either way: it locates THIS claude's plugin by the cwd row in the LOCAL
// registry (~/.tg-bridge-channel/instances.json, written by every plugin for
// its co-located hooks), falling back to the shared bot.db. Returns null when
// no plugin is registered for the cwd → we quietly skip the progress POST.
// Standalone claude → null → no-op. The local JSON is the only source on a
// roaming device (a remote plugin never writes bot.db).

const LOCAL_REGISTRY_PATH = join(homedir(), '.tg-bridge-channel', 'instances.json')
const DB_PATH = join(homedir(), '.tg-copilot-bridge', 'bot.db')
const POST_TIMEOUT_MS = 800

type RegEntry = { host: string; port: number; auth_token: string; cwd: string }

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function buildSummary(toolName: string, inp: Record<string, unknown>): string {
  if (!toolName) return ''
  // Skip our own bridge tools — they're the noisy "send to TG" actions and
  // would just spam the status message we're updating.
  if (toolName.startsWith('mcp__tg-bridge__')) return ''
  if (toolName === 'BashOutput' || toolName === 'KillShell') return ''

  if (toolName === 'Bash' && typeof inp.command === 'string') {
    return `Bash: ${trunc(inp.command.replace(/\s+/g, ' '), 80)}`
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read' || toolName === 'NotebookEdit') {
    const fp = editedPath(inp)
    if (fp) return `${toolName} ${basename(fp)}`
  }
  if (toolName === 'Grep' && typeof inp.pattern === 'string') {
    return `Grep "${trunc(String(inp.pattern), 50)}"`
  }
  if (toolName === 'Glob' && typeof inp.pattern === 'string') {
    return `Glob ${trunc(String(inp.pattern), 60)}`
  }
  if (toolName === 'WebFetch' && typeof inp.url === 'string') {
    return `WebFetch ${trunc(String(inp.url), 80)}`
  }
  if (toolName === 'WebSearch' && typeof inp.query === 'string') {
    return `WebSearch "${trunc(String(inp.query), 60)}"`
  }
  if (toolName === 'Task' && typeof inp.description === 'string') {
    return `Task: ${trunc(String(inp.description), 70)}`
  }
  if (toolName === 'Skill' && typeof inp.skill === 'string') {
    return `Skill: ${String(inp.skill)}`
  }
  return toolName
}

// Bot reaps stale rows when heartbeat is older than 45s (see bridge/registry.py
// HEARTBEAT_FRESH_SECONDS). Within that window the row is still in the table
// but the window may already be dead — sending /progress to it then either
// errors on a closed port or lands on a recycled port belonging to another
// process. Match the bot's freshness threshold so a hung-but-not-yet-reaped
// row can't steal another window's tool-call progress.
const HEARTBEAT_FRESH_SECONDS = 45

type Row = {
  host?: unknown; port?: unknown; auth_token?: unknown; cwd?: unknown
  parent_pid?: unknown; window_uid?: unknown
}

function toEntry(p: Row): RegEntry | null {
  if (typeof p.port !== 'number') return null
  return {
    host: String(p.host ?? '127.0.0.1'),
    port: p.port,
    auth_token: String(p.auth_token ?? ''),
    cwd: String(p.cwd ?? ''),
  }
}

// This hook's ancestry, nearest first — one of these is its agent process.
//
// claude spawns BOTH the plugin and this hook, so the plugin's recorded
// parent_pid is the same agent pid this hook descends from.
//
// Our direct ppid is NOT that agent: claude runs hook commands through a shell.
// The proof is other people's hook configuration rather than our own — a command
// like `AGENTMEM_REPO=infra python3 ...` starts with a variable assignment, which
// is shell syntax and would fail outright on a direct exec, yet those hooks run.
// Measured here: bun <- zsh -c <- claude, one shell in between. So the walk is
// the normal path, not a fallback, and an earlier version of this code claimed a
// free fast path that in fact never hit.
//
// Cost measured on this machine: 1.2 ms per `ps`, against the hook's 3 s budget.
// Three levels is slack for a deeper wrapper.
//
// The walk takes the candidate pids so it can STOP at the first match. An
// earlier version built the whole chain first and compared afterwards, which
// spent a `ps` per level every time and threw the last one away unused — and its
// comment claimed the early exit it did not have. That is the second time in
// this file a comment promised a cheap path the code never took, which is why
// the loop now holds the thing it is searching for.
const MAX_ANCESTRY = 3
const PS_TIMEOUT_MS = 1000

// `known` is EVERY pid some row claims as its agent — including the ambiguous
// ones the caller refuses to resolve. That distinction is the whole point: the
// walk must stop at the NEAREST agent it meets and hand that pid back, even when
// the caller will then decline to act on it.
//
// Climbing past an ambiguous pid is not a harmless retry. Agents nest here — one
// window's Bash tool starts another claude — so the next pid up can be a
// DIFFERENT window's agent, and answering with it means this window's progress
// edits that window's status message. "I cannot tell which window this is" has to
// end in silence, not in a confident wrong answer one level up.
function findAncestorIn(known: Set<number>): number | null {
  let pid = process.ppid
  for (let i = 0; i < MAX_ANCESTRY && Number.isFinite(pid) && pid > 1; i++) {
    if (known.has(pid)) return pid      // costs nothing on the level that matches
    try {
      // Hard timeout: this runs inside the tool call's own latency. A wedged
      // `ps` must degrade to "unknown window" (no post), never hold up an edit.
      const out = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)],
                            { encoding: 'utf8', timeout: PS_TIMEOUT_MS })
      pid = Number((out.stdout || '').trim())
    } catch {
      return null   // no `ps` (Windows) → we cannot climb, fall back to cwd
    }
  }
  return null
}

/** A row whose agent is gone: launchd adopted the plugin (pid 1), or the row
 *  names a pid that no longer exists — which happens between the agent's death
 *  and the plugin's next beat, and indefinitely for a plugin old enough not to
 *  re-stamp parent_pid at all (heartbeatLocal only started doing that today).
 *  Either way it is not a live window, so check the pid rather than trust it. */
function hasLiveAgent(p: Row): boolean {
  const pp = Number(p.parent_pid)
  if (!Number.isFinite(pp) || pp <= 1) return false
  try { process.kill(pp, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

// Which registry row is OUR window?
//
// cwd is NOT unique: the same folder can be open in two live windows at once —
// measured 2026-09-18 with one folder open both in a terminal claude and in Zed's
// external agent, and seven live rows on one Codex folder. The old code took the
// first cwd match ordered by heartbeat freshness, so a tool call was attributed
// to whichever of them had reported most recently, and progress from one window
// edited the other window's status message. Invisible in practice because both
// rows carry the same workspace_name.
//
// So: match on the agent process first, which is exact. Fall back to cwd only
// when exactly ONE live row has it — with several, posting to a guess is worse
// than posting nothing, since the wrong window's message gets rewritten.
// Tools that WRITE. MultiEdit carries file_path too; Bash does not, and cannot.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The file a tool call targets. NotebookEdit does not use `file_path` — its
 *  parameter is `notebook_path` — so listing it above without reading that field
 *  meant notebook edits were silently exempt from the whole overlap check. */
function editedPath(inp: Record<string, unknown>): string {
  const fp = inp.file_path ?? inp.notebook_path
  return typeof fp === 'string' ? fp : ''
}

function pick(rows: Row[], norm: string): RegEntry | null {
  // FIRST KEY: the window uid the launcher minted and every hook inherited.
  // Exact, costs one string comparison, needs no process at all, and works on
  // Windows where there is no `ps` to climb with. Absent for a window the
  // launcher did not start — Zed's external agent starts claude itself — so the
  // ancestry walk below stays as the second key rather than being replaced.
  const uid = (process.env.TG_WINDOW_UID ?? '').trim()
  if (uid) {
    const byUid = rows.filter((p) => typeof p.window_uid === 'string' && p.window_uid === uid)
    // Still refuse to guess: a uid is supposed to be unique, and if two rows
    // claim it something is wrong enough that picking one would be inventing an
    // answer.
    // The orphan rule applies here too. It is stated three times in this
    // function and this was the one place that did not enforce it — and a rule
    // with a hole in it is the rule the reader trusts and the code does not keep.
    if (byUid.length === 1 && hasLiveAgent(byUid[0])) {
      const hit = toEntry(byUid[0])
      if (hit) return hit
    }
  }

  // Index by agent pid, but refuse two kinds of row.
  //
  // pid 1 is an ORPHAN: the agent died and launchd adopted its plugin, which
  // keeps heartbeating and so still looks alive. Five such rows were live on this
  // machine while this was written. They must never match anything — and until
  // now they only failed to by accident, because the walk happens to stop at
  // pid > 1.
  //
  // A pid claimed by more than one row is ambiguous, and the rule here is the
  // same one already applied to cwd: when we cannot tell which window it is,
  // choose none. Silently taking the first is how the original bug worked.
  const byPid = new Map<number, Row>()
  const claimed = new Set<number>()   // every agent pid any row names
  const ambiguous = new Set<number>()
  for (const p of rows) {
    if (!hasLiveAgent(p)) continue
    const pp = Number(p.parent_pid)
    claimed.add(pp)
    if (byPid.has(pp)) ambiguous.add(pp)
    else byPid.set(pp, p)
  }
  for (const pp of ambiguous) byPid.delete(pp)
  // Search against every CLAIMED pid, resolve against the unambiguous ones. An
  // ambiguous hit therefore stops the walk and yields nothing, instead of
  // letting it climb into the next agent up the process tree.
  const agent = findAncestorIn(claimed)
  if (agent !== null) {
    const row = byPid.get(agent)
    if (!row) return null            // ambiguous: our own window, unidentifiable
    const hit = toEntry(row)
    if (hit) return hit
  }
  const byCwd = rows.filter((p) => {
    // Orphans are excluded HERE TOO. The index above refuses them, but this
    // fallback used to look only at cwd and port, so a folder holding exactly
    // one row would happily resolve to a dead window's plugin — defeating, in
    // the same function, the rule stated a few lines up. Reachable whenever an
    // agent's own plugin failed to register and a leftover orphan sits in that
    // folder alone.
    if (!hasLiveAgent(p)) return false
    const entryCwd = typeof p.cwd === 'string' ? p.cwd.replace(/\\/g, '/').toLowerCase() : ''
    return entryCwd !== '' && entryCwd === norm && typeof p.port === 'number'
  })
  return byCwd.length === 1 ? toEntry(byCwd[0]) : null
}

function findInstance(cwd: string): RegEntry | null {
  const norm = cwd.replace(/\\/g, '/').toLowerCase()
  const minHeartbeat = Date.now() / 1000 - HEARTBEAT_FRESH_SECONDS

  // Primary: local JSON registry (the only source on a roaming device).
  try {
    const map = JSON.parse(readFileSync(LOCAL_REGISTRY_PATH, 'utf8')) as Record<string, any>
    if (map && typeof map === 'object') {
      const rows = Object.values(map)
        .filter((r: any) => r && Number(r.heartbeat_at) > minHeartbeat)
        .sort((a: any, b: any) => Number(b.heartbeat_at) - Number(a.heartbeat_at))
      const hit = pick(rows as any, norm)
      if (hit) return hit
    }
  } catch { /* missing/unparsable → fall back to bot.db */ }

  // Fallback: shared bot.db (same-machine, older plugins). Read-only so we never
  // create the file or take a write lock.
  let db: Database | null = null
  try {
    db = new Database(DB_PATH, { readonly: true })
    const rows = db.query(
      'SELECT host, port, auth_token, cwd, parent_pid FROM instances WHERE heartbeat_at > ? ORDER BY heartbeat_at DESC',
    ).all(minHeartbeat) as Array<{ host: string; port: number; auth_token: string; cwd: string; parent_pid: number }>
    return pick(rows, norm)
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

// Pull the model's latest narration prose (the readable text it writes between
// tool calls) from the tail of the transcript. The real extended-thinking blocks
// are signature-only/empty in the transcript, so this assistant `text` is the
// closest "thinking out loud" we can surface. Reads only the last 64KB so a huge
// transcript can't blow the hook's time budget; all failures degrade to ''.
const TRANSCRIPT_TAIL_BYTES = 64 * 1024
const NARRATION_MAX = 280

async function readLatestNarration(transcriptPath: string): Promise<string> {
  if (!transcriptPath) return ''
  try {
    const file = Bun.file(transcriptPath)
    const size = file.size
    if (!size) return ''
    const slice = file.slice(Math.max(0, size - TRANSCRIPT_TAIL_BYTES))
    const buf = await slice.text()
    const lines = buf.split('\n')
    // Drop the first line if we started mid-file — it's a partial record.
    if (size > TRANSCRIPT_TAIL_BYTES && lines.length) lines.shift()
    // Walk from the end for the most recent assistant text block — BUT stop at the
    // current turn's user prompt. Otherwise, when this turn opened straight with a
    // tool call (no preamble prose yet), the most recent text block is still the
    // PREVIOUS turn's final answer, and it leaks in as this turn's "💭 thinking".
    // Note: tool_result records are ALSO type 'user', so only a NON-tool_result
    // user record is the real turn boundary; tool_results are walked past.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      let rec: { type?: string; message?: { content?: unknown } }
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type === 'user') {
        const c = rec.message?.content
        const isToolResult = Array.isArray(c) && c.some(
          (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
        )
        if (!isToolResult) return ''   // reached this turn's prompt → no narration yet
        continue                        // tool_result → still inside the current turn
      }
      if (rec.type !== 'assistant') continue
      const content = rec.message?.content
      if (!Array.isArray(content)) continue
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j] as { type?: string; text?: unknown }
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          // Collapse to a single status line.
          const oneLine = b.text.trim().replace(/\s+/g, ' ')
          return oneLine.length > NARRATION_MAX ? oneLine.slice(0, NARRATION_MAX - 1) + '…' : oneLine
        }
      }
    }
    return ''
  } catch {
    return ''
  }
}

async function main(): Promise<void> {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let event: { cwd?: string; tool_name?: string; tool_input?: unknown; transcript_path?: string }
  try { event = JSON.parse(raw) } catch { return }

  const cwd = typeof event.cwd === 'string' ? event.cwd : ''
  const toolName = typeof event.tool_name === 'string' ? event.tool_name : ''
  const toolInput = (event.tool_input && typeof event.tool_input === 'object')
    ? event.tool_input as Record<string, unknown>
    : {}
  if (!cwd || !toolName) return

  const summary = buildSummary(toolName, toolInput)
  const narration = await readLatestNarration(
    typeof event.transcript_path === 'string' ? event.transcript_path : '',
  )
  // Nothing to show (skipped tool AND no narration) → don't even look up the
  // instance. Narration alone is reason enough to post (it shows the model's
  // prose even ahead of a bridge tool whose own summary we suppress).
  if (!summary && !narration) return

  const instance = findInstance(cwd)
  if (!instance) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    const res = await fetch(`http://${instance.host}:${instance.port}/progress`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${instance.auth_token}`,
        'Content-Type': 'application/json',
      },
      // file_path rides along for the EDITING tools only. The plugin keeps a
      // short list of what this window is touching, so another window can be
      // told before it edits the same file. Read/Grep/Bash deliberately do not
      // report: a read is not a claim, and a Bash command's target cannot be
      // known from its text (see the note in plan/active/board/40-*.md).
      body: JSON.stringify({
        event: 'pre_tool', tool_name: toolName, summary, narration,
        file_path: EDIT_TOOLS.has(toolName) ? (editedPath(toolInput) || undefined) : undefined,
      }),
      signal: controller.signal,
    })
    // The plugin answers with `warn` when another window has this file open.
    // Handed to the model as context, never as a refusal: the decision is the
    // person's, and the same text is already on its way to them in the topic.
    if (res.ok) {
      const data = await res.json().catch(() => null) as { warn?: unknown } | null
      const warn = typeof data?.warn === 'string' ? data.warn.trim() : ''
      if (warn) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warn },
        }))
      }
    }
  } catch {
    // Best-effort: never fail the tool call because the status edit didn't go through.
  } finally {
    clearTimeout(timer)
  }
}

// ── Self-check: `bun hooks/pre-tool-use.ts --self-check` ────────────────────
// pick() decides WHOSE status message a tool call edits. Every bug it has had
// was the same shape — answering confidently for the wrong window — so the
// checks below are all about it refusing to answer.
function selfCheck(): void {
  const ok = (cond: unknown, msg: string) => { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1) } }
  const CWD = '/tmp/self-check-cwd'
  const row = (over: Partial<Row>): Row =>
    ({ host: '127.0.0.1', port: 3100, auth_token: 't', cwd: CWD, parent_pid: process.ppid, ...over })

  // Our own ancestry, so a row can be made to claim a real agent pid.
  const parent = process.ppid
  const grandparent = Number(
    (spawnSync('ps', ['-o', 'ppid=', '-p', String(parent)], { encoding: 'utf8' }).stdout || '').trim(),
  )

  const uid = 'uid-for-self-check'
  process.env.TG_WINDOW_UID = uid
  ok(pick([row({ window_uid: uid, parent_pid: 1 })], CWD) === null,
     'uid must not resolve to an orphan (agent dead, launchd holds the plugin)')
  ok(pick([row({ window_uid: uid })], CWD)?.port === 3100, 'uid on a live row must resolve')
  ok(pick([row({ window_uid: uid, port: 3100 }), row({ window_uid: uid, port: 3101 })], CWD) === null,
     'a duplicated uid is a broken state, not a coin toss')
  delete process.env.TG_WINDOW_UID

  // THE regression: our nearest agent is claimed by two rows. Answering is
  // impossible; climbing one level up and answering for the agent that STARTED
  // ours is worse than silence.
  if (grandparent > 1) {
    const rows = [row({ port: 3100 }), row({ port: 3101 }), row({ port: 3102, parent_pid: grandparent })]
    ok(pick(rows, CWD) === null, 'ambiguous nearest agent must not fall through to the next agent up')
  }

  ok(pick([row({ parent_pid: 1 })], CWD) === null, 'orphan-only cwd must not resolve')
  ok(pick([row({ cwd: '/elsewhere', parent_pid: 1 }), row({ parent_pid: 1 })], CWD) === null,
     'cwd fallback must skip orphans')
  // Two live rows on one folder is the normal case here (terminal + Zed), and
  // the cwd fallback has no way to tell them apart. Use a pid that is alive but
  // NOT in our ancestry, so the walk cannot resolve it for us.
  if (grandparent > 1) {
    const twoLive = [row({ port: 3100, parent_pid: grandparent }), row({ port: 3101, parent_pid: grandparent })]
    ok(pick(twoLive, CWD) === null, 'two rows, one folder → no guess')
  }

  ok(editedPath({ notebook_path: '/a.ipynb' }) === '/a.ipynb', 'NotebookEdit reports notebook_path')
  ok(editedPath({ file_path: '/a.ts' }) === '/a.ts', 'editing tools report file_path')
  ok(editedPath({}) === '', 'no path → no claim')
  console.log('pre-tool-use self-check OK')
}

if (process.argv[2] === '--self-check') selfCheck()
else await main()
