import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

function fixture(on: On, memory = false) {
  const clock = mock.clock(on)
  let visible = true
  let cwd = '/w'
  on('session.start', () => ({ cwd: '/w' }))
  on('command.register', () => ({ value: { command: 'sidebar' } }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.model', () => ({ value: 'fixture' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [] } }))
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
  return { clock, hide: () => { visible = false }, move: () => { cwd = '/other' } }
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
