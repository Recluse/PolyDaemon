import { BOT_URL, AUTH_TOKEN, WORKSPACE_DISPLAY_NAME, canonicalCwd } from './config.ts'
import { log } from './logger.ts'
import { setRemoteTopicBinding } from './topics.ts'
import { setRemoteModelButtons } from './models.ts'
import { recentTouches, setOthersTouching } from './touched.ts'
import type { InstanceRow } from './routes-db.ts'

// HTTP client to the bot's registry server (bot/http_registry.py), used INSTEAD
// of writing the shared bot.db when this plugin runs on another machine
// (TG_BRIDGE_BOT_URL set). Mirrors routes-db.ts's register/heartbeat/delete.
// The Bearer token is the shared TG_BRIDGE_AUTH_TOKEN (== the bot's
// registry_enroll_token); a per-instance scheme is a later hardening step.

const RPC_TIMEOUT_MS = 4000

async function rpc(
  path: string,
  body: unknown,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; data: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let data: any = null
    try { data = await res.json() } catch {}
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } }
  } finally {
    clearTimeout(timer)
  }
}

// The startup row must land before the MCP handshake rename; unregister must
// land last. Concurrent requests can otherwise restore the old identity.
let registryWrites = Promise.resolve()
function registryRpc(path: string, body: unknown) {
  const result = registryWrites.then(() => rpc(path, body))
  registryWrites = result.then(() => {}, () => {})
  return result
}

export async function registerRemote(row: InstanceRow): Promise<void> {
  const r = await registryRpc('/register', row)
  if (!r.ok) log(`tg-bridge: remote register failed (${r.status}): ${JSON.stringify(r.data)}`)
}

// Returns false if the bot didn't recognize our id (e.g. it restarted and lost
// the row) — caller should re-register.
//
// We send our canonical cwd so the bot can look up THIS window's forum-topic
// binding and piggyback it on the response — a remote plugin can't read the
// bot's (container-local) topic-bindings.json, so this is how it learns which
// topic to thread its replies into. The `cwd` matches the key buildRow() and the
// local-file lookup use, so the bot's get_topic() hits the same row.
export async function heartbeatRemote(id: string): Promise<boolean> {
  await registryWrites
  // `touched` rides the beat that already flies every 15 s, so recording what
  // this window edits costs no extra round trip. The bot answers with what OTHER
  // windows are touching (see the topic_binding piggyback above for the same
  // pattern), which is what keeps the check off the hot path entirely.
  const r = await rpc('/heartbeat', {
    id,
    cwd: canonicalCwd(process.cwd()),
    // Our CURRENT agent pid — see heartbeatLocal for why the registered one
    // cannot be trusted. The bot uses it to tell an orphaned plugin from a live
    // window, and could not otherwise learn that the agent had died.
    parent_pid: process.ppid,
    touched: recentTouches().slice(0, 50),
  })
  if (r.ok) setOthersTouching((r.data as any)?.touched_by_others)
  if (r.status === 404) return false
  if (!r.ok) {
    log(`tg-bridge: remote heartbeat failed (${r.status})`)
    return true
  }
  // Present (object or null) => the bot is topic-binding-aware; adopt it as the
  // source of truth. Absent => older bot; leave the local-file fallback intact.
  if (r.data && typeof r.data === 'object' && 'topic_binding' in r.data) {
    setRemoteTopicBinding(r.data.topic_binding ?? null)
  }
  // The model-switch list lives only in the bot and rides down here, so changing
  // it never needs a plugin relaunch. Absent => older bot; keep the fallback.
  if (r.data && typeof r.data === 'object' && 'model_buttons' in r.data) {
    setRemoteModelButtons(r.data.model_buttons)
  }
  return true
}

export async function unregisterRemote(id: string): Promise<void> {
  await registryRpc('/unregister', { id })
}

// Record a (chat_id, message_id) -> instance route ON THE BOT. A remote plugin
// can't write the shared bot.db, so without this every native reply / reaction
// to a remote window's message would fail to route back. Mirrors routes-db.ts
// recordMessageRoute. Best-effort: a dropped route only costs one reply's
// routing, so we log and move on rather than throw into the send path.
export async function recordRouteRemote(
  chatId: number,
  messageId: number,
  instance: string,
): Promise<void> {
  const r = await rpc('/route', { chat_id: chatId, message_id: messageId, instance })
  if (!r.ok) log(`tg-bridge: remote route record failed (${r.status}): ${JSON.stringify(r.data)}`)
}

// Use the live registered workspace name, including the Codex handshake override.

export type WindowInfo = { name: string; workspace: string }

// List the OTHER live windows the bot knows about (excludes this one).
export async function listWindowsRemote(): Promise<{ ok: boolean; windows: WindowInfo[]; reason?: string }> {
  const r = await rpc('/windows', { from: WORKSPACE_DISPLAY_NAME })
  if (!r.ok) return { ok: false, windows: [], reason: r.data?.reason || `HTTP ${r.status}` }
  return { ok: true, windows: Array.isArray(r.data?.windows) ? r.data.windows : [] }
}

// Ask the bot to deliver a message/question from THIS window to window `toName`.
// The bot injects it into that window's session and posts a note into both topics;
// for kind='ask' the target is told to answer by messaging back (tell_window).
// Longer timeout: the bot delivers to the target plugin + posts two Telegram notes.
export async function routeWindowRemote(
  toName: string,
  text: string,
  kind: 'tell' | 'ask',
): Promise<{ ok: boolean; delivered?: string; reason?: string; available?: string[] }> {
  const r = await rpc('/route-window', { from: WORKSPACE_DISPLAY_NAME, to: toName, text, kind }, 12000)
  if (!r.ok) {
    return {
      ok: false,
      reason: r.data?.reason || `HTTP ${r.status}`,
      available: Array.isArray(r.data?.available) ? r.data.available : undefined,
    }
  }
  return { ok: true, delivered: r.data?.delivered }
}

// ── cross-window tasks ─────────────────────────────────────────────────────
// The bot keeps the state (see tg-bot/bot/storage.py `tasks`); these just report.
// Scoped by WORKSPACE_DISPLAY_NAME on the wire: the bot refuses to move a task addressed to
// another window, so a window cannot close work that is not its own.

export type MyTask = { id: number; from: string; kind: string; text: string; state: string }

export async function myTasksRemote(): Promise<{ ok: boolean; tasks: MyTask[]; reason?: string }> {
  const r = await rpc('/my-tasks', { window: WORKSPACE_DISPLAY_NAME })
  if (!r.ok) return { ok: false, tasks: [], reason: r.data?.reason || `HTTP ${r.status}` }
  return { ok: true, tasks: Array.isArray(r.data?.tasks) ? r.data.tasks : [] }
}

export async function setTaskStateRemote(
  id: number, state: 'running' | 'done' | 'failed' | 'blocked', text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const r = await rpc('/task-state', { id, state, text, window: WORKSPACE_DISPLAY_NAME })
  if (!r.ok) return { ok: false, reason: r.data?.reason || `HTTP ${r.status}` }
  return { ok: true }
}
