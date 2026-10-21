// src/query/session-doc.mjs — the session answer's document, page and delta (RFC 3.5 §会话读, 1.6 C.5), from a reduced state that
// src/query/named/session.mjs holds (its `doc`: src/view/reduce.mjs skeletonDoc). Pure over the state: no record, store or heap is touched here.
import { sessionMetaOfFacts } from '../view/board.mjs';
import { num52 } from '../view/reduce.mjs';
import { compareStep } from '../view/step-order.mjs';
import { sessionFactsOf } from './rows.mjs';
import { QueryArgError } from './named/index.mjs';

/** `--limit`: rows a page holds at most, its default and its ceiling (3.5 §会话读). */
export const LIMIT_MAX = 1000;
// One page of rows holds at most this much serialized (3.5 §会话读 ①).
export const PAGE_BYTES = 1048576;
// The answered marks whose serialized rows and lane headers stay kept for `--since`.
const MARKS = 4;

/** limitOf(v) → `--limit` as a whole number 1..LIMIT_MAX (LIMIT_MAX when absent); QueryArgError otherwise. */
export function limitOf(v) {
  if (v == null || v === '') return LIMIT_MAX;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) throw new QueryArgError(`trocar query session: --limit ${JSON.stringify(v)} is not a whole number from 1 to ${LIMIT_MAX}`);
  return n;
}

/** documentOf(st) → the session document at a state's mark, as the answer ships it: rows and lane headers in step order (a lane by
 *  its first row), events by their row's place, records (failed members from their index rows) in step order. */
export function documentOf(st) {
  const sk = st.doc, failed = sk.failed || [];
  const ts = new Map(sk.records.map((r) => [r.id, r.ts_request]));
  const records = [...sk.records, ...failed.map((f) => {
    const r = st.plan.byId.get(f.id) || {};
    return { id: f.id, ts_request: r.ts ?? null, is_llm_call: !!r.is_llm, response: { status: r.status ?? null } };
  })].sort((a, b) => compareStep(a.ts_request, a.id, b.ts_request, b.id));
  const main = sk.lanes.find((l) => l.kind === 'main');
  return {
    rows: sk.rows, lanes: sk.lanes, events: sk.events, records, stats: sk.stats ?? null, logged: sk.logged, probes: sk.probes,
    meta: sessionMetaOfFacts({ ...sessionFactsOf(st.id, st.rows), title: main ? main.task ?? null : null }),
    errors: failed.map((f) => ({ where: f.id, code: f.code, reason: f.reason })),
    tsOf: (rid) => ts.get(rid),
  };
}

/** serialOf(D) → the form `--since` compares: each row's and lane header's serialized bytes as a 52-bit digest, and each row's
 *  serialized length (for paging; not kept with a mark). */
export function serialOf(D) {
  const rows = new Map(), bytes = new Map();
  for (const r of D.rows) { const j = JSON.stringify(r); rows.set(r.rid, num52(j)); bytes.set(r.rid, Buffer.byteLength(j)); }
  return { rows, lanes: new Map(D.lanes.map((l) => [l.lane, num52(JSON.stringify(l))])), bytes };
}
const sizeOf = (s) => { let n = 0; for (const m of [s.rows, s.lanes]) for (const k of m.keys()) n += 2 * k.length + 48; return n; };

/** keep(kept, mark, s) → true when the serialized document `s` at `mark` is newly kept (the oldest past MARKS let go). */
export function keep(kept, mark, s) {
  if (!kept || mark == null || kept.marks.has(mark)) return false;
  kept.marks.set(mark, { rows: s.rows, lanes: s.lanes }); kept.markBytes += sizeOf(s);
  for (const [m, v] of kept.marks) { if (kept.marks.size <= MARKS) break; kept.marks.delete(m); kept.markBytes -= sizeOf(v); }
  return true;
}

/** deltaOf(D, now, then) → the rows, lanes, events and records of D that are new or differ from `then`, and what `then` had that D has not. */
export function deltaOf(D, now, then) {
  const calls = D.rows.filter((r) => then.rows.get(r.rid) !== now.rows.get(r.rid));
  const rids = new Set(calls.map((r) => r.rid));
  return { calls, gone: [...then.rows.keys()].filter((rid) => !now.rows.has(rid)),
    lanes: D.lanes.filter((l) => then.lanes.get(l.lane) !== now.lanes.get(l.lane)), lanes_gone: [...then.lanes.keys()].filter((key) => !now.lanes.has(key)),
    events: D.events.filter((e) => rids.has(e.rid)), records: D.records.filter((r) => rids.has(r.id)) };
}

/** pageOf(D, now, before, limit) → the page ending just before `before` (the newest without it): ≤ limit rows and ≤ PAGE_BYTES of
 *  them, at least one; its records are the members in its span of step order (after the row before it, up to its last row). */
export function pageOf(D, now, before, limit) {
  const end = before != null ? D.rows.findIndex((r) => r.rid === before) : D.rows.length;
  let start = end, bytes = 0;
  while (start > 0 && end - start < limit) {
    const n = now.bytes.get(D.rows[start - 1].rid);
    if (start < end && bytes + n > PAGE_BYTES) break;
    bytes += n; start--;
  }
  const page = D.rows.slice(start, end), rids = new Set(page.map((r) => r.rid));
  const lo = start > 0 ? D.rows[start - 1] : null, hi = end < D.rows.length ? D.rows[end - 1] : null;
  const after = (rec, r) => compareStep(rec.ts_request, rec.id, D.tsOf(r.rid), r.rid) > 0;
  return { more: start > 0, lanes: D.lanes, calls: page, events: D.events.filter((e) => rids.has(e.rid)),
    records: D.records.filter((rec) => (!lo || after(rec, lo)) && (!hi || !after(rec, hi))) };
}
