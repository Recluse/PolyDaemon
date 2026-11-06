// Identity of a local process: pid + OS start token, so a recycled pid is not
// mistaken for the original process. Same algorithm as the channel plugin's
// _procStartTime (channel-plugin/src/registry.ts) on Linux and Windows; macOS
// has no /proc, so `ps -o lstart=` is used there (agentd computes both tokens
// it compares itself, so the format only has to be stable on this host).
//
//   string → the process is alive; the string identifies WHICH process
//   ''     → no process with this pid (verifiably gone)
//   null   → the lookup failed: unknown, never proof of death
import { readFileSync } from 'node:fs'

export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform === 'win32') {
    try {
      const r = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [long][Math]::Floor($p.StartTime.ToFileTimeUtc() / 10000000) }`],
        { timeout: 5000 } as any)
      if (r.exitCode !== 0) return null
      return r.stdout.toString().trim()
    } catch { return null }
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      return rest[19] ?? null
    } catch (e: any) { return e?.code === 'ENOENT' ? '' : null }
  }
  try {
    const r = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
    if (r.exitCode === 1 && !r.stdout.toString().trim()) return ''   // no such pid
    if (r.exitCode !== 0) return null
    return r.stdout.toString().trim() || null
  } catch { return null }
}

export type ProcessIdentity = { pid: number; start: string }

/** 'dead' only when verifiable: the pid is gone, or now belongs to a process
 *  with another start token. A failed lookup is 'unknown'. */
export function processState(who: ProcessIdentity | undefined | null): 'alive' | 'dead' | 'unknown' {
  if (!who || !Number.isInteger(who.pid) || who.pid <= 1 || typeof who.start !== 'string' || !who.start) return 'unknown'
  const now = processStartToken(who.pid)
  if (now === null) return 'unknown'
  if (now === '' || now !== who.start) return 'dead'
  return 'alive'
}
