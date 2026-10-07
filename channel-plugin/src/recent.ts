// Rolling buffer of recent in-window activity — tool calls AND user/Claude
// messages — surfaced via GET /status. Persists across turns so the bot's
// «📊 Окна» status panel can show what's been happening even when the window
// is idle. Capped to keep memory bounded.

const MAX_RECENT = 20

export const recentEvents: string[] = []

export function pushRecent(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  recentEvents.push(trimmed)
  if (recentEvents.length > MAX_RECENT) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT)
  }
}

export function truncForRecent(text: string, n = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}
