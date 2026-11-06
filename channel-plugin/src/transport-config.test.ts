import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readTransportConfig } from './transport-config.ts'

test('temporary transport is explicit, loopback-only and fails closed', () => {
  const parent = resolve(import.meta.dir, '../../tmp')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'transport-test-'))
  const path = join(dir, 'transport.json')
  const value = { version: 1, bot_url: 'http://127.0.0.1:18090', api_root: 'http://127.0.0.1:18081',
    botapi_ssh: 'attachment-host', botapi_container: 'polyd-bot-api' }
  try {
    expect(readTransportConfig(path)).toEqual({})
    writeFileSync(path, JSON.stringify(value))
    expect(readTransportConfig(path)).toEqual(value)
    for (const patch of [{ version: 2 }, { api_root: 'http://remote:8081' }, { bot_url: 'http://127.0.0.1:18090/x' },
      { bot_url: 'http://secret@127.0.0.1:18090' }, { botapi_ssh: '-oProxyCommand=sh' }, { botapi_container: 'x;id' }, { token: 'unrelated' }]) {
      writeFileSync(path, JSON.stringify({ ...value, ...patch }))
      expect(() => readTransportConfig(path)).toThrow()
    }
    writeFileSync(path, '{')
    expect(() => readTransportConfig(path)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v2 endpoint chain is ordered, strict and rejects partial routes', () => {
  const parent = resolve(import.meta.dir, '../../tmp')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'transport-test-'))
  const path = join(dir, 'transport.json')
  const endpoint = { bot_url: 'http://127.0.0.1:18090', api_root: 'http://127.0.0.1:18081',
    botapi_ssh: 'attachment-host', botapi_container: 'polyd-bot-api' }
  const value = { version: 2, endpoints: [endpoint, { ...endpoint, bot_url: 'http://127.0.0.1:28090' }] }
  try {
    writeFileSync(path, JSON.stringify(value))
    expect(readTransportConfig(path)).toEqual(value)
    for (const patch of [
      { endpoints: [] },                       // empty chain
      { endpoints: [endpoint, endpoint, endpoint, endpoint, endpoint] },  // > 4
      { endpoints: [{ ...endpoint, bot_url: 'https://api.telegram.org' }] },  // wrong scheme
      { endpoints: [{ ...endpoint, extra: 1 }] },  // unknown key
      { endpoints: [endpoint], bot_url: endpoint.bot_url },  // mixed with v1 fields
    ]) {
      writeFileSync(path, JSON.stringify({ ...value, ...patch }))
      expect(() => readTransportConfig(path)).toThrow()
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the transport.json example in docs/ha-failover.md passes the validator', () => {
  const doc = readFileSync(resolve(import.meta.dir, '../../docs/ha-failover.md'), 'utf8')
  const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]).filter(b => b.includes('"endpoints"'))
  expect(examples.length).toBeGreaterThan(0)
  const parent = resolve(import.meta.dir, '../../tmp')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'transport-doc-'))
  try {
    for (const example of examples) {
      const path = join(dir, 'transport.json')
      writeFileSync(path, example)
      expect(readTransportConfig(path)).toEqual(JSON.parse(example))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
