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

/** → `[{ harness, pid, start, why: 'started-in-window' | 'rereads' | 'start-unknown' | 'door-seen' }]`, in liveness order, one row per (harness, pid).
 *  `procs`: the live table (listProcs rows); `doorSeen`: `[{ harness, pid, start, at }]` from the door's accepts; `agentList`: readAgentList's result,
 *  whose additions count as the harness's names too (the safe direction, as in undo). */
export function holdersOf({ manifest, procs = [], doorSeen = [], agentList = null } = {}) {
  const raw = manifest && manifest.liveness && typeof manifest.liveness === 'object' ? manifest.liveness : {}
  const { liveness } = withAgentList(raw, agentList)
  const out = []
  for (const [h, l] of Object.entries(liveness)) {
    if (!l || typeof l !== 'object' || l.per_request) continue
    const since = msOf(l.on_at), until = msOf(l.off_at)
    const seen = new Set()
    const add = (p, why) => { if (!seen.has(p.pid)) { seen.add(p.pid); out.push({ harness: h, pid: p.pid, start: p.startedAt ?? null, why }) } }
    for (const p of procs) {
      if (!harnessesOf({ [h]: l }, p).length || !mayHaveRead(p, l, since, until)) continue
      add(p, p.startedAt == null ? 'start-unknown' : l.rereads ? 'rereads' : 'started-in-window')
    }
    for (const s of doorSeen) {
      if (!s || s.harness !== h || !inWindow(msOf(s.at), since, until)) continue
      const p = procs.find((x) => x.pid === s.pid && (x.startedAt ?? null) === (s.start ?? null)) // pid + start: a reused pid is another process
      if (p) add(p, 'door-seen')
    }
  }
  return out
}
