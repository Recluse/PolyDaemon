// Runnable check for the plain-text fallback classifier. No network: it only
// exercises isFormatParseError against sample Telegram error shapes.
//   bun test channel-plugin/src/format-fallback.test.ts
// (needs TG_BOT_TOKEN set so config.ts loads — any dummy value works).
import { expect, test } from 'bun:test'
import { isFormatParseError } from './bot-api.ts'

test('formatting rejections → resend as plain', () => {
  for (const description of [
    "Bad Request: can't parse entities: Unclosed start tag at byte offset 42",
    "Bad Request: can't find end of the entity starting at byte offset 10",
    'Bad Request: unsupported start tag "pre" at byte offset 5',
    "Bad Request: character '<' is reserved and must be escaped with the corresponding HTML entity",
  ]) {
    expect(isFormatParseError({ error_code: 400, description })).toBe(true)
  }
})

test('non-formatting errors → propagate (no plain retry)', () => {
  expect(isFormatParseError({ error_code: 429, description: 'Too Many Requests: retry after 5' })).toBe(false)
  expect(isFormatParseError({ error_code: 400, description: 'Bad Request: chat not found' })).toBe(false)
  expect(isFormatParseError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' })).toBe(false)
  expect(isFormatParseError(new Error('network down'))).toBe(false)
  expect(isFormatParseError(undefined)).toBe(false)
})
