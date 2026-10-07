// Model-switch buttons offered when a usage limit kills the turn.
//
// This list is CONFIG, not plugin state — unlike the approve/ask/plan keyboards
// (whose callback_data carries ids only this process knows), it has no local
// state at all. So it lives in ONE place, the bot (`_MODELS` in
// tg-bot/bot/model_cmd.py), and rides down on every heartbeat. A model change
// then ships via CI in ~30s and every window picks it up within one heartbeat
// (~15s) — no plugin relaunch. Keeping a second copy here is exactly what let
// the two drift until the usage-limit button was silently dead (2026-09-03).
//
// We still render and send the message ourselves rather than asking the bot to:
// a usage limit is a failure path, and it must not acquire a dependency on the
// bot/mesh being reachable at that moment.

export type ModelButton = { alias: string; label: string }

// Used until the bot answers a heartbeat (fresh start) or if it's too old to
// send the field — so the button is never dead. Must stay valid: the [1m]
// suffix only attaches to a bare family alias or a FULL model id.
const FALLBACK: ModelButton[] = [
  { alias: 'claude-opus-5[1m]', label: '🧠 Opus 5 · 1M' },
  { alias: 'claude-fable-5[1m]', label: '🎯 Fable 5 · 1M' },
]

// Telegram's hard cap on callback_data.
const CB_LIMIT = 64

let _remote: ModelButton[] | null = null

/** Adopt the list the bot returned on a heartbeat. Malformed payloads are
 * ignored rather than applied, so a bad response can't blank the keyboard. */
export function setRemoteModelButtons(v: unknown): void {
  if (!Array.isArray(v)) return
  const clean = v.filter(
    (b): b is ModelButton =>
      !!b && typeof b === 'object'
      && typeof (b as ModelButton).alias === 'string' && (b as ModelButton).alias.length > 0
      && typeof (b as ModelButton).label === 'string' && (b as ModelButton).label.length > 0,
  )
  if (clean.length) _remote = clean
}

/** Inline-keyboard rows: bot-provided list when known, else the fallback.
 * Two per row so a six-model list stays compact on an error card. Buttons whose
 * callback_data would exceed Telegram's 64-byte cap are dropped — an oversized
 * one makes the whole sendMessage fail, killing the notification entirely. */
export function modelKeyboardRows(): { text: string; callback_data: string }[][] {
  const btns = (_remote ?? FALLBACK)
    .map((b) => ({ text: b.label, callback_data: `model:${b.alias}` }))
    .filter((b) => Buffer.byteLength(b.callback_data, 'utf8') <= CB_LIMIT)
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2))
  return rows
}
