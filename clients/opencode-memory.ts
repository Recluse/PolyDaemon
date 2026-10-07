// ponytail: observes calls in this session, never starts a model or polls the DB.
export function memoryStatus(messages: any[] = [], servers: any[] = []) {
  const calls = messages.flatMap(m => m.type === 'assistant' ? m.content ?? [] : [])
    .filter(p => p.type === 'tool' && /_get_project_map$/.test(p.name))
  const call = calls.at(-1)
  if (!call) return { connection: 'Not identified', map: 'Not checked' }
  const name = call.name.slice(0, -'_get_project_map'.length)
  const server = servers.find(s => s.name === name)
  const connection = server?.status?.status ?? 'Unknown'
  if (call.state?.status === 'error') return { connection, map: 'Error' }
  if (call.state?.status !== 'completed') return { connection, map: 'Checking' }
  const text = (call.state.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
  const map = /^\(!\) SCOPE:/m.test(text) ? 'Scope warning'
    : /^\(!\) STALE MAP:/m.test(text) ? 'Stale (observed)'
    : /\[no structural map for repo /.test(text) ? 'Missing'
    : /^# PROJECT MAP\b/m.test(text) ? 'Available (observed)' : 'Unknown'
  return { connection, map }
}
