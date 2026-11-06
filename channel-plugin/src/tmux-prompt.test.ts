import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyInjectRecords, tmuxInject, tmuxPromptEmpty, tmuxPromptState } from './tmux-prompt.ts'

const NBSP = '\u00a0'

describe('tmuxPromptEmpty', () => {
  test('an empty Claude Code prompt', () => {
    expect(tmuxPromptEmpty(`❯${NBSP}`, 2)).toBe(true)
    expect(tmuxPromptEmpty('❯ ', 2)).toBe(true)
  })
  test('two spaces left in the input (Tessera, 2026-10-29) are not empty', () => {
    expect(tmuxPromptEmpty(`❯${NBSP}  `, 4)).toBe(false)
  })
  test('a draft before or after the cursor', () => {
    expect(tmuxPromptEmpty(`❯${NBSP}draft`, 7)).toBe(false)
    expect(tmuxPromptEmpty(`❯${NBSP}draft`, 2)).toBe(false)
  })
  test('the cursor is not on a prompt line', () => {
    expect(tmuxPromptEmpty('', 0)).toBe(false)
    expect(tmuxPromptEmpty('  continued draft', 2)).toBe(false)
    expect(tmuxPromptEmpty('$ ', 2)).toBe(false)
  })
})

// A private tmux server in a directory of the test's own, so no live pane is touched.
const tmuxOk = Bun.spawnSync(['tmux', '-V']).exitCode === 0
const dir = mkdtempSync(join(import.meta.dir, '..', '.tmux-prompt-test-'))
const tmux = ['tmux', '-u', '-S', join(dir, 's')]
const runReal = (args: string[]) => {
  const r = Bun.spawnSync([...tmux, ...args])
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}
afterAll(() => {
  Bun.spawnSync([...tmux, 'kill-server'])
  rmSync(dir, { recursive: true, force: true })
})

function paneShowing(name: string, printed: string): string {
  // printf octal escapes: ❯ = \342\235\257, NBSP = \302\240.
  const r = Bun.spawnSync([...tmux, 'new-session', '-d', '-x', '80', '-y', '5', '-s', name, '-P', '-F', '#{pane_id}',
    `printf '${printed}'; sleep 30`], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
  expect(r.exitCode).toBe(0)
  Bun.sleepSync(300)
  return r.stdout.toString().trim()
}

describe.skipIf(!tmuxOk)('tmuxPromptState on a real pane', () => {
  test('an empty prompt is read as empty', () => {
    const pane = paneShowing('empty', '\\342\\235\\257\\302\\240')
    const s = tmuxPromptState(pane, runReal)!
    expect(s).not.toBeNull()
    expect(tmuxPromptEmpty(s.line, s.cursorX)).toBe(true)
  })
  test('leftover spaces in the input are seen', () => {
    const pane = paneShowing('spaces', '\\342\\235\\257\\302\\240  ')
    const s = tmuxPromptState(pane, runReal)!
    expect(s.cursorX).toBe(4)
    expect(tmuxPromptEmpty(s.line, s.cursorX)).toBe(false)
  })
  test('an unknown pane gives no state', () => {
    expect(tmuxPromptState('%99999', runReal)).toBeNull()
  })
})

const rec = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
const NATIVE = rec('/compact') + rec('<command-name>/compact</command-name>\n<command-message>compact</command-message>')

describe('classifyInjectRecords', () => {
  test('a native run', () => expect(classifyInjectRecords(NATIVE, '/compact')).toBe('confirmed'))
  test('the Tessera record: the command behind leftover spaces', () =>
    expect(classifyInjectRecords(rec('  /compact'), '/compact')).toBe('as_text'))
  test('the bare echo alone decides nothing yet', () =>
    expect(classifyInjectRecords(rec('/compact'), '/compact')).toBeNull())
  test('a Telegram message mentioning the command is not typed input', () =>
    expect(classifyInjectRecords(rec('<channel source="telegram">try /compact</channel>'), '/compact')).toBeNull())
  test('garbage and other records are skipped', () =>
    expect(classifyInjectRecords('{bad\n' + JSON.stringify({ type: 'assistant' }) + '\n', '/compact')).toBeNull())
})

// tmuxInject against a scripted tmux and a transcript file of the test's own.
function fakeTmux(screen: { state: string; line: string }, onSend: (args: string[]) => void = () => {}, sendExit = 0) {
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (args[0] === 'display') return { exitCode: 0, stdout: screen.state + '\n', stderr: '' }
    if (args[0] === 'capture-pane') return { exitCode: 0, stdout: screen.line + '\n', stderr: '' }
    onSend(args)
    return { exitCode: sendExit, stdout: '', stderr: sendExit ? 'no pane' : '' }
  }
  return { run, calls, sent: () => calls.filter(c => c[0] === 'send-keys') }
}
const EMPTY = { state: '0 2 61', line: `❯${NBSP}` }
const fast = { confirmMs: 60, sleep: (ms: number) => Bun.sleep(Math.min(ms, 10)) }

