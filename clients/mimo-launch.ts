import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { bridgeEntry } from './opencode-entry.ts'
import { readRegistry, rowIsStale, pidAlive } from '../agent/registry.ts'
import { availableModel, bridgeRequest, inboundTurn, parseModel, relayReplies } from './mimo-bridge.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const cwd = realpathSync(process.cwd())
const args = process.argv.slice(2)
const mimo = process.env.MIMO_BIN || Bun.which('mimo') || join(homedir(), '.mimocode/bin/mimo')
if (args.some(a => ['--help', '-h', '--version', '-v'].includes(a))) {
  process.exit(await Bun.spawn([mimo, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited)
}
// Only session selection is forwarded: server/directory/fork overrides break binding.
let explicit: string | undefined
if (args.length) {
  if (args.length !== 2 || !['--session', '-s'].includes(args[0]) || !/^ses_[A-Za-z0-9]+$/.test(args[1])) {
    throw new Error('Usage: polydaemon-mimo.sh [--session ID]; TG_MIMO_NEW=1 starts a new session')
  }
  explicit = args[1]
}
if (Object.values(readRegistry()).some(row => /-mimo$/i.test(row.instance_name || row.workspace_name)
  && row.cwd === cwd && row.parent_pid > 1 && pidAlive(row.parent_pid) && pidAlive(row.pid) && !rowIsStale(row))) {
  throw new Error('A MiMo bridge window already owns this workspace')
}
const temp = mkdtempSync(join(tmpdir(), 'polydaemon-mimo-'))
const controller = new AbortController()
let server: ReturnType<typeof Bun.spawn> | undefined
let tui: ReturnType<typeof Bun.spawn> | undefined
let pump: Promise<void> | undefined
let relay: Promise<void> | undefined
try {
  const entry = bridgeEntry(repo)
  const env: Record<string, string | undefined> = { ...process.env,
    MIMOCODE_SERVER_PASSWORD: randomUUID(), MIMOCODE_SERVER_USERNAME: 'polydaemon',
    TG_BRIDGE_AGENT: 'mimo', TG_BRIDGE_INSTANCE_NAME: `${process.env.TG_WS_NAME || basename(cwd)}-mimo`,
    TG_WINDOW_UID: randomUUID(), TG_MIMO_ROOT: cwd, TG_MIMO_BINDING: join(temp, 'binding.json'),
    MIMOCODE_TUI_CONFIG: join(temp, 'tui.json') }
  for (const key of ['CODEX_THREAD_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT']) delete env[key]
  process.env.TG_WINDOW_UID = env.TG_WINDOW_UID
  process.env.TG_BRIDGE_AGENT = 'mimo'
  const overlay = JSON.parse(env.MIMOCODE_CONFIG_CONTENT || '{}')
  overlay.plugin = [...(overlay.plugin ?? []), pathToFileURL(join(repo, 'clients/mimo-plugin.ts')).href]
  // Native override suppresses only the legacy Claude import, not other MCPs.
  overlay.mcp = { ...overlay.mcp, 'tg-bridge': { enabled: false }, PolyDaemon: { type: 'local', command: [entry.command, ...entry.args], enabled: true,
    environment: { ...entry.env, TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_AGENT: 'mimo',
      TG_BRIDGE_INSTANCE_NAME: env.TG_BRIDGE_INSTANCE_NAME, TG_WINDOW_UID: env.TG_WINDOW_UID } } }
  env.MIMOCODE_CONFIG_CONTENT = JSON.stringify(overlay)
  const memorySource = join(homedir(), '.config/opencode/opencode.json')
  if (existsSync(memorySource)) {
    const memory = JSON.parse(readFileSync(memorySource, 'utf8')).mcp?.servers?.HyperMnesia
    if (memory?.type === 'local' && !memory.disabled && (!memory.cwd || memory.cwd === '.')) {
      env.TG_MIMO_MEMORY = JSON.stringify({ type: 'local', command: memory.command, environment: memory.environment, enabled: true, timeout: 95000 })
    }
  }
  writeFileSync(env.MIMOCODE_TUI_CONFIG!, JSON.stringify({ plugin: [pathToFileURL(join(repo, 'clients/mimo-tui.tsx')).href] }), { mode: 0o600 })
  server = Bun.spawn([mimo, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: Bun.file(join(temp, 'server.log')) })
  let base = ''
  const discover = (async () => {
    let text = ''
    for await (const chunk of server!.stdout as any) {
      text += new TextDecoder().decode(chunk)
      const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) { base = match[0]; return }
      if (text.length > 100000) throw new Error('MiMo startup output exceeded limit')
    }
    throw new Error('MiMo server exited before listening')
  })()
  let deadline: ReturnType<typeof setTimeout>
  try { await Promise.race([discover, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('MiMo startup timed out')), 60000) })]) }
  finally { clearTimeout(deadline!) }
  const api = async (path: string, body?: unknown, method?: string): Promise<any> => {
    const url = new URL(path, base)
    url.searchParams.set('directory', cwd)
    const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Basic ${Buffer.from(`${env.MIMOCODE_SERVER_USERNAME}:${env.MIMOCODE_SERVER_PASSWORD}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal })
    if (!response.ok) throw new Error(`MiMo HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  let session = explicit ? await api(`/session/${explicit}`) : null
  if (!session && process.env.TG_MIMO_NEW !== '1') {
    const sessions = await api('/session?roots=true')
    session = sessions.find((s: any) => s.directory === cwd && !s.parentID)
  }
  session ??= await api('/session', { title: env.TG_BRIDGE_INSTANCE_NAME })
  if (session.parentID || realpathSync(session.directory) !== cwd) throw new Error('Refusing a foreign or child session')
  writeFileSync(env.TG_MIMO_BINDING!, JSON.stringify({ root: cwd, sessionID: session.id }), { mode: 0o600 })
  await api('/mcp')
  const ready = JSON.parse(readFileSync(`${env.TG_MIMO_BINDING}.ready`, 'utf8'))
  if (ready.root !== cwd || ready.version !== 1) throw new Error('MiMo guard plugin did not initialize')
  const catalog = await api('/provider')
  const config = await api('/config')
  const paths = await api('/path')
  let recent: any[] = []
  try { recent = JSON.parse(readFileSync(join(paths.state, 'model.json'), 'utf8')).recent ?? [] } catch {}
  // Snapshot the TUI's persisted preference once for this window, never borrow
  // another live window's subsequent global selection. Valid session choices win.
  const initialModel = availableModel(catalog, [...recent, parseModel(config.model)])
  console.error(`PolyDaemon / MiMo: ${basename(cwd)} (${session.id})`)
  pump = (async () => {
    let warned = false
    while (!controller.signal.aborted) {
      try {
        const { item } = await bridgeRequest(cwd, '/inbound')
        if (item) {
          if (item.meta.event !== 'reaction') {
            await inboundTurn(api, session.id, item, initialModel, true)
          }
          await bridgeRequest(cwd, '/inbound-ack', { id: item.id })
          continue
        }
        warned = false
      } catch {
        if (!warned && !controller.signal.aborted) {
          await api('/tui/show-toast', { title: 'PolyDaemon', message: 'Telegram delivery pending; message retained', variant: 'warning', duration: 6000 }).catch(() => {})
        }
        warned = true
      }
      await Bun.sleep(1000)
    }
  })()
  relay = (async () => {
    while (!controller.signal.aborted) {
      try {
        await relayReplies(api, session.id, async (text, chatID, promptID) => {
          const sent = await bridgeRequest(cwd, '/auto-reply', { text, chat_id: chatID, prompt_id: promptID })
          if (!['ok', 'deduped'].includes(sent.status)) throw new Error('Telegram reply not delivered')
        })
      } catch {
        // Receipts remain in native history; a failed send never blocks intake.
      }
      await Bun.sleep(1000)
    }
  })()
  tui = Bun.spawn([mimo, 'attach', base, '--dir', cwd, '--session', session.id], { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { controller.abort(); tui?.kill(sig) })
  process.exitCode = await tui.exited
} catch (error) {
  console.error(`polydaemon-mimo: ${error instanceof Error ? error.message : 'Startup failed'}`)
  process.exitCode = 1
} finally {
  controller.abort()
  tui?.kill()
  server?.kill()
  if (tui) await tui.exited
  if (server) await server.exited
  await pump
  await relay
  rmSync(temp, { recursive: true, force: true })
}
