// holders.mjs (core/proxymode) — the daemon's side of P12 (RFC 4.11 P12; plan decision #4): after `off` the daemon stays up while a holder lives.
// The judge is src/off/holders.mjs holdersOf (standalone-safe), so the CLI with the daemon down computes the same table; here are
// what only the daemon has: the doorSeen set (pid + start recorded at accept), the poll of the process table (every 10 s while draining, never a
// connection count — an idle holder still counts), and the exit rule. These are registered on the daemon.

/** The poll interval while draining (P12: every 10 s). */
export const HOLDER_POLL_MS = 10_000

const keyOf = (h) => `${h.harness}\0${h.pid}\0${h.start ?? ''}`

/** The daemon exits after `off` only when no harness is on, no holder lives and no connection is open (P12). */
export const mayExit = ({ harnessesOn = [], holders = [], openConns = 0 } = {}) => harnessesOn.length === 0 && holders.length === 0 && !(openConns > 0)

/** Polls `list()` (→ holdersOf's rows; it reads the process table, never the connections) every `every` ms through injected `timers`
 *  ({ setTimeout, clearTimeout }); `onChange(rows)` when the set of (harness, pid, start) changes, the first answer included. A list that throws keeps
 *  the last answer (an unreadable table is not "nobody holds the door") and is passed to `onError`. → { start(), stop(), now() → rows | null }. */
export function createHolderPoll({ list, every = HOLDER_POLL_MS, timers = globalThis, onChange = () => {}, onError = () => {} } = {}) {
  let rows = null, sig = null, timer = null, running = false
  const tick = async () => {
    try {
      const next = await list()
      const s = next.map(keyOf).sort().join('\n')
      rows = next
      if (s !== sig) { sig = s; onChange(next) }
    } catch (e) { onError(e) }
    if (running) timer = timers.setTimeout(tick, every)
  }
  return {
    start() { if (!running) { running = true; tick() } },
    stop() { running = false; if (timer != null) timers.clearTimeout(timer); timer = null },
    now: () => rows,
  }
}

/** The processes the door identified at accept (pid + start time), with the harness the D51 lookup named and when — holdersOf's `doorSeen`. */
export function createDoorSeen({ clock = Date.now } = {}) {
  const seen = new Map()
  return {
    add({ harness, pid, start = null }) { if (typeof harness === 'string' && Number.isInteger(pid)) { const k = `${harness}\0${pid}\0${start ?? ''}`; if (!seen.has(k)) seen.set(k, { harness, pid, start, at: clock() }) } },
    list: () => [...seen.values()],
  }
}
