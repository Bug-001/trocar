// test/helpers/session-apply.mjs — a `session --since` delta applied the way a client applies it (RFC 3.5 §会话读), and the canonical
// bytes two session documents are compared by: the read tests (test/query/session-read.test.mjs) and the daemon seam
// (test/query/daemon-seam.test.mjs) hold `apply(full(M), since(M)) = full(now)` with the same client.
import { compareStep } from '../../src/view/step-order.mjs'

const KEYS = ['base', 'mark', 'pending', 'truncated', 'more', 'meta', 'stats', 'logged', 'probes', 'unknown', 'lanes', 'calls', 'events', 'records']
/** canon(doc) → the document's 3.5 keys in one fixed order, so two documents compare byte for byte whatever order built them. */
export const canon = (d) => JSON.stringify(Object.fromEntries(KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])))
export const byStep = (a, b) => compareStep(a.ts, a.rid, b.ts, b.rid)

/** apply(full(M), since(M)): rows replaced by rid, `gone` dropped, inserted in step order; lane headers replaced by key,
 *  `lanes_gone` dropped, a lane placed by its first row; a delta row's events replace the held ones, a delta's records replace the held ones by id (a `gone` row's member stays one: its record is kept); a delta's `unknown`
 *  replaces the held one (null: none), its absence keeps it. */
export function apply(full, d) {
  const touched = new Set([...d.calls.map((r) => r.rid), ...d.gone])
  const rows = new Map(full.calls.map((r) => [r.rid, r]))
  for (const rid of d.gone) rows.delete(rid)
  for (const r of d.calls) rows.set(r.rid, r)
  const calls = [...rows.values()].sort(byStep), at = new Map(calls.map((r, i) => [r.rid, i]))
  const place = (rid) => at.get(rid) ?? Infinity
  const lanes = new Map(full.lanes.map((l) => [l.lane, l]))
  for (const k of d.lanes_gone) lanes.delete(k)
  for (const l of d.lanes) lanes.set(l.lane, l)
  const events = [...full.events.filter((e) => !touched.has(e.rid)), ...d.events].map((e, i) => [e, i])
    .sort((a, b) => place(a[0].rid) - place(b[0].rid) || a[1] - b[1]).map(([e]) => e)
  const fresh = new Set(d.records.map((r) => r.id))
  const records = [...full.records.filter((r) => !fresh.has(r.id)), ...d.records].sort((a, b) => compareStep(a.ts_request, a.id, b.ts_request, b.id))
  const { base, more } = full, { mark, pending, truncated, meta, stats, logged, probes } = d
  const unknown = 'unknown' in d ? d.unknown ?? undefined : full.unknown
  return { base, mark, pending, truncated, more, meta, stats, logged, probes, unknown,
    lanes: [...lanes.values()].sort((a, b) => place(a.first) - place(b.first)), calls, events, records }
}
