import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listTree, readProjectFile } from './files.ts'

test('project viewer skips symlinks, rejects escapes, and caps file reads', () => {
  const home = mkdtempSync(join(tmpdir(), 'polydaemon-files-'))
  const root = join(home, 'project')
  mkdirSync(root)
  try {
    writeFileSync(join(home, 'private.txt'), 'outside')
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(1024 * 1024))
    symlinkSync(home, join(root, 'outside'))
    symlinkSync(root, join(root, 'cycle'))
    expect(listTree(root).tree.map(n => n.name)).toEqual(['large.txt'])
    expect(readProjectFile(root, 'outside/private.txt').ok).toBe(false)
    expect(readProjectFile(root, '../private.txt').ok).toBe(false)
    const result = readProjectFile(root, 'large.txt')
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.content?.length).toBe(512 * 1024)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
