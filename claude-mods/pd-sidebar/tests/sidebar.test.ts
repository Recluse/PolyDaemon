import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Engine, Mounted } from 'claude-code/testing'

// The kit's $ has no state noun: what the mod kept is read off its own pane.
// One mounted pane per test: it redraws as the mod's state changes.
const mounted = new WeakMap<Engine, Promise<Mounted<'terminal', 'Pane'>>>()
function renderOnly(on: On) {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
}
const pane = ($: Engine) => {
  let found = mounted.get($)
  if (!found) {
    found = $.ui.mount({ plugin: 'pd-sidebar', surface: 'terminal', component: 'Pane', requestId: 'pd-sidebar', props: { bodyColumns: 60 } as never })
    mounted.set($, found)
  }
  return found
}
const has = async ($: Engine, text: string | RegExp) => !!(await (await pane($)).find({ type: 'Text', text }))

const todoList = [
  { content: 'Write the mod', status: 'completed' as const, activeForm: 'Writing the mod' },
  { content: 'Test it', status: 'in_progress' as const, activeForm: 'Testing it' },
]

test('TodoWrite runs once and its list lands in state', async ($, on) => {
  renderOnly(on)
  let calls = 0
  on('tool.call', { tool: 'TodoWrite' }, () => {
    calls++
    return { result: { oldTodos: [], newTodos: todoList } as never }
  })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't1', todos: todoList })
  expect(calls).toBe(1)
  expect(await has($, 'Todo 1/2')).toBe(true)
  expect(await has($, /Testing it/)).toBe(true)
})

test('a failed state write never runs the tool again', async ($, on) => {
  renderOnly(on)
  let calls = 0
  on('tool.call', { tool: 'TodoWrite' }, () => {
    calls++
    return { result: { oldTodos: [], newTodos: todoList } as never }
  })
  on('state.set', { plugin: 'pd-sidebar' }, () => {
    throw new Error('state store down')
  })
  const ran = await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't2', todos: todoList })
  expect(calls).toBe(1)
  expect('deny' in ran && ran.deny).toBeFalsy()
})

test('edits are counted per file; failed edits are not', async ($, on) => {
  renderOnly(on)
  let fail = false
  on('tool.call', { tool: 'Edit' }, () => (fail ? { result: 'no match' as never, isError: true } : { result: {} as never }))
  const edit = (id: string) =>
    $.tool.call({ tool: 'Edit', tool_use_id: id, file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await edit('e1')
  await edit('e2')
  fail = true
  await edit('e3')
  expect(await has($, 'Edited 1')).toBe(true)
  expect(await has($, /×2/)).toBe(true)
  expect(await has($, /×3/)).toBe(false)
})

test('session tasks follow TaskCreate and TaskUpdate results', async ($, on) => {
  renderOnly(on)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'Ship it' } } as never }))
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({
    result: { success: e.taskId === '7', taskId: e.taskId, updatedFields: ['status'] } as never,
  }))
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'c1', subject: 'Ship it', description: 'd', activeForm: 'Shipping it' })
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'u1', taskId: '7', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'u2', taskId: '99', status: 'completed' })
  expect(await has($, 'Tasks 1 open')).toBe(true)
  expect(await has($, /▸ Shipping it/)).toBe(true)
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'u3', taskId: '7', status: 'deleted' })
  expect(await has($, 'Tasks')).toBe(true)
  expect(await has($, /Shipping it/)).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane draws every section on ${surface}`, async ($, on) => {
    renderOnly(on)
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: todoList } as never }))
    await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'r1', todos: todoList })
    const pane = await $.ui.mount({
      plugin: 'pd-sidebar',
      surface,
      component: 'Pane',
      requestId: 'pd-sidebar',
      props: { bodyColumns: 40 } as never,
    })
    for (const heading of ['Session', 'PolyDaemon', 'Tasks', 'Todo 1/2', 'Tools', 'Edited', 'Windows']) {
      expect(await pane.find({ type: 'Text', text: heading })).toBeTruthy()
    }
    expect(await pane.find({ type: 'Text', text: /Testing it/ })).toBeTruthy()
  })
}
