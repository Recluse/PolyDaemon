import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

// What THIS window is editing, so another window can be warned before it edits
// the same file.
//
// Why this exists: cwd does not tell two windows apart — the same folder is
// routinely open twice at once (a terminal claude and one inside Zed, measured
// 2026-09-18), and two windows editing one working tree overwrite each other
// silently. Git only notices at merge time, which is far too late when there is
// no branch between them.
//
// Deliberately in the PLUGIN and not in the bot: the hook that asks this question
// runs on every edit, so the answer has to be a loopback call to a co-located
// process, not a trip across the mesh.
//
// What this does NOT cover, stated here so the gap is not rediscovered as a
// surprise: writes made through Bash. The hook reports the editing tools, whose
// target path is a field it can read; a shell command's target cannot be known
// from its text without parsing the shell, and a heuristic over `>` and `sed -i`
// would catch the rare forms while missing the common one (a heredoc feeding a
// script that opens the file itself). So this is a warning about overlapping
// EDITS, not about overlapping files.

/** How long a touch stays interesting. Long enough to cover a pause for
 *  thought, short enough that yesterday's work is not still "in progress". */
export const TOUCH_TTL_MS = 30 * 60 * 1000

/** Cap on remembered paths, so a long session cannot grow this without bound. */
const MAX_PATHS = 200

const touched = new Map<string, number>()

export function noteTouched(path: string, now: number = Date.now()): void {
  const key = String(path || '').trim()
  if (!key) return
  touched.delete(key)      // re-insert so iteration order is oldest-first
  touched.set(key, now)
  while (touched.size > MAX_PATHS) {
    const oldest = touched.keys().next()
    if (oldest.done) break
    touched.delete(oldest.value)
  }
}

/** Paths this window touched recently, newest first. Expired entries are
 *  dropped as a side effect, which is the only cleanup this needs. */
export function recentTouches(now: number = Date.now()): string[] {
  const cutoff = now - TOUCH_TTL_MS
  const out: Array<[string, number]> = []
  for (const [path, at] of touched) {
    if (at < cutoff) touched.delete(path)
    else out.push([path, at])
  }
  out.sort((a, b) => b[1] - a[1])
  return out.map(([path]) => path)
}

/** Test seam. Not used in the running plugin. */
export function _reset(): void {
  touched.clear()
}


// ── What OTHER windows are editing ───────────────────────────────────────────
//
// Filled from the heartbeat response, so answering "is anyone else in this file"
// costs nothing at edit time: no network, no process, just a map lookup against
// data that is at most one beat (15 s) old. That staleness is fine for a
// question measured in minutes.

let othersByPath: Record<string, string[]> = {}
let lastAnswerAt = 0
let missedBeats = 0

export function setOthersTouching(map: Record<string, string[]> | null | undefined, now: number = Date.now()): void {
  if (!map || typeof map !== 'object') {
    // The bot answered without the field: an older bot, or something went wrong.
    // Count it rather than silently carrying on with a stale picture — a check
    // that has quietly stopped working must not look the same as a clean one.
    missedBeats += 1
    return
  }
  othersByPath = map
  lastAnswerAt = now
  missedBeats = 0
}

/** Other windows reported editing this exact path, or [] if none/unknown. */
export function othersTouching(path: string): string[] {
  const key = String(path || '').trim()
  if (!key) return []
  return othersByPath[key] ?? []
}

/** Is the answer trustworthy right now? Exposed so callers can say "unknown"
 *  instead of "clear" — the two are not the same and must never look alike. */
export function overlapHealth(now: number = Date.now()): { fresh: boolean; missedBeats: number; ageMs: number } {
  const ageMs = lastAnswerAt === 0 ? Number.POSITIVE_INFINITY : now - lastAnswerAt
  // Three beats of silence. One missed beat is ordinary jitter.
  return { fresh: lastAnswerAt !== 0 && ageMs < 45_000, missedBeats, ageMs }
}

export function _resetOthers(): void {
  othersByPath = {}
  lastAnswerAt = 0
  missedBeats = 0
}


// ── Files that several windows are SUPPOSED to share ─────────────────────────
//
// The warning is only worth having if it is rare. A handful of paths are edited
// by every window on the machine by design — the user-global agent config, the
// bridge's own state — and warning about those trains people to dismiss the
// warning that matters, which is the whole failure mode this feature exists to
// prevent.
//
// The defaults are deliberately narrow: they name places that belong to the
// MACHINE, not to any project. A file inside a working tree stays checked even
// when it is a config file, because two windows in one tree editing one file is
// exactly the collision being looked for — a repo that disagrees says so in its
// own list rather than everyone inheriting the exemption.
const DEFAULT_SHARED_GLOBS = [
  '~/.claude/**',            // hooks, CLAUDE.md, settings, transcripts
  '~/.codex/**',             // the same, for Codex windows
  '~/.tg-bridge-channel/**', // this plugin's own state
  '~/.tg-copilot-bridge/**', // the bridge's shared state
]

/** Per-repository additions, one glob per line, '#' starts a comment. A
 *  relative pattern is relative to the repo root. */
