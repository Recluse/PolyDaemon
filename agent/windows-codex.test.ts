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

test('management subcommands after global options are not standalone UIs', () => {
  expect(isCodexTuiCommand('codex.exe resume saved-thread --remote ws://127.0.0.1:3210')).toBe(false)
  expect(isCodexTuiCommand('codex.exe -c telemetry=false app-server')).toBe(false)
  expect(isCodexTuiCommand('codex.exe --enable feature --config "key=some value" app-server')).toBe(false)
  expect(isCodexTuiCommand('codex.exe --config=key=value sandbox -- node kernel.js')).toBe(false)
  expect(isCodexTuiCommand('codex.exe -c app-server resume')).toBe(true)
  expect(isCodexTuiCommand('codex.exe "explain app-server"')).toBe(true)
  expect(isCodexTuiCommand('codex.exe -- "app-server"')).toBe(true)
  expect(isCodexTuiCommand('codex.exe "explain --remote usage"')).toBe(true)
  expect(standaloneWindowsTui([{ ProcessId: 9392, CommandLine: 'codex.exe -c telemetry=false app-server' }], 'C:\\Work\\infra-win')).toBeNull()
  // Quoted options and the remaining non-interactive subcommands (p20).
  expect(isCodexTuiCommand('codex.exe "--config" "telemetry=false" app-server')).toBe(false)
  expect(isCodexTuiCommand('codex.exe resume "--remote" "ws://127.0.0.1:3210"')).toBe(false)
  expect(isCodexTuiCommand('codex.exe e "summarize this repo"')).toBe(false)
  expect(isCodexTuiCommand('codex.exe exec-server')).toBe(false)
  expect(isCodexTuiCommand('codex.exe plugin list')).toBe(false)
  expect(isCodexTuiCommand('codex.exe debug app-server')).toBe(false)
  expect(isCodexTuiCommand('codex.exe resume --last')).toBe(true)
  expect(isCodexTuiCommand('codex.exe fork')).toBe(true)
  expect(isCodexTuiCommand('codex.exe --no-daemon Help')).toBe(true)
  expect(isCodexTuiCommand('codex.exe Exec')).toBe(true)
  // Without argument boundaries (macOS ps), a prompt that starts with a
  // subcommand word is not trusted as that subcommand (candidate-v6 list only).
  expect(isCodexTuiCommand('codex help me fix tests', false)).toBe(true)
  expect(isCodexTuiCommand('codex plugin list', false)).toBe(true)
  expect(isCodexTuiCommand('codex app-server --listen ws://127.0.0.1:3210', false)).toBe(false)
  expect(isCodexTuiCommand('codex exec do something', false)).toBe(false)
})
