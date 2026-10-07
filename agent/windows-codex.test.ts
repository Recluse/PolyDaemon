import { test, expect } from 'bun:test'
import { isCodexTuiCommand, standaloneWindowsTui } from './windows-codex.ts'
test('Windows standalone guard distinguishes managed remote UI and matching workspace', () => {
  const row = (CommandLine: string) => [{ ProcessId: 42, CommandLine }]
  expect(standaloneWindowsTui(row('codex.exe --cd "C:\\Work\\infra" --no-daemon resume'), 'c:\\work\\infra')).toBe(42)
  expect(standaloneWindowsTui(row('codex.exe --cd C:\\other resume'), 'C:\\Work\\infra')).toBeNull()
  expect(standaloneWindowsTui(row('codex.exe --remote ws://127.0.0.1:3210 resume'), 'C:\\Work\\infra')).toBeNull()
  expect(standaloneWindowsTui(row('codex.exe app-server --listen ws://127.0.0.1:3210'), 'C:\\Work\\infra')).toBeNull()
  expect(standaloneWindowsTui(row('codex.exe resume'), 'C:\\Work\\infra')).toBe(42)
  expect(standaloneWindowsTui(row('"codex.exe" resume'), 'C:\\Work\\infra')).toBe(42)
  expect(standaloneWindowsTui(row('codex.exe mcp list'), 'C:\\Work\\infra')).toBeNull()
  expect(standaloneWindowsTui(row('"C:\\Program Files\\Codex\\codex.exe" sandbox -c default_permissions="node_repl" -- node kernel.js --working-dir C:\\Work\\infra'), 'C:\\Work\\infra')).toBeNull()
  expect(isCodexTuiCommand('/Applications/ChatGPT.app/Contents/Resources/codex sandbox -c default_permissions="node_repl" -- node kernel.js')).toBe(false)
  expect(isCodexTuiCommand('/Applications/Codex.app/Contents/Resources/codex resume known-thread')).toBe(true)
  expect(isCodexTuiCommand('node /work/codex-adapter/server.js')).toBe(false)
  expect(isCodexTuiCommand('codex "explain sandbox"')).toBe(true)
})
