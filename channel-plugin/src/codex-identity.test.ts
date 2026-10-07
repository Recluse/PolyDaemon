import { test, expect } from 'bun:test'

// No live bot/network is used: validate the actual consumers after the same
// identity override the MCP initialize callback applies.
process.env.TG_BOT_TOKEN = 'test-token'
process.env.TG_BRIDGE_AUTH_TOKEN = 'test-auth'
const config = await import('./config.ts')
const { setNameOverride } = await import('./registry.ts')
const { ensureWorkspaceHeader } = await import('./markdown.ts')
const rpc = await import('./bot-rpc.ts')

test('Codex handshake updates headers, RPC sender and topic key; Claude stays unsuffixed', async () => {
  const oldName = config.INSTANCE_NAME
  const oldFetch = globalThis.fetch
  const requests: { path: string; body: any }[] = []
  globalThis.fetch = (async (url: any, options: any) => {
    requests.push({ path: String(url), body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ ok: true, windows: [] }), { status: 200 })
  }) as typeof fetch
  try {
    config.setWorkspaceIdentity('infra-win')
    expect(config.workspaceBindingKey()).toBe(config.canonicalCwd(process.cwd()))
    expect(ensureWorkspaceHeader('test')).toBe('**infra-win →**\ntest')
    setNameOverride('infra-win-codex')
    expect(config.INSTANCE_NAME).toBe('infra-win-codex')
    expect(config.WORKSPACE_DISPLAY_NAME).toBe('infra-win-codex')
    expect(ensureWorkspaceHeader('test')).toBe('**infra-win-codex →**\ntest')
    expect(config.workspaceBindingKey()).toBe(`${config.canonicalCwd(process.cwd())}#codex`)
    await rpc.heartbeatRemote('test-id')
    expect(requests.at(-1)!.body.cwd).toBe(config.canonicalCwd(process.cwd()))
    await rpc.listWindowsRemote()
    expect(requests.at(-1)!.body.from).toBe('infra-win-codex')
    await rpc.routeWindowRemote('other', 'test', 'tell')
    expect(requests.at(-1)!.body.from).toBe('infra-win-codex')
    await rpc.myTasksRemote()
    expect(requests.at(-1)!.body.window).toBe('infra-win-codex')
    setNameOverride('infra-win-opencode')
    expect(config.workspaceBindingKey()).toBe(`${config.canonicalCwd(process.cwd())}#opencode`)
    expect(ensureWorkspaceHeader('test')).toBe('**infra-win-opencode →**\ntest')
    await rpc.listWindowsRemote()
    expect(requests.at(-1)!.body.from).toBe('infra-win-opencode')
  } finally {
    globalThis.fetch = oldFetch
    setNameOverride(oldName)
  }
})
