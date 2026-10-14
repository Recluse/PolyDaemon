export type TopicMessage = { chat_id: number; message_thread_id: number; message_id: number }
type Payload = Record<string, any>
type Prompt = { key: string; payload: Payload; baseline: number; after: Set<number>; busy: boolean }

export function promptKey(markup: any): string | null {
  const buttons = markup?.inline_keyboard
  if (!Array.isArray(buttons)) return null
  for (const row of buttons) {
    if (!Array.isArray(row)) continue
    for (const button of row) {
      const match = /^(approve|ask|plan):([^:]+):/.exec(String(button?.callback_data ?? ''))
      if (match) return `${match[1]}:${match[2]}`
    }
  }
  return null
}

export function isPromptCard(markup: any): boolean {
  return promptKey(markup) !== null || markup?.force_reply === true
}

export function validTopicMessage(value: any): value is TopicMessage {
  return Number.isSafeInteger(value?.chat_id) && value.chat_id !== 0
    && Number.isSafeInteger(value?.message_thread_id) && value.message_thread_id > 0
    && Number.isSafeInteger(value?.message_id) && value.message_id > 0
}

// Only the owning process may repeat a live prompt. Its resolver/timer is untouched.
export class PromptReminders {
  private prompts = new Map<string, Prompt>()
  constructor(private live: (key: string) => boolean,
    private send: (payload: Payload) => Promise<number>,
    private removeButtons: (chat: number, message: number) => Promise<void>,
    private failed: () => void = () => {}) {}

  sent(payload: Payload, messageId: number): void {
    const key = promptKey(payload.reply_markup)
    if (!key || !this.live(key) || !validTopicMessage({ ...payload, chat_id: Number(payload.chat_id), message_id: messageId })) return
    const previous = this.prompts.get(key)
    if (previous) {
      previous.payload = { ...payload }
      previous.baseline = Math.max(previous.baseline, messageId)
      previous.after = new Set([...previous.after].filter(id => id > previous.baseline))
    } else {
      this.prompts.set(key, { key, payload: { ...payload }, baseline: messageId, after: new Set(), busy: false })
    }
  }

  edited(payload: Payload): void {
    const key = promptKey(payload.reply_markup)
    const prompt = key ? this.prompts.get(key) : undefined
    if (prompt) prompt.payload = { ...prompt.payload,
      ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
      reply_markup: payload.reply_markup }
  }

  note(event: TopicMessage): void {
    this.sweep()
    for (const prompt of this.prompts.values()) {
      if (Number(prompt.payload.chat_id) !== event.chat_id
          || prompt.payload.message_thread_id !== event.message_thread_id || event.message_id <= prompt.baseline) continue
      if (prompt.after.has(event.message_id)) continue
      prompt.after.add(event.message_id)
      // Retain the newest IDs during a slow send without growing unboundedly.
      if (prompt.after.size > 256) prompt.after = new Set([...prompt.after].sort((a, b) => b - a).slice(0, 256))
      if (prompt.after.size >= 3 && !prompt.busy) void this.bump(prompt)
    }
  }

  sweep(): void {
    for (const [key] of this.prompts) if (!this.live(key)) this.prompts.delete(key)
  }

  private async bump(prompt: Prompt): Promise<void> {
    prompt.busy = true
    let sent = false
    try {
      if (!this.live(prompt.key)) return
      const id = await this.send({ ...prompt.payload })
      sent = true
      prompt.baseline = Math.max(prompt.baseline, id)
      prompt.after = new Set([...prompt.after].filter(n => n > prompt.baseline))
      if (!this.live(prompt.key)) {
        this.prompts.delete(prompt.key)
        await this.removeButtons(Number(prompt.payload.chat_id), id)
      }
    } catch { this.failed() }
    finally { prompt.busy = false }
    // A failed send is retried only on another ordinary message, never a hot loop.
    if (sent && this.live(prompt.key) && this.prompts.get(prompt.key) === prompt && prompt.after.size >= 3) {
      void this.bump(prompt)
    }
  }
}
