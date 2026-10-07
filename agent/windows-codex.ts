import { realpathSync } from 'fs'

export function canonicalWindowsPath(p: string): string {
  try { p = realpathSync(p) } catch {}
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function isCodexTuiCommand(command: string): boolean {
  const executable = command.match(/^(?:"(?:[^"\n]*[\\/])?codex(?:\.exe)?"|(?:[^\s"]*[\\/])?codex(?:\.exe)?)(?=\s|$)/i)
  if (!executable) return false
  const args = command.slice(executable[0].length).trimStart()
  if (/--remote(?:\s|=)/.test(args)) return false
  // Sandbox kernels and management commands cannot hold an interactive rollout.
  return !/^(?:app-server|mcp|doctor|exec|review|queue|features|sandbox|--help|--version)(?=\s|$)/i.test(args)
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
