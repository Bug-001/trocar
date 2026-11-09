// src/query/index-pool.mjs — the boot pass's segment indexes built on worker threads (3.5 §行表先读, D78②): a sealed segment's index is
// built by the reader's own path (index-build.mjs segmentIndex, which writes the index file), the same bytes as the pass on the worker's
// own thread; the worker then reads each back from disk (warmSegmentIndex), so nothing but a segment's name crosses a thread. A plain
// segment's index is never written by a reader, so those stay on the worker's thread. How many threads (D62: capture must not feel the
// pass): at most half the cores, and only as many as a quarter of the machine's memory holds at twice a thread's heap cap, which is the
// worker's own (WORKER_MEMORY_MB): a segment the worker could index, a thread can. Threads are made after the worker lowered its
// priority, so they run at it. A thread that fails or dies leaves its segment to the caller.
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { segmentIndex } from './index-build.mjs'
import { WORKER_MEMORY_MB } from './warm.mjs'

/** poolSize() → the threads the pass may use on this machine (1: none, the worker's thread alone). */
export function poolSize({ cores = os.availableParallelism(), memory = os.totalmem() } = {}) {
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memory / 4 / (2 * WORKER_MEMORY_MB * 2 ** 20))));
}

/** indexPool({home, threads, deps}) → {build(segment) → Promise<boolean> (the index file is written), close()}. `deps`: the worker's deps module
 *  (worker.mjs argv[3], a test's), loaded by each thread too, so what it changes of the machine holds there as well. */
export function indexPool({ home, threads, deps = null }) {
  const idle = [], waiting = [], all = []
  const spawn = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { indexPool: home, deps }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } })
    w.job = null
    w.on('message', (ok) => { const j = w.job; w.job = null; j.done(ok === true); next(w) })
    w.on('error', () => {}) // the exit below settles its job
    w.on('exit', () => { all.splice(all.indexOf(w), 1); if (w.job) { w.job.done(false); w.job = null } })
    w.unref()
    all.push(w)
    return w
  }
  const next = (w) => { const j = waiting.shift(); if (j) { w.job = j; w.postMessage(j.segment) } else idle.push(w) }
  for (let i = 0; i < threads; i++) idle.push(spawn())
  return {
    build: (segment) => new Promise((done) => {
      const j = { segment, done }
      const w = idle.pop()
      if (w && all.includes(w)) { w.job = j; w.postMessage(segment) } else if (all.length) waiting.push(j); else done(false)
    }),
    close: () => { for (const w of [...all]) w.terminate(); for (const j of waiting.splice(0)) j.done(false) },
  }
}

if (!isMainThread && workerData && workerData.indexPool) {
  const home = workerData.indexPool
  const loaded = workerData.deps ? import(pathToFileURL(workerData.deps).href) : Promise.resolve()
  parentPort.on('message', async (segment) => {
    let ok = false
    try { await loaded; await segmentIndex({ home, segment }); ok = true } catch { /* the caller indexes it */ }
    parentPort.postMessage(ok)
  })
}