const REPO_IGNORE_FILE = '.tg-bridge-overlap-ignore'

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" spans ZERO or more directories. Zero matters: it is what lets an
        // anchored "<root>/**/build/**" still match "<root>/build/x", which is
        // the reason an earlier version left such patterns unanchored instead —
        // and unanchored is how one repo's file silenced the whole machine.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 }
        else { out += '.*'; i++ }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `normalize`, with symlinks resolved, so a pattern and a path that name the
 *  same file compare equal. Not cosmetic: on macOS /tmp IS a symlink to
 *  /private/tmp, and a working tree reached through one would silently match
 *  nothing — the allowlist would look present and do nothing, which is worse
 *  than not having it. Falls back a step at a time, because the file being
 *  edited may not exist yet (Write creates it) while its directory does. */
function normalizeReal(p: string): string {
  const raw = p.replace(/\\/g, '/')
  // Walk up to the deepest part that exists, resolve THAT, and put the rest
  // back. A single fallback level is not enough: Write creates parent
  // directories, so the path being edited can have several segments that do not
  // exist yet, and giving up on the first miss leaves the unresolved form.
  let head = raw
  const tail: string[] = []
  for (;;) {
    try { return normalize([realpathSync(head), ...tail].join('/')) } catch {}
    const cut = head.lastIndexOf('/')
    if (cut <= 0) return normalize(raw)   // nothing above resolves — use it as written
    tail.unshift(head.slice(cut + 1))
    head = head.slice(0, cut)
  }
}

function expand(glob: string, home: string, root: string): string {
  const g = glob.replace(/\\/g, '/').trim()
  if (g.startsWith('~/')) return normalize(`${home}/${g.slice(2)}`)
  if (g.startsWith('/')) return normalizeReal(g)
  // ALWAYS repo-relative, wildcard or not. A leading wildcard used to be left
  // unanchored so that "**/build/**" could match at any depth, which meant a
  // lone "**" in one repository's file expanded to "match every path on this
  // machine" and silently disabled the overlap check everywhere — a per-repo
  // file must never reach past its own repo. Depth is now globToRegExp's job:
  // "**/" spans zero or more directories, so anchoring costs nothing.
  return normalize(`${root}/${g}`)
}

function safeReal(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

let _patterns: RegExp[] | null = null
let _patternsKey = ''

function patterns(): RegExp[] {
  // Both bases resolved once per (re)build, not per edit.
  const home = normalize(safeReal(homedir()))
  const root = normalize(safeReal(process.cwd()))
  const file = join(root, REPO_IGNORE_FILE)
  // Re-read only when the repo's file actually changed; the common case is that
  // it does not exist at all, which statSync answers in one syscall.
  let key = 'none'
  try { const st = statSync(file); key = `${st.mtimeMs}:${st.size}` } catch {}
  if (_patterns !== null && key === _patternsKey) return _patterns

  const globs = [...DEFAULT_SHARED_GLOBS]
  if (key !== 'none') {
    try {
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const line = raw.split('#')[0].trim()
        if (line) globs.push(line)
      }
    } catch { /* unreadable → defaults only, silently: this must never break an edit */ }
  }
  _patterns = globs.map((g) => globToRegExp(expand(g, home, root)))
  _patternsKey = key
  return _patterns
}

/** Is this a file windows share on purpose, so an overlap on it is not news? */
export function isSharedInfrastructure(path: string): boolean {
  const p = normalizeReal(String(path || ''))
  if (!p) return false
  return patterns().some((re) => re.test(p))
}

/** Test seam — forget the cached patterns so a test can change the file. */
export function _resetPatterns(): void {
  _patterns = null
  _patternsKey = ''
}


