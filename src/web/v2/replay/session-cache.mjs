// replay/session-cache.mjs — the session cache (D71③, 0.2 §5, 1.2 §路由「离开再回来」): the replay desks of the sessions a reader
// left, kept in the tab's memory only (D27: nothing of a capture goes to browser storage). An entry is a desk instance
// {bytes(), dispose()}. An attached desk is never evicted; at every call the detached desks leave least recently attached first
// until the cache holds at most `maxSessions` desks and `maxBytes` of read answers, or only attached ones remain. An evicted desk is
// disposed exactly once (its reads in flight are aborted).
export function createSessionCache({ maxSessions = 3, maxBytes = 120 * 2 ** 20 } = {}) {
  const entries = new Map() // key → {inst, on, at}
  let clock = 0
  function trim() {
    for (;;) {
      let total = 0, old = null
      for (const [k, e] of entries) { total += e.inst.bytes(); if (!e.on && (!old || e.at < old[1].at)) old = [k, e] }
      if (!old || (entries.size <= maxSessions && total <= maxBytes)) return
      entries.delete(old[0])
      try { old[1].inst.dispose() } catch (e) { console.error('dispose failed', e) }
    }
  }
  return {
    // the cached desk of `key`, now attached; null when there is none
    take(key) { const e = entries.get(key); if (!e) return null; e.on = true; e.at = ++clock; trim(); return e.inst },
    // a new desk, attached
    put(key, inst) { entries.set(key, { inst, on: true, at: ++clock }); trim(); return inst },
    // the desk left the screen: it stays until the bounds evict it
    release(key) { const e = entries.get(key); if (e) { e.on = false; trim() } },
  }
}

export const sessionCache = createSessionCache()
