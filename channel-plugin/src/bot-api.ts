import { Bot } from 'grammy'
import { realpathSync } from 'fs'
import { join, sep } from 'path'
import { TOKEN, STATE_DIR, API_ROOT, API_IS_LOCAL, WORKSPACE_DISPLAY_NAME, BOT_URL } from './config.ts'
import { myPrefix, myTopicBinding } from './topics.ts'
import { heartbeatRemote } from './bot-rpc.ts'
import { REGISTRY_ID } from './registry.ts'
import { alreadyAttributed, renderPrefix } from './prefix.ts'

// ---------------------------------------------------------------------------
// grammy Bot — outbound only (no polling)
// ---------------------------------------------------------------------------

export const bot = new Bot(TOKEN!, { client: { apiRoot: API_ROOT } })

// 429 auto-retry. The forum chat is shared by EVERY window plus the router
// bot's status edits — Telegram's per-group budget (~20 msg/min) is a common
// resource, and a long reply split into chunks trips it easily. Telegram
// tells us exactly how long to wait (retry_after); honor it a few times
// instead of failing the model's reply tool-call. Live case, 2026-07-07: a
// window lost a 4k-char answer to three consecutive 429s.
const MAX_429_RETRIES = 3
const MAX_RETRY_AFTER_S = 60
bot.api.config.use(async (prev, method, payload, signal) => {
  let attempt = 0
  for (;;) {
    const res = await prev(method, payload, signal)
    if (res.ok) return res
    const retryAfter = (res as { parameters?: { retry_after?: number } }).parameters?.retry_after
    if (res.error_code !== 429 || typeof retryAfter !== 'number' || attempt >= MAX_429_RETRIES) {
      return res
    }
    const waitS = Math.min(retryAfter, MAX_RETRY_AFTER_S)
    attempt += 1
    console.error(`PolyDaemon: ${method} hit 429 — retrying in ${waitS}s (attempt ${attempt}/${MAX_429_RETRIES})`)
    await new Promise((r) => setTimeout(r, waitS * 1000 + 250))
  }
})

// ---------------------------------------------------------------------------
// Shared-topic prefix
//
// When the bot puts every window in ONE forum topic (telegram.topic_mode:
// shared), the thread no longer says who is speaking, so each window has to say
// it itself. The bot hands us the rendered prefix on the heartbeat; '' means
// per-window topics, where the thread already answers the question.
//
// Here and not at the call sites, because there are a dozen of them — replies,
// approval prompts, plan prompts, problem notices, progress edits — and the one
// that gets forgotten is the one that leaves a message unattributed in a room
// full of agents. A transformer also covers call sites that do not exist yet.
//
// Idempotent by inspection, not by bookkeeping: `ensureWorkspaceHeader` already
// opens ordinary replies with the window name, and some notices interpolate it
// themselves. If the first line already names this window, nothing is added —
// otherwise a shared topic would read "[X] X → ..." on every reply.
// ---------------------------------------------------------------------------

const TEXT_METHODS = new Set(['sendMessage', 'editMessageText'])
const CAPTION_METHODS = new Set([
  'sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio', 'sendAnimation', 'sendVoice',
  'editMessageCaption',
])

bot.api.config.use(async (prev, method, payload, signal) => {
  let p = payload as Record<string, unknown>
  if (BOT_URL && Number(p.chat_id) < 0
      && (method.startsWith('send') || method === 'copyMessage' || method === 'forwardMessage')) {
    // A send can beat the first heartbeat. Resolve the topic before emitting it.
    if (!myTopicBinding()) await heartbeatRemote(REGISTRY_ID)
    const binding = myTopicBinding()
    if (binding && String(p.chat_id) === String(binding.forum_chat_id)) {
      p = { ...p, message_thread_id: binding.message_thread_id }
    } else if (!binding && p.message_thread_id == null) {
      const chat = await bot.api.getChat(p.chat_id as string | number)
      if ('is_forum' in chat && chat.is_forum) {
        throw new Error('Forum topic binding is not ready; refusing to send into General')
      }
    }
  }
  const prefix = myPrefix()
  if (prefix) {
    const field = TEXT_METHODS.has(method) ? 'text'
      : CAPTION_METHODS.has(method) ? 'caption'
      : ''
    const body = field ? p[field] : undefined
    if (typeof body === 'string' && body && !alreadyAttributed(body, WORKSPACE_DISPLAY_NAME, prefix)) {
      return prev(method, { ...p, [field]: renderPrefix(prefix, p.parse_mode) + body } as typeof payload, signal)
    }
  }
  return prev(method, p as typeof payload, signal)
})

// A Telegram "Bad Request: can't parse entities …" (or unsupported/unclosed tag)
// means our Markdown→HTML render produced markup Telegram rejects — e.g. a chunk
// boundary that split a construct, or a <pre> nested where it isn't allowed.
// True ⇒ the SAME text should be resent WITHOUT parse_mode (plain) rather than
// lost, since it's the formatting, not the content, Telegram objects to.
export function isFormatParseError(e: unknown): boolean {
  const err = e as { error_code?: number; description?: string }
  if (err?.error_code !== 400 || typeof err.description !== 'string') return false
  return /can't parse entities|can't find end|unsupported start tag|unclosed|reserved and must be escaped/i.test(err.description)
}

// sendMessage that never loses content to a formatting error: try with the
// requested parse_mode; if Telegram rejects the MARKUP, resend the identical
// text as plain (no parse_mode). Every other error (429 handled by the
// middleware above, network, chat-not-found) still propagates. This is why a
// long reply whose 2nd chunk had bad HTML used to vanish — one flaky chunk threw
// and dropped the rest (live case: infra-win, 2026-08-27).
export async function sendMessageSafe(
  chatId: string,
  text: string,
  parseMode: 'MarkdownV2' | 'HTML' | undefined,
  extra: Record<string, unknown> = {},
): Promise<{ message_id: number }> {
  try {
    return await bot.api.sendMessage(chatId, text, {
      ...extra,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    })
  } catch (e) {
    if (parseMode && isFormatParseError(e)) {
      console.error(`PolyDaemon: ${parseMode} rejected (${(e as { description?: string }).description}) — resending chunk as plain text`)
      return await bot.api.sendMessage(chatId, text, extra)
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Helpers — copied verbatim from official plugin
// ---------------------------------------------------------------------------

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = (API_IS_LOCAL ? 1990 : 50) * 1024 * 1024
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
