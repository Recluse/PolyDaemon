import { expect, spyOn, test } from 'bun:test'
import { bot } from './bot-api.ts'
import { registerRemote } from './bot-rpc.ts'
import { setRemoteTopicBinding } from './topics.ts'

test('startup sends wait for registration and never fall into unbound General', async () => {
  const originalFetch = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let bound = true
  const calls: string[] = []
  const sent: any[] = []
  const getChat = spyOn(bot.api, 'getChat').mockResolvedValue({ is_forum: true } as any)
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path === '/register') await gate
    return Response.json({ ok: true, topic_binding: bound
      ? { forum_chat_id: -100123, message_thread_id: 42 } : null })
  }) as typeof fetch
  const route = bot.api.config.installedTransformers().at(-1)!
  const send = async (_method: any, payload: any) => {
    sent.push(payload)
    return { ok: true, result: { message_id: 1 } } as any
  }
  try {
    setRemoteTopicBinding(null)
    const registration = registerRemote({
      id: 'startup-window', host: '127.0.0.1', port: 3100, auth_token: 'test',
      instance_name: 'project-codex', workspace_name: 'project-codex',
      cwd: '/work/project', pid: 123, parent_pid: 122, started_at: '',
    })
    const message = route(send, 'sendMessage', { chat_id: -100123, text: 'progress' })
    await Promise.resolve()
    expect(calls).not.toContain('/heartbeat')
    expect(sent).toHaveLength(0)
    release()
    await registration
    await message
    expect(sent[0].message_thread_id).toBe(42)
    await route(send, 'sendPhoto', { chat_id: -100123, photo: 'test', message_thread_id: 28 })
    expect(sent[1].message_thread_id).toBe(42)
    bound = false
    setRemoteTopicBinding(null)
    await expect(route(send, 'sendMessage', { chat_id: -100123, text: 'progress' }))
      .rejects.toThrow('refusing to send into General')
    expect(sent).toHaveLength(2)
    await route(send, 'sendMessage', { chat_id: 123, text: 'DM' })
    expect(sent[2].message_thread_id).toBeUndefined()
    getChat.mockResolvedValue({ type: 'group' } as any)
    await route(send, 'sendMessage', { chat_id: -123, text: 'group' })
    expect(sent[3].message_thread_id).toBeUndefined()
  } finally {
    release()
    globalThis.fetch = originalFetch
    getChat.mockRestore()
    setRemoteTopicBinding(null)
  }
})
