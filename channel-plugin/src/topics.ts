import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { BRIDGE_DIR, BOT_URL, workspaceBindingKey } from './config.ts'

// ---------------------------------------------------------------------------
// Forum topic binding (Slice 2)
//
// The Python bot writes ~/.tg-copilot-bridge/topic-bindings.json keyed by each
// window's workspace path (== the `cwd` the plugin reported at registration,
// which is process.cwd()). When a binding exists for THIS window, outbound
// replies are mirrored into its forum topic so the whole conversation lives in
// one place. Missing file / no entry => feature off, only the DM is used.
// ---------------------------------------------------------------------------

const TOPIC_BINDINGS_PATH = join(BRIDGE_DIR, 'topic-bindings.json')

export type TopicBinding = {
  forum_chat_id: number
  message_thread_id: number
  title?: string
  // What this window puts in front of everything it says, e.g. "[api-gateway]".
  // Non-empty only when the bot is configured to put every window in ONE topic,
  // where the thread can no longer say who is speaking. The bot sends the
  // rendered string rather than a mode flag, so this side has no rule to keep
  // in sync — absent means unprefixed, which is what every older bot means too.
  prefix?: string
}

// (mtime,size)-keyed memo of the whole bindings map. A single reply can trigger
// myTopicBinding()/forumThreadFor() 5-10× (deliverReply, startProgress,
// appendProgress, keyboard helpers), and each call was a fresh
// readFileSync+JSON.parse. statSync is one syscall and lets us skip both.
// The bot's writes bump mtime so we pick them up on the very next call; the
// size component catches two writes landing in the same millisecond (coarse FS
// timestamp) when the byte length also changed.
let _bindingsCache: Record<string, TopicBinding> | null = null
let _bindingsKey = ''

function readBindings(): Record<string, TopicBinding> | null {
  let key: string
  try {
    const st = statSync(TOPIC_BINDINGS_PATH)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return null // file missing
  }
  if (_bindingsCache !== null && key === _bindingsKey) return _bindingsCache
  try {
    _bindingsCache = JSON.parse(readFileSync(TOPIC_BINDINGS_PATH, 'utf8'))
    _bindingsKey = key
    return _bindingsCache
  } catch {
    return null
  }
}

// Remote-mode binding (bot on another machine). The bot's topic-bindings.json
// lives in ITS filesystem (a container on the bot host) and is unreachable from here,
// so the local file only ever holds stale entries from when the bot ran
// same-machine — a NEW workspace never appears in it and its replies fall into
// General. Instead the bot streams THIS window's binding back on every heartbeat
// (see bot-rpc.heartbeatRemote → /heartbeat). Remote mode never consults the
// stale local file, even before the first heartbeat has supplied a binding.
let _remoteBinding: TopicBinding | null = null
let _remoteAuthoritative = false

/** Record the binding the bot returned on a heartbeat (null = bot has no topic
 * for this window yet). Marks remote as authoritative so myTopicBinding() stops
 * reading the local file. Called only in remote mode by heartbeatRemote(). */
export function setRemoteTopicBinding(b: TopicBinding | null): void {
  _remoteBinding =
    b && typeof b.forum_chat_id === 'number' && typeof b.message_thread_id === 'number' ? b : null
  _remoteAuthoritative = true
}

/** This window's forum topic, or null if unbound / feature off. Read lazily on
 * each send — the file is tiny and the bot may (re)write it at any time. */
export function myTopicBinding(): TopicBinding | null {
  // Null until the remote bot supplies this window's binding; never inherit a
  // stale local Claude binding while a Codex window is starting.
  if (BOT_URL || _remoteAuthoritative) return _remoteBinding
  const map = readBindings()
  if (!map) return null
  const b = map[workspaceBindingKey()]
  if (b && typeof b.forum_chat_id === 'number' && typeof b.message_thread_id === 'number') {
    return b
  }
  return null
}

/** The prefix this window must put in front of what it says, or '' when its
 *  own thread already identifies it. */
export function myPrefix(): string {
  const p = myTopicBinding()?.prefix
  return typeof p === 'string' ? p.trim() : ''
}

/** message_thread_id to use when sending to `chatId`, or undefined.
 *
 * The bot only ever hands us a bare chat_id. When that chat IS this window's
 * forum, a bare send lands in General — every outbound (replies, questions,
 * progress, plan/permission prompts) must instead thread into THIS window's
 * own topic. Returns undefined for real DMs, leaving sends unthreaded. */
export function forumThreadFor(chatId: string | number): number | undefined {
  const b = myTopicBinding()
  return b && String(chatId) === String(b.forum_chat_id) ? b.message_thread_id : undefined
}

/** Console-started work can need approval before the first Telegram message. */
export function approvalChatFor(lastChatId: number | null): number | null {
  return lastChatId ?? myTopicBinding()?.forum_chat_id ?? null
}
