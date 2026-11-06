import { expect, test } from 'bun:test'
import { homedir } from 'os'
import { redactSecrets, redactTokens } from './redact.ts'

test('short tokens and every spelling of the home path are removed', () => {
  process.env.TG_BRIDGE_AUTH_TOKEN = 'abc123'
  process.env.TG_BOT_TOKEN = '42:fixture-bot-token'
  expect(redactTokens('Bearer abc123 for 42:fixture-bot-token')).toBe('Bearer <redacted> for <redacted>')
  const home = homedir()
  expect(redactSecrets(`open ${home}/x failed`)).toBe('open ~/x failed')
  expect(redactTokens(`open ${home}/x`)).toContain(home)   // tokens only: paths stay
})
