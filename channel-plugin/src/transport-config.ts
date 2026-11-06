import { readFileSync } from 'node:fs'

export type TransportEndpoint = {
  bot_url: string
  api_root: string
  botapi_ssh: string
  botapi_container: string
}

export type TransportConfig = {
  version: 1 | 2
  endpoints: TransportEndpoint[] // ordered primary-first; empty = legacy single route
  bot_url: string
  api_root: string
  botapi_ssh: string
  botapi_container: string
}

const URL_KEYS = ['bot_url', 'api_root']
const ENDPOINT_KEYS = ['bot_url', 'api_root', 'botapi_ssh', 'botapi_container']

function checkUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error()
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
  return value
}

function checkEndpoint(raw: any): TransportEndpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
  if (Object.keys(raw).length !== ENDPOINT_KEYS.length
    || ENDPOINT_KEYS.some(k => !Object.hasOwn(raw, k))) throw new Error()
  const bot_url = checkUrl(raw.bot_url)
  const api_root = checkUrl(raw.api_root)
  if (typeof raw.botapi_ssh !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9_.@-]*)?$/.test(raw.botapi_ssh)) throw new Error()
  if (typeof raw.botapi_container !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw.botapi_container)) throw new Error()
  return { bot_url, api_root, botapi_ssh: raw.botapi_ssh, botapi_container: raw.botapi_container }
}

export function readTransportConfig(path: string): Partial<TransportConfig> {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (error: any) {
    if (error.code === 'ENOENT') return {}
    throw new Error('PolyDaemon transport config is unreadable')
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()

    // v2: ordered failover chain of full endpoints.
    if (value.version === 2) {
      const keys = ['version', 'endpoints']
      if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error()
      if (!Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 4) throw new Error()
      const endpoints = value.endpoints.map(checkEndpoint)
      return { version: 2, endpoints }
    }

    // v1: one explicit route (kept for existing hosts).
    const keys = ['version', 'bot_url', 'api_root', 'botapi_ssh', 'botapi_container']
    if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))
      || value.version !== 1) throw new Error()
    for (const key of URL_KEYS) checkUrl(value[key])
    if (typeof value.botapi_ssh !== 'string' || !/^(?:[A-Za-z0-9][A-Za-z0-9_.@-]*)?$/.test(value.botapi_ssh)
      || typeof value.botapi_container !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.botapi_container)) throw new Error()
    return value
  } catch {
    throw new Error('PolyDaemon transport config is invalid; refusing old-route fallback')
  }
}
