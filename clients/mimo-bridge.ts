import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatCodexInbound } from '../channel-plugin/src/codex-inbound.ts'
import type { InboundItem } from '../channel-plugin/src/inbound-queue.ts'

export function binding(cwd: string) {
  const file = process.env.TG_MIMO_BINDING
  if (!file) throw new Error('MiMo bridge session is not bound')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (value.root !== realpathSync(cwd) || !/^ses_[A-Za-z0-9]+$/.test(value.sessionID)) {
    throw new Error('MiMo bridge session scope mismatch')
  }
  return value as { root: string; sessionID: string }
}

export async function bridgeRequest(cwd: string, path: string, body?: unknown, signal = AbortSignal.timeout(10000)): Promise<any> {
  if (!process.env.TG_WINDOW_UID) throw new Error('MiMo window identity missing')
  // MiMo's async TS loader cannot require this shared CommonJS hook. Node uses
  // the existing locator unchanged; tokens stay in the captured pipe, not argv.
  const lookup = spawnSync('node', ['-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).findOwnPlugin(process.argv[2], "mimo")))',
    fileURLToPath(new URL('../hooks/tg-bridge-locate.js', import.meta.url)), cwd], { encoding: 'utf8', timeout: 5000, env: { ...process.env } })
  if (lookup.status !== 0) throw new Error('MiMo bridge not connected')
  const target = JSON.parse(lookup.stdout)
  if (!target) throw new Error('MiMo bridge not connected')
  const response = await fetch(`http://${target.host}:${target.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${target.auth_token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  })
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`)
  return response.json()
}

export const inboundPartID = (id: string) => `prt_${createHash('sha256').update(id).digest('hex')}`
export const isInboundMessage = (m: any) => m?.info?.role === 'user'
  && (/^msg_[a-f0-9]{64}$/.test(m.info.id) || m.parts?.some((p: any) => /^prt_[a-f0-9]{64}$/.test(p.id)))

export type MimoModel = { providerID: string; modelID: string }
export function availableModel(catalog: any, candidates: (MimoModel | undefined)[]): MimoModel | undefined {
  return candidates.find(m => m && catalog.connected?.includes(m.providerID)
    && catalog.all?.some((p: any) => p.id === m.providerID && Object.hasOwn(p.models ?? {}, m.modelID)))
}
export const parseModel = (s: string | undefined): MimoModel | undefined => {
  if (!s?.includes('/')) return undefined
  const [providerID, ...rest] = s.split('/')
  return { providerID, modelID: rest.join('/') }
}

export function modelError(error: any): string {
  const message = error?.data?.message
  return typeof message === 'string' && /^Model not found: [\w./:-]+\.?$/.test(message)
    ? message : 'MiMo could not finish the Telegram turn; see console'
}

type MimoAPI = (path: string, body?: unknown, method?: string) => Promise<any>
const submissions = new WeakMap<MimoAPI, Set<string>>()

export async function inboundTurn(api: MimoAPI, sessionID: string, item: InboundItem, initialModel?: MimoModel, admitOnly = false) {
  const path = `/session/${sessionID}/message`
  const partID = inboundPartID(item.id)
  // Recognize old persisted messages too, but never automatically execute them again.
  const legacyID = partID.replace(/^prt_/, 'msg_')
  const find = (messages: any[]) => messages.find(m => m.info?.role === 'user'
    && (m.info.id === legacyID || m.parts?.some((p: any) => p.id === partID)))
  let messages = await api(path)
  const submitted = submissions.get(api) ?? new Set<string>()
  submissions.set(api, submitted)
  const key = `${sessionID}:${item.id}`
  if (!find(messages) && !submitted.has(key)) {
    const catalog = await api('/provider')
    const config = await api('/config')
    const last = messages.findLast((m: any) => m.info?.role === 'user'
      && (!m.info.agentID || m.info.agentID === 'main'))?.info.model
    const model = availableModel(catalog, [last, initialModel, parseModel(config.model)])
    if (!model) throw new Error('Select a connected model in MiMo before Telegram delivery')
    // MiMo compares message IDs chronologically. Let its native generator own
    // that order; the stable part ID is solely an admission/dedup receipt.
    if (admitOnly) submitted.add(key)
    try {
      await api(admitOnly ? `/session/${sessionID}/prompt_async` : path, { model,
        parts: [{ id: partID, type: 'text', text: formatCodexInbound(item.content, item.meta),
          ...(admitOnly ? { metadata: { polydaemonInbound: { chatID: item.meta.chat_id, delivered: false } } } : {}) }] })
    } catch (error) {
      // A definite HTTP rejection is retryable; an ambiguous transport loss is
      // checked against the receipt, never blindly resubmitted.
      if (/^MiMo HTTP (?:400|401|403|404|409|429)$/.test(String((error as Error).message))) submitted.delete(key)
      throw error
    }
    messages = await api(path)
  }
  const user = find(messages)
  if (!user) throw new Error('MiMo did not persist the incoming message')
  submitted.delete(key)
  if (admitOnly) {
    const receipt = user.parts.find((p: any) => p.id === partID) ?? user.parts.find((p: any) => p.type === 'text')
    if (!receipt) throw new Error('MiMo receipt missing')
    if (!receipt.metadata?.polydaemonInbound) {
      await api(`${path}/${user.info.id}/part/${receipt.id}`, { ...receipt,
        metadata: { ...receipt.metadata, polydaemonInbound: { chatID: item.meta.chat_id, delivered: false } } }, 'PATCH')
    }
    return { id: user.info.id as string, final: null }
  }
  let final = finalReply(messages, user.info.id)
  if (!final || (!final.error && !final.replied && !final.text)) {
    const idle = async () => {
      const status = await api('/session/status')
      if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Invalid MiMo session status')
      return !Object.hasOwn(status, sessionID) || status[sessionID]?.type === 'idle'
    }
    if (await idle()) {
      const permissions = await api('/permission'), questions = await api('/question')
      if (!Array.isArray(permissions) || !Array.isArray(questions)) throw new Error('Invalid MiMo pending requests')
      if (![...permissions, ...questions].some(p => p.sessionID === sessionID)) {
        // Idle is published after native cleanup. Re-read history and status so
        // a finishing or concurrently resumed turn is not mistaken for an orphan.
        messages = await api(path)
        final = finalReply(messages, user.info.id)
        if ((!final || (!final.error && !final.replied && !final.text)) && await idle()) {
          final = { error: true, text: '', replied: false,
            message: 'MiMo остановился без итогового ответа. Ход сохранён в сессии; команды не повторялись. Следующие сообщения будут обработаны.' }
        }
      }
    }
  }
  return { id: user.info.id as string, final }
}

