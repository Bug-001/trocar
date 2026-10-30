// replay/pricing.mjs — loads the unit-price table for the desk, and remembers WHY it could not. A table that could not be read is a
// different fact from a table that lacks a model's price: the first used to be ignored, so the raw panel and the drawer said
// 「本地价表里没有价格」 about a table nobody had seen (invariant 4). The loader keeps the reason; the desk shows it.
// The reads run on their own schedule (4.4 live-poll 「其余」, C2's poller): a failure backs off per 1.5 K-29 from PRICING_MS, a
// session tick that calls load() before the next read is due reads nothing, a reader's own action reads at once, a loaded table
// is never read again.
// `fetchPricing()` → an api envelope { ok, data, status, error }; data is the server's models[] document (core/metrics.mjs priceTableOf).
// load(byReader) → Promise<boolean>: did the state (table or reason) change.
import { priceTableOf } from '../core/metrics.mjs'
import { createPoller } from './follow.mjs'

export const PRICING_MS = 30000 // 4.4 live-poll: `pricing` is read every 30 s
export function createPricingLoader(fetchPricing, initial = null, { now = Date.now, base = PRICING_MS } = {}) {
  let table = initial, err = null
  const poller = createPoller({ base, now, alive: () => !table, run: async () => {
    let r
    try { r = await fetchPricing() } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
    const t = r && r.ok ? priceTableOf(r.data) : null
    if (t) { table = t; err = null; return {} }
    err = r && r.ok ? 'the price table has the wrong format' : (r && r.error) || (r && r.status ? 'HTTP ' + r.status : 'no response')
    return { ok: false }
  } })
  return {
    table: () => table,
    err: () => err,
    async load(byReader = false) {
      const was = [table, err]
      await poller.poll(byReader)
      return table !== was[0] || err !== was[1]
    },
  }
}
