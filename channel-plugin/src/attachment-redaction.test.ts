// Real MCP server, fake local Bot API and a fake `docker` that fails the copy and
// echoes its arguments (as the real one does). The bot token sits in the
// server-side file path; it must not reach the tool result the model sees.
import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createServer } from 'net'

test('a failed attachment copy does not put the bot token into the tool result', async () => {
  const root = resolve(import.meta.dir, '../..')
  const scratch = join(root, '.local-test-artifacts')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'attachment-'))
  const workspace = join(home, 'project')
  mkdirSync(workspace)
  const docker = join(home, 'fake-docker')
  writeFileSync(docker, '#!/bin/sh\necho "Error response from daemon: Could not find the file $2" >&2\nexit 1\n')
  chmodSync(docker, 0o755)
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(r => socket.close(() => r()))
  const fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/register' || path === '/heartbeat') return Response.json({ ok: true, topic_binding: null })
    // A refusal whose reason quotes secrets and a local path (as an error text might).
    if (path === '/route-window') {
      return Response.json({ ok: false, reason: `token secret-auth-fixture rejected, see ${home}/x.log` }, { status: 404 })
    }
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123, is_bot: true, first_name: 'F' } })
    if (path.endsWith('/getFile')) {
      return Response.json({ ok: true, result: { file_id: 'f1', file_unique_id: 'u1', file_path: 'documents/file_1.pdf' } })
    }
    return Response.json({ ok: true, result: true })
  } })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(TG_|CLAUDE_|CODEX_)/.test(k)) env[k] = v
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TG_BOT_TOKEN: '123:secret-fixture-token',
    TG_BRIDGE_AUTH_TOKEN: 'secret-auth-fixture', TG_BRIDGE_FORCE_CHANNELS: '1', TG_BRIDGE_PORT: String(port),
    TG_BRIDGE_BIND_HOST: '127.0.0.1', TG_BRIDGE_BOT_URL: fake.url.origin, TG_API_ROOT: fake.url.origin,
    TG_BOTAPI_DOCKER: docker })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'channel-plugin/server.ts')],
    cwd: workspace, env, stderr: 'pipe' })
  const client = new Client({ name: 'claude-code', version: 'fixture' })
  try {
    await client.connect(transport)
    const result: any = await client.callTool({ name: 'download_attachment', arguments: { file_id: 'f1' } })
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result)
    expect(text).toContain('Could not find the file')   // the copy really failed with the path in stderr
    expect(text).not.toContain('secret-fixture-token')
    expect(text).not.toContain('secret-auth-fixture')

    // Ordinary failure results (not exceptions) are redacted too.
    const told: any = await client.callTool({ name: 'tell_window', arguments: { name: 'other', message: 'hi' } })
    const toldText = JSON.stringify(told)
    expect(toldText).toContain('rejected')
    expect(toldText).not.toContain('secret-auth-fixture')
    expect(toldText).not.toContain(home)
  } finally {
    await client.close().catch(() => {})
    fake.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
