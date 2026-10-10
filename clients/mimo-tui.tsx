import { createSignal, onCleanup } from 'solid-js'
import { binding, bridgeRequest } from './mimo-bridge.ts'
import { readProjectMemory } from './opencode-memory-reader.ts'

export default { id: 'polydaemon.mimo.status', tui: async (api: any) => {
  api.slots.register({ order: 210, slots: { sidebar_content(_context: any, props: any) {
    const [view, setView] = createSignal<any>({ bridge: 'Connecting', memory: 'Not checked' })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const cwd = api.state.path.directory
    async function refresh() {
      const next: any = { bridge: 'Unavailable', memory: 'Unknown' }
      try {
        if (binding(cwd).sessionID !== props.session_id) throw new Error('Unbound')
        const status = await bridgeRequest(cwd, '/status', undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
        const topic = status.topic
        next.bridge = Number.isSafeInteger(topic?.message_thread_id) && topic.message_thread_id > 0
          ? `${topic.title || status.instance_name} (#${topic.message_thread_id})` : 'Not registered'
      } catch (error) {
        // Only local error categories, never raw transport errors or credentials.
        const message = error instanceof Error ? error.message : ''
        next.bridge = /^(MiMo bridge not connected|MiMo window identity missing|MiMo bridge session scope mismatch|Unbound|Bridge HTTP \d+)$/.test(message)
          ? message : `Unavailable (${error instanceof Error ? error.name : 'error'})`
      }
      try {
        const { data: config } = await api.client.config.get({ directory: cwd })
        const servers = api.state.mcp().filter((s: any) => /^(HyperMnesia|agentmem)$/i.test(s.name))
        if (servers.length === 1) {
          const server = servers[0]
          next.memory = server.status
          const descriptor = config?.mcp?.[server.name]
          if (server.status === 'connected' && descriptor?.enabled !== false) {
            next.data = await readProjectMemory(descriptor, cwd, AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]))
          }
        }
      } catch { next.memory = 'Check unavailable' }
      if (controller.signal.aborted) return
      setView(next)
      timer = setTimeout(refresh, next.data ? 60000 : 10000)
    }
    void refresh()
    onCleanup(() => { controller.abort(); clearTimeout(timer) })
    const theme = () => api.theme.current
    const number = (n: unknown) => typeof n === 'number' ? String(n) : 'Unknown'
    const data = () => view().data
    return <box flexDirection="column" marginTop={1}>
      <text fg={theme().text}><b>PolyDaemon</b></text>
      <text fg={theme().textMuted} wrapMode="word">{() => view().bridge}</text>
      <text fg={theme().text} marginTop={1}><b>HyperMnesia</b></text>
      <text fg={theme().textMuted}>{() => `MCP: ${view().memory}`}</text>
      <text fg={theme().textMuted} wrapMode="word">{() => `Repo: ${data()?.repo ?? 'Unknown'}`}</text>
      <text fg={theme().textMuted}>{() => `Docs ${number(data()?.documents.indexed)} / chunks ${number(data()?.chunks.indexed)}`}</text>
      <text fg={data()?.freshness.state === 'fresh' ? theme().success : theme().warning}>{() => `Freshness: ${data()?.freshness.state ?? 'Unknown'}`}</text>
      <text fg={theme().textMuted} wrapMode="word">{() => `Changed ${number(data()?.freshness.stale)} / new ${number(data()?.freshness.unindexed)} / missing ${number(data()?.freshness.missing)}`}</text>
      <text fg={theme().textMuted}>{() => `Map: ${data()?.map.state ?? 'Unknown'}`}</text>
      <text fg={theme().textMuted} wrapMode="word">{() => `Checked: ${data()?.checked_at ?? 'Unknown'}`}</text>
    </box>
  } } })
} }
