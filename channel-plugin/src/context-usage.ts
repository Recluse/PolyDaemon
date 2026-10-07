import { readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Estimate how much of the context window a window's session is using, read from
// its own claude transcript. The Python bot runs on another host and can't see
// these files, but this plugin is co-located with its claude, so it computes the
// number locally and the bot fetches it via GET /context.
//
// claude records per-assistant-turn token accounting in message.usage. The tokens
// that occupy the context window for a turn are the INPUT side:
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (output_tokens are the reply, not context). The newest assistant turn's input
// total ≈ the current context occupancy. Transcripts live at
// ~/.claude/projects/<cwd with / : \ -> ->/<id>.jsonl.

const TAIL_BYTES = 512 * 1024

// The window size isn't recorded in the transcript (1M is a beta header, not part
// of the model id), so we can't read it — the caller decides how to present a %.
//
// `idleS` is seconds since the newest RECORD TIMESTAMP, not since the file's
// mtime: transcripts get their mtime bumped without gaining a record (observed
// 2026-09-10 on an Infra window idle since the previous evening whose file had
// been touched 40 minutes earlier), so mtime reads as "busy" for a window that
// has not had a turn in a day. The record timestamp is the only honest signal.
export type ContextUsage = { used: number; model: string; idleS: number | null } | null

function projectDir(): string {
  const enc = process.cwd().replace(/[/:\\]/g, '-')
  return join(homedir(), '.claude', 'projects', enc)
}

function newestTranscript(dir: string): string | null {
  let newest: string | null = null
  let newestMtime = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const fp = join(dir, name)
      try {
        const m = statSync(fp).mtimeMs
        if (m > newestMtime) { newestMtime = m; newest = fp }
      } catch {}
    }
  } catch { return null }
  return newest
}

function readTail(fp: string, bytes: number): string {
  const fd = openSync(fp, 'r')
  try {
    const size = fstatSync(fd).size
    if (!size) return ''
    const start = Math.max(0, size - bytes)
    const len = size - start
    const b = Buffer.allocUnsafe(len)
    const read = readSync(fd, b, 0, len, start)
    return b.toString('utf8', 0, read)
  } finally { closeSync(fd) }
}

const TS_RE = /"timestamp":"([^"]+)"/

export function contextUsage(): ContextUsage {
  const dir = projectDir()
  const fp = newestTranscript(dir)
  if (!fp) return null
  let tail: string
  try { tail = readTail(fp, TAIL_BYTES) } catch { return null }
  if (!tail) return null
  const lines = tail.split('\n')
  let idleS: number | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    // Newest timestamp wins. The regex is only a cheap pre-filter to skip lines
    // that have no timestamp at all; the value MUST come from the parsed record's
    // own top-level field. A tool call whose input carries its own `timestamp`
    // puts a second one on the line, and reading the regex match would then take
    // an argument's date for the record's — silently reporting a busy window as
    // idle. (In the current corpus the record's own field happens to serialize
    // first — 1006 multi-timestamp lines out of 104k, none misordered — but that
    // is JSON key order, which nothing guarantees.) Only the first line from the
    // end that actually parses costs a parse, so this is ~1 parse per call.
    if (idleS === null && TS_RE.test(line)) {
      let stamped: any
      try { stamped = JSON.parse(line) } catch { stamped = null }
      const ts = stamped && typeof stamped.timestamp === 'string' ? stamped.timestamp : ''
      const t = ts ? Date.parse(ts) : NaN
      if (!Number.isNaN(t)) idleS = Math.max(0, Math.round((Date.now() - t) / 1000))
    }
    if (line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }
    const u = rec?.message?.usage
    if (rec?.type === 'assistant' && u && typeof u === 'object') {
      const used = (Number(u.input_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0)
        + (Number(u.cache_creation_input_tokens) || 0)
      if (used > 0) return { used, model: String(rec.message.model || ''), idleS }
    }
  }
  return null
}
