import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DOWNTIME_MS } from './endpoint-chain.ts'

// A fake bot registry that can be taken down and brought back on the same port.
function fakeBot(name: string) {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = reservation.port
  reservation.stop(true)
  let server: ReturnType<typeof Bun.serve> | null = null
  let mode: 'bot' | 'proxy-page' | 'bare-null' | 'proxy-json' | 'refusal' = 'bot'
  const up = () => {
    server = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => {
      if (mode === 'proxy-page') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
      if (mode === 'bare-null') return Response.json(null)
      if (mode === 'proxy-json') return Response.json({ detail: 'Bad Gateway' }, { status: 502 })
      // The real registry refusing one operation (e.g. another window's task).
      if (mode === 'refusal') return Response.json({ ok: false, reason: 'not your task' }, { status: 403 })
      return Response.json({ ok: true, windows: [{ name, workspace: name }] })
    } })
  }
  const down = () => { server?.stop(true); server = null }
  up()
  return { port, up, down, setMode: (m: typeof mode) => { mode = m } }
}

const cleanup: (() => void)[] = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

async function session(primaryPort: number, reservePort: number) {
  mkdirSync('tmp', { recursive: true })
  const home = mkdtempSync(resolve('tmp/failover-'))
  cleanup.push(() => rmSync(home, { recursive: true, force: true }))
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'endpoint-failover.fixture.ts'),
    String(primaryPort), String(reservePort)], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH!, TG_BRIDGE_AUTH_TOKEN: 'fixture', TG_BOT_TOKEN: 'fixture' },
  })
  cleanup.push(() => child.kill())
  const reader = child.stdout.getReader()
  let buffered = ''
  const nextLine = async (): Promise<any> => {
    while (!buffered.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('fixture exited: ' + await new Response(child.stderr).text())
      buffered += new TextDecoder().decode(value)
    }
    const i = buffered.indexOf('\n')
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    return JSON.parse(line)
  }
  const send = async (line: string) => { child.stdin.write(line + '\n'); await child.stdin.flush(); return nextLine() }
  return { request: () => send('request'), advance: (ms: number) => send(`advance ${ms}`) }
}

test('a recovered primary is used again once its failure mark expires', async () => {
  const primary = fakeBot('primary'), reserve = fakeBot('reserve')
  cleanup.push(primary.down, reserve.down)
  const s = await session(primary.port, reserve.port)
  expect((await s.request()).answered).toBe('primary')
  primary.down()
  expect((await s.request()).answered).toBe('fail')        // this request is lost, not retried
  const onReserve = await s.request()
  expect(onReserve.answered).toBe('reserve')
  expect(onReserve.api_root).toContain(String(reserve.port))
  primary.up()
  await s.advance(DOWNTIME_MS + 1)
  const back = await s.request()
  expect(back.answered).toBe('primary')
  expect(back.api_root).toContain(String(primary.port))      // Bot API calls follow the same endpoint
})

test('a dead reserve is charged to the reserve, not to the healthy primary', async () => {
  const primary = fakeBot('primary'), reserve = fakeBot('reserve')
  cleanup.push(primary.down, reserve.down)
  const s = await session(primary.port, reserve.port)
  primary.down()
  expect((await s.request()).answered).toBe('fail')
  expect((await s.request()).answered).toBe('reserve')
  primary.up()
  reserve.down()
  await s.advance(5_000)
  // Primary still inside its cooldown: the request goes to the reserve and fails there.
  expect((await s.request()).answered).toBe('fail')
  // The failure marked the reserve down, so the next request reaches the primary.
  expect((await s.request()).answered).toBe('primary')
  expect((await s.request()).answered).toBe('primary')
})

test('both endpoints down: whichever comes back first is found', async () => {
  for (const comesBack of ['primary', 'reserve'] as const) {
    const primary = fakeBot('primary'), reserve = fakeBot('reserve')
    cleanup.push(primary.down, reserve.down)
    const s = await session(primary.port, reserve.port)
    primary.down(); reserve.down()
    expect((await s.request()).answered).toBe('fail')
    await s.advance(1_000)
    expect((await s.request()).answered).toBe('fail')
    ;(comesBack === 'primary' ? primary : reserve).up()
    const seen: string[] = []
    for (let i = 0; i < 40 && !seen.includes(comesBack); i++) {
      await s.advance(4_000)
      seen.push((await s.request()).answered)
    }
    expect(seen).toContain(comesBack)
    const last = await s.request()
    expect(last.answered).toBe(comesBack)
    while (cleanup.length) cleanup.pop()!()
  }
})

test('an answer that is not the registry does not count as recovery', async () => {
  for (const impostor of ['proxy-page', 'bare-null', 'proxy-json'] as const) {
    const primary = fakeBot('primary'), reserve = fakeBot('reserve')
    cleanup.push(primary.down, reserve.down)
    const s = await session(primary.port, reserve.port)
    primary.down()
    expect((await s.request()).answered).toBe('fail')
    expect((await s.request()).answered).toBe('reserve')
    primary.up()
    primary.setMode(impostor)                     // something answers on the port, not the bot
    await s.advance(DOWNTIME_MS + 1)
    const probe = await s.request()
    expect(probe.ok).toBe(false)                  // not reported as a successful operation
    const after = await s.request()
    expect(after.answered).toBe('reserve')
    expect(after.api_root).toContain(String(reserve.port))   // bindings never moved to the impostor
    while (cleanup.length) cleanup.pop()!()
  }
})

test('a refusal from the real registry is not an endpoint failure', async () => {
  const primary = fakeBot('primary'), reserve = fakeBot('reserve')
  cleanup.push(primary.down, reserve.down)
  const s = await session(primary.port, reserve.port)
  primary.setMode('refusal')
  for (let i = 0; i < 3; i++) {
    const r = await s.request()
    expect(r.ok).toBe(false)
    expect(r.bot_url).toContain(String(primary.port))     // no flapping to the reserve
  }
})
