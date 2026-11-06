// tips.mjs (src/query) — the board's tip table, on its own so the daemon keeps one from its start without loading the board (src/server.mjs), which it
// loads only once its control endpoint listens (D62).
const TIP_IDS = 64, TIP_KEYS = 256; // per session the newest model calls; the sessions remembered, least recently tipped dropped first

/** The board's tip table (4.4 §答案文件 `x-trocar-tip`): `add(pairs)` takes the index keeper's [session_key, id] of each pass,
 *  `of(id)` → the ≤ TIP_IDS newest ids of that session, oldest first, space separated, or null. The daemon owns one. */
export function tipTable() {
  const m = new Map()
  return {
    add(pairs) {
      for (const [key, id] of pairs) {
        const k = String(key), ids = m.get(k) || []
        m.delete(k); m.set(k, ids); // most recently tipped last
        ids.push(String(id))
        if (ids.length > TIP_IDS) ids.splice(0, ids.length - TIP_IDS)
      }
      while (m.size > TIP_KEYS) m.delete(m.keys().next().value)
    },
    of: (id) => { const ids = m.get(String(id)); return ids && ids.length ? ids.join(' ') : null; },
  }
}

