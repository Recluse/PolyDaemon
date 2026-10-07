import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readRegistry, rowIsStale } from './registry.ts'
import { debug, log } from './log.ts'

// ---------------------------------------------------------------------------
// Claude Code JSONL transcripts — reader + tailer.
//
// Claude Code writes one .jsonl per session under
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, where <encoded-cwd>
// is the cwd with every non-alphanumeric character replaced by '-' (verified
// against live dirs: /Users/me/Work/my-project →
// -Users-me-Work-my-project).
//
// The format is UNDOCUMENTED — the parser is tolerant: unknown record types
// and unknown content blocks are debug-logged (once per type) and skipped,
// never thrown on.
// ---------------------------------------------------------------------------

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

export interface AgentEvent {
  window_key: string
  ts: string // ISO-8601, from the record's own timestamp
  kind: 'message' | 'thought' | 'tool_call' | 'tool_result' | 'other'
  role?: string
  text?: string
  tool?: string
  detail?: string
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function projectDir(cwd: string): string {
  return join(PROJECTS_DIR, encodeCwd(cwd))
}

/** Newest .jsonl in a project dir by mtime — the session currently being
 *  written. null if the dir doesn't exist or has no transcripts. */
export function latestJsonl(dir: string): string | null {
  try {
    let best: string | null = null
    let bestM = -1
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const p = join(dir, name)
      try {
        const m = statSync(p).mtimeMs
        if (m > bestM) { bestM = m; best = p }
      } catch {}
    }
    return best
  } catch {
    return null
  }
}

// --- Normalization ----------------------------------------------------------

const CAP_TEXT = 8000
const CAP_DETAIL = 2000
const seenUnknown = new Set<string>()

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s
}

function skipOnce(what: string): void {
  if (seenUnknown.has(what)) return
  seenUnknown.add(what)
  debug(`transcript: skipping unhandled ${what}`)
}

/** Flatten a tool_result content field (string | [{type:'text',text}...]). */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && (b as any).type === 'text' ? String((b as any).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** One JSONL line → zero or more normalized events. Tolerant: anything
 *  unparseable or unrecognized yields [] (debug-logged once per shape). */
export function normalizeLine(line: string, windowKey: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let rec: any
  try { rec = JSON.parse(trimmed) } catch { skipOnce('unparseable line'); return [] }
  if (!rec || typeof rec !== 'object') return []

  const type = String(rec.type ?? '')
  if (type !== 'assistant' && type !== 'user') {
    // system / attachment / queue-operation / file-history-snapshot / … —
    // not part of the conversation; skip quietly.
    skipOnce(`record type "${type || '<none>'}"`)
    return []
  }

  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : new Date().toISOString()
  const base = { window_key: windowKey, ts }
  const msg = rec.message
  const events: AgentEvent[] = []

  if (type === 'user' && typeof msg?.content === 'string') {
    if (msg.content) events.push({ ...base, kind: 'message', role: 'user', text: cap(msg.content, CAP_TEXT) })
    return events
  }

  const blocks = Array.isArray(msg?.content) ? msg.content : []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    switch (b.type) {
      case 'text': {
        const text = String(b.text ?? '')
        if (text) events.push({ ...base, kind: 'message', role: type, text: cap(text, CAP_TEXT) })
        break
      }
      case 'thinking': {
        // Empty thinking blocks (signature-only) are noise — skip.
        const text = String(b.thinking ?? '')
        if (text) events.push({ ...base, kind: 'thought', role: 'assistant', text: cap(text, CAP_TEXT) })
        break
      }
      case 'tool_use':
        events.push({
          ...base, kind: 'tool_call', role: 'assistant', tool: String(b.name ?? ''),
          detail: cap(safeJson(b.input), CAP_DETAIL),
        })
        break
      case 'tool_result':
        events.push({
          ...base, kind: 'tool_result', role: 'user',
          text: cap(flattenContent(b.content), CAP_TEXT),
          detail: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
        })
        break
      default:
        skipOnce(`content block "${String(b.type)}"`)
        events.push({ ...base, kind: 'other', role: type, detail: String(b.type ?? '') })
    }
  }
  return events
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? '' } catch { return '[unserializable]' }
}

// --- History (GET /v1/windows/{key}/transcript) ------------------------------

/** Read the newest transcript of a cwd, normalized, filtered to ts > since,
 *  first `limit` events. sinceMs ≤ 0 = from the beginning. */
