import { expect, test } from 'bun:test'
import { PromptReminders, promptKey, isPromptCard } from './prompt-reminders.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const payload = (id: string, thread = 42) => ({ chat_id: '-100123', message_thread_id: thread,
  text: `Request ${id}`, reply_markup: { inline_keyboard: [[{ text: 'Once', callback_data: `approve:${id}:once` }]] } })
const event = (id: number, thread = 42) => ({ chat_id: -100123, message_thread_id: thread, message_id: id })

test('five pending cards repeat after three ordinary messages, never each other', async () => {
  const live = new Set(['a', 'b', 'c', 'd', 'e'].map(id => `approve:${id}`))
  const sent: any[] = []
  let messageId = 20
  const tracker = new PromptReminders(key => live.has(key), async p => {
    sent.push(p)
    tracker.sent(p, ++messageId) // same observer used for originals and reminders
    return messageId
  }, async () => {})
  for (const [i, id] of ['a', 'b', 'c', 'd', 'e'].entries()) tracker.sent(payload(id), i + 1)
  expect(sent).toHaveLength(0)
  tracker.note(event(10, 999))
  tracker.note({ ...event(10), chat_id: -999 })
  tracker.note(event(6))
  tracker.note(event(6))
  tracker.note(event(7))
  expect(sent).toHaveLength(0)
  tracker.note(event(8))
  await tick()
  expect(sent.map(p => promptKey(p.reply_markup))).toEqual([...live])
  expect(sent[0]).toEqual(payload('a'))
  await tick()
  expect(sent).toHaveLength(5)
  tracker.note(event(26)); tracker.note(event(27))
  expect(sent).toHaveLength(5)
  live.delete('approve:a')
  messageId = 30
  tracker.note(event(28))
  await tick()
  expect(sent).toHaveLength(9)
  expect(sent.slice(5).every(p => promptKey(p.reply_markup) !== 'approve:a')).toBe(true)
  live.clear()
  tracker.note(event(40)); tracker.note(event(41)); tracker.note(event(42))
  await tick()
  expect(sent).toHaveLength(9)
})

test('slow sends coalesce, failures never resolve, and a decision in flight removes new buttons', async () => {
  let live = true, fail = true, sends = 0, errors = 0
  let finish: (n: number) => void = () => {}
  const cleaned: number[] = []
  const tracker = new PromptReminders(() => live, async () => {
    sends++
    if (fail) throw new Error('network')
    return new Promise<number>(resolve => { finish = resolve })
  }, async (_chat, id) => { cleaned.push(id) }, () => { errors++ })
  tracker.sent(payload('a'), 1)
  for (const n of [2, 3, 4]) tracker.note(event(n))
  await tick()
  expect(sends).toBe(1); expect(errors).toBe(1); expect(live).toBe(true)
  await tick()
  expect(sends).toBe(1)
  tracker.note(event(4))
  await tick()
  expect(sends).toBe(1)
  fail = false
  tracker.note(event(5))
  for (const n of [6, 7, 8]) tracker.note(event(n))
  expect(sends).toBe(2)
  live = false
  finish(9)
  await tick()
  expect(cleaned).toEqual([9])
  tracker.note(event(10))
  expect(sends).toBe(2)
})

test('edits preserve current keyboard; other kinds of request cards are identified', async () => {
  for (const kind of ['approve', 'ask', 'plan']) {
    expect(promptKey({ inline_keyboard: [[{ callback_data: `${kind}:123:done` }]] })).toBe(`${kind}:123`)
  }
  expect(promptKey({ inline_keyboard: [[{ callback_data: 'window:other' }]] })).toBeNull()
  expect(isPromptCard({ force_reply: true })).toBe(true)
  expect(isPromptCard({ inline_keyboard: [] })).toBe(false)
  const sent: any[] = []
  const tracker = new PromptReminders(() => true, async p => { sent.push(p); return 10 }, async () => {})
  tracker.sent(payload('a'), 1)
  const changed = payload('a')
  changed.reply_markup.inline_keyboard[0]![0]!.text = 'Updated'
  tracker.edited(changed)
  for (const n of [2, 3, 4]) tracker.note(event(n))
  await tick()
  expect(sent[0].reply_markup).toEqual(changed.reply_markup)
})

test('three newer messages arriving before a send response still cause the next reminder', async () => {
  let finish: (id: number) => void = () => {}
  let sends = 0
  const tracker = new PromptReminders(() => true, async () => {
    sends++
    if (sends === 1) return new Promise<number>(resolve => { finish = resolve })
    return 20
  }, async () => {})
  tracker.sent(payload('a'), 1)
  for (const n of [2, 3, 4]) tracker.note(event(n))
  for (const n of [6, 7, 8]) tracker.note(event(n))
  expect(sends).toBe(1)
  finish(5)
  await tick()
  expect(sends).toBe(2)
  await tick()
  expect(sends).toBe(2)
})
