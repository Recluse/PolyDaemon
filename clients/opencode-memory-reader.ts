import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const require = createRequire(new URL('../channel-plugin/package.json', import.meta.url))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const count = (n: unknown) => n === null || (Number.isSafeInteger(n) && Number(n) >= 0)
const timestamp = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s))

export function projectStatus(value: any, cwd: string, repo: string) {
  if (value?.version !== 1 || value.repo !== repo || typeof value.root !== 'string'
      || realpathSync(value.root) !== realpathSync(cwd)) throw new Error('Memory project scope mismatch')
  if (!timestamp(value.checked_at) || !count(value.documents?.indexed) || !count(value.chunks?.indexed)
      || !['fresh', 'stale', 'unknown', 'error'].includes(value.freshness?.state)
      || !['available', 'missing', 'unknown'].includes(value.map?.state)
      || !count(value.map?.components)
      || !['stale', 'unindexed', 'missing'].every(k => count(value.freshness[k]))
      || ![value.freshness.checked_at, value.map.checked_at].every(t => t === null || timestamp(t))
      || !(value.freshness.reason === null || typeof value.freshness.reason === 'string')) {
    throw new Error('Invalid memory status contract')
  }
  if (value.freshness.state === 'fresh' && (value.documents.indexed === null || value.chunks.indexed === null
      || value.freshness.checked_at === null || ['stale', 'unindexed', 'missing'].some(k => value.freshness[k] !== 0))) {
    throw new Error('Incomplete memory freshness check')
  }
  // Only the agreed fields leave the reader; no credentials or unscoped backend extras.
  return { version: 1, repo: value.repo, checked_at: value.checked_at,
    documents: { indexed: value.documents.indexed }, chunks: { indexed: value.chunks.indexed },
    freshness: { state: value.freshness.state, checked_at: value.freshness.checked_at,
      stale: value.freshness.stale, unindexed: value.freshness.unindexed, missing: value.freshness.missing,
      reason: value.freshness.reason },
    map: { state: value.map.state, components: value.map.components, checked_at: value.map.checked_at } }
}

export async function readProjectMemory(config: any, cwd: string, signal: AbortSignal) {
  if (config.type !== 'local' || config.disabled || config.protocol === 'acp') throw new Error('Memory MCP is unavailable')
  const env = config.environment ?? {}
  const workdir = resolve(cwd, config.cwd ?? cwd)
  const root = resolve(workdir, env.HM_ROOT ?? env.AGENTMEM_ROOT ?? workdir)
  if (realpathSync(root) !== realpathSync(cwd)) throw new Error('Memory project scope mismatch')
  const repo = env.HM_REPO ?? env.AGENTMEM_REPO ?? basename(workdir)
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error('Invalid memory repo scope')
  const client = new Client({ name: 'polydaemon-project-status', version: '1' })
  const transport = new StdioClientTransport({ command: config.command[0], args: config.command.slice(1),
    cwd: workdir, env: { ...process.env, ...env }, stderr: 'ignore' })
  const cancel = () => { void transport.close() }
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await client.connect(transport, { signal, timeout: 10000 })
    const catalog = await client.listTools({}, { signal, timeout: 10000 })
    const tool = catalog.tools.find((t: any) => t.name === 'project_status')
    if (!tool || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false) {
      throw new Error('Read-only project_status is not supported')
    }
    const result = await client.callTool({ name: 'project_status', arguments: {} }, undefined, { signal, timeout: 20000 })
    if (result.isError) throw new Error('Memory project check failed')
    const value = result.structuredContent ?? JSON.parse(result.content.find((p: any) => p.type === 'text')?.text ?? '')
    return projectStatus(value, cwd, repo)
  } finally {
    signal.removeEventListener('abort', cancel)
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

export async function registerProjectMemory(ctx: any, rpc: any, bridge: (input: any) => Promise<any> = async () => ({ state: 'unbound', topic: null })) {
  let pending: Promise<any> | null = null
  let checked = 0
  let last: any
  await ctx.rpc.register(rpc, { bridge, status: async (_: unknown, context: any) => {
    if (pending) return pending
    const ttl = last?.state === 'unknown' || last?.state === 'pending' ? 5000 : 60000
    if (last && Date.now() - checked < ttl) return last
    pending = (async () => {
      let server: string | null = null
      try {
        const tools = await ctx.tool.list()
        const { data: servers } = await ctx.mcp.list()
        const candidates = servers.filter((s: any) => tools.some((t: any) => t.id === `${s.name.replace(/[^A-Za-z0-9_-]/g, '_')}_project_status`))
        if (candidates.length !== 1) return { server: null, data: null, state: 'unknown', reason: candidates.length ? 'Multiple memory servers' : 'project_status not available' }
        server = candidates[0].name
        if (candidates[0].status.status !== 'connected') return { server, data: null, state: candidates[0].status.status, reason: 'Memory MCP not connected' }
        let config: any
        const inspection = await ctx.mcp.transform((editor: any) => { config = editor.get(server) })
        await inspection.dispose()
        const data = await readProjectMemory(config, ctx.location.directory, context.signal)
        return { server, data, state: 'connected', reason: null }
      } catch (error) {
        // Never expose raw transport/DB errors, which can contain credentials.
        const reason = error instanceof Error && /^(Memory project scope mismatch|Invalid memory (repo scope|status contract)|Incomplete memory freshness check|Read-only project_status is not supported|Memory MCP is unavailable)$/.test(error.message)
          ? error.message : 'Memory project check unavailable'
        return { server, data: null, state: 'error', reason }
      }
    })()
    try { last = await pending; checked = Date.now(); return last }
    finally { pending = null }
  } })
}
