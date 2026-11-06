import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

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
  // The last thread the server confirmed. While switches are in flight the
  // panel shows none; a failed switch returns to this, even when an earlier
  // switch was still pending when the later one was sent.
  confirmed: { thread: string | null; context: ContextUsage | null } = { thread: null, context: null }
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
          if (this.confirmed.thread === this.thread) this.confirmed.context = this.context
          this.publish(this.thread, this.context)
        }
        return
      }
      if (m.method || !this.pending.has(m.id)) return
      const pending = this.pending.get(m.id)!
      this.pending.delete(m.id)
      if (pending.sequence !== this.sequence) {
        // An older switch answered after a newer one was sent. It does not
        // decide what the panel shows now, but if it succeeded the CLI WAS on
        // that thread, so a later failure must fall back to it, not further.
        const t = m.result?.thread
        let same = false
        try { same = !!t && realpathSync(t.cwd) === realpathSync(this.cwd) } catch { /* not ours */ }
        if (!m.error && t && typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(t.id)
            && t.ephemeral !== true && t.parentThreadId == null) {
          this.confirmed = same ? { thread: t.id, context: null } : { thread: null, context: null }
        }
        return
      }
      if (m.error || !m.result) {
        // The CLI's switch failed, so it is still on the last confirmed thread.
        this.thread = this.confirmed.thread
        this.context = this.confirmed.context
        this.publish(this.thread, this.context)
        return
      }
      const t = m.result?.thread
      if (t?.ephemeral === true || t?.parentThreadId != null) {
        this.thread = pending.previous.thread
        this.context = pending.previous.context
        this.publish(this.thread, this.context)
        return
      }
      let sameWorkspace = false
      try { sameWorkspace = realpathSync(t?.cwd) === realpathSync(this.cwd) } catch { /* unreadable cwd: not ours */ }
      if (typeof t?.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(t.id) || !sameWorkspace) {
        // The CLI is now on a thread of another workspace (or one we cannot
        // read): nothing of this workspace is confirmed any more.
        this.confirmed = { thread: null, context: null }
        return
      }
      this.thread = t.id
      this.confirmed = { thread: t.id, context: null }
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

/** Writes the panel's binding file. The file sits in a per-launch folder under
 *  the workspace's tmp/, which cleanup can delete while the CLI keeps running;
 *  the folder is recreated instead of failing every later write in silence
 *  (the panel then showed "unavailable" for good while Telegram worked). */
export function bindingFilePublisher(file: string, cwd: string) {
  const folder = dirname(file)
  const scratch = dirname(folder)            // the workspace's tmp/
  // O_NOFOLLOW where the platform has it: a planted .next symlink must not
  // redirect (and truncate) another file.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
  const write = (body: string) => {
    const fd = openSync(file + '.next', flags, 0o600)
    try { writeSync(fd, body) } finally { closeSync(fd) }
    renameSync(file + '.next', file)
  }
  // The launcher refuses a symlinked tmp/. Check before every write, not only
  // when recreating: a link swapped in later would otherwise be followed.
  const refuseLinks = () => {
    for (const dir of [scratch, folder]) {
      try { if (lstatSync(dir).isSymbolicLink()) throw new Error(`binding folder ${dir} is a symlink`) }
      catch (e: any) { if (e?.code !== 'ENOENT') throw e }
    }
  }
  return (thread: string | null, context: ContextUsage | null = null) => {
    const body = JSON.stringify({ thread, cwd, context })
    refuseLinks()
    try {
      write(body)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      refuseLinks()
      write(body)
    }
  }
}

if (import.meta.main) {
  const [url, cwd, file] = process.argv.slice(2)
  if (!url || !cwd || !file) throw Error('Expected URL cwd binding-file')
  const publish = bindingFilePublisher(file, cwd)
  publish(null)
  const proxy = launchProxy(url, cwd, publish)
  console.log(JSON.stringify({ port: proxy.port }))
  const stop = () => { proxy.stop(); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