describe('tmuxInject', () => {
  const tdir = mkdtempSync(join(import.meta.dir, '..', '.tmux-inject-test-'))
  afterAll(() => rmSync(tdir, { recursive: true, force: true }))
  let n = 0
  const transcript = (initial = rec('earlier prompt')) => { const fp = join(tdir, `t${n++}.jsonl`); writeFileSync(fp, initial); return fp }

  test('a draft of spaces: nothing is typed, refused', async () => {
    const t = fakeTmux({ state: '0 4 61', line: `❯${NBSP}  ` })
    const r = await tmuxInject('%1', '/compact', { run: t.run, transcript: () => transcript(), ...fast })
    expect(r.outcome).toBe('refused')
    expect(t.sent()).toEqual([])
  })
  test('copy mode or an unreadable pane: refused', async () => {
    for (const state of ['1 2 61', '']) {
      const t = fakeTmux({ state, line: `❯${NBSP}` })
      expect((await tmuxInject('%1', '/compact', { run: t.run, ...fast })).outcome).toBe('refused')
      expect(t.sent()).toEqual([])
    }
  })
  test('confirmed only once the transcript shows the command running', async () => {
    const fp = transcript(NATIVE)   // an OLD native run before the send must not count
    const t = fakeTmux(EMPTY, a => { if (a[3] === 'Enter') appendFileSync(fp, NATIVE) })
    const r = await tmuxInject('%1', '/compact', { run: t.run, transcript: () => fp, ...fast })
    expect(r.outcome).toBe('confirmed')
    expect(t.sent().map(a => a.slice(3))).toEqual([['-l', '/compact'], ['Enter']])
  })
  test('an old native run alone is not a confirmation', async () => {
    const fp = transcript(NATIVE)
    const r = await tmuxInject('%1', '/compact', { run: fakeTmux(EMPTY).run, transcript: () => fp, ...fast })
    expect(r.outcome).toBe('unconfirmed')
  })
  // The race that remains: the prompt was empty when checked, the person typed
  // before the keys landed. The guard cannot see it; the transcript does.
  test('race: input typed between the check and the keys is caught as text', async () => {
    const fp = transcript()
    const t = fakeTmux(EMPTY, a => { if (a[3] === 'Enter') appendFileSync(fp, rec('x/compact')) })
    const r = await tmuxInject('%1', '/compact', { run: t.run, transcript: () => fp, ...fast })
    expect(r.outcome).toBe('as_text')
  })
  test('race with no trace in the transcript stays unconfirmed, never success', async () => {
    const fp = transcript()
    const r = await tmuxInject('%1', '/compact', { run: fakeTmux(EMPTY).run, transcript: () => fp, ...fast })
    expect(r.outcome).toBe('unconfirmed')
  })
  test('no transcript to read: unconfirmed', async () => {
    const r = await tmuxInject('%1', '/compact', { run: fakeTmux(EMPTY).run, transcript: () => null, ...fast })
    expect(r.outcome).toBe('unconfirmed')
  })
  test('tmux cannot type: failed', async () => {
    const r = await tmuxInject('%1', '/compact', { run: fakeTmux(EMPTY, () => {}, 1).run, transcript: () => transcript(), ...fast })
    expect(r).toEqual({ outcome: 'failed', reason: 'tmux send-keys failed: no pane' })
  })
})
