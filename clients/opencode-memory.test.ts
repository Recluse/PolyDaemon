import { expect, test } from 'bun:test'
import { memoryStatus } from './opencode-memory.ts'

test('memory status uses only observed map calls and current MCP state', () => {
  const server = { name: 'custom-memory', status: { status: 'connected' } }
  const result = (text: string, status = 'completed') => [{ type: 'assistant', content: [
    { type: 'tool', name: 'custom-memory_get_project_map', state: { status, content: [{ type: 'text', text }] } },
  ] }]
  expect(memoryStatus([], [server])).toEqual({ connection: 'Not identified', map: 'Not checked' })
  expect(memoryStatus(result('# PROJECT MAP\n'), [server])).toEqual({ connection: 'connected', map: 'Available (observed)' })
  expect(memoryStatus(result("[no structural map for repo 'project' yet — its docs are searchable]"), [server]).map).toBe('Missing')
  expect(memoryStatus(result('(none)'), [server]).map).toBe('Unknown')
  expect(memoryStatus(result('(!) SCOPE: wrong tag\n# PROJECT MAP\n'), [server]).map).toBe('Scope warning')
  expect(memoryStatus(result('(!) STALE MAP: refresh failed\n# PROJECT MAP\n'), [server]).map).toBe('Stale (observed)')
  expect(memoryStatus(result('failed', 'error'), [server]).map).toBe('Error')
  expect(memoryStatus(result('', 'running'), [server]).map).toBe('Checking')
  expect(memoryStatus(result('# PROJECT MAP\n'), [{ ...server, status: { status: 'failed' } }]).connection).toBe('failed')
  expect(memoryStatus(result('# PROJECT MAP\n'), [])).toEqual({ connection: 'Unknown', map: 'Available (observed)' })
  expect(memoryStatus([{ type: 'user', content: result('# PROJECT MAP\n')[0].content }], [server]).map).toBe('Not checked')
  expect(memoryStatus([...result('# PROJECT MAP\n'), ...result('failed', 'error')], [server]).map).toBe('Error')
})
