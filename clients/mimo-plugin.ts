import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { guardInput } from './bridge-tool-input.ts'
import { binding, bridgeRequest, isInboundMessage } from './mimo-bridge.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

export default { id: 'polydaemon.mimo', server: async (ctx: any) => {
  const cwd = realpathSync(ctx.directory)
  if (process.env.TG_MIMO_ROOT !== cwd) return {}
  const native = async (path: string, body?: unknown) => {
    const url = new URL(path, ctx.serverUrl)
    url.searchParams.set('directory', cwd)
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.MIMOCODE_SERVER_USERNAME || 'mimocode'}:${process.env.MIMOCODE_SERVER_PASSWORD}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`MiMo HTTP ${response.status}`)
    return response.json()
  }
  async function owns(id: string) {
    const bound = binding(cwd)
    for (let depth = 0; id && depth < 32; depth++) {
      if (id === bound.sessionID) return true
      const session = await native(`/session/${encodeURIComponent(id)}`)
      if (realpathSync(session.directory) !== cwd) return false
      id = session.parentID
    }
    return false
  }
  async function approve(tool: string, input: unknown) {
    const result = await bridgeRequest(cwd, '/approve-request', { cwd, tool_name: tool, tool_input: input, sensitive: true }, AbortSignal.timeout(86460000))
    if (result.decision !== 'allow' && result.decision !== 'deny') throw new Error('PolyDaemon: no approval decision received')
    return result.decision === 'allow'
  }
  const approved = new Set<string>()
  return {
    config: async (config: any) => {
      if (!Object.keys(config.mcp ?? {}).some(name => /^(HyperMnesia|agentmem)$/i.test(name)) && process.env.TG_MIMO_MEMORY) {
        config.mcp ??= {}
        config.mcp.HyperMnesia = JSON.parse(process.env.TG_MIMO_MEMORY)
        config.permission = { ...(typeof config.permission === 'string' ? { '*': config.permission } : config.permission), HyperMnesia_memory_write: 'deny', HyperMnesia_memory_supersede: 'deny' }
      }
      if (process.env.TG_MIMO_BINDING) writeFileSync(`${process.env.TG_MIMO_BINDING}.ready`, JSON.stringify({ root: cwd, version: 1 }), { mode: 0o600 })
    },
    'session.pre': async (event: any, output: any) => {
      try {
        if (!await owns(event.sessionID)) throw new Error('Unbound session')
        const config = await native('/config')
        const required = Object.entries(config.mcp ?? {}).filter(([, c]: any) => c.enabled !== false).map(([name]) => name)
        for (let i = 0; i < 300; i++) {
          const status = await native('/mcp')
          if (required.every(name => status[name]?.status === 'connected')) return
          if (required.some(name => ['failed', 'needs_auth'].includes(status[name]?.status))) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('MCP not ready')
      } catch {
        output.cancel = true
        output.cancelReason = 'PolyDaemon: session or MCP is not ready; no model request sent'
      }
    },
    'experimental.chat.system.transform': async (event: any, output: any) => {
      if (event.sessionID && await owns(event.sessionID)) output.system.push(
        'Telegram messages carry source=telegram metadata. Call the native PolyDaemon_reply MCP tool with chat_id and text for the final answer. Do not print a JSON tool invocation as text. Push/deploy and access outside the project require owner approval. Never resolve approvals on behalf of the owner.')
    },
    'tool.execute.before': async (event: any, output: any) => {
      try {
        if (!await owns(event.sessionID)) throw new Error('Unbound session')
        const input = guardInput(event.tool, output.args, cwd, 'mimo')
        const call = spawnSync('node', [join(repo, 'hooks/tg-approve.js'), '--classify'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 })
        if (call.status !== 0) throw new Error('Guard failed')
        if (JSON.parse(call.stdout).sensitive) {
          if (!await approve(event.tool, output.args)) throw new Error('Owner did not approve')
          approved.add(`${event.sessionID}:${event.callID}:${event.tool}`)
        }
        const detail = output.args?.command ?? output.args?.filePath ?? ''
        await bridgeRequest(cwd, '/progress', { tool_name: event.tool, summary: `${event.tool}: ${detail}`.slice(0, 200) }).catch(() => {})
      } catch {
        output.cancel = true
        output.cancelReason = 'PolyDaemon: action not approved or guard unavailable'
      }
    },
    'tool.execute.after': async (event: any) => { approved.delete(`${event.sessionID}:${event.callID}:${event.tool}`) },
    event: async ({ event }: any) => {
      if (event.type !== 'permission.asked') return
      const p = event.properties
      // Do not block the event bus while waiting for the human's callback.
      void (async () => {
        if (!await owns(p.sessionID)) return
        const key = `${p.sessionID}:${p.tool?.callID}:${p.permission}`
        let allowed = approved.delete(key)
        if (!allowed) allowed = await approve(p.permission, { patterns: p.patterns, ...p.metadata })
        await native(`/permission/${encodeURIComponent(p.id)}/reply`, { reply: allowed ? 'once' : 'reject' })
      })().catch(async error => {
        // Leave the native request pending. A lost response is not a new decision;
        // in particular, never follow a possibly delivered allow with reject.
        console.error('PolyDaemon: approval transport failed', p.id, error)
        await bridgeRequest(cwd, '/notify', { kind: 'api_error',
          message: `MiMo: ошибка передачи разрешения (${p.id}). Доставка решения не подтверждена; отказ вместо ошибки не отправлялся. Проверь запрос в консоли.` }).catch(() => {})
      })
    },
    'session.post': async (event: any) => {
      if (event.outcome !== 'completed' && await owns(event.sessionID)) {
        const messages = await native(`/session/${event.sessionID}/message`)
        const assistant = messages.find((m: any) => m.info.id === event.assistantMessageID)
        const user = assistant ? messages.find((m: any) => m.info.id === assistant.info.parentID)
          : messages.findLast((m: any) => m.info.role === 'user')
        // The durable Telegram pump owns error delivery and ack for this input.
        if (isInboundMessage(user)) return
        await bridgeRequest(cwd, '/notify', { kind: 'api_error', message: `MiMo turn ${event.outcome}; see console for details` }).catch(() => {})
      }
    },
  }
} }
