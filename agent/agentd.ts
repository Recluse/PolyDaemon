#!/usr/bin/env bun
// agentd.ts — PolyDaemon agent v0: the board's per-machine eyes and hands
// (plan/active/board/01-daemon-v0.md; SRS 10/40/95).
//
//   GET  /v1/health                          — no auth: {ok, version}
//   GET  /v1/status                          — windows / orphans / stale rows
//   WS   /v1/events                          — normalized live transcript tail
//   GET  /v1/windows/{key}/transcript        — history pages (?since=&limit=)
//   POST /v1/send                            — {window_key, text} → plugin /message
//   POST /v1/launch                          — {workspace_path, name?} → Terminal.app
//
// Config: ~/.tg-bridge/agent.toml (created with defaults on first run).
// Run:    bun run agent/agentd.ts
import { randomBytes, timingSafeEqual } from 'crypto'
import { loadConfig } from './config.ts'
import { log } from './log.ts'
import { readRegistry, rowIsStale, findByKey, HEARTBEAT_FRESH_SECONDS, type LocalRow } from './registry.ts'
import { scanOrphans } from './orphans.ts'
import { TranscriptTailer, readTranscript, type AgentEvent } from './transcripts.ts'
import { launchWindow, type LaunchRequest } from './launch.ts'
import { listTree, readProjectFile } from './files.ts'
import { ensureAppServer, stopAppServer, deliverToCodex, codexStatus, lastThreadFor } from './codex.ts'

export const VERSION = '0.1.0'

// Zig-era Bun known-good for the bridge. The Rust port is heading into
// releases with thousands of unsafe blocks (bun.com/bun-unsafe-audit) —
// refuse to silently run the fleet's plumbing on an unvetted runtime.
// Bump deliberately after testing, together with `brew upgrade bun`.
const EXPECTED_BUN_MAJOR_MINOR = '1.3'
{
  const mm = Bun.version.split('.').slice(0, 2).join('.')
  if (mm !== EXPECTED_BUN_MAJOR_MINOR) {
    log(`WARNING: bun ${Bun.version} != expected ${EXPECTED_BUN_MAJOR_MINOR}.x — `
      + `runtime changed under us (Rust port?). Verify before trusting this daemon; `
      + `brew pin bun / rollback if unintended.`)
  }
}

const cfg = loadConfig()
const tailer = new TranscriptTailer()

// --- Auth --------------------------------------------------------------------

