import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { bridgeEntry } from './opencode-entry.ts'
import { readRegistry, rowIsStale, pidAlive } from '../agent/registry.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const cwd = realpathSync(process.cwd())
const args = process.argv.slice(2)
const headless = args[0] === 'run'
if (headless) args.shift()
const env = { ...process.env, TG_OPENCODE_BRIDGE: '0' }
delete env.CODEX_THREAD_ID
delete env.CLAUDE_PROJECT_DIR
delete env.CLAUDE_CODE_ENTRYPOINT
function api(operation: string, params: string[] = [], body?: unknown): any {
  const call = Bun.spawnSync(['opencode', 'api', '--standalone', operation, ...params,
    ...(body === undefined ? [] : ['--data', JSON.stringify(body)])], { cwd, env })
  if (call.exitCode !== 0) throw new Error(call.stderr.toString().trim() || `OpenCode ${operation} failed`)
  return JSON.parse(call.stdout.toString()).data
}
try {
  if (args.includes('--server') || args.some(a => a.startsWith('--server='))) {
    throw new Error('polydaemon-opencode uses a private local server; --server is not supported')
  }
  if (args.includes('--fork')) throw new Error('Use TG_OPENCODE_NEW=1; --fork would change the bound session')
  if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v')) {
    const call = Bun.spawn(['opencode', ...args, cwd], { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    process.exit(await call.exited)
  }
  const entry = bridgeEntry(repo)
  if (Object.values(readRegistry()).some(row => /-opencode$/i.test(row.instance_name || row.workspace_name)
    && row.parent_pid > 1 && pidAlive(row.parent_pid) && pidAlive(row.pid) && !rowIsStale(row) && row.cwd === cwd)) {
    throw new Error('An OpenCode bridge window already owns this workspace; use that window')
  }
  const index = args.findIndex(a => a === '--session' || a === '-s')
  const explicit = index >= 0 ? args[index + 1] : args.find(a => a.startsWith('--session='))?.slice(10)
  if (index >= 0 && !explicit) throw new Error('--session requires an ID')
  let session = explicit ? api('session.get', ['--param', `sessionID=${explicit}`]) : null
  if (!session && process.env.TG_OPENCODE_NEW !== '1') {
    session = api('session.list', ['--param', `directory=${cwd}`, '--param', 'parentID=null', '--param', 'limit=1'])?.[0]
  }
  session ??= api('session.create', [], { location: { directory: cwd }, title: `${basename(cwd)}-opencode` })
  if (!session?.id || session.parentID || realpathSync(session.location.directory) !== cwd) {
    throw new Error('Refusing to attach a child session or a session from another workspace')
  }
  if (index >= 0) args.splice(index, 2)
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith('--session=') || ['--continue', '-c', '--standalone'].includes(args[i])) args.splice(i, 1)
  }
  // Credentials stay in the inherited environment, never in argv or repository files.
  const child = Bun.spawn(['opencode', ...(headless ? ['run'] : []), '--standalone', '--session', session.id,
    ...args, ...(headless ? [] : [cwd])], {
    cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    env: { ...env, TG_OPENCODE_BRIDGE: '1', TG_OPENCODE_ROOT: cwd, TG_OPENCODE_SESSION: session.id,
      TG_OPENCODE_ENTRY: JSON.stringify(entry), TG_BRIDGE_AGENT: 'opencode',
      TG_BRIDGE_INSTANCE_NAME: `${process.env.TG_WS_NAME || basename(cwd)}-opencode`, TG_WINDOW_UID: randomUUID() },
  })
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  process.exit(await child.exited)
} catch (error) {
  console.error(`polydaemon-opencode: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
