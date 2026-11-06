import { homedir } from 'os'

/** Bot token and bridge auth token, read from the environment at call time so
 *  values loaded from ~/.tg-bridge-channel/.env are covered too. */
function secrets(): string[] {
  // Even short tokens are secret; only trivially short values (which would
  // blank ordinary words) are skipped.
  return [process.env.TG_BOT_TOKEN, process.env.TG_BRIDGE_AUTH_TOKEN].filter((s): s is string => !!s && s.length >= 4)
}

/** Remove the bot and bridge tokens. Safe for any text: a token is never a
 *  legitimate part of a log line, a tool result or a chat message. */
export function redactTokens(text: string): string {
  for (const secret of secrets()) text = text.split(secret).join('<redacted>')
  return text
}

/** Spellings of the home directory as they show up in error text: native,
 *  with forward slashes (Windows), and as a WSL mount (/mnt/c/...). */
function homeSpellings(): string[] {
  const home = homedir()
  if (home.length <= 1) return []
  const forms = new Set([home, home.replace(/\\/g, '/')])
  const drive = home.match(/^([A-Za-z]):[\\/](.*)$/)
  if (drive) forms.add(`/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`)
  return [...forms].sort((a, b) => b.length - a.length)
}

/** Tokens plus local account paths (shown as ~), for text that leaves the
 *  machine as an error: chat messages and failed tool results. Not for paths a
 *  caller must open (e.g. a downloaded attachment). */
export function redactSecrets(text: string): string {
  text = redactTokens(text)
  for (const home of homeSpellings()) {
    const re = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    text = text.replace(re, '~')
  }
  return text
}
