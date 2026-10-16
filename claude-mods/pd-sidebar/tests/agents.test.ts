import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

function fixture(on: On, memory = false, initiallyVisible = true) {
  const clock = mock.clock(on)
  let visible = initiallyVisible
  let cwd = '/w'
  let sessionGate: Promise<void> | undefined
  let usageCalls = 0
  on('session.start', () => ({ cwd: '/w' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.model', () => ({ value: 'fixture' }))
  on('session.usage', async () => {
    usageCalls++
    await sessionGate
    return { value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }
  })
  on('session.repo', () => ({ value: null }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('tool.list', () => ({ value: memory ? [{ name: 'mcp__HyperMnesia__project_status', description: '', mcp: true }] : [] }))
  on('ui.open', ($, e) => {
    if (e.id === 'pd-sidebar') expect(e.columns).toBe(44)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: visible ? [
    { id: 'pd-sidebar', isShown: true }, { id: 'pd-agent', isShown: true },
  ] as never : [] }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Inspect parser', type: 'Explore', status: 'running' as const }] }))
  return { clock, hide: () => { visible = false }, show: () => { visible = true }, move: () => { cwd = '/other' },
    gateSession: (gate?: Promise<void>) => { sessionGate = gate }, usageCalls: () => usageCalls }
}

test('a closed viewer rejects an in-flight transcript', async ($, on) => {
  const f = fixture(on)
  on('session.messages', async () => {
    await f.clock.sleep(100)
    return { value: [{ role: 'assistant' as const, text: 'late result', toolUses: [] }] }
  })
  await start($)
  await f.clock.settle()
  const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
  const pressing = sidebar.press({ key: 'agent:a1' })
  await f.clock.settle()
  const viewer = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-agent', props: { bodyColumns: 50 } as never })
  await viewer.press({ key: 'close-agent' })
  await f.clock.advance(100)
  await pressing
  expect(await viewer.find({ type: 'Text', text: /late result/ })).toBeFalsy()
})

const memoryStatus = () => ({ version: 1, root: '/w', repo: 'w', checked_at: '2026-10-13T12:00:00Z',
  documents: { indexed: 2 }, chunks: { indexed: 3 },
  freshness: { state: 'fresh', checked_at: '2026-10-13T12:00:00Z', stale: 0, unindexed: 0, missing: 0, reason: null },
  map: { state: 'available', components: 1, checked_at: '2026-10-13T12:00:00Z' } })

test('first visible render starts missing sources without waiting for a timer', async ($, on) => {
  const f = fixture(on, true, false)
  let calls = 0
  on('mcp.call', async () => {
    calls++
    await f.clock.sleep(100)
    return { value: { content: [], isError: false, structuredContent: memoryStatus() } }
  })
  await start($)
  await f.clock.settle()
  expect(calls).toBe(0)
  const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
  await f.clock.settle()
  expect(calls).toBe(0)
  f.show()
  await sidebar.redraw()
  await f.clock.settle()
  expect(calls).toBe(1)
  await sidebar.redraw()
  await f.clock.settle()
  expect(calls).toBe(1)
  await f.clock.advance(100)
  expect(await sidebar.find({ type: 'Text', text: /fresh/ })).toBeTruthy()
  expect(await sidebar.find({ type: 'Text', text: 'fixture' })).toBeTruthy()
  expect(await sidebar.find({ type: 'Text', text: /status helper not installed/ })).toBeTruthy()
})

test('memory deadline unlocks polling and rejects the expired response', async ($, on) => {
  const f = fixture(on, true)
  let calls = 0
  let release!: () => void
  const hanging = new Promise<void>(resolve => { release = resolve })
  on('mcp.call', async () => {
    const call = ++calls
    if (call === 1) await hanging
    return { value: { content: [], isError: false, structuredContent: {
      ...memoryStatus(), documents: { indexed: call === 1 ? 999 : 2 },
    } } }
  })
  await start($)
  await f.clock.settle()
  const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
  await f.clock.advance(15000)
  expect(calls).toBe(1)
  expect(await sidebar.find({ type: 'Text', text: /status unavailable/ })).toBeTruthy()
  await sidebar.redraw()
  await f.clock.settle()
  expect(calls).toBe(1)
  await f.clock.advance(45000)
  expect(calls).toBe(2)
  expect(await sidebar.find({ type: 'Text', text: /2 docs/ })).toBeTruthy()
  release()
  await f.clock.settle()
  expect(await sidebar.find({ type: 'Text', text: /999 docs/ })).toBeFalsy()
  expect(await sidebar.find({ type: 'Text', text: /2 docs/ })).toBeTruthy()
})

test('session deadline is unavailable rather than loading and allows a later retry', async ($, on) => {
  const f = fixture(on)
  let release!: () => void
  f.gateSession(new Promise<void>(resolve => { release = resolve }))
  await start($)
  await f.clock.settle()
  const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
  await f.clock.advance(8000)
  expect(f.usageCalls()).toBe(1)
  expect(await sidebar.find({ type: 'Text', text: 'Session status unavailable' })).toBeTruthy()
  await sidebar.redraw()
  await f.clock.settle()
  expect(f.usageCalls()).toBe(1)
  f.gateSession()
  await f.clock.advance(2000)
  expect(f.usageCalls()).toBe(2)
  expect(await sidebar.find({ type: 'Text', text: 'fixture' })).toBeTruthy()
  release()
  await f.clock.settle()
  expect(await sidebar.find({ type: 'Text', text: 'Session status unavailable' })).toBeFalsy()
})

test('memory failure clears fresh, and an in-flight old cwd never publishes', async ($, on) => {
  const f = fixture(on, true)
  let fail = false, slow = false
  on('mcp.call', async () => {
    if (fail) throw new Error('transport failure with private details')
    if (slow) await f.clock.sleep(100)
    return { value: { content: [], isError: false, structuredContent: memoryStatus() } }
  })
  await start($)
  await f.clock.settle()
  const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane',
    requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
  expect(await sidebar.find({ type: 'Text', text: /fresh/ })).toBeTruthy()
  fail = true
  await f.clock.advance(60000)
  expect(await sidebar.find({ type: 'Text', text: /fresh/ })).toBeFalsy()
  expect(await sidebar.find({ type: 'Text', text: /private details/ })).toBeFalsy()
  fail = false; slow = true
  await f.clock.advance(60000)
  f.move()
  await f.clock.advance(100)
  expect(await sidebar.find({ type: 'Text', text: /fresh/ })).toBeFalsy()
})

async function start($: Engine) {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`one press reads only the selected agent on ${surface}; denial and close clear content`, async ($, on) => {
    const f = fixture(on)
    let calls = 0
    let deny = false
    on('session.messages', async ($, e) => {
      calls++
      expect(e.agentId).toBe('a1')
      return deny ? { deny: 'not readable' } : { value: [{ role: 'assistant' as const, text: 'Parser inspected',
        toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'parser.ts' }, text: 'source' }] }] }
    })
    await start($)
    await f.clock.settle()
    const sidebar = await $.ui.mount({ plugin: 'pd-sidebar', surface, component: 'Pane',
      requestId: 'pd-sidebar', props: { bodyColumns: 50 } as never })
    expect(await sidebar.find({ key: 'agent:a1' })).toBeTruthy()
    await sidebar.press({ key: 'agent:a1' })
    const viewer = await $.ui.mount({ plugin: 'pd-sidebar', surface, component: 'Pane',
      requestId: 'pd-agent', props: { bodyColumns: 50 } as never })
    expect(await viewer.find({ type: 'Text', text: /Parser inspected/ })).toBeTruthy()
    expect(await viewer.find({ type: 'Text', text: /parser.ts/ })).toBeTruthy()
    expect(calls).toBe(1)
    deny = true
    await sidebar.press({ key: 'agent:a1' })
    expect(await viewer.find({ type: 'Text', text: /Agent messages unavailable/ })).toBeTruthy()
    expect(await viewer.find({ type: 'Text', text: /Parser inspected/ })).toBeFalsy()
    await viewer.press({ key: 'close-agent' })
    expect(await viewer.find({ type: 'Text', text: /Parser inspected/ })).toBeFalsy()
    f.hide()
    await f.clock.advance(65000)
    expect(calls).toBe(2)
  })
}
