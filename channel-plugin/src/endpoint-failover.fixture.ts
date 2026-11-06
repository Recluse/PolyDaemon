// Child process for endpoint-failover.test.ts: config.ts reads transport.json from
// $HOME once at import, so every scenario needs a fresh process. Prints one JSON
// line per request: which fake bot endpoint answered (or "fail").
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [primaryPort, reservePort] = process.argv.slice(2).map(Number)
const home = process.env.HOME!
mkdirSync(join(home, '.tg-bridge-channel'), { recursive: true })
const endpoint = (port: number) => ({ bot_url: `http://127.0.0.1:${port}/`, api_root: `http://127.0.0.1:${port}/`,
  botapi_ssh: '', botapi_container: 'telegram-bot-api' })
writeFileSync(join(home, '.tg-bridge-channel', 'transport.json'),
  JSON.stringify({ version: 2, endpoints: [endpoint(primaryPort), endpoint(reservePort)] }))

let now = 1_000_000
Date.now = () => now
const { listWindowsRemote } = await import('./bot-rpc.ts')
const config = await import('./config.ts')

for await (const line of console) {
  const [command, arg] = line.trim().split(' ')
  if (command === 'advance') { now += Number(arg); console.log(JSON.stringify({ advanced: arg })); continue }
  if (command === 'exit') break
  const result = await listWindowsRemote()
  console.log(JSON.stringify({ ok: result.ok, answered: result.ok ? result.windows[0]?.name : 'fail',
    bot_url: config.BOT_URL, api_root: config.API_ROOT }))
}
process.exit(0)