// Constant-time Bearer check (the daemon may be mesh-exposed) — same pattern
// as clients/launch-agent.ts. WS clients can't always set headers, so
// /v1/events also accepts ?token=.
function tokenOk(got: string): boolean {
  const a = Buffer.from(got)
  const b = Buffer.from(cfg.auth_token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authed(req: Request, url: URL): boolean {
  const header = req.headers.get('Authorization') ?? ''
  if (header.startsWith('Bearer ') && tokenOk(header.slice(7))) return true
  const q = url.searchParams.get('token')
  return q !== null && tokenOk(q)
}

// --- Views -------------------------------------------------------------------

/** Registry row → public window view. auth_token stays private to this host —
 *  the board talks to windows through the daemon, never directly. */
function windowView(id: string, row: LocalRow, nowSec: number) {
  return {
    key: row.instance_name || row.workspace_name,
    registry_id: id,
    instance_name: row.instance_name,
    workspace_name: row.workspace_name,
    cwd: row.cwd,
    host: row.host,
    port: row.port,
    pid: row.pid,
    parent_pid: row.parent_pid,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    heartbeat_age_s: Math.round((nowSec - (row.heartbeat_at ?? 0)) * 10) / 10,
  }
}

// Last-known plugin /status per registry id — a slow/absent plugin must not
// blank the board's state, it just goes stale until the next good poll.
const pluginStatusCache = new Map<string, unknown>()

async function fetchPluginStatus(row: LocalRow): Promise<unknown | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`http://${row.host}:${row.port}/status`, {
      headers: { Authorization: `Bearer ${row.auth_token}` },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function statusBody() {
  const nowSec = Date.now() / 1000
  const registry = readRegistry()
  const live: Array<[string, LocalRow]> = []
  const stale: (ReturnType<typeof windowView> & { stale_reason: string })[] = []
  for (const [id, row] of Object.entries(registry)) {
    if (rowIsStale(row, nowSec)) {
      stale.push({
        ...windowView(id, row, nowSec),
        stale_reason: `heartbeat older than ${HEARTBEAT_FRESH_SECONDS}s and pid not verifiably alive`,
      })
    } else {
      live.push([id, row])
    }
  }
  const plugins = await Promise.all(live.map(async ([id, row]) => {
    const st = await fetchPluginStatus(row)
    if (st !== null) pluginStatusCache.set(id, st)
    return st ?? pluginStatusCache.get(id) ?? null
  }))
  const windows = live.map(([id, row], i) => ({
    ...windowView(id, row, nowSec),
    plugin: plugins[i],
  }))
  return {
    machine_id: cfg.machine_id,
    version: VERSION,
    windows,
    orphans: scanOrphans(registry),
    stale,
  }
}

/** Proxy an Agent-Inbox decision to the window plugin's callback route.
 *  Race with TG/VS Code is resolved inside the plugin (first wins, 404 for
 *  the loser) — we just relay the verdict. */
async function handleResolve(req: Request): Promise<Response> {
  let body: { window_key?: string; kind?: string; id?: string; action?: string; idx?: number; text?: string }
  try { body = await req.json() as typeof body } catch { return new Response('Bad JSON', { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response('Bad JSON', { status: 400 })
  const { window_key: key, kind, id } = body
  if (!key || !kind || !id) return Response.json({ ok: false, reason: 'window_key, kind, id required' }, { status: 400 })
  const found = findByKey(key)
  if (!found) return Response.json({ ok: false, reason: `unknown window "${key}"` }, { status: 404 })

  let path: string
  let payload: Record<string, unknown>
  if (kind === 'approval') {
    if (!body.action || !['once', 'always', 'deny'].includes(body.action)) {
      return Response.json({ ok: false, reason: 'explicit once/always/deny action required' }, { status: 400 })
    }
    path = '/approve-callback'; payload = { id, action: body.action }
  } else if (kind === 'plan') {
    if (!body.action || !['apply', 'decline'].includes(body.action)) {
      return Response.json({ ok: false, reason: 'explicit apply/decline action required' }, { status: 400 })
    }
    path = '/plan-callback'; payload = { id, action: body.action }
  } else if (kind === 'ask') {
    path = '/ask-callback'
    payload = typeof body.idx === 'number' ? { id, idx: body.idx }
      : body.text ? { id, action: 'text', text: body.text }
      : { id, action: body.action ?? 'confirm' }
  } else {
    return Response.json({ ok: false, reason: `unknown kind "${kind}"` }, { status: 400 })
  }
  try {
    const res = await fetch(`http://${found.row.host}:${found.row.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${found.row.auth_token}` },
      body: JSON.stringify(payload),
    })
    const detail = await res.json().catch(() => ({}))
    return Response.json({ ok: res.ok, plugin_status: res.status, detail }, { status: res.ok ? 200 : res.status })
  } catch (e) {
    return Response.json({ ok: false, reason: `plugin unreachable: ${e}` }, { status: 502 })
  }
}

// --- Handlers ----------------------------------------------------------------

function handleTranscript(key: string, url: URL): Response {
  const found = findByKey(key)
  if (!found) return Response.json({ ok: false, reason: `unknown window "${key}"` }, { status: 404 })

  const sinceRaw = url.searchParams.get('since') ?? ''
  let sinceMs = 0
  if (sinceRaw) {
    // Accept ISO-8601 or unix epoch (seconds or ms).
    const asNum = Number(sinceRaw)
    if (Number.isFinite(asNum) && sinceRaw.trim() !== '') {
      sinceMs = asNum > 1e12 ? asNum : asNum * 1000
    } else {
      const parsed = Date.parse(sinceRaw)
      if (!Number.isFinite(parsed)) {
        return Response.json({ ok: false, reason: 'since must be ISO-8601 or unix epoch' }, { status: 400 })
      }
      sinceMs = parsed
    }
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 1000)

  const { file, events } = readTranscript(key, found.row.cwd, sinceMs, limit)
  // next_since: pass the last event's ts back as ?since= for the next page.
  const nextSince = events.length === limit ? events[events.length - 1].ts : null
  return Response.json({
    ok: true, window_key: key, cwd: found.row.cwd, transcript_file: file,
    count: events.length, next_since: nextSince, events,
  })
}

async function handleSend(req: Request): Promise<Response> {
  let body: { window_key?: string; text?: string }
  try { body = await req.json() as typeof body } catch { return new Response('Bad JSON', { status: 400 }) }
  const key = String(body.window_key ?? '')
  const text = String(body.text ?? '')
  if (!key || !text) return Response.json({ ok: false, reason: 'window_key and text required' }, { status: 400 })

  const found = findByKey(key)
  if (!found) return Response.json({ ok: false, reason: `unknown window "${key}"` }, { status: 404 })
  if (rowIsStale(found.row)) {
    return Response.json({ ok: false, reason: `window "${key}" looks stale (lapsed heartbeat, dead pid)` }, { status: 409 })
  }

  // Plugin /message contract: channel-plugin/server.ts InboundBody.
  // chat_id: the REAL forum chat when configured — the model's routing rule
  // replies to the tag's chat_id, and a pseudo-id ('board') made every reply
  // die with 400 "chat not found" (seen live 2026-07-07). With the
  // real chat the reply lands in the window's own topic (plugin resolves the
  // thread from its binding) and the board reads it back from the transcript.
  const inbound = {
    request_id: randomBytes(8).toString('hex'),
    chat_id: cfg.forum_chat_id || 'board',
    user_id: 'board',
    message_id: '0',
    text,
  }
  const target = `http://${found.row.host}:${found.row.port}/message`
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${found.row.auth_token}`,
      },
      body: JSON.stringify(inbound),
      signal: AbortSignal.timeout(10_000),
    })
    const detail = await res.text().catch(() => '')
    if (!res.ok && res.status !== 202) {
      return Response.json({ ok: false, reason: `plugin responded ${res.status}: ${detail.slice(0, 200)}` }, { status: 502 })
    }
    log(`send: → ${key} (${found.row.host}:${found.row.port}), ${text.length} chars`)
    return Response.json({ ok: true, window_key: key, request_id: inbound.request_id, plugin_status: res.status })
  } catch (e) {
    return Response.json({ ok: false, reason: `plugin unreachable at ${target}: ${e}` }, { status: 502 })
  }
}

// --- Server ------------------------------------------------------------------

type WsData = { sink: (ev: AgentEvent) => void }

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

async function route(
  req: Request,
  srv: Parameters<NonNullable<Parameters<typeof Bun.serve<WsData>>[0]['fetch']>>[1],
  url: URL,
): Promise<Response | undefined> {
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return Response.json({ ok: true, version: VERSION })
  }
  if (!authed(req, url)) return new Response('Unauthorized', { status: 401 })

  if (url.pathname === '/v1/events') {
    // sink is filled in ws.open — created here so close() can always find it.
    const data: WsData = { sink: () => {} }
    if (srv.upgrade(req, { data })) return undefined
    return new Response('Expected a WebSocket upgrade', { status: 426 })
  }
  if (req.method === 'GET' && url.pathname === '/v1/status') {
    return Response.json(await statusBody())
  }
  if (req.method === 'POST' && url.pathname === '/v1/resolve') {
    return handleResolve(req)
  }
  if (req.method === 'POST' && url.pathname === '/v1/codex/deliver') {
    let body: { cwd?: string; text?: string }
    try { body = await req.json() as typeof body } catch { return new Response('Bad JSON', { status: 400 }) }
    if (!body.cwd || !body.text) return Response.json({ ok: false, reason: 'cwd and text required' }, { status: 400 })
    try {
      const r = await deliverToCodex(body.cwd, body.text)
      log(`codex deliver cwd=${body.cwd}: ${r.ok ? `${r.mode} -> ${r.thread_id}` : `refused: ${r.reason}`}`)
      return Response.json(r, { status: r.ok ? 200 : 409 })
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) }, { status: 502 })
    }
  }
  if (req.method === 'GET' && url.pathname === '/v1/codex/status') {
    return Response.json(await codexStatus())
  }
  if (req.method === 'GET' && url.pathname === '/v1/codex/last-thread') {
    const cwd = url.searchParams.get('cwd') ?? ''
    if (!cwd) return Response.json({ ok: false, reason: 'cwd required' }, { status: 400 })
    try {
      return Response.json({ ok: true, thread_id: await lastThreadFor(cwd) })
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) }, { status: 502 })
    }
  }
  const tMatch = url.pathname.match(/^\/v1\/windows\/([^/]+)\/transcript$/)
  if (req.method === 'GET' && tMatch) {
    return handleTranscript(decodeURIComponent(tMatch[1]), url)
  }
  const fMatch = url.pathname.match(/^\/v1\/windows\/([^/]+)\/(files|file)$/)
  if (req.method === 'GET' && fMatch) {
    const found = findByKey(decodeURIComponent(fMatch[1]))
    if (!found) return Response.json({ ok: false, reason: 'unknown window' }, { status: 404 })
    try {
      if (fMatch[2] === 'files') {
        return Response.json({ ok: true, ...listTree(found.row.cwd) })
      }
      const rel = url.searchParams.get('path') ?? ''
      if (!rel) return Response.json({ ok: false, reason: 'path required' }, { status: 400 })
      const r = readProjectFile(found.row.cwd, rel)
      return Response.json(r, { status: r.ok ? 200 : 404 })
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) }, { status: 500 })
    }
  }
  if (req.method === 'POST' && url.pathname === '/v1/send') {
    return handleSend(req)
  }
  if (req.method === 'POST' && url.pathname === '/v1/launch') {
    let body: LaunchRequest
    try { body = await req.json() as LaunchRequest } catch { return new Response('Bad JSON', { status: 400 }) }
    const result = launchWindow(body)
    return Response.json(result, { status: result.ok ? 200 : 400 })
  }
  return new Response('Not Found', { status: 404 })
}

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve<WsData>({
    hostname: cfg.bind_host,
    port: cfg.port,
    async fetch(req, srv) {
      const url = new URL(req.url)

      // CORS: the board's webview (tauri://localhost) calls us with an
      // Authorization header, which triggers a preflight. Localhost-only
      // daemon + Bearer auth make a permissive origin acceptable here.
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }
      const res = await route(req, srv, url)
      if (res) for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
      return res as Response
    },
    websocket: {
      open(ws) {
        // One JSON event per WS text frame — ndjson-compatible for clients
        // that concatenate frames with '\n'.
        ws.data.sink = (ev: AgentEvent) => { try { ws.send(JSON.stringify(ev)) } catch {} }
        tailer.subscribe(ws.data.sink)
        log(`events: subscriber connected (${tailer.subscriberCount} total)`)
      },
      close(ws) {
        tailer.unsubscribe(ws.data.sink)
        log(`events: subscriber left (${tailer.subscriberCount} total)`)
      },
      message() { /* inbound WS messages are ignored in v0 */ },
    },
    error(err) {
      log(`server error: ${err}`)
      return new Response('Internal Server Error', { status: 500 })
    },
  })
} catch (e) {
  log(`cannot bind ${cfg.bind_host}:${cfg.port} — ${e}. `
    + `If bind_host is a mesh IP, check the interface is up.`)
  process.exit(1)
}

log(`PolyDaemon agent v${VERSION} listening on ${cfg.bind_host}:${cfg.port} (machine_id=${cfg.machine_id})`)

// Codex adapter: own the app-server so TUIs can attach (codex --remote) and
// the bot's inbound can be pushed into threads (см. /v1/codex/deliver).
void ensureAppServer()

// --- Graceful shutdown ---------------------------------------------------------

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} — shutting down`)
  try { tailer.stop() } catch {}
  try { stopAppServer() } catch {}
  try { server.stop(true) } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
