import { mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOG_FILE = join(homedir(), '.tg-bridge-channel', 'debug.log')

export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try { mkdirSync(join(homedir(), '.tg-bridge-channel'), { recursive: true }); appendFileSync(LOG_FILE, line) } catch {}
}
