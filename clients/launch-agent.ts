#!/usr/bin/env bun
// launch-agent.ts — persistent per-machine window launcher.
//
// When the bot moves off the Windows PC onto a separate bot host (Linux), it can no longer
// spawn a Windows VS Code/claude window directly. A running plugin can't help
// either: a plugin only exists while a window is ALREADY up, and /launch starts
// a window that isn't. So this tiny always-on HTTP server does the spawn on the
// machine where the workspaces live.
//
// It reuses the EXACT transport the bot already uses to reach plugins — mesh
// HTTP + a shared Bearer token — so there is no SSH, no tunnel, no second
// credential. Effectively a "degenerate plugin" that only knows how to launch.
//
// Run it autostarted on EVERY machine that holds workspaces — Windows (Task
// Scheduler at logon, or the Startup folder) and macOS (a launchd LaunchAgent):
//   bun run clients/launch-agent.ts
// The bot lists one entry per machine under bot.launch_agents, each saying which
// working-tree roots that machine owns, and /launch shows them as tabs.
// Env:
//   TG_BRIDGE_AUTH_TOKEN  shared Bearer, == bot.registry_enroll_token   [required]
//   TG_LAUNCH_AGENT_BIND  bind host — the mesh IP; NEVER 0.0.0.0     [default 127.0.0.1]
//   TG_LAUNCH_AGENT_PORT  listen port                                [default 8091]
//   TG_MAC_TERMINAL       macOS: iterm|terminal|tmux|auto — where the launch
//                         script opens the window [default auto]; Linux: tmux
//   TG_LAUNCH_SCRIPT      path to the launch script
//                         [default: repo-root/launch-ws.ps1 on Windows,
//                                   clients/launch-ws.sh elsewhere]
//
// The bot dials this at bot.launch_agent_url (e.g. http://198.51.100.<win>:8091).
// Pre-cutover you can test the whole path locally: run the agent bound to
// 127.0.0.1 and set the (still-on-Windows) bot's launch_agent_url to
// http://127.0.0.1:8091.
import { spawn, spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { timingSafeEqual } from 'crypto'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const TOKEN = process.env.TG_BRIDGE_AUTH_TOKEN ?? ''
if (!TOKEN) {
  console.error('launch-agent: TG_BRIDGE_AUTH_TOKEN is required (shared Bearer == bot.registry_enroll_token)')
  process.exit(1)
}
const BIND = process.env.TG_LAUNCH_AGENT_BIND || '127.0.0.1'
const PORT = Number(process.env.TG_LAUNCH_AGENT_PORT || 8091)
const HERE = dirname(fileURLToPath(import.meta.url))
// Each platform has its own launcher and they are NOT interchangeable: the
// Windows one opens a console and nudges the startup TUI with keystrokes, the
// macOS one writes a .command file and hands it to Terminal. This agent used to
// hardcode PowerShell, so a Mac could run it, answer 200, and launch nothing.
const IS_WINDOWS = process.platform === 'win32'
// launch-ws.ps1 lives at the repo root (one level above clients/);
// launch-ws.sh lives here in clients/.
const SCRIPT = process.env.TG_LAUNCH_SCRIPT
  || (IS_WINDOWS ? resolve(HERE, '..', 'launch-ws.ps1') : resolve(HERE, 'launch-ws.sh'))

// launch-ws.sh drives iTerm2/Terminal on macOS and tmux on Linux. Without tmux a
// Linux launch would fail after this agent had already answered 200, so refuse
// up front.
const HAS_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
const CAN_LAUNCH = IS_WINDOWS || process.platform === 'darwin'
  || (process.platform === 'linux' && HAS_TMUX) || !!process.env.TG_LAUNCH_SCRIPT

// Mirror launcher.py _SAFE_NAME exactly: a workspace is a folder basename —
// letters/digits/space/dot/dash/underscore, never leading '-' (PowerShell would
// parse a leading-dash token as a parameter to launch-ws.ps1). Defence-in-depth
// on the arg parser; the spawn array form already blocks shell-metachar injection.
const SAFE_NAME = /^[\w.][\w .\-]*$/
const AGENTS = ['claude', 'codex', 'opencode', 'mimo']

// Constant-time Bearer check (this server is mesh-exposed). timingSafeEqual needs
// equal-length buffers, so the length guard is an unavoidable length-only leak.
function authed(req: Request): boolean {
  const got = Buffer.from(req.headers.get('Authorization') ?? '')
  const want = Buffer.from(`Bearer ${TOKEN}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

// The folder to open, when the bot knows it. Absolute, no NUL, bounded — the
// scripts only use it if it holds a tg-claude launcher, and search by name
// otherwise, so a bad or stale path costs a search, never a wrong window.
function safeDir(v: unknown): string {
  const d = typeof v === 'string' ? v : ''
  const absolute = IS_WINDOWS ? /^[A-Za-z]:[\\/]/.test(d) : d.startsWith('/')
  return absolute && d.length <= 1024 && !d.includes('\0') ? d : ''
}

function launch(name: string, dir: string, agent: string, fresh: boolean): void {
  // Fire-and-forget. The launch script opens its OWN visible window (Windows:
  // Start-Process + a TUI keystroke nudge; macOS: a .command handed to
  // Terminal); windowsHide only hides this PowerShell host (mirrors
  // launcher.py's CREATE_NO_WINDOW) and is ignored elsewhere. No detach — the
  // child exits seconds after spawning the real window; launches are rare.
  const [cmd, args] = IS_WINDOWS
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, name,
        ...(dir ? ['-Dir', dir] : []), '-Agent', agent, ...(fresh ? ['-NewSession'] : [])]]
    : ['bash', [SCRIPT, name, dir, agent, fresh ? 'new' : 'resume']] as [string, string[]]
  // The script's own output goes to this agent's log: it is the only place that
  // says WHY a launch fell back to Terminal.app or found no workspace.
  const child = spawn(cmd as string, args as string[], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  child.on('error', (e) => console.error(`launch-agent: spawn failed for ${name}: ${e}`))
}

// What this machine's checkout is at, for the bot's /versions. Read on request,
// not cached: the point is to see a `git pull` someone just did.
const REPO = resolve(HERE, '..')
function run(cmd: string, args: string[], timeout = 15000): { ok: boolean; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', timeout, windowsHide: true })
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() }
}
const PYTHON = IS_WINDOWS ? 'python' : 'python3'
function version() {
  const sha = run('git', ['rev-parse', '--short', 'HEAD'])
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'])
  // install.py --check: 0 = hooks exactly as this checkout installs them, 3 = not.
  const hooks = spawnSync(PYTHON, ['hooks/install.py', '--check'],
    { cwd: REPO, timeout: 15000, windowsHide: true })
  return {
    ok: sha.ok,
    sha: sha.out.trim(),
    branch: branch.out.trim(),
    dirty: status.ok ? status.out.split('\n').filter(Boolean).map((l) => l.slice(3)) : null,
    hooks_current: hooks.status === 0 ? true : hooks.status === 3 ? false : null,
  }
}

// POST /update {sha}: bring this checkout to a commit the bot names — and only
// to one that is already in the remote's default branch (origin/main, say).
// The bot can pick WHICH published commit, never supply code: whoever holds the
// token cannot push anything onto this machine that is not in your remote.
// Fast-forward only: local commits or a conflicting local edit stop it, with
// git's own words, and nothing is reset or stashed. Then the hooks are
// re-registered from the new checkout. The running windows keep their plugin
// until they restart; the bot's /versions says which.
//
// This agent's own code changes too. Under a supervisor that restarts it
// (launchd KeepAlive; the Windows wrapper loop in docs/multi-machine.md), set
// TG_LAUNCH_AGENT_SUPERVISED=1 and it exits after answering, to come back on
// the new code. Without that it keeps running the old one and says so.
const SUPERVISED = process.env.TG_LAUNCH_AGENT_SUPERVISED === '1'
let updating = false
type Step = { step: string; ok: boolean; detail: string }
function update(sha: string): { ok: boolean; steps: Step[]; sha_now: string; restarting: boolean } {
  const steps: Step[] = []
  let changed = false
  const finish = (ok: boolean) => ({
    // Restart only when the agent's own code may have moved: re-running on an
    // unchanged checkout (a machine already at, or ahead of, the bot) must not
    // bounce it — on Linux under systemd that could take the tmux server along.
    ok, steps, sha_now: run('git', ['rev-parse', '--short', 'HEAD']).out.trim(), restarting: ok && changed && SUPERVISED,
  })
  // `detail` is the success text; on failure git's own words are kept.
  const step = (name: string, r: { ok: boolean; out: string; err: string }, detail = '') => {
    steps.push({ step: name, ok: r.ok, detail: (r.ok && detail ? detail : r.ok ? r.out.trim() : r.err || r.out.trim()).slice(0, 400) })
    return r.ok
  }
  // Fetch first, from the remote this branch tracks (else origin), and refresh
  // what that remote calls its default branch: origin/HEAD is set once at clone
  // time and never updated by a fetch, so a renamed default (master → main)
  // would otherwise refuse every update forever.
  const tracked = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const remote = tracked.ok ? tracked.out.trim().split('/')[0] : 'origin'
  if (!step('fetch', run('git', ['fetch', remote], 120000), remote)) return finish(false)
  run('git', ['remote', 'set-head', remote, '--auto'], 30000)
  // "Published" = in the remote's DEFAULT branch, not in whatever this local
  // branch tracks: a clone left on a feature branch tracking its own stale
  // remote branch would refuse every update — or, with a plain `git pull`,
  // silently pull nothing and report success.
  let up = run('git', ['rev-parse', '--abbrev-ref', `${remote}/HEAD`])
  if (!up.ok) up = tracked
  if (!step('upstream', up)) return finish(false)
  const upstream = up.out.trim()
  if (!step('published', run('git', ['merge-base', '--is-ancestor', `${sha}^{commit}`, upstream]),
    `${sha} is in ${upstream}`)) {
    steps[steps.length - 1].detail = `${sha} is not in ${upstream} — refusing`
    return finish(false)
  }
  if (run('git', ['merge-base', '--is-ancestor', `${sha}^{commit}`, 'HEAD']).ok) {
    steps.push({ step: 'merge', ok: true, detail: 'already at or past it' })
  } else if (!step('merge', run('git', ['merge', '--ff-only', `${sha}^{commit}`], 60000))) {
    return finish(false)
  } else {
    changed = true
  }
  if (!step('hooks', run(PYTHON, ['hooks/install.py'], 60000))) return finish(false)
  // Codex hooks too, when this machine has them (install.py --codex). Same
  // commands, so the entries' hashes do not change and Codex keeps trusting them.
  const codexHooks = resolve(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'hooks.json')
  if (existsSync(codexHooks) && readFileSync(codexHooks, 'utf8').includes('tg-approve.js')) {
    if (!step('codex hooks', run(PYTHON, ['hooks/install.py', '--codex'], 60000))) return finish(false)
  }
  return finish(true)
}

try {
  Bun.serve({
    hostname: BIND,
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, agents: AGENTS, new_session: true })
      }
      if (!authed(req)) return new Response('Unauthorized', { status: 401 })
      if (req.method === 'GET' && url.pathname === '/version') {
        return Response.json(version())
      }
      if (req.method === 'POST' && url.pathname === '/update') {
        let body: { sha?: string }
        try { body = (await req.json()) as typeof body }
        catch { return new Response('Bad JSON', { status: 400 }) }
        const sha = String(body.sha ?? '')
        if (!/^[0-9a-f]{7,40}$/.test(sha)) {
          return Response.json({ ok: false, reason: 'sha must be 7-40 hex characters' }, { status: 400 })
        }
        if (updating) return Response.json({ ok: false, reason: 'an update is already running' }, { status: 409 })
        updating = true
        try {
          const result = update(sha)
          console.log(`launch-agent: update to ${sha}: ${result.ok ? 'ok' : 'failed'} ${JSON.stringify(result.steps)}`)
          if (result.restarting) setTimeout(() => process.exit(0), 1000)
          return Response.json(result)
        } finally { updating = false }
      }
      if (req.method === 'POST' && url.pathname === '/launch') {
        let body: { name?: string; cwd?: string; agent?: string; new_session?: boolean }
        try { body = (await req.json()) as typeof body }
        catch { return new Response('Bad JSON', { status: 400 }) }
        if (!body || typeof body !== 'object') return new Response('Bad JSON', { status: 400 })
        const name = String(body.name ?? '')
        const agent = body.agent ?? 'claude'
        const fresh = body.new_session ?? false
        if (!AGENTS.includes(agent) || typeof fresh !== 'boolean') {
          return Response.json({ ok: false, reason: 'invalid agent or session mode' }, { status: 400 })
        }
        if (!SAFE_NAME.test(name)) {
          return Response.json({ ok: false, reason: 'unsafe or empty name' }, { status: 400 })
        }
        if (!CAN_LAUNCH) {
          return Response.json({ ok: false, reason: `no window launcher here — ${process.platform === 'linux' ? 'install tmux' : 'set TG_LAUNCH_SCRIPT'}` }, { status: 501 })
        }
        const dir = safeDir(body.cwd)
        if (body.cwd && !dir) return Response.json({ ok: false, reason: 'invalid cwd' }, { status: 400 })
        const extension = IS_WINDOWS ? 'cmd' : 'sh'
        if (!existsSync(SCRIPT) || (dir && !existsSync(resolve(dir, `polydaemon-${agent}.${extension}`))
            && !(agent === 'claude' && !fresh && existsSync(resolve(dir, `tg-claude.${extension}`))))) {
          return Response.json({ ok: false, reason: 'selected launcher not installed in workspace' }, { status: 404 })
        }
        launch(name, dir, agent, fresh)
        console.log(`launch-agent: launch ${name} agent=${agent} new=${fresh}${dir ? ` in ${dir}` : ''}`)
        return Response.json({ ok: true })
      }
      return new Response('Not Found', { status: 404 })
    },
    error(err) {
      console.error(`launch-agent: server error: ${err}`)
      return new Response('Internal Server Error', { status: 500 })
    },
  })
} catch (e) {
  // A bad BIND (mesh IP not up yet) fails here — surface it, don't die silently.
  console.error(`launch-agent: cannot bind ${BIND}:${PORT} — ${e}. `
    + `If BIND is a mesh IP, check the interface is up.`)
  process.exit(1)
}
// Say the platform out loud at startup: "listening" with the wrong launcher
// behind it looks identical to working, and the failure is silent — the POST
// answers 200 and no window appears.
if (!existsSync(SCRIPT)) {
  console.error(`launch-agent: launch script not found: ${SCRIPT} — /launch will answer `
    + `200 and do nothing. Set TG_LAUNCH_SCRIPT or run from the repo checkout.`)
}
console.log(`launch-agent: listening on ${BIND}:${PORT}, platform=${process.platform}, `
  + `runner=${IS_WINDOWS ? 'powershell' : 'bash'}, script=${SCRIPT}`)
