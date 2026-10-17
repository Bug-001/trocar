// holders.mjs (core/proxymode) — the daemon's side of P12 (RFC 4.11 P12; plan decision #4): after `off` the daemon stays up while a holder lives.
// The judge is src/off/holders.mjs holdersOf (standalone-safe), so the CLI with the daemon down computes the same table; here are
// what only the daemon has: the doorSeen set (pid + start recorded at accept), the poll of the process table (every 10 s while draining, never a
// connection count — an idle holder still counts), and the exit rule. These are registered on the daemon.

/** The poll interval while draining (P12: every 10 s). */
export const HOLDER_POLL_MS = 10_000

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

/** The processes the door identified at accept (pid + start time), with the harness the D51 lookup named and the LATEST time it did — holdersOf's
 *  `doorSeen`. The latest, not the first: a process seen in on window 1 and again in window 2 must fall inside window 2 when off #2 judges it (P12). */
export function createDoorSeen({ clock = Date.now } = {}) {
  const seen = new Map()
  return {
    add({ harness, pid, start = null }) { if (typeof harness === 'string' && Number.isInteger(pid)) { seen.set(`${harness}\0${pid}\0${start ?? ''}`, { harness, pid, start, at: clock() }) } },
    list: () => [...seen.values()],
  }
}
