import { realpathSync } from 'fs'

export function canonicalWindowsPath(p: string): string {
  try { p = realpathSync(p) } catch {}
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

const CODEX_EXECUTABLE = /^(?:"(?:[^"\n]*[\\/])?codex(?:\.exe)?"|(?:[^\s"]*[\\/])?codex(?:\.exe)?)(?=\s|$)/i

/** The command line starts with a codex executable (any subcommand). */
export function isCodexExecutable(command: string): boolean { return CODEX_EXECUTABLE.test(command) }

/** Whether a codex command line is an interactive session. `exact` = the
 *  argument boundaries are known (Windows command line, Linux argv). Without
 *  them (macOS `ps` output) only the subcommands candidate-v6 already excluded
 *  are trusted, so a prompt such as `codex "help me"` is not taken for the
 *  `help` subcommand. */
export function isCodexTuiCommand(command: string, exact = true): boolean {
  const executable = command.match(CODEX_EXECUTABLE)
  if (!executable) return false
  const args = command.slice(executable[0].length).trimStart()
  // Keep quoted values together: command names inside a prompt or config value
  // are not subcommands. Global options may precede the actual subcommand.
  // Quotes around a whole token are shell quoting, not part of the option.
  const tokens = (args.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? []).map(t => t.replace(/^"(.*)"$/, '$1'))
  const valueOptions = new Set(['-c', '--config', '--enable', '--disable', '-C', '--cd',
    '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval',
    '--local-provider', '--add-dir', '-i', '--image'])
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--') break
    if (valueOptions.has(tokens[i])) { i++; continue }
    if (tokens[i] === '--remote' || tokens[i].startsWith('--remote=')) return false
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--remote' || token.startsWith('--remote=')) return false
    if (token === '--help' || token === '--version' || token === '-h' || token === '-V') return false
    if (token === '--') return true
    if (valueOptions.has(token)) { i++; continue }
    if (token.startsWith('-')) continue
    if (!exact) return !/^(?:app-server|mcp|doctor|exec|review|queue|features|sandbox)$/.test(token)
    // Every subcommand that runs without an interactive session (codex --help).
    // Case-sensitive like the CLI: `codex Help` is a prompt, not a subcommand.
    // resume, fork, agents and cloud open a UI and stay counted.
    return !/^(?:exec|e|review|login|logout|mcp|mcp-server|plugin|app-server|remote-control|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|exec-server|features|help)$/.test(token)
  }
  return true
}

export function standaloneWindowsTui(rows: { ProcessId: number; CommandLine?: string }[], cwd: string): number | null {
  for (const row of rows) {
    const command = row.CommandLine ?? ''
    if (!command) return row.ProcessId
    if (!isCodexTuiCommand(command)) continue
    const m = command.match(/(?:--cd|-C)(?:\s+|=)(?:"([^"]+)"|([^\s]+))/)
    // Windows has no unprivileged cwd lookup. An unqualified standalone TUI
    // cannot safely be ruled out, so fail closed rather than resume concurrently.
    if (!m || canonicalWindowsPath(m[1] ?? m[2]) === canonicalWindowsPath(cwd)) return row.ProcessId
  }
  return null
}
