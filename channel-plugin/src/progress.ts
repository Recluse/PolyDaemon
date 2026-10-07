import { bot } from './bot-api.ts'
import { WORKSPACE_DISPLAY_NAME } from './config.ts'
import { forumThreadFor } from './topics.ts'
import { htmlEscape } from './markdown.ts'
import { log } from './logger.ts'
import { pushRecent } from './recent.ts'

// ---------------------------------------------------------------------------
// Progress — live status message edited as Claude works
// ---------------------------------------------------------------------------

const PROGRESS_EDIT_MIN_MS = 15_000
const PROGRESS_MAX_LINES = 15
const NARRATION_MAX_CHARS = 180

// A status line is either a tool-call summary (• …) or a snippet of the model's
// own narration prose between tool calls (💭 …) — the latter is the closest
// readable thing to "thinking" that Claude Code exposes (the real extended-
// thinking blocks are signature-only / empty in the transcript).
type ProgressLine = { kind: 'tool' | 'narration'; text: string }

export type ProgressState = {
  chatId: string
  statusMessageId: number
  lines: ProgressLine[]
  lastNarration: string       // dedup: the last narration text we appended
  lastEditTs: number
  lastRenderedKey: string
  pendingTimer: ReturnType<typeof setTimeout> | null
}

export let activeProgress: ProgressState | null = null

function renderProgressText(state: ProgressState): string {
  const head = `<b>${htmlEscape(WORKSPACE_DISPLAY_NAME)}</b>\n⏳ Работаю...`
  if (state.lines.length === 0) return head
  const body = state.lines
    .map(l => `${l.kind === 'narration' ? '💭' : '•'} ${htmlEscape(l.text)}`)
    .join('\n')
  return `${head}\n${body}`
}

export async function startProgress(chatId: string, replyToMessageId: number): Promise<void> {
  // Clean up any leftover state from a previous turn (e.g. plugin restarted
  // mid-turn or Claude crashed before clearProgress fired).
  await clearProgress()

  const text = `<b>${htmlEscape(WORKSPACE_DISPLAY_NAME)}</b>\n⏳ Работаю...`
  const thread = forumThreadFor(chatId)
  try {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: { message_id: replyToMessageId },
      parse_mode: 'HTML',
      ...(thread != null ? { message_thread_id: thread } : {}),
    })
    activeProgress = {
      chatId,
      statusMessageId: sent.message_id,
      lines: [],
      lastNarration: '',
      lastEditTs: Date.now(),
      lastRenderedKey: text,
      pendingTimer: null,
    }
  } catch (e) {
    log(`PolyDaemon: startProgress failed: ${e}`)
  }
}

export function appendProgress(summary: string): void {
  if (!summary) return
  // Mirror every tool-call summary into the recent buffer so the bot's status
  // panel still has context after the live "⏳ Работаю..." message goes away.
  pushRecent(summary)
  if (!activeProgress) return
  activeProgress.lines.push({ kind: 'tool', text: summary })
  trimLines(activeProgress)
  scheduleProgressFlush()
}

// The model's narration prose (the text it writes between tool calls). The hook
// sends the latest assistant text block on each tool event; we dedup against
// the last narration shown so a single prose block spanning several tool calls
// only appears once, and surface it as a 💭 line in the live status.
export function appendNarration(text: string): void {
  if (!text) return
  if (!activeProgress) return
  const trimmed = text.length > NARRATION_MAX_CHARS
    ? text.slice(0, NARRATION_MAX_CHARS - 1) + '…'
    : text
  if (trimmed === activeProgress.lastNarration) return
  activeProgress.lastNarration = trimmed
  activeProgress.lines.push({ kind: 'narration', text: trimmed })
  trimLines(activeProgress)
  scheduleProgressFlush()
}

function trimLines(state: ProgressState): void {
  if (state.lines.length > PROGRESS_MAX_LINES) {
    state.lines.splice(0, state.lines.length - PROGRESS_MAX_LINES)
  }
}

function scheduleProgressFlush(): void {
  if (!activeProgress) return
  const state = activeProgress
  const elapsed = Date.now() - state.lastEditTs
  if (elapsed >= PROGRESS_EDIT_MIN_MS) {
    void flushProgress()
    return
  }
  if (state.pendingTimer) return
  state.pendingTimer = setTimeout(() => {
    if (activeProgress) activeProgress.pendingTimer = null
    void flushProgress()
  }, PROGRESS_EDIT_MIN_MS - elapsed)
}

async function flushProgress(): Promise<void> {
  if (!activeProgress) return
  const state = activeProgress
  const rendered = renderProgressText(state)
  if (rendered === state.lastRenderedKey) return
  try {
    await bot.api.editMessageText(state.chatId, state.statusMessageId, rendered, { parse_mode: 'HTML' })
    state.lastRenderedKey = rendered
    state.lastEditTs = Date.now()
  } catch (e) {
    // Edits routinely fail when nothing changed or the message is gone — log
    // and move on so a broken status never blocks real output.
    log(`PolyDaemon: flushProgress edit failed: ${e}`)
  }
}

export async function clearProgress(): Promise<void> {
  if (!activeProgress) return
  const state = activeProgress
  activeProgress = null
  if (state.pendingTimer) clearTimeout(state.pendingTimer)
  try {
    await bot.api.deleteMessage(state.chatId, state.statusMessageId)
  } catch {
    // Status message may already be gone (manual delete, expired) — ignore.
  }
}
