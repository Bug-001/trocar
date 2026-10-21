// holders.mjs (core/proxymode) — the daemon's side of P12 (RFC 4.11 P12; plan decision #4): after `off` the daemon stays up while a holder lives.
// The judge is src/off/holders.mjs holdersOf (standalone-safe), so the CLI with the daemon down computes the same table; here are
// what only the daemon has: the door record it keeps on disk (door-seen.json: the lives met at accept and PAC serve), the poll of the process table (every 10 s while draining, never a
// connection count — an idle holder still counts), and the exit rule. These are registered on the daemon.

/** The poll interval while draining (P12: every 10 s). */
export const HOLDER_POLL_MS = 10_000

import { readDoorSeen, writeDoorSeen, msOf, DOOR_SEEN_MAX } from '../../../off/door-seen.mjs'

const keyOf = (h) => `${h.harness}\0${h.pid}\0${h.start ?? ''}`

/** The daemon exits after `off` only when no harness is on, no holder lives and no connection is open (P12). `holders` null (the poll has no readable
 *  table yet) is unknown, so the daemon may not exit. */
export const mayExit = ({ harnessesOn = [], holders = [], openConns = 0 } = {}) => harnessesOn.length === 0 && Array.isArray(holders) && holders.length === 0 && !(openConns > 0)

/** Polls `list()` (→ holdersOf's rows; it reads the process table, never the connections) every `every` ms through injected `timers`
 *  ({ setTimeout, clearTimeout }); `onChange(rows)` when the set of (harness, pid, start) changes, the first answer included. A list that throws keeps
 *  the last answer (an unreadable table is not "nobody holds the door") and is passed to `onError`. → { start(seed?), stop(), now() → rows | null }.
 *  Each `start` begins a new watch (an `off`): `seed` is the table that off has just judged (null: none yet), and nothing of an earlier watch stands for
 *  this one — neither its rows nor a read still in flight (a poll stopped with [] answered GET /holders and mayExit for the next off while its
 *  first table was still being read). `stop` forgets the rows: GET /holders then judges afresh. */
export function createHolderPoll({ list, every = HOLDER_POLL_MS, timers = globalThis, onChange = () => {}, onError = () => {} } = {}) {
  let rows = null, sig = null, timer = null, running = false, watch = 0
  const sigOf = (r) => r.map(keyOf).sort().join('\n')
  const tick = async (w) => {
    try {
      const next = await list()
      if (w !== watch) return // a read of a watch that has ended or been restarted
      const s = sigOf(next)
      rows = next
      if (s !== sig) { sig = s; onChange(next) }
    } catch (e) { if (w === watch) onError(e) }
    if (running && w === watch) timer = timers.setTimeout(() => tick(w), every)
  }
  const clear = () => { if (timer != null) timers.clearTimeout(timer); timer = null }
  return {
    start(seed = null) {
      clear(); running = true
      const w = ++watch
      rows = Array.isArray(seed) ? seed : null; sig = rows ? sigOf(rows) : null
      if (rows) timer = timers.setTimeout(() => tick(w), every); else tick(w)
    },
    stop() { ++watch; running = false; clear(); rows = null; sig = null },
    now: () => rows,
  }
}

/** The door's durable record of the lives it met (4.11 P12 「门的持久记录」; the file and its format are src/off/door-seen.mjs): one row per
 *  (group, pid, start, kind) — kind 'accept' (a connection; `decrypt` / `reason` the door's latest judgement) or 'pac' (a PAC GET) — with the LATEST
 *  time it was seen and `n`, the times this life did it at this door. The latest, not the first: a process seen in on window 1 and again in window 2
 *  must fall inside window 2 when off #2 judges it. Loaded from `dir` at creation; a file that cannot be read starts empty and is said once through
 *  `onError({ code, reason })`. From then on the record is not known before that moment (`unknown_before`, kept from a file that already carries it):
 *  `list()` answers null (holdersOf takes the safe direction, D50) and every write carries it, never a file of only the lives met since — until
 *  `prune(isLive, claimable)` sees no claimable process (one of a harness that was on) started before it or at an unknown time.
 *  Writes are throttled: a change arms one unref'd timer (`throttleMs`); nothing changed, nothing armed and nothing written. The file is state, not a
 *  record. `prune` drops the rows whose life is gone; `close()` writes what is pending, synchronously, and arms nothing after. */
export function createDoorSeen({ clock = Date.now, dir = null, fs = undefined, timers = globalThis, onError = () => {}, throttleMs = 1000 } = {}) {
  const seen = new Map() // insertion order = `at` order: an update moves its row last
  const keyOf = (r) => `${r.group ?? ''}\0${r.pid}\0${r.start ?? ''}\0${r.kind}`
  const fit = (r) => !!r && typeof r.harness === 'string' && Number.isInteger(r.pid) && (r.kind === 'accept' || r.kind === 'pac')
  let unknownBefore = null, dirty = false, timer = null, closed = false, writeSaid = false
  if (dir) {
    const r = readDoorSeen({ dir, fs })
    if (r.rows == null) { unknownBefore = r.unknownBefore ?? clock(); onError({ code: 'door-record-unreadable', reason: `${r.error}: the lives the door met before ${new Date(unknownBefore).toISOString()} are not known, so every live process of a harness that was on counts as a holder` }) }
    for (const row of [...(r.rows || r.kept || [])].filter(fit).sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0))) seen.set(keyOf(row), row)
  }
  const flush = () => {
    if (timer != null) timers.clearTimeout(timer)
    timer = null
    if (!dirty || !dir) return
    dirty = false
    try { writeDoorSeen({ dir, rows: [...seen.values()], unknownBefore, fs }); writeSaid = false } catch (e) {
      if (!writeSaid) { writeSaid = true; onError({ code: 'engine-error', reason: `the door record could not be written (${(e && e.code) || e}); off's receipt and status with the daemon down miss the lives met since` }) }
    }
  }
  const touch = () => {
    dirty = true
    if (dir && !closed && timer == null) { timer = timers.setTimeout(flush, throttleMs); if (timer && timer.unref) timer.unref() }
  }
  return {
    add({ harness, group = null, pid, start = null, kind = 'accept' }) {
      const row0 = { harness, group, pid, start, kind }
      if (!fit(row0)) return
      const k = keyOf(row0), old = seen.get(k)
      seen.delete(k)
      seen.set(k, { ...old, ...row0, at: clock(), n: ((old && old.n) || 0) + 1 })
      while (seen.size > DOOR_SEEN_MAX) seen.delete(seen.keys().next().value)
      touch()
    },
    /** The door's judgement of an accept row's life: `decrypt` / `reason` are the latest (a changed one only is written). */
    judged({ group = null, pid, start = null, decrypt, reason = null }) {
      const r = seen.get(keyOf({ group, pid, start, kind: 'accept' }))
      if (!r || (r.decrypt === decrypt && (r.reason ?? null) === reason)) return
      r.decrypt = decrypt; if (reason == null) delete r.reason; else r.reason = reason
      touch()
    },
    list: () => (unknownBefore == null ? [...seen.values()] : null),
    prune(isLive, claimable = null) {
      let gone = false
      for (const [k, r] of seen) if (!isLive(r)) { seen.delete(k); gone = true }
      if (unknownBefore != null && Array.isArray(claimable) && !claimable.some((p) => (msOf(p.startedAt) ?? -Infinity) < unknownBefore)) { unknownBefore = null; gone = true }
      if (gone) touch()
    },
    flush,
    close() { closed = true; flush() },
  }
}
