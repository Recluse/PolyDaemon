import { expect, test } from 'bun:test'
import { pollMiMoStatus } from './mimo-status.ts'

test('bridge registration refreshes during a slow memory check; cleanup cancels both polls', async () => {
  let resolveMemory!: (value: any) => void
  let memoryCalls = 0, bridgeCalls = 0
  let memorySignal!: AbortSignal, bridgeSignal!: AbortSignal
  let view: any = {}
  const publish = (patch: any) => { view = { ...view, ...patch } }
  const stopMemory = pollMiMoStatus(signal => {
    memorySignal = signal
    memoryCalls++
    return new Promise(resolve => { resolveMemory = resolve })
  }, publish, () => 60000)
  const stopBridge = pollMiMoStatus(async signal => {
    bridgeSignal = signal
    return { bridge: ++bridgeCalls === 1 ? 'Waiting for Telegram topic' : 'fixture-mimo (#42)' }
  }, publish, () => 5)
  try {
    for (let n = 0; n < 100 && bridgeCalls < 3; n++) await Bun.sleep(5)
    expect(bridgeCalls).toBeGreaterThanOrEqual(3)
    expect(memoryCalls).toBe(1)
    expect(view.bridge).toBe('fixture-mimo (#42)')
    resolveMemory({ memory: 'connected', data: { documents: { indexed: 478 } } })
    await Bun.sleep(5)
    expect(view.data.documents.indexed).toBe(478)
    expect(view.bridge).toBe('fixture-mimo (#42)')
  } finally {
    stopMemory(); stopBridge()
  }
  expect(memorySignal.aborted).toBe(true)
  expect(bridgeSignal.aborted).toBe(true)
  const calls = bridgeCalls
  await Bun.sleep(20)
  expect(bridgeCalls).toBe(calls)
})

test('unmounted panel ignores a late result', async () => {
  let resolve!: (value: string) => void
  const values: string[] = []
  const stop = pollMiMoStatus(() => new Promise<string>(r => { resolve = r }), value => values.push(value), () => 5)
  stop()
  resolve('late')
  await Bun.sleep(20)
  expect(values).toEqual([])
})
