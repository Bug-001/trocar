// holders.mjs (src/off) — the one judge of a live process's life against its harness's door (4.11 P11 status, P12 holders): did it read an entry
// that still leads to the door, may it have, or did it not? From the manifest's `liveness.<h>` (identity, rereads, on_at, off_at, since, door_since,
// windows), the door's durable rows (door-seen.mjs) and a process table alone — never from open connections (an idle agent still holds the door
// address) — so the daemon's poll, `off`'s receipt, `status` and `uninstall`'s refusal while the daemon is down compute the same answer. A holder is
// any state but `not-read`, the safe direction (D50: one more holder, never one less; invariant 5). A harness whose hook re-reads the switch per
// request (`per_request`: the cordis-plugin) makes none. Built on the kept off liveness judge (signature.mjs); imports only src/off (standalone-safe, 0.1 §2).
import { harnessesOf, withAgentList, mayHaveRead } from './signature.mjs'
import { chromiumRole } from './chromium.mjs'
import { validFor, validRow, msOf } from './door-seen.mjs'
import { itemsOfPhase } from './manifest.mjs'

export const WINDOWS_MAX = 32 // liveness.<h>.windows keeps at most this many earlier on windows (4.11 P12)
const NOT = Object.freeze({ state: 'not-read' })

/** Every on window of `l`, the earlier ones `windows` keeps then the latest [on_at, off_at) — until null while it is open. → [{ since, until }] */
const windowsOf = (l) => (l && typeof l === 'object' && l.on_at != null
  ? [...(Array.isArray(l.windows) ? l.windows : []).filter((w) => w && w.on_at != null && w.off_at != null).map((w) => ({ since: msOf(w.on_at), until: msOf(w.off_at) })),
    { since: msOf(l.on_at), until: l.off_at == null ? null : msOf(l.off_at) }]
  : [])

/** Is door row `row` of process `p`'s life — the same pid AND the same start (a reused pid is another process)? */
export const sameLife = (row, p) => !!row && !!p && row.pid === p.pid && msOf(row.start) === msOf(p.startedAt)

/** judgeLife({ p, l, table, rows, carrierAt, isMine }) → { state: 'door' | 'read' | 'maybe' | 'not-read' | 'start-unknown', row?, via? }
 *  p: a process-table row; l: its harness's liveness record; table: the whole table (ppid walks, the Chromium fold); rows: the harness's door rows
 *  (null: the door's record could not be read — a live process of h is then judged in the safe direction);
 *  carrierAt: the earliest carrier time (ms) or null (unknown: the safe direction); isMine(x): is x a process of this harness (D51).
 *  via ∈ started-in-window · rereads · history-unknown · host-of · ancestor. */
export function judgeLife({ p, l, table = [], rows = [], carrierAt = null, isMine = () => true }, seen = new Set()) {
  if (!p || seen.has(p.pid)) return NOT
  seen.add(p.pid)
  const row = (rows || []).find((r) => sameLife(r, p) && validFor(r, l))
  if (row) return { state: 'door', row }
  const again = (x) => judgeLife({ p: x, l, table, rows, carrierAt, isMine }, seen)
  if (chromiumRole(p.argv) === null) { // a Chromium host reads through its network service: the child's judgement is the host's
    for (const c of table) {
      if (c.ppid !== p.pid || c.pid === p.pid || !isMine(c) || chromiumRole(c.argv) !== 'network-service') continue
      const j = again(c)
      if (j.state !== 'not-read') return { ...j, via: 'host-of' }
    }
  }
  const w = windowsOf(l)
  if (!w.length) return NOT // never on: no entry to read
  // rows null: the door's record could not be read — whether this life has a row is not known, so the safe direction (4.11 P12)
  const gap = rows == null && isMine(p) ? { state: 'maybe', via: 'history-unknown' } : NOT
  if (p.startedAt == null) return { state: 'start-unknown' }
  const q = { startedAt: msOf(p.startedAt), startGrain: p.startGrain }
  if (q.startedAt == null) return { state: 'start-unknown' }
  if (l.rereads && mayHaveRead(q, true, null, w[w.length - 1].until)) return { state: 'read', via: 'rereads' }
  const moved = Math.max(-Infinity, ...Object.values((l.door_since && typeof l.door_since === 'object') ? l.door_since : {}).map(msOf).filter((x) => x != null))
  const hit = w.filter((x) => mayHaveRead(q, false, x.since, x.until))
  if (hit.length) return { state: hit.some((x) => x.since == null || x.since >= moved) ? 'read' : 'maybe', via: 'started-in-window' }
  const last = Number.isFinite(q.startGrain) && q.startGrain > 1 ? q.startedAt + q.startGrain - 1 : q.startedAt
  if (msOf(l.since) == null && w[0].since != null && q.startedAt < w[0].since && (carrierAt == null || last > carrierAt)) return { state: 'maybe', via: 'history-unknown' }
  // a known gap: what it read is what its nearest ancestor of the same harness may have handed down
  const parentOf = (x) => table.find((y) => y.pid === x.ppid && y.pid !== x.pid)
  for (let a = parentOf(p); a && !seen.has(a.pid); a = parentOf(a)) {
    if (!isMine(a)) { seen.add(a.pid); continue }
    return again(a).state !== 'not-read' ? { state: 'maybe', via: 'ancestor' } : gap
  }
  return gap
}

const whyOf = (j) => j.via || (j.state === 'door' ? 'door-seen' : 'start-unknown')

/** → `[{ harness, pid, start, why }]`, in liveness then table order; why ∈ door-seen · started-in-window · rereads · start-unknown · history-unknown ·
 *  ancestor · host-of. `procs`: the live table (listProcs rows); `doorSeen`: the door's durable rows (door-seen.mjs); `agentList`: readAgentList's
 *  result, whose additions count as the harness's names too (the safe direction, as in undo). `doorSeen` null = the door's record could not be
 *  read: every live process of a harness that was on is then a holder (history-unknown) unless other evidence names it. */
export function holdersOf({ manifest, procs = [], doorSeen = [], agentList = null } = {}) {
  const raw = manifest && manifest.liveness && typeof manifest.liveness === 'object' ? manifest.liveness : {}
  const { liveness } = withAgentList(raw, agentList)
  const items = itemsOfPhase(manifest, 'install')
  const out = []
  for (const [h, l] of Object.entries(liveness)) {
    // holders exist only after off (1.6 R5): a record without on_at is not the model's (Linux, the old model), one without off_at is still on
    if (!l || typeof l !== 'object' || l.per_request || l.on_at == null || l.off_at == null) continue
    const isMine = (x) => harnessesOf({ [h]: l }, x).length > 0
    // null: not known (an unreadable door record); a row is valid by its door group's harness's record (validRow), as status judges it
    const rows = doorSeen == null ? null : doorSeen.filter((r) => r && r.harness === h && validRow(r, raw))
    const t = items.filter((i) => i.harness === h || i.kind === 'system-root').map((i) => msOf(i.installed_at)).filter((x) => x != null)
    const carrierAt = t.length ? Math.min(...t) : null // the earliest carrier: the safe direction
    for (const p of procs) {
      if (!isMine(p) && !(rows || []).some((r) => sameLife(r, p))) continue
      const j = judgeLife({ p, l, table: procs, rows, carrierAt, isMine })
      if (j.state !== 'not-read') out.push({ harness: h, pid: p.pid, start: p.startedAt ?? null, why: whyOf(j) })
    }
  }
  return out
}
