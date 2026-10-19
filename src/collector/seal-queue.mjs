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
/** The worker's exit code for "my parent is gone": the daemon is stopping, so this is not a seal failure — nothing is
 *  recorded and the next start's scan seals the segment (4.2 §自动封存). */
export const WORKER_GONE_EXIT = 75

/** How long a closed segment waits for the index keeper's catch-up before it is sealed anyway (see startSealing). */
export const BEFORE_SEAL_MS = 5_000

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
  let running = null, idlePromise = null, markIdle = null, stopping = false

  function pump() {
    if (running || !queued.length) { if (!running && markIdle) { markIdle(); idlePromise = null; markIdle = null } return }
    const file = running = queued.shift()
    Promise.resolve(run(file, { lockFile, journal })).then((r) => r, (e) => ({ code: -1, reason: e.message })).then(({ code, reason }) => {
      if (code !== 0 && code !== WORKER_GONE_EXIT && !stopping) {
        failed.add(file)
        onFailure({ file, reason: reason || `the sealer exited with ${code}` }) // the worker wrote the journal line; this is the collector-side `failure` (D38)
      }
      running = null
      pump()
    })
  }

  /** Queue one closed segment. Idempotent; a segment this run already failed on is not tried again. */
  function add(file) {
    if (stopping || failed.has(file) || file === running || queued.includes(file)) return
    queued.push(file)
    pump()
  }

  /** At start: drop leftover temps, then queue every plaintext segment in raw/ that is not the live one. */
  function scan({ current = null } = {}) {
    clearLockSegment()
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

  /** The crashed run's lock still names the segment it was appending to, and that run is gone (this daemon's
   *  single-instance gate proved it before the scan): clear `segment`, or the worker would refuse that segment for
   *  ever. Only this field changes; the rest is left for the start's unclean-stop line. A lock that cannot be
   *  rewritten costs one refused seal, retried at the next start. */
  function clearLockSegment() {
    let lock
    try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) } catch { return } // no lock, or unreadable: it names no segment
    if (lock.segment == null) return
    const tmp = `${lockFile}.seal-queue.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify({ ...lock, segment: null }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, lockFile) }
    catch { try { fs.unlinkSync(tmp) } catch { /* never written */ } }
  }

  /** Resolves once nothing is queued or running. */
  function idle() {
    if (!running && !queued.length) return Promise.resolve()
    if (!idlePromise) idlePromise = new Promise((r) => { markIdle = r })
    return idlePromise
  }

  /** The daemon is stopping: the segment the store closes now is NOT sealed (the next start's scan takes it), and a
   *  worker this stop cuts off is not a failure (4.2 §自动封存). */
  function stop() { stopping = true }

  return { add, scan, idle, stop }
}

/** What the daemon calls once at start: scan (temps and leftovers), then seal every segment the store closes. This
 *  version is not backwards compatible: records an earlier version wrote elsewhere are not read,
 *  not moved and not touched.
 *  `beforeSeal(segment)` is awaited before a segment the store just closed is queued (D62): the index keeper brings
 *  that segment's index up to date and hands it over while its plaintext is still there, so the keeper and the worker
 *  (which indexes the sealed copy) never write one index file at the same time. It never stops a seal, and it never
 *  delays one for longer than `beforeSealMs`; past that deadline `handOff(segment)` takes the index away from the
 *  keeper first, so the pass that did not come back cannot write after the sealer's rename either. */
export function startSealing({ store, raw, lockFile, journal, fork: run, fs = nodeFs, failure, beforeSeal = null, handOff = () => {}, beforeSealMs = BEFORE_SEAL_MS }) {
  const queue = createSealQueue({ raw, lockFile, journal, fs, fork: run,
    onFailure: ({ file, reason }) => failure('raw', Object.assign(new Error(`sealing ${file} failed (${reason}); its plaintext is kept, and it is not sealed again before the next start`), { code: 'seal-failed' }), { file }) })
  queue.scan({ current: store.currentSegment })
  if (!beforeSeal) store.onSegmentClosed(queue.add)
  else store.onSegmentClosed((file) => {
    const seg = parseSegment(path.basename(file))
    if (!seg) return queue.add(file)
    // The index is a cache: a catch-up that fails — or that simply does not come back (a slow disk, a backlog, a bug
    // in the chain) — never keeps the segment unsealed. Past the deadline the index is TAKEN from the keeper
    // (`handOff`, so a pass still in flight stops before writing again — 4.2 §段索引 one writer), the segment is
    // queued anyway and the wait is said once (D38): the seal worker rewrites the sealed copy's index whole, so the
    // answer is right either way.
    let queuedAnyway = false
    const late = setTimeout(() => {
      queuedAnyway = true
      handOff(seg.segment)
      failure('raw', Object.assign(new Error(`keeping the index of ${seg.segment} current did not finish within ${beforeSealMs} ms, so it is sealed with its index behind; the sealer rewrites that index whole`), { code: 'index-failed' }), { segment: seg.segment })
      queue.add(file)
    }, beforeSealMs)
    late.unref?.() // the seal of a closed segment never keeps the process alive on its own
    ;(async () => beforeSeal(seg.segment))().catch(() => {}).then(() => { clearTimeout(late); if (!queuedAnyway) queue.add(file) })
  })
  return queue
}