export function readTranscript(
  windowKey: string,
  cwd: string,
  sinceMs: number,
  limit: number,
): { file: string | null; events: AgentEvent[] } {
  const file = latestJsonl(projectDir(cwd))
  if (!file) return { file: null, events: [] }
  const events: AgentEvent[] = []
  // Transcripts reach hundreds of MB only in pathological cases; v0 reads the
  // whole file. TODO: byte-offset index for very large sessions.
  const content = readFileSync(file, 'utf8')
  for (const line of content.split('\n')) {
    for (const ev of normalizeLine(line, windowKey)) {
      if (sinceMs > 0) {
        const t = Date.parse(ev.ts)
        if (Number.isFinite(t) && t <= sinceMs) continue
      }
      events.push(ev)
      if (events.length >= limit) return { file, events }
    }
  }
  return { file, events }
}

// --- Live tail (WS /v1/events) -----------------------------------------------

interface TailState {
  key: string
  cwd: string
  dir: string
  file: string | null
  offset: number // byte position already consumed
  partial: string // trailing half-line from the previous read
  watcher: FSWatcher | null
}

const POLL_MS = 1000
const REFRESH_EVERY_TICKS = 10 // re-read the registry every ~10s
const MAX_CHUNK = 4 * 1024 * 1024

/**
 * Tails the newest transcript of every live registered window and fans
 * normalized events out to subscribers. Runs only while subscribers exist.
 * fs.watch on each project dir gives low latency; a 1s poll is the fallback
 * (fs.watch on macOS occasionally misses writes; both paths are idempotent —
 * reads are guarded by the stored byte offset).
 */
export class TranscriptTailer {
  private subs = new Set<(ev: AgentEvent) => void>()
  private states = new Map<string, TailState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tick = 0

  subscribe(sink: (ev: AgentEvent) => void): void {
    this.subs.add(sink)
    if (this.subs.size === 1) this.start()
  }

  unsubscribe(sink: (ev: AgentEvent) => void): void {
    this.subs.delete(sink)
    if (this.subs.size === 0) this.stop()
  }

  get subscriberCount(): number { return this.subs.size }

  private start(): void {
    this.refreshWindows()
    this.timer = setInterval(() => {
      this.tick++
      if (this.tick % REFRESH_EVERY_TICKS === 0) this.refreshWindows()
      for (const st of this.states.values()) this.check(st)
    }, POLL_MS)
    log(`tail: started (${this.states.size} windows)`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    for (const st of this.states.values()) st.watcher?.close()
    this.states.clear()
    log('tail: stopped (no subscribers)')
  }

  private refreshWindows(): void {
    const now = Date.now() / 1000
    const live = new Map<string, string>() // key → cwd
    for (const row of Object.values(readRegistry())) {
      if (rowIsStale(row, now)) continue
      const key = row.instance_name || row.workspace_name
      if (key && row.cwd) live.set(key, row.cwd)
    }
    // Drop windows that left the registry.
    for (const [key, st] of this.states) {
      if (!live.has(key)) {
        st.watcher?.close()
        this.states.delete(key)
        debug(`tail: window ${key} gone`)
      }
    }
    // Add newcomers — start at EOF so subscribers only see NEW events.
    for (const [key, cwd] of live) {
      if (this.states.has(key)) continue
      const dir = projectDir(cwd)
      const file = latestJsonl(dir)
      const st: TailState = {
        key, cwd, dir, file,
        offset: file ? safeSize(file) : 0,
        partial: '',
        watcher: null,
      }
      try {
        if (existsSync(dir)) st.watcher = watch(dir, () => this.check(st))
      } catch (e) {
        debug(`tail: fs.watch failed for ${dir}: ${e}`) // poll still covers it
      }
      this.states.set(key, st)
      debug(`tail: watching ${key} → ${file ?? '(no transcript yet)'}`)
    }
  }

  private check(st: TailState): void {
    try {
      const newest = latestJsonl(st.dir)
      if (!newest) return
      if (newest !== st.file) {
        // New session file: stream it from the start — all content is new.
        st.file = newest
        st.offset = 0
        st.partial = ''
        debug(`tail: ${st.key} switched to ${newest}`)
      }
      const size = safeSize(st.file)
      if (size < st.offset) { st.offset = 0; st.partial = '' } // truncated/rewritten
      if (size === st.offset) return

      const want = Math.min(size - st.offset, MAX_CHUNK)
      const buf = Buffer.alloc(want)
      const fd = openSync(st.file, 'r')
      let got = 0
      try { got = readSync(fd, buf, 0, want, st.offset) } finally { closeSync(fd) }
      if (got <= 0) return
      st.offset += got

      const chunk = st.partial + buf.toString('utf8', 0, got)
      const lines = chunk.split('\n')
      st.partial = lines.pop() ?? '' // last element = incomplete tail
      for (const line of lines) {
        for (const ev of normalizeLine(line, st.key)) this.broadcast(ev)
      }
    } catch (e) {
      debug(`tail: check failed for ${st.key}: ${e}`)
    }
  }

  private broadcast(ev: AgentEvent): void {
    for (const sink of this.subs) {
      try { sink(ev) } catch {}
    }
  }
}

function safeSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}
