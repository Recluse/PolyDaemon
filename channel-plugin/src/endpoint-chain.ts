/**
 * Ordered bot-endpoint chain with failure-driven failover.
 *
 * The chain is ordered by preference (primary first). A transport failure on
 * the active endpoint marks it down for a cooldown and makes the best remaining
 * endpoint active. When a more preferred endpoint's mark expires, ONE request
 * at a time probes it while the rest stay on the active endpoint; it becomes
 * active only when a probe succeeds, so a still-dead primary costs one request
 * per cooldown, and Bot API calls never move to an endpoint nobody verified.
 *
 * Every request carries a lease. A result only counts if the request started
 * after the endpoint's state last changed (a failure mark or an answer): a late
 * success must not clear a newer failure mark or activate a probe that failed
 * meanwhile, and a late failure must not mark down an endpoint that has
 * answered since.
 */

export type Endpoint = {
  bot_url: string
  api_root: string
  botapi_ssh: string
  botapi_container: string
}

export type Lease = { index: number; started: number; probe: boolean; seq: number }

export const DOWNTIME_MS = 60_000
/** A probe that never reported back (should not happen: requests time out) is
 *  forgotten after this, so recovery cannot stall forever. */
export const PROBE_STALE_MS = 30_000

export class EndpointChain {
  private readonly endpoints: Endpoint[]
  private readonly downUntil: number[]
  // Sequence numbers, not timestamps, order leases against state changes: two
  // events in the same millisecond must still have an order.
  private readonly changedSeq: number[]
  private seq = 0
  private activeIdx = 0
  private probe: { index: number; seq: number; started: number } | null = null

  constructor(endpoints: Endpoint[]) {
    this.endpoints = endpoints
    this.downUntil = endpoints.map(() => 0)
    this.changedSeq = endpoints.map(() => 0)
  }

  /** The endpoint most worth trying now: the first one not cooling down, or,
   *  if all are, the one whose failure is oldest. */
  pick(now: number = Date.now()): number {
    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.downUntil[i] <= now) return i
    }
    let oldest = this.activeIdx
    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.downUntil[i] < this.downUntil[oldest]) oldest = i
    }
    return oldest
  }

  /** Lease an endpoint for one request. */
  acquire(now: number = Date.now()): Lease {
    if (this.probe && now - this.probe.started > PROBE_STALE_MS) this.probe = null
    const best = this.pick(now)
    const seq = ++this.seq
    if (best !== this.activeIdx && this.probe === null) {
      this.probe = { index: best, seq, started: now }
      return { index: best, started: now, probe: true, seq }
    }
    return { index: this.activeIdx, started: now, probe: false, seq }
  }

  /** The leased request got an HTTP answer. */
  succeeded(lease: Lease, now: number = Date.now()): void {
    if (lease.index < 0 || lease.index >= this.endpoints.length) return
    const probe = this.isProbe(lease)
    if (probe) this.probe = null
    // Older than the endpoint's latest state change (a failure or another
    // answer): it says nothing new, and must not activate or clear anything.
    if (lease.seq < this.changedSeq[lease.index]) return
    this.downUntil[lease.index] = 0
    this.changedSeq[lease.index] = ++this.seq
    if (probe) this.activeIdx = lease.index
  }

  /** The leased request failed at the transport level. */
  failed(lease: Lease, now: number = Date.now()): void {
    if (lease.index < 0 || lease.index >= this.endpoints.length) return
    if (this.isProbe(lease)) this.probe = null
    if (lease.seq < this.changedSeq[lease.index]) return // the endpoint has answered or failed since
    this.downUntil[lease.index] = now + DOWNTIME_MS
    this.changedSeq[lease.index] = ++this.seq
    if (lease.index === this.activeIdx) this.activeIdx = this.pick(now)
  }

  private isProbe(lease: Lease): boolean {
    return lease.probe && this.probe !== null && this.probe.index === lease.index && this.probe.seq === lease.seq
  }

  markDown(index: number, now: number = Date.now()): void {
    this.failed({ index, started: now, probe: false, seq: ++this.seq }, now)
  }

  get activeIndex(): number {
    return this.activeIdx
  }

  endpoint(index: number): Endpoint | undefined {
    return this.endpoints[index]
  }

  current(): Endpoint | undefined {
    return this.endpoints[this.activeIdx]
  }

  get size(): number {
    return this.endpoints.length
  }
}
