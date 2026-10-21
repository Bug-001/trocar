// holders.mjs (src/off) — who may still use a door after `off` (RFC 4.11 P12; plan decision #4). A holder is a live process (pid + start time) that
// may have read a route during its harness's on window: a process of h (D51 identity) started inside [on_at, off_at) — or, for a harness that
// re-reads its entry while running (`rereads`), any process of h alive at off_at — or a process the door identified during that window (`doorSeen`,
// recorded at accept). A harness whose hook re-reads the switch per request (`per_request`: the cordis-plugin) makes none: its next request after
// `off` goes its own way. Judged from the manifest's `liveness.<h>` and a process table alone, never from open connections (an idle agent still holds
// the door address), so the daemon's poll, `off`'s receipt, `status` and `uninstall`'s refusal while the daemon is down compute the same table.
// Built on the kept judge (signature.mjs harnessesOf / withAgentList / mayHaveRead); imports only src/off (standalone-safe, 0.1 §2).
import { harnessesOf, withAgentList, mayHaveRead } from './signature.mjs'

const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : Number.isFinite(v) ? v : NaN; return Number.isFinite(t) ? t : null }
const inWindow = (at, since, until) => at == null || ((since == null || at >= since) && (until == null || at < until))
export const WINDOWS_MAX = 32 // liveness.<h>.windows keeps at most this many earlier on windows (4.11 P12)

/** Every on window of `l` whose entry value is the current one (4.11 P12): the earlier ones `on` kept in `windows` (the door's port and token
 *  unchanged since), then the latest [on_at, off_at) — `until` null while it is still open. A full list's earliest start is not known (-Infinity: the
 *  safe direction, one more holder) — its end still is: a process started in the gap after it read no entry. → [{ since, until }] */
export function windowsOf(l) {
  if (!l || typeof l !== 'object' || l.on_at == null) return []
  const past = (Array.isArray(l.windows) ? l.windows : []).filter((w) => w && w.on_at != null && w.off_at != null).map((w) => ({ since: msOf(w.on_at), until: msOf(w.off_at) }))
  if (past.length >= WINDOWS_MAX) past[0].since = -Infinity
  return [...past, { since: msOf(l.on_at), until: l.off_at == null ? null : msOf(l.off_at) }]
}

/** Did live process `p` (startedAt in ms or ISO) read an entry of `l`'s harness that still leads to its door (4.11 P11 status, D31①)? → true · false · null (its start is not known).
 *  `p.startGrain` (ms, listProcs's rows) is how finely its reader knows the start: the true start is somewhere in [startedAt, startedAt + startGrain) —
 *  a whole-second reading (macOS `lstart`) inside on_at's second read the entry (1.6 A.2 row 32). A row that states none is taken as exact. */
export function sawEntry(p, l) {
  const w = windowsOf(l)
  if (!w.length) return false
  if (p.startedAt == null) return null
  const at = msOf(p.startedAt)
  const last = at + (Number.isFinite(p.startGrain) && p.startGrain > 1 ? p.startGrain - 1 : 0)
  // the earliest possible start (a rereading harness: started before off_at), and the possible start nearest the window's opening
  return w.some((x) => [at, Math.min(Math.max(at, x.since ?? at), last)].some((s) => mayHaveRead({ startedAt: s }, l, x.since, x.until)))
}

/** → `[{ harness, pid, start, why: 'started-in-window' | 'rereads' | 'start-unknown' | 'door-seen' }]`, in liveness order, one row per (harness, pid).
 *  `procs`: the live table (listProcs rows); `doorSeen`: `[{ harness, pid, start, at }]` from the door's accepts; `agentList`: readAgentList's result,
 *  whose additions count as the harness's names too (the safe direction, as in undo). */
export function holdersOf({ manifest, procs = [], doorSeen = [], agentList = null } = {}) {
  const raw = manifest && manifest.liveness && typeof manifest.liveness === 'object' ? manifest.liveness : {}
  const { liveness } = withAgentList(raw, agentList)
  const out = []
  for (const [h, l] of Object.entries(liveness)) {
    // holders exist only after off (1.6 R5): a record without on_at is not the model's (Linux, the old model), one without off_at is still on
    if (!l || typeof l !== 'object' || l.per_request || l.on_at == null || l.off_at == null) continue
    const windows = windowsOf(l) // every on window that led to this door, the latest last (an off→on keeps the earlier ones, P12)
    const seen = new Set()
    const add = (p, why) => { if (!seen.has(p.pid)) { seen.add(p.pid); out.push({ harness: h, pid: p.pid, start: p.startedAt ?? null, why }) } }
    for (const p of procs) {
      if (!harnessesOf({ [h]: l }, p).length || !windows.some((w) => mayHaveRead(p, l, w.since, w.until))) continue
      add(p, p.startedAt == null ? 'start-unknown' : l.rereads ? 'rereads' : 'started-in-window')
    }
    for (const s of doorSeen) {
      if (!s || s.harness !== h || !windows.some((w) => inWindow(msOf(s.at), w.since, w.until))) continue
      const p = procs.find((x) => x.pid === s.pid && (x.startedAt ?? null) === (s.start ?? null)) // pid + start: a reused pid is another process
      if (p) add(p, 'door-seen')
    }
  }
  return out
}
