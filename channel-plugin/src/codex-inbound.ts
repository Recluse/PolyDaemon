/** Human context first; preserve exact tool arguments in a separate footer. */
export function formatCodexInbound(content: string, meta: Record<string, string>): string {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
  const sender = oneLine(meta.sender_name || `пользователь ${meta.user_id || meta.user || '?'}`)
  const username = meta.sender_username ? ` (@${oneLine(meta.sender_username)})` : ''
  const lines = [`Telegram — ${sender}${username}`]
  if (meta.chat_title) lines.push(`Чат: ${oneLine(meta.chat_title)}`)
  if (meta.forward_from) {
    lines.push(`Переслано от: ${oneLine(meta.forward_from)}`)
    content = content.replace(`[Форвард от: ${meta.forward_from}]\n`, '')
  }
  if (meta.file_name) {
    const size = meta.file_size ? ` · ${oneLine(meta.file_size)} Б` : ''
    const type = meta.mime_type ? ` · ${oneLine(meta.mime_type)}` : ''
    lines.push(`Вложение: ${oneLine(meta.file_name)}${size}${type}`)
  } else if (meta.image_path) lines.push('Вложение: изображение')
  if (meta.event) lines.push(`Событие: ${oneLine(meta.event)}`)
  const routing: Record<string, string> = {}
  for (const key of ['source', 'chat_id', 'message_id', 'user_id', 'ts', 'image_path', 'attachment_file_id', 'file_name', 'mime_type', 'file_size', 'event']) {
    if (meta[key] !== undefined) routing[key] = meta[key]
  }
  return `${lines.join('\n')}\n\n${content}\n\nСлужебные данные Telegram для reply/download_attachment:\n${JSON.stringify(routing, null, 2)}`
}
