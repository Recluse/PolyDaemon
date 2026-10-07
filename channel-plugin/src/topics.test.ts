import { expect, test } from 'bun:test'
import { approvalChatFor, forumThreadFor, setRemoteTopicBinding } from './topics.ts'

test('approval uses the bound topic before the first inbound message', () => {
  setRemoteTopicBinding({ forum_chat_id: -100123, message_thread_id: 42 })
  expect(approvalChatFor(null)).toBe(-100123)
  expect(forumThreadFor(approvalChatFor(null)!)).toBe(42)
  expect(approvalChatFor(123)).toBe(123)
  setRemoteTopicBinding(null)
  expect(approvalChatFor(null)).toBeNull()
  expect(approvalChatFor(123)).toBe(123)
})
