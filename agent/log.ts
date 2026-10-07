// Logging — stderr with an `agentd:` prefix (launchd captures stderr; keep
// stdout clean). `debug` is gated on TG_AGENTD_DEBUG so tolerant-parser skips
// don't flood the log in normal operation.

const DEBUG = process.env.TG_AGENTD_DEBUG === '1'

export function log(msg: string): void {
  console.error(`agentd: ${msg}`)
}

export function debug(msg: string): void {
  if (DEBUG) console.error(`agentd: [debug] ${msg}`)
}
