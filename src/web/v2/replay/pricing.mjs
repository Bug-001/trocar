// replay/pricing.mjs — loads the unit-price table for the desk, and remembers WHY it could not. A table that could not be read is a
// different fact from a table that lacks a model's price: the first used to be ignored, so the raw panel and the drawer said
// 「本地价表里没有价格」 about a table nobody had seen (invariant 4). The loader keeps the reason; the desk shows it and retries on its next poll.
// `fetchPricing()` → an api envelope { ok, data, status, error }; data is the server's models[] document (core/metrics.mjs priceTableOf). load() → Promise<boolean>: did the state (table or reason) change.
import { priceTableOf } from '../core/metrics.mjs'
export function createPricingLoader(fetchPricing, initial = null) {
  let table = initial, err = null, busy = false
  return {
    table: () => table,
    err: () => err,
    async load() {
      if (table || busy) return false // a loaded table is never fetched again; an overlapping poll does not start a second request
      busy = true
      let r
      try { r = await fetchPricing() } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
      finally { busy = false }
      const t = r && r.ok ? priceTableOf(r.data) : null
      if (t) { table = t; err = null; return true }
      const next = r && r.ok ? 'the price table has the wrong format' : (r && r.error) || (r && r.status ? 'HTTP ' + r.status : 'no response')
      const changed = next !== err
      err = next
      return changed
    },
  }
}
