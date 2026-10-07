import { Plugin } from '@opencode/plugin/tui'
import { createEffect, onCleanup } from 'solid-js'
import { memoryStatus } from './opencode-memory.ts'
import { ProjectMemory } from './opencode-memory-rpc.ts'

export default Plugin.define({
  id: 'polydaemon.memory',
  setup(context) {
    const rpc = context.client.rpc(ProjectMemory)
    const [cache, update] = context.storage.memory('project-status', { initial: { views: {} } })
    return context.ui.slot({
      append: 'sidebar.content',
      render: (props) => {
        const location = () => context.data.session.get(props.sessionID)?.location ?? context.location ?? context.data.location.default()
        createEffect(() => {
          const current = location()
          const sessionID = props.sessionID
          if (!current?.directory) return
          const controller = new AbortController()
          let timer: ReturnType<typeof setTimeout>
          const refresh = async () => {
            let view, bridge
            try { bridge = await rpc.bridge({ sessionID }, { location: current, signal: controller.signal }) }
            catch { bridge = { state: 'unavailable', topic: null } }
            try {
              view = await rpc.status({}, { location: current,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) })
            } catch {
              view = { server: null, data: null, state: 'error', reason: 'Status unavailable' }
            }
            if (controller.signal.aborted) return
            update(draft => { draft.views[current.directory] = { ...view, bridge } })
            timer = setTimeout(refresh, view?.state === 'unknown' || view?.state === 'pending' ? 5000 : 60000)
          }
          void refresh()
          onCleanup(() => { controller.abort(); clearTimeout(timer) })
        })
        const status = () => memoryStatus(
          context.data.session.message.list(props.sessionID),
          context.data.location.mcp.server.list(location()),
        )
        const view = () => cache.views[location()?.directory]
        const data = () => view()?.data
        const number = (n: unknown) => typeof n === 'number' ? String(n) : 'Unknown'
        return <box flexDirection="column" marginTop={1}>
          <text fg={context.theme.text.base}>PolyDaemon</text>
          <text fg={context.theme.text.base}>{() => `Topic: ${view()?.bridge?.topic ? `${view().bridge.topic.title} (#${view().bridge.topic.id})` : view()?.bridge?.state ?? 'Unknown'}`}</text>
          <text fg={context.theme.text.base}>HyperMnesia</text>
          <text fg={context.theme.text.base}>{() => `MCP: ${view()?.server ? view().state : status().connection}`}</text>
          <text fg={context.theme.text.base}>{() => `Repo: ${data()?.repo ?? 'Unknown'}`}</text>
          <text fg={context.theme.text.base}>{() => `Docs: ${number(data()?.documents.indexed)}`}</text>
          <text fg={context.theme.text.base}>{() => `Chunks: ${number(data()?.chunks.indexed)}`}</text>
          <text fg={context.theme.text.base}>{() => `Freshness: ${data()?.freshness.state ?? view()?.state ?? 'Unknown'}`}</text>
          <text fg={context.theme.text.base}>{() => `Changed: ${number(data()?.freshness.stale)}`}</text>
          <text fg={context.theme.text.base}>{() => `New: ${number(data()?.freshness.unindexed)}`}</text>
          <text fg={context.theme.text.base}>{() => `Missing: ${number(data()?.freshness.missing)}`}</text>
          <text fg={context.theme.text.base}>{() => `Map: ${data()?.map.state ?? status().map}`}</text>
          <text fg={context.theme.text.base}>{() => `Checked: ${data()?.checked_at ?? 'Unknown'}`}</text>
        </box>
      },
    })
  },
})
