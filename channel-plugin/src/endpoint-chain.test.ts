import { describe, expect, test } from 'bun:test'
import { EndpointChain, DOWNTIME_MS, PROBE_STALE_MS, type Endpoint } from './endpoint-chain.ts'

const ep = (n: string): Endpoint => ({
  bot_url: `http://127.0.0.1:1${n}90`,
  api_root: `http://127.0.0.1:1${n}81`,
  botapi_ssh: '',
  botapi_container: 'telegram-bot-api',
})
const P = 0, R = 1

describe('EndpointChain', () => {
  test('starts on the primary', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    expect(chain.acquire(1000)).toMatchObject({ index: P, started: 1000, probe: false })
  })

  test('a failure on the active endpoint moves to the next one', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1004)
    expect(chain.activeIndex).toBe(R)
    expect(chain.acquire(1005).index).toBe(R)
  })

  test('a recovered primary is probed by one request at a time and taken back only on success', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)
    const t = 1000 + DOWNTIME_MS + 1
    const probe = chain.acquire(t)
    expect(probe).toMatchObject({ index: P, started: t, probe: true })
    // Concurrent requests while the probe is in flight stay on the reserve.
    expect(chain.acquire(t + 1)).toMatchObject({ index: R, started: t + 1, probe: false })
    expect(chain.acquire(t + 2).index).toBe(R)
    expect(chain.activeIndex).toBe(R)
    chain.succeeded(probe, t + 50)
    expect(chain.activeIndex).toBe(P)
    expect(chain.acquire(t + 60).index).toBe(P)
  })

  test('a failed probe keeps the reserve active and restarts the cooldown', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)
    const t = 1000 + DOWNTIME_MS + 1
    const probe = chain.acquire(t)
    chain.failed(probe, t + 4000)
    expect(chain.activeIndex).toBe(R)
    expect(chain.acquire(t + 4001).probe).toBe(false)
    expect(chain.acquire(t + 4000 + DOWNTIME_MS + 1).probe).toBe(true)
  })

  test('a late success from before a failure mark does not clear it', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    const a = chain.acquire(1000)        // A and B both on the primary
    const b = chain.acquire(1001)
    chain.failed(b, 1005)                // B fails: reserve takes over
    chain.succeeded(a, 1006)             // A's answer arrives late
    expect(chain.activeIndex).toBe(R)
    expect(chain.acquire(1007)).toMatchObject({ index: R, started: 1007, probe: false })
  })

  test('a late failure from before a success does not mark the endpoint down', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)
    const t = 1000 + DOWNTIME_MS + 1
    const probe = chain.acquire(t)
    chain.succeeded(probe, t + 10)
    const later = chain.acquire(t + 11)          // on the primary now
    const old = { ...later, seq: probe.seq }     // a request that started with the probe
    chain.failed(old, t + 20)
    expect(chain.activeIndex).toBe(P)
  })

  test('a dead reserve is charged to the reserve, and the primary is tried next', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)          // primary down at 1000
    chain.failed(chain.acquire(5000), 5000)          // reserve down at 5000
    // Both cooling: the oldest failure (primary) is the best guess.
    expect(chain.activeIndex).toBe(P)
    expect(chain.acquire(5001).index).toBe(P)
  })

  test('both down: recovery of either one is found', () => {
    for (const recovers of [P, R]) {
      const chain = new EndpointChain([ep('a'), ep('b')])
      chain.failed(chain.acquire(1000), 1000)
      chain.failed(chain.acquire(2000), 2000)
      let now = 3000
      let answered = false
      for (let i = 0; i < 200 && !answered; i++, now += 4000) {
        const lease = chain.acquire(now)
        if (lease.index === recovers) { chain.succeeded(lease, now + 10); answered = true }
        else chain.failed(lease, now + 4000)
      }
      expect(answered).toBe(true)
      expect(chain.activeIndex).toBe(recovers)
    }
  })

  test('a probe that never reports back is forgotten', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)
    const t = 1000 + DOWNTIME_MS + 1
    expect(chain.acquire(t).probe).toBe(true)
    expect(chain.acquire(t + 1).probe).toBe(false)
    expect(chain.acquire(t + PROBE_STALE_MS + 1).probe).toBe(true)
  })

  test('a probe that answers after its endpoint failed again does not activate it', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    chain.failed(chain.acquire(1000), 1000)
    const t = 1000 + DOWNTIME_MS + 1
    const probe = chain.acquire(t)                 // probe of P
    chain.failed(chain.acquire(t + 1), t + 2)      // R fails: P (cooldown over) becomes active
    chain.failed(chain.acquire(t + 3), t + 4)      // a new request on P fails: R active again
    chain.succeeded(probe, t + 5)                  // the old probe's answer arrives
    expect(chain.activeIndex).toBe(R)
  })

  test('an older failure does not override a newer success', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    const a = chain.acquire(1000)
    const b = chain.acquire(1001)
    chain.succeeded(b, 1002)
    chain.failed(a, 1003)
    expect(chain.activeIndex).toBe(P)
    expect(chain.acquire(1004).index).toBe(P)
  })

  test('events in the same millisecond keep their order', () => {
    const chain = new EndpointChain([ep('a'), ep('b')])
    const a = chain.acquire(1000)
    const b = chain.acquire(1000)
    chain.failed(b, 1000)
    chain.succeeded(a, 1000)                       // started before B's failure: stale
    expect(chain.activeIndex).toBe(R)
    expect(chain.acquire(1001).probe).toBe(false)  // no early probe of P
  })

  test('a single endpoint keeps being used', () => {
    const chain = new EndpointChain([ep('a')])
    chain.failed(chain.acquire(1000), 1000)
    expect(chain.acquire(1001)).toMatchObject({ index: 0, started: 1001, probe: false })
  })
})
