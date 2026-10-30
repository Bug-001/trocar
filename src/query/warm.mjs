// src/query/warm.mjs — the read side's memory (RFC 3.5 §访问模式, D63 ①; the ≤ 50 ms line of 1.6 §4.1).
//
// Everything remembered here is REVALIDATED against the files it was derived from on every lookup, so a cached
// answer can never be older than the bytes on disk. The key is what the answer DEPENDS on, never "the corpus":
// a segment's index rows depend on that segment's file, a session's records on that session's own row list. That
// is the whole point — the daemon appends another session's records every few seconds, so a cache invalidated by
// any new byte anywhere would never be warm while capture runs, which is exactly when the board is used.
//
// Always on, in every process: a one-shot CLI simply never gets a second lookup, and correctness does not depend
// on who is calling. The bound is the HEAP (heapBudget below), estimated before anything is read, so a warm worker's footprint
// is set by its budget and not by the corpus or by the size of one session; and measured while a session is folded (heapCeiling),
// so an estimate that is wrong cuts the session shorter instead of taking the worker down.
import nodeFs from 'node:fs'
import v8 from 'node:v8'
import vm from 'node:vm'

/** Which `fs` a cached value was read through, as a key fragment. A caller that injects its own `fs` reads its own
 *  files (src/query/client.mjs localOnly), so its entries MUST NOT be the ones the real file system put there. */
const fsIds = new WeakMap()
let fsSeq = 0
export function fsTag(fs = nodeFs) {
  if (fs === nodeFs) return ''
  let id = fsIds.get(fs)
  if (id === undefined) fsIds.set(fs, (id = `fs${++fsSeq}`))
  return id
}

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

/** The query worker's heap (its `--max-old-space-size`, src/query/service.mjs forks it with this). It lives here because the read
 *  side's budget is derived from it: every process that answers a query cuts at the same place, so the worker and the local path
 *  give the same document (3.5 §内存有界). */
export const WORKER_MEMORY_MB = 384
/** What one stored byte of a record costs in the heap once read back and parsed (measured: 0.97x on generated Claude Code
 *  sessions, 1.62-1.69x on the user's real one, 2026-10-21). */
export const HEAP_PER_STORED = 2

// ONE ledger for every cache of this process (3.5 §内存有界): the heap is shared, so is the budget. `lru` holds every kept entry in
// recency order across all caches (a hit moves it to the end); `held` is what queries in flight have reserved with hold().
const lru = new Set()
let total = 0, held = 0, steady = 0
let limit = null
const heapLimit = () => (limit == null ? (limit = Math.min(v8.getHeapStatistics().heap_size_limit, WORKER_MEMORY_MB * 1048576)) : limit)

/** The read side's heap budget, in bytes: two thirds of min(this process's heap limit, the worker's). The last third is the answer's
 *  serialization and the GC's slack. The min makes a one-shot CLI (a heap of gigabytes) cut a large session where the worker does. */
export const heapBudget = () => (heapLimit() * 2) / 3
/** The last guard of the MEASURED bound (3.5 §内存有界): a query whose live heap passes three quarters of THIS process's own limit
 *  stops what it is building (src/query/named/session.mjs), whatever the estimates said — no session's size takes a process to
 *  V8's own limit. */
export const heapCeiling = () => (v8.getHeapStatistics().heap_size_limit * 3) / 4
/** What the STEADY caches keep (warmCache({steady: true}): what every query reads again, the segments' index rows), in their
 *  estimates. A query sizes what it builds beside them; the other caches give way to it. */
export const steadyBytes = () => steady
let collect = null
/** The heap still in use, in bytes: a full collection first, so garbage is not counted. The worker is not started with
 *  --expose-gc; the flag is set here, once, and its `gc` taken from a fresh context. */
export function liveHeap() {
  if (!collect) {
    if (typeof globalThis.gc === 'function') collect = globalThis.gc
    else { v8.setFlagsFromString('--expose-gc'); collect = vm.runInNewContext('gc') }
  }
  collect()
  return v8.getHeapStatistics().used_heap_size
}
/** The heap allocated, garbage included: cheap, an upper bound of liveHeap(). */
export const usedHeap = () => v8.getHeapStatistics().used_heap_size

