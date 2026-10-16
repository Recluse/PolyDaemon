import { realpathSync, renameSync, writeFileSync } from 'node:fs'

export type ContextUsage = { tokens: number; window: number | null }
export function contextUsage(value: any): ContextUsage | null {
  const tokens = value?.last?.totalTokens, window = value?.modelContextWindow
  if (!Number.isSafeInteger(tokens) || tokens < 0
      || (window !== null && (!Number.isSafeInteger(window) || window <= 0))) return null
  return { tokens, window }
}

// Observe only replies to THIS CLI's requests, never a global thread/started event.
export class LaunchBinding {
  pending = new Map<string | number, { sequence: number; previous: { thread: string | null; context: ContextUsage | null } }>()
  sequence = 0
  thread: string | null = null
  context: ContextUsage | null = null
  constructor(readonly cwd: string, readonly publish: (thread: string | null, context?: ContextUsage | null) => void) {}
  client(raw: string) {
    try {
      const m = JSON.parse(raw)
      if (!['thread/start', 'thread/resume', 'thread/fork'].includes(m.method) || m.id == null) return
      // The CLI also starts ephemeral background work on this same connection.
      // Those requests do not represent navigation to another conversation.
      if (m.params?.ephemeral === true) return
      if (this.pending.size >= 256) this.pending.clear()
      this.pending.set(m.id, { sequence: ++this.sequence, previous: { thread: this.thread, context: this.context } })
      this.thread = null
      this.context = null
      this.publish(null)
    } catch { /* observation must not modify transport */ }
  }
  server(raw: string) {
    try {
      const m = JSON.parse(raw)
      if (m.method === 'thread/tokenUsage/updated') {
        if (this.thread && m.params?.threadId === this.thread) {
          this.context = contextUsage(m.params.tokenUsage)
          this.publish(this.thread, this.context)
        }
        return
      }
      if (m.method || !this.pending.has(m.id)) return
      const pending = this.pending.get(m.id)!
      this.pending.delete(m.id)
      if (pending.sequence !== this.sequence) return
      const t = m.result?.thread
      if (t?.ephemeral === true || t?.parentThreadId != null) {
        this.thread = pending.previous.thread
        this.context = pending.previous.context
        this.publish(this.thread, this.context)
        return
      }
      if (typeof t?.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(t.id)
          || realpathSync(t.cwd) !== realpathSync(this.cwd)) return
      this.thread = t.id
      this.publish(t.id)
    } catch { /* bad or failed replies leave the panel unbound */ }
  }
}

export function launchProxy(url: string, cwd: string, publish: (id: string | null, context?: ContextUsage | null) => void) {
  const target = new URL(url)
  if (target.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(target.hostname)
      || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw Error('Loopback required')
  let claimed = false
  let peer: any = null
  let upstream: WebSocket | null = null
  const binding = new LaunchBinding(cwd, publish)
  let buffered: (string | Buffer)[] = [], bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    clearTimeout(timer); buffered = []; bytes = 0
    publish(null)
    upstream?.close(); peer?.close()
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      if (claimed) return new Response('One CLI only', { status: 409 })
      if (server.upgrade(req)) { claimed = true; return }
      return new Response('WebSocket required', { status: 400 })
    },
    websocket: {
      open(ws) {
        peer = ws
        upstream = new WebSocket(url)
        upstream.binaryType = 'arraybuffer'
        timer = setTimeout(close, 8000)
        upstream.onopen = () => {
          clearTimeout(timer)
          for (const raw of buffered) upstream!.send(raw)
          buffered = []; bytes = 0
        }
        upstream.onmessage = event => {
          if (typeof event.data === 'string') binding.server(event.data)
          ws.send(event.data as string)
        }
        upstream.onclose = close
        upstream.onerror = close
      },
      message(_ws, raw) {
        if (typeof raw === 'string') binding.client(raw)
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw)
        else {
          bytes += Buffer.byteLength(raw)
          if (bytes > 1024 * 1024) { close(); return }
          buffered.push(raw)
        }
      },
      close() { close() },
    },
  })
  return { port: server.port, stop() { close(); server.stop(true) } }
}

if (import.meta.main) {
  const [url, cwd, file] = process.argv.slice(2)
  if (!url || !cwd || !file) throw Error('Expected URL cwd binding-file')
  const publish = (thread: string | null, context: ContextUsage | null = null) => {
    writeFileSync(file + '.next', JSON.stringify({ thread, cwd, context }), { mode: 0o600 })
    renameSync(file + '.next', file)
  }
  publish(null)
  const proxy = launchProxy(url, cwd, publish)
  console.log(JSON.stringify({ port: proxy.port }))
  const stop = () => { proxy.stop(); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
