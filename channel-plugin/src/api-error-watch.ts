import { readdirSync, statSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Catch API problems that strand a window. Two shapes, both invisible otherwise
// (no Stop/Notification hook fires on either):
//   • SURFACED error — a turn died and claude wrote an assistant record with
//     `isApiErrorMessage: true` (rate limit / 529 / 500 / auth / final "unable to
//     connect"). The window just stops on "⏳ Работаю...".
//   • CONNECTING — the API is unreachable (provider/VPN dropped; Telegram still
//     works) and claude is mid-retry, logging `type:"system" subtype:"api_error"`
//     records ("Unable to connect to API (ECONNRESET/FailedToOpenSocket/…)") with
//     NO assistant response yet. The window looks busy but is going nowhere.
//
// claude stores transcripts at ~/.claude/projects/<cwd with / : \ -> ->/<id>.jsonl.

const TAIL_BYTES = 48 * 1024

// Any connection-class problem → a STABLE key, so a minutes-long outage (many
// distinct retry records, each later surfacing as an assistant error) is reported
// once per episode, not every poll.
const CONN_RE =
  /Unable to connect|FailedToOpenSocket|ConnectionRefused|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket connection was closed|Connection error|Connection closed|Stream idle timeout/i

// Context-overflow: the session grew past the model's input limit. This is NOT
// transient (retrying re-sends the same over-limit context and fails identically),
// so it needs its own actionable message — compact/clear, not "retry when it lets
// up". Matches Anthropic's "prompt is too long" (invalid_request) and kin.
const OVERFLOW_RE =
  /prompt is too long|input is too long|too many tokens|maximum.*(context|tokens)|context (length|window|limit)|exceeds? the (maximum|context)/i

export type ApiProblem = {
  kind: 'surfaced' | 'connecting' | 'overflow'
  text: string
  status?: number
  errKind?: string
  key: string // 'conn'/'overflow' for episodic problems (one message per episode), else the record uuid
}

function projectDir(): string {
  // Claude Code names the folder after the REAL path (a junction or symlink is
  // resolved) with every non-alphanumeric character turned into '-'. Replacing
  // only / : \ missed '_', '.' and spaces, so for a folder like sample_project-1
  // this looked in a directory that does not exist and never saw an error.
  let cwd = process.cwd()
  try { cwd = realpathSync.native(cwd) } catch {}
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

/** mtime of this window's newest transcript, 0 when there is none. */
export function transcriptMtime(): number {
  const fp = newestTranscript(projectDir())
  try { return fp ? statSync(fp).mtimeMs : 0 } catch { return 0 }
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

// Inspect the latest meaningful record in this window's transcript. Returns a
// problem only if the CURRENT state is bad — a later successful assistant response
// clears it (returns null). dedup/hysteresis is the caller's job (compare .key).
export function checkApiError(): ApiProblem | null {
  const fp = newestTranscript(projectDir())
  if (!fp) return null
  let tail: string
  try { tail = readTail(fp, TAIL_BYTES) } catch { return null }
  if (!tail) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    // Cheap pre-filter: only assistant / system-api_error / user records matter.
    if (line.indexOf('"assistant"') === -1 && line.indexOf('"api_error"') === -1 && line.indexOf('"user"') === -1) continue
    let rec: any
    try { rec = JSON.parse(line) } catch { continue }

    if (rec?.type === 'assistant') {
      if (!rec.isApiErrorMessage) return null // last turn produced a real response
      const content = rec.message?.content
      let text = ''
      if (Array.isArray(content)) {
        const t = content.find((b: any) => b?.type === 'text' && typeof b.text === 'string')
        text = t?.text ?? ''
      }
      text = text || 'API error'
      const isConn = CONN_RE.test(text)
      const isOverflow = !isConn && OVERFLOW_RE.test(text)
      return {
        kind: isConn ? 'surfaced' : isOverflow ? 'overflow' : 'surfaced',
        text,
        status: typeof rec.apiErrorStatus === 'number' ? rec.apiErrorStatus : undefined,
        errKind: typeof rec.error === 'string' ? rec.error : undefined,
        // Overflow keeps re-firing on every retry (new record uuid each turn), so
        // collapse it to one episodic key like 'conn' — report once until recovered.
        key: isConn ? 'conn' : isOverflow ? 'overflow' : String(rec.uuid ?? text),
      }
    }

    if (rec?.type === 'system' && rec.subtype === 'api_error') {
      const e = rec.error || {}
      const text = String(e.formatted || e.connection?.message || e.message || 'Unable to connect to API')
      return { kind: 'connecting', text, errKind: e.connection?.code, key: 'conn' }
    }

    if (rec?.type === 'user') {
      // A real prompt ends the search (claude is working normally); a tool_result
      // (also type:user, no text block) is mid-turn — keep walking past it.
      const c = rec.message?.content
      const isPrompt = typeof c === 'string' || (Array.isArray(c) && c.some((b: any) => b?.type === 'text'))
      if (isPrompt) return null
    }
  }
  return null
}
