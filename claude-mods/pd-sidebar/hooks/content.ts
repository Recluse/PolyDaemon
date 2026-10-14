// Pure validation/formatting; no model, filesystem or bridge access.
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0)
const timestamp = (value: unknown) => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))

export function projectStatus(value: unknown, cwd: string) {
  if (!object(value) || value.version !== 1 || value.root !== cwd ||
      typeof value.repo !== 'string' || !value.repo || !timestamp(value.checked_at)) return null
  const { freshness: f, documents: d, chunks: c, map: m } = value
  if (![f, d, c, m].every(object)) return null
  if (!['fresh', 'stale', 'unknown', 'error'].includes(f.state) ||
      !['available', 'missing', 'unknown'].includes(m.state) ||
      ![f.stale, f.unindexed, f.missing, d.indexed, c.indexed, m.components].every(count) ||
      !(f.checked_at === null || timestamp(f.checked_at)) ||
      !(m.checked_at === null || timestamp(m.checked_at)) ||
      !(f.reason === null || typeof f.reason === 'string')) return null
  if (['fresh', 'stale'].includes(f.state) &&
      (f.checked_at === null || [f.stale, f.unindexed, f.missing].some(v => v === null))) return null
  if (f.state === 'fresh' && (f.stale !== 0 || f.unindexed !== 0 || f.missing !== 0)) return null
  return { repo: value.repo as string, state: f.state as string,
    stale: f.stale as number | null, unindexed: f.unindexed as number | null,
    missing: f.missing as number | null, documents: d.indexed as number | null,
    chunks: c.indexed as number | null, map: m.state as string,
    checkedAt: Date.parse(value.checked_at) }
}

export function plain(value: string, limit = 2000): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').slice(0, limit)
}

function json(value: unknown): string {
  try { return plain(JSON.stringify(value, null, 2) ?? '', 1500) } catch { return '[unavailable]' }
}

export type Transcript = { state: 'ready' | 'unavailable'; text: string }

export function transcript(value: unknown): Transcript {
  if (!Array.isArray(value)) return { state: 'unavailable', text: 'Agent messages unavailable' }
  const lines: string[] = []
  if (value.length > 20) lines.push('[Latest 20 messages]')
  for (const message of value.slice(-20)) {
    if (!object(message) || !['user', 'assistant'].includes(message.role)) continue
    lines.push(message.role === 'user' ? 'User' : 'Assistant', plain(String(message.text ?? ''), 2500))
    if (Array.isArray(message.toolUses)) {
      for (const tool of message.toolUses.slice(-8)) {
        if (!object(tool)) continue
        lines.push(`Tool: ${plain(String(tool.tool ?? '?'), 120)}`, json(tool.input))
        if (typeof tool.text === 'string') lines.push(tool.isError ? 'Error' : 'Result', plain(tool.text, 1500))
        else if (tool.result !== undefined) lines.push(tool.isError ? 'Error' : 'Result', json(tool.result))
      }
    }
    if (Array.isArray(message.toolResults)) {
      for (const result of message.toolResults.slice(-8)) {
        if (object(result) && typeof result.text === 'string') {
          lines.push(`Result: ${plain(String(result.tool_use_id ?? ''), 100)}${result.isError ? ' (error)' : ''}`, plain(result.text, 1500))
        }
      }
    }
    lines.push('')
  }
  let text = lines.join('\n') || 'No messages yet'
  if (text.length > 18000) text = '[Earlier content omitted]\n' + text.slice(-18000)
  return { state: 'ready', text }
}