// ── Self-check: `bun src/touched.ts` ─────────────────────────────────────────
// The allowlist decides which overlaps are never mentioned, so a pattern that
// matches too much silently disables the feature for those paths. The negative
// cases below are the ones worth keeping.
if (import.meta.main) {
  const ok = (c: unknown, m: string) => { if (!c) { console.error(`FAIL: ${m}`); process.exit(1) } }
  const H = homedir()
  const root = process.cwd()

  // The machine's own config is shared by every window on it.
  ok(isSharedInfrastructure(`${H}/.claude/hooks/tg-bridge-locate.js`), 'global hooks are shared')
  ok(isSharedInfrastructure(`${H}/.claude/CLAUDE.md`), 'the global CLAUDE.md is shared')
  ok(isSharedInfrastructure(`${H}/.claude/settings.json`), 'global settings are shared')
  ok(isSharedInfrastructure(`${H}/.codex/AGENTS.md`), 'the Codex side too')
  ok(isSharedInfrastructure(`${H}/.tg-bridge-channel/instances.json`), 'bridge state')

  // A working tree stays checked — this is the collision the feature exists for.
  ok(!isSharedInfrastructure(`${root}/CLAUDE.md`), "a repo's own CLAUDE.md is NOT exempt")
  ok(!isSharedInfrastructure(`${root}/.mcp.json`), "a repo's own .mcp.json is NOT exempt")
  ok(!isSharedInfrastructure(`${root}/channel-plugin/server.ts`), 'ordinary source is checked')
  ok(!isSharedInfrastructure(`${H}/Work/other/.claude/hooks/x.ts`), 'only the HOME .claude, not any .claude')
  ok(!isSharedInfrastructure(''), 'no path, no claim')

  // A repo that disagrees says so itself.
  const repo = mkdtempSync(join(tmpdir(), 'overlap-'))
  process.chdir(repo)
  _resetPatterns()
  ok(!isSharedInfrastructure(`${repo}/.mcp.json`), 'not exempt before the file exists')
  writeFileSync(join(repo, '.tg-bridge-overlap-ignore'),
    '# shared here on purpose\n.mcp.json\nbuild/**\n\n  **/*.generated.ts  \n')
  _resetPatterns()
  ok(isSharedInfrastructure(`${repo}/.mcp.json`), 'a repo-relative pattern')
  ok(isSharedInfrastructure(`${repo}/build/x/y.js`), '** crosses directories')
  ok(isSharedInfrastructure(`${repo}/src/a.generated.ts`), 'a leading ** matches anywhere')
  ok(!isSharedInfrastructure(`${repo}/src/a.ts`), 'and still misses what it should')
  ok(!isSharedInfrastructure('/elsewhere/.mcp.json'), 'a repo-relative pattern stays in the repo')

  // A repo's file must not reach past its own repo. A lone "**" used to expand
  // to "every path on this machine", which silenced the check everywhere from
  // one repository — found while auditing this code, 2026-09-24.
  writeFileSync(join(repo, REPO_IGNORE_FILE), '**\n')
  _resetPatterns()
  ok(isSharedInfrastructure(`${repo}/anything/at/all`), '** covers the repo')
  ok(!isSharedInfrastructure('/etc/passwd'), '** must NOT cover the machine')
  ok(!isSharedInfrastructure(`${H}/Work/other/x.ts`), 'nor another working tree')

  // Anchoring is only safe because "**/" spans ZERO or more directories —
  // otherwise "**/build/**" would stop matching "build" at the repo root, which
  // is exactly the reasoning that produced the unanchored version.
  writeFileSync(join(repo, REPO_IGNORE_FILE), '**/build/**\n')
  _resetPatterns()
  ok(isSharedInfrastructure(`${repo}/build/x.js`), 'zero directories in between')
  ok(isSharedInfrastructure(`${repo}/a/b/build/x.js`), 'and several')
  ok(!isSharedInfrastructure(`${repo}/buildings/x.js`), 'but not a longer name')

  // Regexp metacharacters in a pattern stay literal.
  writeFileSync(join(repo, REPO_IGNORE_FILE), 'a+b\n(x|y)\n')
  _resetPatterns()
  ok(isSharedInfrastructure(`${repo}/a+b`), 'plus is literal')
  ok(!isSharedInfrastructure(`${repo}/aab`), 'not a quantifier')
  ok(isSharedInfrastructure(`${repo}/(x|y)`), 'parens and pipe are literal')
  ok(!isSharedInfrastructure(`${repo}/x`), 'not an alternation')
  process.chdir(root)
  rmSync(repo, { recursive: true, force: true })
  // What this window remembers: newest first, expiring, capped.
  _reset()
  noteTouched('/a.ts', 1000)
  noteTouched('/b.ts', 2000)
  noteTouched('/a.ts', 3000)          // re-touch moves it to the front
  ok(JSON.stringify(recentTouches(3000)) === JSON.stringify(['/a.ts', '/b.ts']), 'newest first')
  // '/a.ts' carries its RE-touch time (3000), not its first (1000) — the point
  // of re-inserting. So at 2000+TTL only '/b.ts' is gone.
  ok(recentTouches(2000 + TOUCH_TTL_MS + 1).length === 1, 'the older one expires first')
  ok(recentTouches(2000 + TOUCH_TTL_MS + 1)[0] === '/a.ts', 'and it is the one re-touched that stays')
  ok(recentTouches(3000 + TOUCH_TTL_MS + 1).length === 0, 'and then so does the rest')
  _reset()
  for (let i = 0; i < 500; i++) noteTouched(`/f${i}.ts`, 1000 + i)
  ok(recentTouches(1500).length === 200, 'the cap holds')
  ok(!recentTouches(1500).includes('/f0.ts'), 'and drops the OLDEST, not the newest')

  // "Nobody is in this file" and "we cannot tell" must never look alike.
  _resetOthers()
  ok(overlapHealth(1000).fresh === false, 'no answer yet is not a clean answer')
  setOthersTouching({ '/x.ts': ['other'] }, 1000)
  ok(overlapHealth(1000).fresh === true && othersTouching('/x.ts')[0] === 'other', 'a fresh answer')
  ok(overlapHealth(1000 + 60_000).fresh === false, 'and it goes stale')
  setOthersTouching(null, 1000)
  ok(overlapHealth(1000).missedBeats === 1, 'a missing field is counted, not ignored')

  console.log('touched self-check OK')
}