// Native history is the durable delivery ledger; receiving the next prompt does
// not depend on this relay, a model response, or a Telegram send succeeding.
export async function relayReplies(api: MimoAPI, sessionID: string, send: (text: string, chatID: string, promptID: string) => Promise<void>) {
  const path = `/session/${sessionID}/message`
  const status = await api('/session/status')
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Invalid MiMo session status')
  const idle = !Object.hasOwn(status, sessionID) || status[sessionID]?.type === 'idle'
  const pending = idle ? [...await api('/permission'), ...await api('/question')] : []
  const messages = await api(path)
  for (const user of messages.filter(isInboundMessage)) {
    const receipt = user.parts.find((p: any) => p.metadata?.polydaemonInbound && !p.metadata.polydaemonInbound.delivered)
    if (!receipt) continue
    const delivery = receipt.metadata.polydaemonInbound
    let final = finalReply(messages, user.info.id)
    if (!final || (!final.error && !final.replied && !final.text)) {
      if (!idle || pending.some(p => p.sessionID === sessionID)) continue
      const now = await api('/session/status')
      if (!now || typeof now !== 'object' || Array.isArray(now)) throw new Error('Invalid MiMo session status')
      if (Object.hasOwn(now, sessionID) && now[sessionID]?.type !== 'idle') continue
      // MiMo may combine/steer several incoming prompts into the latest turn.
      const later = messages.slice(messages.indexOf(user) + 1).some((m: any) => m.info.role === 'user')
      final = later ? { error: false, replied: true, text: '' }
        : { error: true, replied: false, text: '', message: 'MiMo остановился без итогового ответа. Ход сохранён; команды не повторялись.' }
    }
    if (final.error || !final.replied) await send(final.error ? final.message : final.text, delivery.chatID, user.info.id)
    await api(`${path}/${user.info.id}/part/${receipt.id}`, { ...receipt,
      metadata: { ...receipt.metadata, polydaemonInbound: { ...delivery, delivered: true } } }, 'PATCH')
  }
}

export function finalReply(messages: any[], messageID: string) {
  const at = messages.findIndex(m => m.info?.id === messageID && m.info?.role === 'user')
  if (at < 0) return null
  const next = messages.findIndex((m, i) => i > at && m.info?.role === 'user')
  const answers = messages.filter((m, i) => m.info?.role === 'assistant'
    && (m.info.parentID ? m.info.parentID === messageID : i > at && (next < 0 || i < next)))
  const last = answers.at(-1)
  // Native aborts can persist an error without time.completed.
  if (last?.info.error) return { error: true, text: '', replied: false, message: modelError(last.info.error) }
  if (!last?.info?.time?.completed) return null
  // MiMo stops on permission rejection before finish-step, but still stamps completed.
  if (!last.info.finish && last.parts?.some((p: any) => p.type === 'tool' && p.state?.status === 'error'
    && p.state.error === 'The user rejected permission to use this specific tool call.')) {
    const stoppedAt = new Date(last.info.time.completed).toISOString()
    return { error: true, text: '', replied: false,
      message: `MiMo: ход остановился ${stoppedAt} после отклонения запроса разрешения. Это время события, не доставки уведомления. Источник отказа не установлен; команда автоматически не повторялась.` }
  }
  if (!last.info.finish || last.info.finish === 'tool-calls') return null
  const replied = answers.some(m => m.parts?.some((p: any) => p.type === 'tool'
    && /^(?:PolyDaemon|tg[-_]bridge)_reply$/i.test(p.tool) && p.state?.status === 'completed'
    && !p.state?.metadata?.isError && /\bsent (?:\(id: [1-9]\d*\)|[1-9]\d* parts \(ids: [1-9]\d*(?:, [1-9]\d*)*\))/.test(p.state?.output ?? '')))
  const text = (last.parts ?? []).filter((p: any) => p.type === 'text' && !p.ignored).map((p: any) => p.text).join('\n').trim()
  return { error: false, text, replied }
}
