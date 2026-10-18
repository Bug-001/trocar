// src/query/warm.mjs — the read side's memory (RFC 3.5 §访问模式, D63 ①; the ≤ 50 ms line of 1.6 §4.1).
//
// Everything remembered here is REVALIDATED against the files it was derived from on every lookup, so a cached
// answer can never be older than the bytes on disk. The key is what the answer DEPENDS on, never "the corpus":
// a segment's index rows depend on that segment's file, a session's records on that session's own row list. That
// is the whole point — the daemon appends another session's records every few seconds, so a cache invalidated by
// any new byte anywhere would never be warm while capture runs, which is exactly when the board is used.
//
// Always on, in every process: a one-shot CLI simply never gets a second lookup, and correctness does not depend
// on who is calling. The bound is bytes, so a warm worker's footprint is set by its budget and not by the corpus.
import nodeFs from 'node:fs'

/** A file's identity, the same three fields the index layer calls a match (src/query/index-build.mjs `usability`):
 *  size + mtime + ctime. `null` when there is no such file — which is itself a stamp (it may come back). */
export function statKey(file, fs = nodeFs) {
  try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch { return null }
}

/** A row list's identity (src/query/rows.mjs rows): the records it names were appended once and are never
 *  rewritten (invariant 2), so the count, the two ends and the total stored bytes name exactly those bytes.
 *  → { id, bytes } — `bytes` is also what the list costs to read back. */
export function rowsKey(rows) {
  let bytes = 0
  for (const r of rows) bytes += (r.stored_bytes || 0) + 1
  return { id: `${rows.length}:${rows.length ? `${rows[0].id}:${rows[rows.length - 1].id}` : ''}:${bytes}`, bytes }
}

/**
 * warmCache({maxBytes, max, bytes}) → { get(id, stamp, compute) }: `compute()` runs when this `id` was never
 * seen or its `stamp` moved; otherwise the remembered value comes back untouched. Least recently used entries
 * are dropped first, so that the whole cache stays inside `maxBytes` (`bytes(value)` sizes one entry) and `max`
 * entries. The entry just computed is never the one dropped.
 */
export function warmCache({ maxBytes = Infinity, max = Infinity, bytes = () => 0 } = {}) {
  const m = new Map() // insertion order IS the LRU order: a hit is deleted and set again
  let total = 0
  const trim = (keep) => {
    for (const [k, e] of m) {
      if (total <= maxBytes && m.size <= max) break
      if (k === keep) continue // the answer of THIS lookup is never evicted, whatever the budget
      m.delete(k); total -= e.size
    }
  }
  return {
    get(id, stamp, compute) {
      const hit = m.get(id)
      if (hit && hit.stamp === stamp) { m.delete(id); m.set(id, hit); return hit.value }
      if (hit) { total -= hit.size; m.delete(id) }
      const value = compute()
      const e = { stamp, value, size: 0 }
      m.set(id, e)
      // A promise is sized when it settles (the segment readers are async), and a rejected one is forgotten
      // at once: a transient read error must not become this segment's answer for the rest of the process.
      if (value && typeof value.then === 'function') value.then((v) => { e.size = bytes(v); total += e.size; trim(id) }, () => { if (m.get(id) === e) { m.delete(id); total -= e.size } })
      else { e.size = bytes(value); total += e.size; trim(id) }
      return value
    },
    /** What the cache holds now: `{entries, bytes}` — the worker's memory line, and what a test asserts on. */
    state: () => ({ entries: m.size, bytes: total }),
  }
}
