import { WORKSPACE_DISPLAY_NAME } from './config.ts'

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Convert standard Markdown (the dialect Claude naturally produces) to the
// subset of HTML that Telegram's parse_mode='HTML' supports: <b>, <i>, <code>,
// <pre>, <a>. Code spans/blocks are protected from re-processing via placeholders
// so bold/link conversions can't smear into their contents.
export function markdownToTelegramHtml(text: string): string {
  let s = htmlEscape(text)

  const codeBlocks: string[] = []
  s = s.replace(/```(?:\w*\n?)?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(String(code).replace(/^\n/, '').replace(/\n$/, ''))
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  const inlineCodes: string[] = []
  s = s.replace(/`([^`\n]+?)`/g, (_m, code) => {
    inlineCodes.push(String(code))
    return `\x00IC${inlineCodes.length - 1}\x00`
  })

  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__([^_\n]+?)__/g, '<b>$1</b>')
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  // Pretty unordered-list bullets: keep indentation, swap the dash for em-dash
  s = s.replace(/^(\s*)[-+]\s+(.+)$/gm, '$1— $2')
  // Wrap consecutive `> ...` lines into Telegram's native <blockquote> (markers
  // are `&gt;` here because we already HTML-escaped the source).
  s = s.replace(
    /(?:^|\n)((?:&gt;[^\n]*\n?)+)/g,
    (_m, block) => {
      const inner = String(block)
        .replace(/\n$/, '')
        .split('\n')
        .map((line: string) => line.replace(/^&gt;\s?/, ''))
        .join('\n')
      return `\n<blockquote>${inner}</blockquote>`
    },
  )

  s = s.replace(/\x00IC(\d+)\x00/g, (_m, idx) => `<code>${inlineCodes[Number(idx)]}</code>`)
  s = s.replace(/\x00CB(\d+)\x00/g, (_m, idx) => `<pre><code>${codeBlocks[Number(idx)]}</code></pre>`)
  return s
}

// Every Telegram message originated from a specific VSCode window. We prepend
// the workspace folder name as a bold first line so the user always knows
// which window is talking, even when several windows reply into the same chat.
// (Claude Code's default channel-progress prefix is the *agent* name "main",
// which says nothing useful — we strip/replace it.)
//
// The trailing "→" marks direction in the flat DM feed: window OUTPUT reads
// "<window> →", while a message the user typed INTO a window is mirrored as
// "→ <window>" (see the inbound mirror in the Python bot's _forward_message).
export function ensureWorkspaceHeader(text: string): string {
  if (!text) return text
  // Strip Claude's default agent prefix "main\n" (channel-progress convention).
  let result = text.replace(/^main(\s*(?:\r?\n|$))/, '')
  // If the first line is already a workspace header (plain, markdown-bold, or
  // html-bold, with or without the → arrow) leave alone — avoids double headers
  // when Claude already adds one.
  const firstLine = result.split('\n', 1)[0].trim()
  const name = WORKSPACE_DISPLAY_NAME
  const existingHeaders = new Set([
    name, `${name} →`,
    `**${name}**`, `**${name} →**`,
    `<b>${name}</b>`, `<b>${name} →</b>`,
  ])
  if (existingHeaders.has(firstLine)) return result
  return `**${name} →**\n${result}`
}

export function resolveTextFormat(text: string, format: unknown): { rendered: string; parseMode: 'MarkdownV2' | 'HTML' | undefined } {
  if (format === 'text') return { rendered: text, parseMode: undefined }
  if (format === 'markdownv2') return { rendered: text, parseMode: 'MarkdownV2' }
  if (format === 'html') return { rendered: text, parseMode: 'HTML' }
  // default ('auto' or unspecified): convert Markdown to HTML
  return { rendered: markdownToTelegramHtml(text), parseMode: 'HTML' }
}
