import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { formatCodexInbound } from '../channel-plugin/src/codex-inbound.ts'
import { ProjectMemory } from './opencode-memory-rpc.ts'
import { registerProjectMemory } from './opencode-memory-reader.ts'
import { cleanAutoReply, parsePseudoReply } from './opencode-auto-reply.ts'
import { guardInput } from './bridge-tool-input.ts'
export { guardInput } from './bridge-tool-input.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const { findOwnPlugin } = createRequire(import.meta.url)('../hooks/tg-bridge-locate.js')

export default {
  id: 'tg-bridge',
  async setup(ctx: any) {
    let bridgeStatus = async (_: any): Promise<any> => ({ state: 'unbound', topic: null })
    await registerProjectMemory(ctx, ProjectMemory, input => bridgeStatus(input))
    if (process.env.TG_OPENCODE_BRIDGE !== '1') return
    const cwd = process.env.TG_OPENCODE_ROOT!
    const sessionID = process.env.TG_OPENCODE_SESSION!
    if (!cwd || !sessionID || realpathSync(ctx.location.directory) !== realpathSync(cwd)) return
    const session = await ctx.session.get({ sessionID })
    if (session.parentID || realpathSync(session.location.directory) !== realpathSync(cwd)) throw new Error('Wrong OpenCode bridge session')
    const entry = JSON.parse(process.env.TG_OPENCODE_ENTRY!)
    const controller = new AbortController()
    const signal = controller.signal
    const own = () => findOwnPlugin(cwd, 'opencode')
    async function request(path: string, body?: unknown, timeout = 10000) {
      const target = own()
      if (!target) throw new Error('Own OpenCode MCP bridge is not ready')
      const response = await fetch(`http://${target.host}:${target.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${target.auth_token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) throw new Error(`Bridge ${path}: HTTP ${response.status}`)
      return response.json()
    }
    let requiredServers: string[] = []
    await ctx.mcp.transform((editor: any) => {
      editor.set('PolyDaemon', {
      type: 'local', command: [entry.command, ...entry.args], cwd, codemode: false,
      environment: { ...entry.env, TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_AGENT: 'opencode',
        TG_BRIDGE_INSTANCE_NAME: process.env.TG_BRIDGE_INSTANCE_NAME!, TG_WINDOW_UID: process.env.TG_WINDOW_UID! },
      })
      requiredServers = editor.list().filter(([, config]: any) => !config.disabled).map(([name]: any) => name)
    })
    async function owns(id: string): Promise<boolean> {
      for (let depth = 0; id && depth < 32; depth++) {
        if (id === sessionID) return true
        const child = await ctx.session.get({ sessionID: id })
        if (realpathSync(child.location.directory) !== realpathSync(cwd)) return false
        id = child.parentID
      }
      return false
    }
    bridgeStatus = async (input) => {
      if (!await owns(input.sessionID)) return { state: 'unbound', topic: null }
      try {
        const status = await request('/status')
        const topic = status.topic
        if (!topic || !Number.isSafeInteger(topic.forum_chat_id) || !Number.isSafeInteger(topic.message_thread_id)
            || topic.message_thread_id <= 0) return { state: 'unregistered', topic: null }
        return { state: 'registered', topic: { id: topic.message_thread_id,
          title: typeof topic.title === 'string' ? topic.title : status.instance_name } }
      } catch { return { state: 'unavailable', topic: null } }
    }
    async function approve(tool: string, input: unknown) {
      const result = await request('/approve-request', { cwd, tool_name: tool, tool_input: input, sensitive: true }, 86460000)
      if (result.decision !== 'allow' && result.decision !== 'deny') throw new Error('PolyDaemon: no approval decision received')
      return result
    }
    // Admission precedes the executable tool snapshot; don't prime a model with an empty MCP catalog.
    await ctx.session.hook('prompt', async (event: any) => {
      if (!await owns(event.sessionID)) return
      for (let n = 0; n < 300; n++) {
        const { data: servers } = await ctx.mcp.list()
        const failed = servers.find((s: any) => requiredServers.includes(s.name) && ['failed', 'needs_auth'].includes(s.status.status))
        if (failed) throw new Error(`MCP ${failed.name}: ${failed.status.error || failed.status.status}`)
        if (requiredServers.every(name => servers.some((s: any) => s.name === name && s.status.status === 'connected'))) {
          const tools = await ctx.tool.list()
          if (tools.some((t: any) => /(?:tg[-_]?bridge|polydaemon).*reply/i.test(t.id))) return
        }
        await sleep(100, undefined, { signal })
      }
      throw new Error('OpenCode MCP catalog is not ready; prompt was not admitted')
    })
    // One-shot tool IDs prevent a second native prompt for the same approval.
    const approved = new Set<string>()
    await ctx.tool.hook('execute.before', async (event: any) => {
      if (!await owns(event.sessionID)) return
      if (/(?:tg[-_]?bridge|polydaemon).*(?:reply|react|edit_message|receive|tell_window|ask_window|task_|list_windows|download_attachment)/i.test(event.tool)) return
      const input = guardInput(event.tool, event.input, cwd)
      const classify = spawnSync('node', [join(repo, 'hooks/tg-approve.js'), '--classify'], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 10000,
      })
      if (classify.status !== 0) throw new Error('Bridge guard failed; action not executed')
      const classified = JSON.parse(classify.stdout)
      if (classified.sensitive) {
        const decision = await approve(event.tool, event.input)
        if (decision.decision === 'deny') throw new Error(decision.reason || 'Not approved by owner')
      }
      if (event.id && (classified.sensitive || classified.bridgeRead)) approved.add(`${event.sessionID}:${event.id}`)
      const detail = /^(shell|bash)$/.test(event.tool)
        ? event.input?.command ?? event.input?.cmd
        : event.input?.filePath ?? event.input?.file_path ?? event.input?.path
      const summary = `${event.tool}${typeof detail === 'string' && detail ? `: ${detail}` : ''}`
        .replace(/\s+/g, ' ').slice(0, 200)
      await request('/progress', { tool_name: event.tool, summary }).catch(() => {})
    })
    await ctx.tool.hook('execute.after', (event: any) => { approved.delete(`${event.sessionID}:${event.id}`) })
    await ctx.permission.hook('evaluate', async (event: any) => {
      if (event.effect !== 'ask' || !await owns(event.sessionID)) return
      if (event.source?.id && approved.has(`${event.sessionID}:${event.source.id}`)) {
        event.effect = 'allow'; return
      }
      try {
        const decision = await approve(event.action, { resources: event.resources, ...event.metadata })
        event.effect = decision.decision
      } catch (error) {
        // Keep native ask as-is: unavailable Telegram is not a human decision.
        event.message = `PolyDaemon: approval transport failed; use the native prompt. ${String(error)}`
        console.error(event.message)
        await request('/notify', { kind: 'api_error', message: event.message }).catch(() => {})
      }
    })
    await ctx.session.hook('context', (event: any) => {
      if (event.sessionID !== sessionID) return
      event.system.push({ type: 'text', text: 'Telegram prompts include source=telegram metadata. For every Telegram prompt, call the native MCP tool PolyDaemon_reply for the final answer: arguments must be {"chat_id":"<metadata chat_id>","text":"<answer>"}, with optional reply_to set to the incoming message_id. Do not print a JSON tool call, XML tags, <|im_end|>, or the tool name as text. If the PolyDaemon tool is unavailable, say so in normal prose instead of pretending to call it. Acknowledge with PolyDaemon_react when useful. Push/deploy and file access outside this workspace require explicit owner permission. Never approve actions on behalf of the owner.' })
    })
    await ctx.session.hook('retry', async (event: any) => {
      if (event.sessionID !== sessionID) return
      await request('/notify', { kind: 'api_error', message: event.error.message, will_retry: event.decision.retry }).catch(console.error)
    })
    let latest: { id: string; meta: any } | null = null
    let waiting = false
    async function mirror() {
      if (waiting) return
      waiting = true
      let used: string | null = null
      try {
        await ctx.session.wait({ sessionID })
        const prompt = latest
        if (!prompt) return
        used = prompt.id
        const messages = await ctx.session.context({ sessionID })
        if (latest?.id !== used) return
        const at = messages.findIndex((m: any) => m.id === prompt.id)
        if (at < 0) return
        const answers = messages.slice(at + 1).filter((m: any) => m.type === 'assistant')
        const final = answers.at(-1)
        if (final?.error) {
          await request('/notify', { kind: 'api_error', message: final.error.message })
          return
        }
        const replied = answers.some((m: any) => m.content.some((p: any) =>
          p.type === 'tool' && /(?:^|_)(?:tg.?bridge|polydaemon).*reply$/i.test(p.name) && p.state?.status === 'completed'))
        const rawText = final?.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') ?? ''
        const pseudo = parsePseudoReply(rawText)
        const text = cleanAutoReply(rawText)
        if (!replied && pseudo) {
          await request('/auto-reply', { text: pseudo.text, chat_id: prompt.meta.chat_id,
            reply_to: pseudo.reply_to ?? prompt.meta.message_id, prompt_id: prompt.id })
        } else if (!replied && text) {
          await request('/auto-reply', { text, chat_id: prompt.meta.chat_id, prompt_id: prompt.id })
        }
      } catch (error) { if (!signal.aborted) console.error('PolyDaemon: final reply failed', error) }
      finally {
        waiting = false
        if (!signal.aborted && latest && used && latest.id !== used) void mirror()
      }
    }
    void (async () => {
      while (!signal.aborted) {
        try {
          const { item } = await request('/inbound')
          if (item) {
            if (item.meta.event !== 'reaction') {
              const admitted = await ctx.session.prompt({ sessionID, id: `msg_tg_${item.id}`,
                text: formatCodexInbound(item.content, item.meta), metadata: item.meta, delivery: 'steer' })
              latest = { id: admitted.id, meta: item.meta }
              void mirror()
            }
            await request('/inbound-ack', { id: item.id })
          }
        } catch (error) { if (!signal.aborted && own()) console.error('PolyDaemon: admission failed', error) }
        await sleep(1000, undefined, { signal }).catch(() => {})
      }
    })()
    return () => controller.abort()
  },
}
