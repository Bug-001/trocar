// src/collector/index-keeper.mjs — the daemon keeps the segment index current (D62; RFC 1.6 §4.1, 4.2 §段索引).
//
// WHY HERE: the segment index is a rebuildable projection of the raw bytes (invariant 2), and the daemon is the only
// writer of those bytes — so it is the only thing that can index them as a side effect of writing, which is what makes
// `trocar query` never pay for a cold build (3.9 s on 1 GB before this, a macOS machine). The lazy build in
// src/query/index-build.mjs stays as the fallback, and a reader that takes it says `index-cold` (D38).
//
// ALMOST OFF THE HOT PATH: `wrote()` builds THIS record's index entry from the envelope the store just serialized —
// its own index work, which the pass would otherwise pay with a read-back and a JSON.parse of the whole record — and
// then does one Set add and at most one timer. The PASS (the file read, the mark, the append) runs DEBOUNCE_MS after
// the last append, so a burst is one pass, not one pass per record, and in chunks of CHUNK_BYTES with one turn of the
// event loop between them, so a backlog never blocks the engine for longer than a chunk.
// NO POLLING: nothing is armed while nothing is written, so an idle daemon has no wakeup of its own here.
//
// WHO WRITES WHICH INDEX FILE: this keeper, the segment the daemon is appending to — until that segment closes, when
// `flush()` brings it up to date one last time and hands it over; from there it is the seal worker's (seal-worker.mjs),
// in the child process that sealed it, so the daemon's event loop never parses a whole segment. The two never write the
// same file at the same time: seal-queue.mjs awaits this flush before it queues the segment for sealing, and one pass
// runs at a time here (the chain below). A query never writes that file at all (4.2 §段索引 谁写哪一笔).
//
// WHAT A PASS COSTS: the index document is append-only NDJSON (INDEX_V 5), so a pass writes its new entries plus one
// mark line and reads only the file's last mark — both proportional to the NEW records, not to the segment. The
// whole-document format this replaces made a pass cost the segment's record count in both, which with sparse real
// traffic (a pass per record) came to ≈ e·N²/2 index bytes per segment.
//
// WHAT IT COSTS, MEASURED: the numbers (write amplification on the reference mix and per record in the worst arrival
// shape, the CPU per pass, what a query pays to read a current index, the cold query times this removed) are measured, not
// estimated: `scripts/perf-cli.mjs --write-amp <HOME>` reproduces the two write-amplification numbers on a dataset
// `scripts/gen-dataset.mjs` generates, and the spec's two lines are 1.6 §3.1. A measurement does not belong in a
// source comment, where it rots.
import { segmentIndex, KEEPER_CHUNK_BYTES, indexEntryOf } from '../query/index-build.mjs'

export const DEBOUNCE_MS = 1_000 // one pass per burst; the tail a query may still have to resume is this much traffic
export const CHUNK_BYTES = KEEPER_CHUNK_BYTES // ~15 ms of parsing per turn of the event loop (a macOS machine: ~260 MB/s)

/**
 * createIndexKeeper({ home, failure, kick }) → { wrote, flush, pause, idle, stop }
 *   kick(ids):       after each pass (debounced or at close), the record ids of the model calls it indexed (once, never thrown onto the write path).
 *   wrote(segment):  a record was appended there (called from the store's write path: it must stay trivial).
 *   flush(segment):  index it fully, and never touch it again — the segment is closed. → the chain's promise.
 *   handOff(segment): give its index to the sealer NOW — a pass in flight stops before its next write (seal-queue's
 *                    deadline calls it, so the keeper and the seal worker are never both writing one index file).
 *   pause():         the daemon is stopping: no new debounce is armed (the segment the stop closes still flushes).
 *   idle():          resolves when every queued pass is done (the stop awaits it after the store closed).
 *   stop():          → a promise. Nothing more is queued, and when it settles the pass that was in flight is over:
 *                    after that this keeper has written its last byte. The daemon's stop awaits it.
 * `index` / `debounceMs` / `chunkBytes` are test seams.
 */
