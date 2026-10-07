import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { formatApprovalContext } from './permissions.ts'

test('approval context follows the execution worktree and handles unborn/detached/unavailable Git', () => {
  const scratch = resolve(import.meta.dir, '../../.local-test-artifacts')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'approval-context-'))
  const repo = join(home, 'repository & one')
  const nested = join(repo, 'nested')
  const noHooks = join(home, 'no-hooks')
  mkdirSync(nested, { recursive: true })
  mkdirSync(noHooks)
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' },
    })
    expect(r.status).toBe(0)
    return r.stdout.trim()
  }
  try {
    git('init', '-b', 'feature/with&scope')
    const expected = 'Repository: <code>repository &amp; one</code>\nBranch: <code>feature/with&amp;scope</code>'
    expect(formatApprovalContext({}, nested)).toBe(expected)
    expect(formatApprovalContext({ workdir: 'repository & one/nested' }, home)).toBe(expected)
    expect(formatApprovalContext({ cwd: nested }, home)).toBe(expected)
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${noHooks}`, 'commit', '--allow-empty', '-m', 'fixture')
    git('checkout', '--detach')
    expect(formatApprovalContext({}, nested)).toContain(`Branch: <code>detached HEAD (${git('rev-parse', '--short', 'HEAD')})</code>`)
    expect(formatApprovalContext({}, join(home, 'missing'))).toBe(
      'Repository: <code>unavailable</code>\nBranch: <code>unavailable</code>')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
