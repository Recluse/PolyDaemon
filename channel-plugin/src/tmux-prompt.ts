// Typing a slash command into a Claude Code TUI that runs in a tmux pane, and
// telling what came of it.
//
// Typed keys append to whatever the input already holds: on 2026-10-29 two
// spaces left in Tessera's input turned an injected "/compact" into the plain
// prompt "  /compact", which the TUI sent to the model, and the bot reported
// success. So the command is typed only from an empty prompt, and success is
// claimed only when the transcript shows the TUI ran it.
//
// The emptiness check and the keystrokes are separate tmux calls; a person
// typing in between is NOT excluded (no atomicity is claimed). The transcript
// check after sending is what catches that case.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** Claude Code draws the prompt as "❯" plus one (non-breaking) space and leaves
 *  the cursor right after it when the input is empty. Anything else, including
 *  whitespace, a ghost suggestion, a wrapped draft or a dialog, counts as not
 *  empty: refusing there is safe, typing is not. */
export function tmuxPromptEmpty(line: string, cursorX: number): boolean {
  return /^❯[ \u00a0]/.test(line) && cursorX === 2 && line.slice(2).trim() === ''
}

type Run = (args: string[]) => { exitCode: number; stdout: string; stderr: string }

export const runTmux: Run = args => {
  const r = Bun.spawnSync(['tmux', ...args])
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

/** The cursor line and column of `pane`; null when tmux cannot tell or the pane
 *  is in copy mode (the cursor then is not the input's). */
export function tmuxPromptState(pane: string, run: Run = runTmux): { line: string; cursorX: number } | null {
  const pos = run(['display', '-p', '-t', pane, '#{pane_in_mode} #{cursor_x} #{cursor_y}'])
  const m = pos.exitCode === 0 ? pos.stdout.trim().match(/^0 (\d+) (\d+)$/) : null
  if (!m) return null
  const row = run(['capture-pane', '-p', '-t', pane, '-S', m[2], '-E', m[2]])
  if (row.exitCode !== 0) return null
  return { line: row.stdout.replace(/\n$/, ''), cursorX: Number(m[1]) }
}

export type InjectOutcome =
  | 'confirmed'    // the transcript records the TUI running the command
  | 'as_text'      // the transcript records it reaching the model as a prompt
  | 'unconfirmed'  // keys were typed; the transcript showed neither in time
  | 'refused'      // nothing typed: the prompt was not provably empty
  | 'failed'       // tmux could not type

/** Decide from transcript records written after the keys were sent; null while
 *  undecided. A native command first echoes the bare command as a user record,
 *  then a <command-name> record. Channel messages ("<channel …") are not typed
 *  input and are ignored. */
export function classifyInjectRecords(jsonl: string, cmd: string): 'confirmed' | 'as_text' | null {
  const name = cmd.split(' ')[0]
  for (const line of jsonl.split('\n')) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    const c = r?.type === 'user' ? r.message?.content : undefined
    if (typeof c !== 'string') continue
    if (c.includes(`<command-name>${name}</command-name>`)) return 'confirmed'
    if (c === cmd || c.startsWith('<')) continue
    if (c.includes(cmd)) return 'as_text'
  }
  return null
}

function fileSize(fp: string): number {
  try { const fd = openSync(fp, 'r'); try { return fstatSync(fd).size } finally { closeSync(fd) } } catch { return 0 }
}

function readFrom(fp: string, offset: number): string {
  try {
    const fd = openSync(fp, 'r')
    try {
      const len = Math.max(0, fstatSync(fd).size - offset)
      const b = Buffer.allocUnsafe(len)
      return b.toString('utf8', 0, readSync(fd, b, 0, len, offset))
    } finally { closeSync(fd) }
  } catch { return '' }
}

export type TmuxInjectDeps = {
  run?: Run
  transcript?: () => string | null   // this window's current transcript file
  confirmMs?: number
  sleep?: (ms: number) => Promise<unknown>
}

export async function tmuxInject(pane: string, text: string, deps: TmuxInjectDeps = {}): Promise<{ outcome: InjectOutcome; reason: string }> {
  const run = deps.run ?? runTmux
  const sleep = deps.sleep ?? Bun.sleep
  const prompt = tmuxPromptState(pane, run)
  if (!prompt || !tmuxPromptEmpty(prompt.line, prompt.cursorX)) {
    return { outcome: 'refused', reason: 'the window prompt is not empty' }
  }
  const fp = deps.transcript?.() ?? null
  const offset = fp ? fileSize(fp) : 0
  const typed = run(['send-keys', '-t', pane, '-l', text])
  const entered = typed.exitCode === 0 ? run(['send-keys', '-t', pane, 'Enter']) : typed
  if (entered.exitCode !== 0) {
    return { outcome: 'failed', reason: `tmux send-keys failed: ${entered.stderr.trim() || 'unknown'}` }
  }
  if (!fp) return { outcome: 'unconfirmed', reason: 'no transcript to confirm from' }
  const deadline = Date.now() + (deps.confirmMs ?? 3000)
  for (;;) {
    const seen = classifyInjectRecords(readFrom(fp, offset), text)
    if (seen === 'confirmed') return { outcome: 'confirmed', reason: '' }
    if (seen === 'as_text') return { outcome: 'as_text', reason: 'the window took the command as a plain prompt' }
    if (Date.now() >= deadline) return { outcome: 'unconfirmed', reason: 'the transcript did not show the command running' }
    await sleep(150)
  }
}
