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
import nodeFs from 'node:fs'
import path from 'node:path'
import { indexDir, segmentIndex } from './index-build.mjs'
import { WORKER_MEMORY_MB } from './warm.mjs'

/** poolSize() → the threads the pass may use on this machine (1: none, the worker's thread alone). */
export function poolSize({ cores = os.availableParallelism(), memory = os.totalmem() } = {}) {
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memory / 4 / (2 * WORKER_MEMORY_MB * 2 ** 20))));
}

/** indexPool({home, threads, deps, tick}) → {build(segment) → Promise<boolean> (the index file is written), close()}. `deps`: the worker's deps
 *  module (worker.mjs argv[3], a test's), loaded by each thread too, so what it changes of the machine holds there as well. `tick`: called as a
 *  thread's scan goes on (its checkpoints, index-build.mjs easing), never by a clock, so a thread stuck on one record says nothing and the
 *  daemon's silence and idle clocks see the pass as they saw it on one thread. A thread that dies settles its job false; with no thread left,
 *  every job waiting does too, so the caller builds them and the pass ends. */
export function indexPool({ home, threads, deps = null, tick = () => {} }) {
  const idle = [], waiting = [], live = new Set()
  const give = (w, j) => { w.job = j; w.postMessage(j.segment) }
  const spawn = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { indexPool: home, deps }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } })
    w.job = null
    w.on('message', (m) => {
      if (m === 'tick') return tick()
      tick() // a segment done is work done too
      const j = w.job; w.job = null; j.done(m === true)
      const n = waiting.shift(); if (n) give(w, n); else idle.push(w)
    })
    w.on('error', () => {}) // the exit below settles its job
    w.on('exit', () => {
      live.delete(w); const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1)
      if (w.job) { w.job.done(false); w.job = null }
      if (!live.size) for (const j of waiting.splice(0)) j.done(false)
    })
    w.unref()
    live.add(w)
    return w
  }
  for (let i = 0; i < threads; i++) idle.push(spawn())
  return {
    build: (segment) => new Promise((done) => {
      const j = { segment, done }, w = idle.pop()
      if (w) give(w, j); else if (live.size) waiting.push(j); else done(false)
    }),
    close: () => { for (const w of [...live]) w.terminate(); for (const j of waiting.splice(0)) j.done(false) },
  }
}

/** sweepTemps(home): the temp index files (storeIndex's `<file>.tmp-<pid>-…`) a process that is gone left in index/ — a worker killed mid-pass
 *  leaves one per thread at work. A live writer's (the seal worker's, this process's) stay. */
export function sweepTemps(home, fs = nodeFs) {
  let names = []
  try { names = fs.readdirSync(indexDir(home)) } catch { return }
  for (const n of names) {
    const m = /\.tmp-(\d+)-/.exec(n)
    if (!m) continue
    const pid = Number(m[1])
    try { process.kill(pid, 0); continue } catch (e) { if (e.code === 'EPERM') continue } // alive (EPERM: someone else's, alive)
    try { fs.rmSync(path.join(indexDir(home), n), { force: true }) } catch { /* the next pass */ }
  }
}

if (!isMainThread && workerData && workerData.indexPool) {
  const home = workerData.indexPool
  const loaded = workerData.deps ? import(pathToFileURL(workerData.deps).href) : Promise.resolve()
  parentPort.on('message', async (segment) => {
    let ok = false
    // `ease` at the scan's checkpoints says the thread is at work (tick above); the bytes written are the same with it or without
    try { await loaded; await segmentIndex({ home, segment, ease: async () => parentPort.postMessage('tick') }); ok = true } catch { /* the caller indexes it */ }
    parentPort.postMessage(ok)
  })
}
