import { pidAlive, type LocalRow } from './registry.ts'
import { debug } from './log.ts'

// ---------------------------------------------------------------------------
// Orphan detection (SRS 40, FR-401): a channel-plugin bun process whose parent
// window died keeps running, holds its port, and EATS inbound Telegram
// messages (EPIPE on the dead MCP stdio — see memory: orphan-plugins-eat-tg-
// messages). Two signals:
//   • ps shows the plugin with PPID=1 (parent exited, re-parented to launchd)
//   • the registry row's parent_pid is dead while its pid is alive
// ---------------------------------------------------------------------------

export interface Orphan {
  pid: number
  ppid: number
  command: string
  reason: 'ppid=1' | 'parent-dead'
  window_key?: string
}

interface PsRow { pid: number; ppid: number; command: string }

/** All bun processes running channel-plugin/server.ts. On macOS an
 *  unprivileged ps may not see everything — any failure returns []. */
function scanPluginProcs(): PsRow[] {
  try {
    const proc = Bun.spawnSync(['ps', '-axww', '-o', 'pid=,ppid=,command='])
    if (proc.exitCode !== 0) return []
    const rows: PsRow[] = []
    for (const line of proc.stdout.toString().split('\n')) {
      if (!line.includes('channel-plugin/server.ts') || !line.includes('bun')) continue
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
    }
    return rows
  } catch (e) {
    debug(`ps scan failed: ${e}`)
    return []
  }
}

export function scanOrphans(registry: Record<string, LocalRow>): Orphan[] {
  const rowByPid = new Map<number, LocalRow>()
  for (const row of Object.values(registry)) rowByPid.set(row.pid, row)

  const orphans: Orphan[] = []
  for (const p of scanPluginProcs()) {
    const row = rowByPid.get(p.pid)
    if (p.ppid === 1) {
      orphans.push({ ...p, reason: 'ppid=1', window_key: row?.instance_name })
    } else if (row && row.parent_pid > 1 && !pidAlive(row.parent_pid)) {
      orphans.push({ ...p, reason: 'parent-dead', window_key: row.instance_name })
    }
  }
  return orphans
}