export function createIndexKeeper({ home, failure = () => {}, kick = () => {}, index = segmentIndex, debounceMs = DEBOUNCE_MS, chunkBytes = CHUNK_BYTES }) {
  const pending = new Set()   // segments with appended bytes that may not be in their index yet
  const handed = new Set()    // segments flushed at close: the sealer's child owns their index from then on
  const given = new Set()     // handed over WHILE a pass may be in flight: that pass MUST stop before it writes again
  const fresh = new Map()     // segment → the entries of the lines written since the last pass, in line order
  let timer = null, chain = Promise.resolve(), stopped = false, paused = false

  const after = (fn) => (chain = chain.then(fn, fn)) // one pass at a time, in the order they were asked for
  // What the keeper's own failure is (D38): the raw layer's `index-failed`, NEVER a record error — the record is
  // written, and the index is a cache the next query rebuilds (it then says `index-cold`).
  const indexFailed = (segment, what) => failure('raw', Object.assign(new Error(`${what}; the records are on disk, and the next query indexes them itself, which costs that query the build`), { code: 'index-failed' }), { segment })
  const arm = () => {
    if (paused || stopped || timer || !pending.size) return
    timer = setTimeout(() => { timer = null; after(drain) }, debounceMs)
    timer.unref() // the index is a cache: it never keeps the process alive
  }

  // The pass's kick (3.5 §后台抽取与归约, D63 ①): the record ids of the model calls this pass indexed from the facts it was
  // handed, once per pass — the debounced one and the close pass alike — so the query worker folds their sessions as they are
  // captured. Which session a record is in is the worker's to say (sessionGroups, the synthesized keys included): nothing here
  // parses a body, knows a session or computes a query. A scan pass (no facts) kicks nothing; the next query folds what it indexed.
  async function pass(segments) {
    const ids = []
    for (const segment of segments) { segments.delete(segment); await catchUp(segment, ids) }
    if (!ids.length || stopped) return
    try { kick(ids) } catch { /* the kick is a hint: a query folds the same members */ }
  }
  const drain = () => pass(pending)

  // Measurement seam for scripts/perf-capture.mjs (D62): nothing is installed unless that script set the hook, so
  // the product path is one `typeof` per pass.
  const measured = async (fn) => {
    const hook = globalThis.__trocarPerfHook
    if (typeof hook !== 'function') return fn()
    const c = process.cpuUsage()
    try { return await fn() } finally { const d = process.cpuUsage(c); hook((d.user + d.system) / 1000) }
  }

  // One segment, chunk by chunk, until its index covers every complete line it has. A failure is the daemon's to
  // report (D38); the answer stays correct, because the next query builds what is missing and says `index-cold`.
  async function catchUp(segment, ids = null) {
    while (!stopped && !given.has(segment)) {
      let r
      // What this pass already knows: the entries of the lines written since the last one. Taken away before the
      // pass, so a line appended DURING it starts the next pass's list (whose offsets then continue from this
      // pass's mark); a pass that fails or that has to scan simply leaves that list empty, and the scan is the truth.
      const entries = fresh.get(segment) || null
      fresh.delete(segment)
      if (ids && entries) for (const { entry } of entries) if (entry.is_llm && !entry.log_only) ids.push(entry.id)
      try { r = await measured(() => index({ home, segment, maxBytes: chunkBytes, owner: true, entries })) } catch (e) {
        indexFailed(segment, `keeping the index of ${segment} current failed (${String((e && e.message) || e)})`)
        return
      }
      // the other problems are stored in the index document, so a reader says them; this one is about the write
      const unwritable = r.problems.find((p) => p.code === 'index-unwritable')
      if (unwritable) {
        indexFailed(segment, unwritable.reason)
        return // another pass would only repeat it
      }
      if (r.done) return
      await new Promise(setImmediate) // the engine's turn
    }
  }

  return {
    wrote(segment, facts = null) {
      if (paused || stopped || !segment || handed.has(segment)) return
      // This runs ON the record's write path (store.mjs onRecord). It MUST NOT throw there: the store would count the
      // keeper's failure as `record-error` (the wrong D38 class — the record itself is on disk) and set it as the
      // store's last error. So whatever fails here is said as the raw layer's `index-failed` instead, and the record
      // write is left alone.
      //
      // The entry is built HERE, from the envelope the store just serialized, and not in the pass: the pass would
      // otherwise have to read the line back and JSON.parse it (5.2 ms of a 500 KB exchange's 9.4 ms, a macOS machine
      // 2026-10-20), and holding the envelope until the debounce fires would hold every body of the burst in memory.
      // It is this record's own index work and nothing more; the pass still happens once per burst.
      try {
        pending.add(segment)
        if (facts && facts.env) {
          const e = { lineNo: facts.lineNo, offset: facts.offset, storedBytes: facts.storedBytes, entry: indexEntryOf(facts.env, { segment, ...facts }) }
          const list = fresh.get(segment)
          if (list) list.push(e); else fresh.set(segment, [e])
        } else fresh.delete(segment) // no facts: this pass has to scan the segment for them
        arm()
      } catch (e) {
        fresh.delete(segment) // what the pass does not know, it scans
        indexFailed(segment, `arming the index catch-up of ${segment} failed (${String((e && e.message) || e)})`)
      }
    },
    flush(segment) {
      if (stopped || !segment) return chain
      if (!handed.has(segment)) { pending.delete(segment); handed.add(segment); after(() => pass(new Set([segment]))) }
      return chain
    },
    /** The seal queue waited for `flush` and gave up (its deadline): this segment's index is the sealer's from NOW,
     *  so a pass still in flight stops at its next chunk instead of appending to a file the sealer is about to
     *  replace whole (4.2 §段索引 谁写哪一笔 — one writer). The write itself is by fd (src/query/index-build.mjs
     *  storeIndex), so even a chunk that loses the race lands on the old, unlinked inode. */
    handOff(segment) {
      if (!segment) return
      pending.delete(segment); handed.add(segment); given.add(segment); fresh.delete(segment)
    },
    pause() { paused = true; clearTimeout(timer); timer = null },
    // Best effort, for the stop's convenience: the guarantee that nothing more is written is stop()'s, not this one's.
    async idle() { for (let i = 0; i < 100; i++) { const c = chain; await c.catch(() => {}); if (c === chain) return } },
    stop() {
      stopped = true; paused = true; clearTimeout(timer); timer = null; pending.clear(); fresh.clear()
      // `wrote` and `flush` add nothing to the chain once stopped, so this IS the last pass: when it settles (its own
      // failure included — a failed pass has already been reported), nothing of this keeper's can still be written.
      return chain.then(() => {}, () => {})
    },
  }
}
