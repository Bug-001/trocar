// src/collector/seal-queue.mjs — the daemon's seal queue (RFC 4.2 §自动封存, D60②).
//
// One daemon per user (its single-instance lock) and one queue in it: closed segments are sealed ONE AT A TIME, each
// in a `child_process.fork` child, so the daemon's event loop never encodes or hashes. There is no seal lock because
// there is no second sealer. A failed segment keeps its plaintext and is not tried again in this run; the next start's
// `scan` retries it once. Every step tolerates ENOENT (a segment that never got a file, a raw/ that is not there yet).
import nodeFs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseSegment } from './core/record/segments.mjs'

const WORKER = fileURLToPath(new URL('./seal-worker.mjs', import.meta.url))
const TEMP = /^\..*\.tmp$/ // a temp an interrupted seal left in raw/ (seal.mjs names them `.<segment>.<pid>-<hex>.tmp`)
// `capture-<YYYY-MM-DD>.ndjson` from a version before D60, plus the close marker that version left beside it
const CAPTURE = /^capture-(\d{4})-(\d{2})-(\d{2})\.ndjson$/

/** Seal `file` in a child process → { code, reason }. The child exits as soon as this parent disconnects. */
const forkWorker = (file, { lockFile, journal }) => new Promise((resolve) => {
  const child = fork(WORKER, [file, lockFile, ...(journal ? [journal] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let reason = ''
  child.stderr.on('data', (d) => { reason += d })
  child.on('error', (e) => resolve({ code: -1, reason: e.message }))
  child.on('exit', (code, signal) => resolve({ code: code === 0 ? 0 : code === null ? -1 : code, reason: reason.trim() || (signal ? `the sealer was killed (${signal})` : '') }))
})

export function createSealQueue({ raw, lockFile, journal = undefined, fs = nodeFs, fork: run = forkWorker, onFailure = () => {} }) {
  const queued = [], failed = new Set() // failed: not sealed again before the next start (no retry loop)
  let running = null, idlePromise = null, markIdle = null

  function pump() {
    if (running || !queued.length) { if (!running && markIdle) { markIdle(); idlePromise = null; markIdle = null } return }
    const file = running = queued.shift()
    Promise.resolve(run(file, { lockFile, journal })).then((r) => r, (e) => ({ code: -1, reason: e.message })).then(({ code, reason }) => {
      if (code !== 0) {
        failed.add(file)
        onFailure({ file, reason: reason || `the sealer exited with ${code}` }) // the worker wrote the journal line; this is the collector-side `failure` (D38)
      }
      running = null
      pump()
    })
  }

  /** Queue one closed segment. Idempotent; a segment this run already failed on is not tried again. */
  function add(file) {
    if (failed.has(file) || file === running || queued.includes(file)) return
    queued.push(file)
    pump()
  }

  /** At start: drop leftover temps, then queue every plaintext segment in raw/ that is not the live one. */
  function scan({ current = null } = {}) {
    let names
    try { names = fs.readdirSync(raw) } catch { return [] } // no raw/ yet: nothing was ever written
    const took = []
    for (const n of names.sort()) {
      if (TEMP.test(n)) { try { fs.unlinkSync(path.join(raw, n)) } catch { /* gone */ } continue }
      const seg = parseSegment(n)
      // a plaintext segment that is not the live one is closed — even with a sealed file beside it (an interrupted
      // seal between rename and unlink): the plaintext wins and is sealed again over that file
      if (!seg || seg.sealed || seg.segment === current) continue
      took.push(path.join(raw, n))
      add(path.join(raw, n))
    }
    return took
  }

  /** Resolves once nothing is queued or running. */
  function idle() {
    if (!running && !queued.length) return Promise.resolve()
    if (!idlePromise) idlePromise = new Promise((r) => { markIdle = r })
    return idlePromise
  }

  return { add, scan, idle }
}

/** Upgrade (4.2 §自动封存 「升级」): every `<collector>/capture-<YYYY-MM-DD>.ndjson` becomes the ordinary closed segment
 *  `<raw>/<YYYYMMDD>T000000Z.ndjson` by a same-device rename — the bytes are untouched (invariant 2, D27③) — and the
 *  close marker that version left beside it goes. Nothing older is read or touched. → the segment paths it made. */
export function upgradeCaptures({ collectorDir, raw, fs = nodeFs }) {
  let names
  try { names = fs.readdirSync(collectorDir) } catch { return [] }
  const made = []
  for (const n of names.sort()) {
    const m = CAPTURE.exec(n)
    if (!m) continue
    fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
    const base = `${m[1]}${m[2]}${m[3]}T000000Z`
    let name = base
    for (let k = 2; fs.existsSync(path.join(raw, `${name}.ndjson`)) || fs.existsSync(path.join(raw, `${name}.sealed`)); k++) name = `${base}-${k}`
    const to = path.join(raw, `${name}.ndjson`)
    try { fs.renameSync(path.join(collectorDir, n), to) } catch (e) { if (e.code !== 'ENOENT') throw e; continue }
    try { fs.unlinkSync(path.join(collectorDir, `${n}.closed`)) } catch { /* no marker, or gone */ }
    made.push(to)
  }
  return made
}

/** What the daemon calls once at start: upgrade, scan (temps and leftovers), then seal every segment the store closes. */
export function startSealing({ store, raw, collectorDir, lockFile, journal, fork: run, fs = nodeFs, failure }) {
  const queue = createSealQueue({ raw, lockFile, journal, fs, fork: run,
    onFailure: ({ file, reason }) => failure('raw', Object.assign(new Error(`sealing ${file} failed (${reason}); its plaintext is kept, and it is not sealed again before the next start`), { code: 'seal-failed' }), { file }) })
  upgradeCaptures({ collectorDir, raw, fs })
  queue.scan({ current: store.currentSegment })
  store.onSegmentClosed(queue.add)
  return queue
}
