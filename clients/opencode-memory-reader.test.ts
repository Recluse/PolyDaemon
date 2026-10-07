import { test, expect } from 'bun:test'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { readProjectMemory, projectStatus, registerProjectMemory } from './opencode-memory-reader.ts'

const root = realpathSync(process.cwd())
const snapshot = { version: 1, repo: basename(root), root, checked_at: '2026-10-05T16:00:00Z',
  documents: { indexed: 12 }, chunks: { indexed: 34 },
  freshness: { state: 'stale', checked_at: '2026-10-05T16:00:00Z', stale: 1, unindexed: 2, missing: 3, reason: null },
  map: { state: 'available', components: 4, checked_at: '2026-10-05T16:00:00Z' } }

if (process.argv.includes('--fixture')) {
  const require = createRequire(new URL('../channel-plugin/package.json', import.meta.url))
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'project_status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false } }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    if (request.params.name !== 'project_status' || Object.keys(request.params.arguments).length) throw new Error('Unexpected call')
    return { structuredContent: snapshot, content: [{ type: 'text', text: JSON.stringify(snapshot) }] }
  })
  await server.connect(new StdioServerTransport())
} else {
  test('scoped real stdio status, strict counts, no false freshness, coalesced RPC', async () => {
    const config = { type: 'local', command: [process.execPath, import.meta.path, '--fixture'],
      environment: { HM_REPO: snapshot.repo, HM_ROOT: root } }
    const result = await readProjectMemory(config, root, AbortSignal.timeout(5000))
    expect(result.documents.indexed).toBe(12)
    expect(result.freshness.unindexed).toBe(2)
    expect(result).not.toHaveProperty('root')
    expect(() => projectStatus({ ...snapshot, repo: 'foreign' }, root, snapshot.repo)).toThrow('scope mismatch')
    expect(() => projectStatus({ ...snapshot, chunks: { indexed: -1 } }, root, snapshot.repo)).toThrow('contract')
    expect(() => projectStatus({ ...snapshot, freshness: { ...snapshot.freshness, state: 'fresh' } }, root, snapshot.repo)).toThrow('Incomplete')
    const unknown = projectStatus({ ...snapshot, documents: { indexed: null },
      freshness: { ...snapshot.freshness, state: 'unknown', stale: null } }, root, snapshot.repo)
    expect(unknown.documents.indexed).toBeNull()
    await expect(readProjectMemory({ ...config, disabled: true }, root, AbortSignal.timeout(5000))).rejects.toThrow('unavailable')
    let handlers: any, reads = 0, disposals = 0
    const ctx = { location: { directory: root }, rpc: { register: async (_: any, h: any) => { handlers = h } },
      tool: { list: async () => [{ id: 'custom_memory_project_status' }] },
      mcp: { list: async () => ({ data: [{ name: 'custom.memory', status: { status: 'connected' } }] }),
        transform: async (fn: any) => { reads++; fn({ get: () => config }); return { dispose: async () => { disposals++ } } } } }
    await registerProjectMemory(ctx, {})
    const context = { signal: AbortSignal.timeout(5000) }
    const a = handlers.status({}, context), b = handlers.status({}, context)
    expect(await a).toEqual(await b)
    expect((await handlers.status({}, context)).data.chunks.indexed).toBe(34)
    expect(reads).toBe(1)
    expect(disposals).toBe(1)
    expect(await handlers.bridge({ sessionID: 'foreign' })).toEqual({ state: 'unbound', topic: null })
  })
}
