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
// runs at a time here (the chain below). A query never writes that file at all (4.2 §段索引 谁写哪一笔).
//
// WHAT A PASS COSTS: the index document is append-only NDJSON (INDEX_V 4), so a pass writes its new entries plus one
// mark line and reads only the file's last mark — both proportional to the NEW records, not to the segment. The
// whole-document format this replaces made a pass cost the segment's record count in both, which with sparse real
// traffic (a pass per record) came to ≈ e·N²/2 index bytes per segment.
//
// MEASURED, SPARSE arrival (found in development): one record per debounce window — what real traffic looks like
// (OpenCode: an LLM call every few seconds plus small non-LLM records) — with the mix 70 % ≈ 1.5 KB / 30 % ≈ 100 KB,
// 2 000 records / 63 MB, through this keeper with the index bytes counted at `segmentIndex`'s fs seam:
//   index bytes written per captured byte: 13.03 with the whole-document format (v3) → 0.018 here
//     (D62 asks ≤ 1.1 for plaintext + index together);
//   the keeper's CPU per record, first 100 → last 100: 1.21 → 3.46 ms with v3 (it grew with the record count),
//     0.89 → 1.58 ms here, and 0.75 → 1.27 ms over 4 000 records — flat, inside D62's ≤ 5 ms per request;
//   what a query pays to READ a current index (20 000 entries): 12.6 ms v3 → 14.5 ms here.
// MEASURED, queries (the dense replay of the 458 MB / 1 436 records / 8 segments of the 附录 D dataset through the
// real record store + this keeper, 2026-10-19; unchanged by the format, whose read path is 2 ms per 20 k entries):
//   cold `query sessions` 2 024 ms → 176 ms first run / 123 ms p50, and 0 `index-cold` errors (8 before);
//   cold `query session --id` 2 587 ms → 723 ms (what is left is the session view's own cost, not the index's);
//   daemon CPU: 1 731 ms per 1 000 appended records without the keeper, 3 290-3 513 ms with it.
//   On a 300 MB generated dataset with the index as this keeper leaves it: `query sessions` 11 ms first / 3 ms warm,
//   `query session` 495 ms, 0 errors.
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
