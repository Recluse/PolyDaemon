// Identity of the Codex window this plugin process belongs to.
//
// The shared app-server starts one plugin process per loaded thread, so a
// random id minted here names exactly one window's thread for the plugin's
// lifetime. agentd keys its window → thread binding by this id
// (agent/codex-bindings.ts); it is sent with every delivery and returned by
// bridge_status so agentd can ask a thread's own plugin which window it is.
// TG_WINDOW_UID is deliberately not used: Codex plugins inherit the
// app-server's environment, so every window would share one inherited value.
// Not derived from the display name either: a rename must not move routing.
import { randomBytes } from 'crypto'

export const CODEX_WINDOW_ID = `codex-${randomBytes(16).toString('hex')}`
// Known only to this process and sent only to agentd (header). agentd stores
// its hash with the binding it creates and requires it for later deliveries
// to that binding. The id itself is public (bridge_status, registry).
export const CODEX_WINDOW_SECRET = randomBytes(32).toString('hex')
export const SECRET_HEADER = 'X-Codex-Window-Secret'
// agentd records this process (pid + its own start-token lookup) with a
// binding it creates and retires the binding only once the process is dead.
export const PID_HEADER = 'X-Codex-Window-Pid'

export type AgentDaemon = { url: string; token: string }

/** The thread agentd has bound to this window (binding it on first use when
 *  that is unambiguous). Never a guess: a refusal comes back as ok=false. */
export async function codexBoundThread(d: AgentDaemon | null, cwd: string, windowId = CODEX_WINDOW_ID):
    Promise<{ ok: boolean; thread_id?: string | null; reason?: string }> {
  if (!d) return { ok: false, reason: 'no ~/.tg-bridge/agent.toml (daemon not set up)' }
  try {
    const q = new URLSearchParams({ cwd, window_id: windowId })
    const res = await fetch(`${d.url}/v1/codex/binding?${q}`, {
      headers: { Authorization: `Bearer ${d.token}`, [SECRET_HEADER]: CODEX_WINDOW_SECRET, [PID_HEADER]: String(process.pid) }, signal: AbortSignal.timeout(20000),
    })
    const out = await res.json() as { ok?: boolean; thread_id?: unknown; reason?: string }
    if (!res.ok || out.ok !== true) return { ok: false, reason: String(out.reason ?? `HTTP ${res.status}`) }
    if (out.thread_id !== null && (typeof out.thread_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(out.thread_id))) {
      return { ok: false, reason: 'invalid thread id from agentd' }
    }
    return { ok: true, thread_id: out.thread_id }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}
