import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('Claude transcript watcher starts after handshake, never for Codex', async () => {
  const home = mkdtempSync(join(process.env.HOME!, 'watcher-test-'))
  const server = resolve(import.meta.dir, '../server.ts')
  // Observe the real polling timer without waiting 20 seconds or contacting Telegram.
  const script = `
    const interval = globalThis.setInterval;
    globalThis.setInterval = (...args) => {
      if (args[1] === 20000) console.error('CLAUDE_WATCHER_STARTED');
      return interval(...args);
    };
    await import(${JSON.stringify(server)});
  `
  try {
    for (const name of ['codex-cli', 'claude-code', 'opencode']) {
      let stderr = ''
      const clientHome = mkdtempSync(join(home, name + '-'))
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--eval', script],
        cwd: clientHome,
        stderr: 'pipe',
        env: {
          HOME: clientHome,
          PATH: process.env.PATH!,
          TG_BOT_TOKEN: 'test-token',
          TG_BRIDGE_AUTH_TOKEN: 'test-auth',
          TG_BRIDGE_FORCE_CHANNELS: '1',
          TG_BRIDGE_BOT_URL: 'http://127.0.0.1:1',
          TG_API_ROOT: 'http://127.0.0.1:1',
          TG_BRIDGE_PORT: '0',
          ...(name === 'opencode' ? { TG_BRIDGE_AGENT: 'opencode' } : {}),
        },
      })
      transport.stderr!.on('data', chunk => { stderr += String(chunk) })
      const client = new Client({ name, version: 'test' })
      try {
        await transport.start()
        let ready = false
        for (let i = 0; i < 100 && !ready; i++) {
          try { ready = readFileSync(join(clientHome, '.tg-bridge-channel/debug.log'), 'utf8').includes('connecting MCP transport') } catch {}
          if (!ready) await Bun.sleep(20)
        }
        expect(ready).toBe(true)
        expect(stderr).not.toContain('CLAUDE_WATCHER_STARTED')
        // Client.connect normally starts the transport; it is already running here.
        transport.start = async () => {}
        await client.connect(transport)
        await client.listTools()
        await Bun.sleep(50)
        expect(stderr.includes('CLAUDE_WATCHER_STARTED')).toBe(name === 'claude-code')
      } finally {
        await client.close()
        await transport.close()
      }
    }
  } finally {
    rmSync(home, { recursive: true })
  }
}, 15_000)
