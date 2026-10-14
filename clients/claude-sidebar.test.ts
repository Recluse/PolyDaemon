import { expect, test } from 'bun:test'
import { plain, projectStatus, transcript } from '../claude-mods/pd-sidebar/hooks/content'

const status = () => ({ version: 1, root: '/w', repo: 'w', checked_at: '2026-10-13T12:00:00Z',
  freshness: { state: 'fresh', checked_at: '2026-10-13T12:00:00Z', stale: 0, unindexed: 0, missing: 0, reason: null },
  documents: { indexed: 2 }, chunks: { indexed: 3 },
  map: { state: 'available', components: 1, checked_at: '2026-10-13T12:00:00Z' } })

test('memory requires exact identity, version, enums, timestamps and coherent freshness', () => {
  expect(projectStatus(status(), '/w')?.documents).toBe(2)
  expect(projectStatus(status(), '/other')).toBeNull()
  for (const patch of [{ version: 2 }, { checked_at: 'yesterday' }, { root: '/w/../other' },
    { documents: { indexed: -1 } }, { chunks: { indexed: false } }, { map: { state: 'ready' } }]) {
    expect(projectStatus({ ...status(), ...patch }, '/w')).toBeNull()
  }
  for (const patch of [{ state: 'ready' }, { unindexed: 1 }, { checked_at: null }, { stale: null }, { missing: 1.5 }]) {
    expect(projectStatus({ ...status(), freshness: { ...status().freshness, ...patch } }, '/w')).toBeNull()
  }
  const unknown = { ...status(), freshness: { state: 'unknown', checked_at: null, stale: null,
    unindexed: null, missing: null, reason: 'unavailable' }, documents: { indexed: null } }
  expect(projectStatus(unknown, '/w')?.documents).toBeNull()
  expect(projectStatus(unknown, '/w')?.state).toBe('unknown')
})

test('agent transcript preserves messages and tools, treats denial as unavailable, bounds output', () => {
  expect(transcript({ deny: 'private details' })).toEqual({ state: 'unavailable', text: 'Agent messages unavailable' })
  expect(transcript(null).state).toBe('unavailable')
  expect(transcript([]).text).toBe('No messages yet')
  const rendered = transcript([{ role: 'assistant', text: 'Result', thinking: 'not for display',
    toolUses: [{ tool: 'Read', input: { file_path: 'a.ts' }, text: 'contents' }],
    toolResults: [{ tool_use_id: '1', text: 'failed', isError: true }] }]).text
  for (const word of ['Result', 'Read', 'a.ts', 'contents', 'failed', '(error)']) expect(rendered).toContain(word)
  expect(rendered).not.toContain('not for display')
  const long = transcript(Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', text: `${i}:` + 'x'.repeat(3000) })))
  expect(long.text.length).toBeLessThan(18100)
  expect(long.text).toContain('99:')
  expect(long.text).not.toContain('0:')
  expect(plain('a\x1bb\x00c')).toBe('abc')
})