const forget = (e) => { if (lru.delete(e)) { e.cache.delete(e.id); total -= e.size; if (e.steady) steady -= e.size } }
/** Make room for `need` more bytes: the least recently used entries of ANY cache go first; `keep` never. */
function room(need, keep = null) {
  for (const e of lru) {
    if (total + need <= heapBudget()) return
    if (e !== keep) forget(e)
  }
}

/** A query's own working set (src/query/named/session.mjs: the window it is about to assemble), reserved BEFORE it is built: the
 *  caches give way for it, and what they keep while it is held cannot grow into it. → release(), called when the query is done. */
export function hold(bytes) {
  room(bytes)
  total += bytes; held += bytes
  let on = true
  return () => { if (on) { on = false; total -= bytes; held -= bytes } }
}

/**
 * warmCache({max, cost}) → { get(id, stamp, compute, estimate), peek(id, stamp) }: `compute(previous)` runs when this `id` was never
 * seen or its `stamp` moved (`previous` = the value it held, if any, which the cache lets go of); otherwise the remembered value comes back untouched. `cost(value)` is what the value costs in the HEAP (an
 * estimate from stored bytes, never a count of entries or a serialized size); `estimate` is the same, known BEFORE computing, so
 * the room is made first and the peak never passes the budget. A value whose cost is past the whole budget is returned but never
 * kept. `max` bounds this cache's entries. `steady`: every query reads these entries again (steadyBytes).
 */
export function warmCache({ max = Infinity, cost = () => 0, steady: isSteady = false } = {}) {
  const m = new Map()
  const keep = (id, e, size) => {
    e.size = size
    if (size > heapBudget()) return // answered this once, never kept, and nothing else is pushed out for it
    room(size)
    if (total + size > heapBudget()) return // past what the budget can give it (a query in flight holds the rest): answered, never kept
    m.set(id, e); lru.add(e); total += size
    if (isSteady) { e.steady = true; steady += size }
    if (m.size > max) for (const old of m.values()) { if (m.size <= max) break; if (old !== e) forget(old) }
  }
  const fresh = (id, stamp) => { const hit = m.get(id); return hit && hit.stamp === stamp ? hit : null }
  const touch = (e) => { if (lru.delete(e)) lru.add(e); return e.value } // a promise still in flight is in no ledger yet
  return {
    get(id, stamp, compute, estimate = 0) {
      const hit = fresh(id, stamp)
      if (hit) return touch(hit)
      const old = m.get(id)
      if (old) forget(old)
      if (estimate && estimate <= heapBudget()) room(estimate)
      const value = compute(old ? old.value : undefined) // what this id held before: a value that can be grown is grown
      const e = { cache: m, id, stamp, value, size: 0 }
      // A promise is sized and kept when it settles (the segment readers are async); a rejected one is never kept: a transient
      // read error must not become this segment's answer for the rest of the process. A lookup that came in while it was in
      // flight finds the promise itself (`pending`), so the segment is not read twice.
      if (value && typeof value.then === 'function') {
        m.set(id, e)
        value.then((v) => { if (m.get(id) === e) { m.delete(id); keep(id, e, cost(v)) } }, () => { if (m.get(id) === e) m.delete(id) })
      } else keep(id, e, cost(value))
      return value
    },
    /** The remembered value if it is there and still fresh, without computing anything: the caller that can answer a cheaper way
     *  when it is absent (src/query/named/session.mjs renders the window only), and the caller that decides AFTER computing whether
     *  the answer may be remembered (src/query/records.mjs: never a failed read). */
    peek: (id, stamp) => { const hit = fresh(id, stamp); return hit ? touch(hit) : undefined },
    /** The value this `id` holds, whatever its stamp, taken out of the cache and the ledger: a caller that grows it — or lets it go
     *  BEFORE building another — holds the only reference (src/query/named/session.mjs: never two spines in the heap at once). */
    take(id) {
      const e = m.get(id)
      if (!e) return undefined
      forget(e); m.delete(id)
      const v = e.value
      e.value = undefined
      return v
    },
  }
}
