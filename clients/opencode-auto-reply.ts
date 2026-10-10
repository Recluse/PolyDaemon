export function parsePseudoReply(text: string): { text: string; reply_to?: string } | null {
  const cleaned = text.replace(/<\|im_end\|>/g, '').trim()
  const candidate = cleaned.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed === 'object'
        && /^(?:tg[-_]?bridge|polydaemon)[_.].*(?:reply|react|edit_message)$/i.test(String(parsed.name ?? ''))
        && parsed.arguments && typeof parsed.arguments === 'object'
        && typeof parsed.arguments.text === 'string') {
      return { text: parsed.arguments.text, ...(typeof parsed.arguments.reply_to === 'string' ? { reply_to: parsed.arguments.reply_to } : {}) }
    }
  } catch { /* ordinary prose is expected */ }
  return null
}

export function cleanAutoReply(text: string): string | null {
  if (parsePseudoReply(text)) return null
  const cleaned = text.replace(/<\|im_end\|>/g, '').trim()
  return cleaned || null
}
