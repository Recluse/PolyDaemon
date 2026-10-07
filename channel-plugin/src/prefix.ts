// The shared-topic prefix, as pure functions — no Bot instance, so it can be
// tested without a token. The transformer that applies it lives in bot-api.ts.
//
// Deliberately imports NOTHING. The obvious import, htmlEscape from markdown.ts,
// drags in config.ts, which calls process.exit(1) when no bot token is set — so
// the self-check below exited 1 with no output at all, which reads exactly like
// a failing assertion. The escaper is three replaces; a copy is cheaper than that.

/** Same as markdown.ts's htmlEscape — Telegram HTML needs only these three. */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** MarkdownV2 reserves these everywhere; an unescaped one rejects the message. */
export function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`)
}

export function renderPrefix(prefix: string, parseMode: unknown): string {
  if (parseMode === 'HTML') return `<b>${htmlEscape(prefix)}</b> `
  if (parseMode === 'MarkdownV2') return `*${escapeMarkdownV2(prefix)}* `
  return `${prefix} `
}

/** Does the first line already say which window this is?
 *
 *  Checks for the specific forms this plugin attributes with — never for the
 *  bare name. A bare-substring test was the first version, and it failed open:
 *  a window called "api" would treat "The api is down" as already attributed and
 *  post it unprefixed into a room full of agents, and a one-letter name would
 *  match nearly everything. The forms, in the order they occur:
 *    "name →"            the reply header from ensureWorkspaceHeader, any format
 *    "<b>name</b>"       notices that bold the window name themselves
 *    the prefix itself    so a re-sent message is not prefixed twice — checked
 *                         as the ACTUAL prefix string, since a Codex window's
 *                         prefix is "[ws-codex]" while its header says "ws →"
 */
export function alreadyAttributed(text: string, name: string, prefix: string): boolean {
  const firstLine = text.split('\n', 1)[0]
  if (!name) return false
  return firstLine.includes(`${name} →`)
    || firstLine.includes(`<b>${htmlEscape(name)}</b>`)
    || (prefix !== '' && (
      firstLine.includes(prefix)
      || firstLine.includes(escapeMarkdownV2(prefix))
    ))
}

// ── Self-check: `bun src/prefix.ts` ──────────────────────────────────────────
if (import.meta.main) {
  const ok = (c: unknown, m: string) => { if (!c) { console.error(`FAIL: ${m}`); process.exit(1) } }

  // Attributed forms are recognised…
  ok(alreadyAttributed('<b>api →</b>\nhello', 'api', '[api]'), 'reply header, HTML')
  ok(alreadyAttributed('**api →**\nhello', 'api', '[api]'), 'reply header, raw markdown')
  ok(alreadyAttributed('🔌 <b>api</b> — нет связи', 'api', '[api]'), 'a notice bolding the name')
  ok(alreadyAttributed('<b>[api]</b> hi', 'api', '[api]'), 'our own prefix, HTML')
  ok(alreadyAttributed('*\\[api\\]* hi', 'api', '[api]'), 'our own prefix, MarkdownV2')

  // …and a bare mention is NOT attribution. This is the case that failed open.
  ok(!alreadyAttributed('The api is down', 'api', '[api]'), 'prose mentioning the name')
  ok(!alreadyAttributed('a', 'a', '[a]'), 'one-letter name vs a one-letter message')
  ok(!alreadyAttributed('Chat restarted', 'Chat', '[Chat]'), 'a name that is an ordinary word')
  ok(!alreadyAttributed('first line\n<b>api →</b>', 'api', '[api]'), 'only the FIRST line counts')

  // Codex windows: header says "ws →", prefix says "[ws-codex]" — both hold.
  ok(alreadyAttributed('<b>ws →</b>\nx', 'ws', '[ws-codex]'), 'codex reply header')
  ok(alreadyAttributed('<b>[ws-codex]</b> x', 'ws', '[ws-codex]'), 'codex prefix, no double prefix')

  // HTML-special names are matched in their escaped form.
  ok(alreadyAttributed('<b>a&amp;b</b> — x', 'a&b', '[a&b]'), 'escaped name in bold')
  ok(!alreadyAttributed('', 'api', '[api]'), 'empty text')
  ok(!alreadyAttributed('<b>api →</b>', '', ''), 'no name, no attribution claim')

  // Rendering: the visible text is "[name] " in every mode, whatever the markup.
  ok(renderPrefix('[api]', 'HTML') === '<b>[api]</b> ', 'HTML render')
  ok(renderPrefix('[a<b]', 'HTML') === '<b>[a&lt;b]</b> ', 'HTML escaping')
  ok(renderPrefix('[api.v2]', 'MarkdownV2') === '*\\[api\\.v2\\]* ', 'MarkdownV2 escaping')
  ok(renderPrefix('[api]', undefined) === '[api] ', 'plain')

  console.log('prefix self-check OK')
}
