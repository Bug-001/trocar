// src/collector/index-keeper.mjs — the daemon keeps the segment index current (D62; RFC 1.6 §4.1, 4.2 §段索引).
//
// WHY HERE: the segment index is a rebuildable projection of the raw bytes (invariant 2), and the daemon is the only
// writer of those bytes — so it is the only thing that can index them as a side effect of writing, which is what makes
// `asight query` never pay for a cold build (3.9 s on 1 GB before this, a macOS machine). The lazy build in
// src/query/index-build.mjs stays as the fallback, and a reader that takes it says `index-cold` (D38).
//
// OFF THE HOT PATH: `wrote()` is all the record's own path does — one Set add and at most one timer. The indexing runs
// DEBOUNCE_MS after the last append (so a burst is one pass, not one pass per record) and in chunks of CHUNK_BYTES
// with one turn of the event loop between them, so a backlog never blocks the engine for longer than a chunk.
// NO POLLING: nothing is armed while nothing is written, so an idle daemon has no wakeup of its own here.
//
// WHO WRITES WHICH INDEX FILE: this keeper, the segment the daemon is appending to — until that segment closes, when
// `flush()` brings it up to date one last time and hands it over; from there it is the seal worker's (seal-worker.mjs),
// in the child process that sealed it, so the daemon's event loop never parses a whole segment. The two never write the
// same file at the same time: seal-queue.mjs awaits this flush before it queues the segment for sealing, and one pass
// runs at a time here (the chain below).
//
// shortcut: a catch-up rewrites the segment's whole index document, so the index bytes written grow with the segment's
// record count; upgrade to an append-only index document (an INDEX_V bump) if the measured amplification matters.
import { segmentIndex, KEEPER_CHUNK_BYTES } from '../query/index-build.mjs'

export const DEBOUNCE_MS = 1_000 // one pass per burst; the tail a query may still have to resume is this much traffic
export const CHUNK_BYTES = KEEPER_CHUNK_BYTES // ~15 ms of parsing per turn of the event loop (a macOS machine: ~260 MB/s)

/**
 * createIndexKeeper({ home, failure }) → { wrote, flush, pause, idle, stop }
 *   wrote(segment):  a record was appended there (called from the store's write path: it must stay trivial).
 *   flush(segment):  index it fully, and never touch it again — the segment is closed. → the chain's promise.
 *   pause():         the daemon is stopping: no new debounce is armed (the segment the stop closes still flushes).
 *   idle():          resolves when every queued pass is done (the stop awaits it after the store closed).
 *   stop():          nothing more is indexed, and nothing of this keeper's is written after it.
 * `index` / `debounceMs` / `chunkBytes` are test seams.
 */
export function createIndexKeeper({ home, failure = () => {}, index = segmentIndex, debounceMs = DEBOUNCE_MS, chunkBytes = CHUNK_BYTES }) {
  const pending = new Set()   // segments with appended bytes that may not be in their index yet
  const handed = new Set()    // segments flushed at close: the sealer's child owns their index from then on
  let timer = null, chain = Promise.resolve(), stopped = false, paused = false

  const after = (fn) => (chain = chain.then(fn, fn)) // one pass at a time, in the order they were asked for
  const arm = () => {
    if (paused || stopped || timer || !pending.size) return
    timer = setTimeout(() => { timer = null; after(drain) }, debounceMs)
    timer.unref() // the index is a cache: it never keeps the process alive
  }

  async function drain() {
    for (const segment of pending) { pending.delete(segment); await catchUp(segment) }
  }

  // One segment, chunk by chunk, until its index covers every complete line it has. A failure is the daemon's to
  // report (D38); the answer stays correct, because the next query builds what is missing and says `index-cold`.
  async function catchUp(segment) {
    while (!stopped) {
      let r
      try { r = await index({ home, segment, maxBytes: chunkBytes, owner: true }) } catch (e) {
        failure('raw', Object.assign(new Error(`keeping the index of ${segment} current failed (${String((e && e.message) || e)}); the records are on disk, and the next query indexes them itself, which costs that query the build`), { code: 'index-failed' }), { segment })
        return
      }
      // the other problems are stored in the index document, so a reader says them; this one is about the write
      const unwritable = r.problems.find((p) => p.code === 'index-unwritable')
      if (unwritable) {
        failure('raw', Object.assign(new Error(`${unwritable.reason}; the next query indexes ${segment} itself, which costs that query the build`), { code: 'index-failed' }), { segment })
        return // another pass would only repeat it
      }
      if (r.done) return
      await new Promise(setImmediate) // the engine's turn
    }
  }

  return {
    wrote(segment) { if (paused || stopped || !segment || handed.has(segment)) return; pending.add(segment); arm() },
    flush(segment) {
      if (stopped || !segment) return chain
      if (!handed.has(segment)) { pending.delete(segment); handed.add(segment); after(() => catchUp(segment)) }
      return chain
    },
    pause() { paused = true; clearTimeout(timer); timer = null },
    async idle() { for (let i = 0; i < 100; i++) { const c = chain; await c.catch(() => {}); if (c === chain) return } },
    stop() { stopped = true; paused = true; clearTimeout(timer); timer = null },
  }
}
