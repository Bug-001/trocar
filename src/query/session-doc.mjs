// src/query/session-doc.mjs — the session answer's page and delta (RFC 3.5 §会话读, 1.6 C.5), read from the session's FOLD LOG
// (src/query/fold-log.mjs) at its last frontier (`mark` = the reduction frontier): rows, their events and the lane headers by
// offset; logged / probes / unknown and the failures from the log's item and failed lines; records and meta from the segment
// index's rows. Pure over what it is handed: no record is read and nothing is folded here (src/query/named/session.mjs folds).
// Kept per call: its row's ts by its slot in the projection and its place in the step-order column; nothing else per member.
import { sessionMetaOfFacts, itemsView } from '../view/board.mjs';
import { unknownSummary } from '../view/assemble.mjs';
import { compareStep } from '../view/step-order.mjs';
import { posCmp, num52 } from './projection.mjs';
import { sessionFactsOf } from './rows.mjs';
import { QueryArgError } from './named/index.mjs';

/** `--limit`: rows a page holds at most, its default and its ceiling (3.5 §会话读). */
export const LIMIT_MAX = 1000;
// One page of rows holds at most this much serialized (3.5 §会话读 ①).
export const PAGE_BYTES = 1048576;

/** limitOf(v) → `--limit` as a whole number 1..LIMIT_MAX (LIMIT_MAX when absent); QueryArgError otherwise. */
export function limitOf(v) {
  if (v == null || v === '') return LIMIT_MAX;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) throw new QueryArgError(`trocar query session: --limit ${JSON.stringify(v)} is not a whole number from 1 to ${LIMIT_MAX}`);
  return n;
}

/** markOf(log) → the reduction frontier the log's last frontier line names (its `f`), or null before the first fold step. */
export const markOf = (log) => (log.frontier == null ? null : log.read(log.frontier).f);
// the line of `rid` as it stood at byte `off` (its latest at or before it), or null
function rowAt(log, rid, off) {
  const at = log.latest(rid);
  if (!at) return null;
  if (at[0] <= off) return log.read(...at);
  const v = log.versionAt(rid, off);
  return v ? log.read(...v) : null;
}
// the lane's line as it stood at byte `off`, or null
function laneAt(log, key, off) {
  let at = log.lane(key);
  while (at && at[0] > off) { const p = log.read(...at).p; at = p == null ? null : [p]; }
  return at ? log.read(...at) : null;
}
const rowOf = (o) => (o && o.c != null ? o.r : null);
const headOf = (o) => { if (!o || o.l == null) return null; const { l, p, ...h } = o; return h; };
const recOf = (r) => ({ id: String(r.id), ts_request: r.ts ?? null, is_llm_call: !!r.is_llm, response: { status: r.status ?? null } });

/** columns(slotOf) → the step-order columns of a fold log's calls: each call row's ts by its rid's slot in the projection
 *  (`slotOf`), the rids in step order, the live lane keys; sync() brings them to the log's frontier from the lines past the last
 *  sync, each moved row taken out and put back by binary search: a warm state and a cold open build the same columns. */
export const columns = (slotOf) => ({ at: -1, slotOf, ts: [], order: [], lanes: new Set(), its: null });
const tsOf = (cols, rid) => cols.ts[cols.slotOf(rid)];
// where (t, rid) goes in the step-order column: the first place whose row sorts at or after it
function placeOf(cols, t, rid) {
  let lo = 0, hi = cols.order.length;
  while (lo < hi) { const m = (lo + hi) >> 1, r = cols.order[m]; if (compareStep(tsOf(cols, r), r, t, rid) < 0) lo = m + 1; else hi = m; }
  return lo;
}
export function sync(cols, log) {
  const f = log.frontier;
  if (f == null || f === cols.at) return cols;
  const ch = log.changedSince(cols.at);
  for (const rid of ch.rids) {
    const k = cols.slotOf(rid);
    if (k === undefined) throw new Error(`the fold log names ${rid}, which the context projection has no row for`);
    const old = cols.ts[k], r = rowOf(log.read(...log.latest(rid)));
    if (old !== undefined) cols.order.splice(placeOf(cols, old, rid), 1);
    if (r) { cols.ts[k] = r.ts ?? null; cols.order.splice(placeOf(cols, cols.ts[k], rid), 0, rid); } else cols.ts[k] = undefined;
  }
  for (const key of ch.lanes) { if (log.read(...log.lane(key)).l != null) cols.lanes.add(key); else cols.lanes.delete(key); }
  cols.at = f;
  return cols;
}

// the log's item lines in step order
const itemLines = (log) => [...log.items.keys()].map((rid) => log.read(...log.items.get(rid)))
  .sort((a, b) => compareStep(a.it ? a.it.ts_request : null, a.i, b.it ? b.it.ts_request : null, b.i));
// the records no dissector read as a call (3.5 §会话读 `unknown`, C1): with rows, the LLM ones; with none, those or else all
function unknownOf(lines, hasRows) {
  const llm = (o) => !!(o.it && o.it.is_llm_call);
  const a = lines.filter((o) => o.u && llm(o)).map((o) => o.u), b = lines.filter((o) => o.u && !llm(o)).map((o) => o.u);
  const list = hasRows ? a : a.length ? a : b;
  if (!list.length) return undefined;
  const s = unknownSummary(list, hasRows);
  return { records: s.records, reason: s.reason, endpoints: s.endpoints };
}
// logged, probes, unknown and the failed members, made again only when the log's item or failed lines (or whether it has rows) changed
function itemsOf(cols, log) {
  const ni = log.items.size, nx = log.failures.size, rows = cols.order.length > 0, c = cols.its;
  if (c && c.ni === ni && c.nx === nx && c.rows === rows) return c;
  const lines = itemLines(log);
  const failed = [...log.failures.keys()].map((rid) => { const { x, reason, code } = log.read(...log.failures.get(rid)); return { id: x, reason, code }; })
    .sort((a, b) => posCmp(a.id, b.id));
  return (cols.its = { ni, nx, rows, ...itemsView(lines.filter((o) => o.it).map((o) => o.it)), unknown: unknownOf(lines, rows), failed });
}

/** viewOf({id, log, cols, members, plan, mark}) → what every answer at the log's frontier reads besides its page: the rows' order
 *  (cols), the lane headers in the order of their first row, stats (the last frontier line's `st`), logged, probes, unknown, the
 *  failed members, meta (the index rows), and the cut (`plan.read`, the index rows the reduction reads, in step order) and mark the
 *  records are taken from. */
export function viewOf({ id, log, cols, members, plan, mark }) {
  sync(cols, log);
  const f = log.frontier, its = itemsOf(cols, log);
  const at = (rid) => (tsOf(cols, rid) === undefined ? Infinity : placeOf(cols, tsOf(cols, rid), rid));
  const lanes = [...cols.lanes].map((k) => headOf(log.read(...log.lane(k)))).sort((a, b) => at(a.first) - at(b.first));
  const main = lanes.find((l) => l.kind === 'main'), fl = f == null ? null : log.read(f);
  return {
    log, f, cols, plan, mark, lanes, failed: its.failed, logged: its.logged, probes: its.probes, unknown: its.unknown,
    stats: fl ? fl.st : { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 },
    meta: sessionMetaOfFacts({ ...sessionFactsOf(id, members), title: main ? main.task ?? null : null }),
    has: (rid) => { const k = cols.slotOf(rid); return k !== undefined && cols.ts[k] !== undefined; },
  };
}

const eventsOf = (lines) => lines.flatMap((o) => o.e.map((e) => ({ type: e.type, rid: o.c, lane: o.r.lane })));
// how many rows of the cut sort at or before the member `rid` in step order
function upTo(plan, rid) {
  const t = plan.byId.get(rid).ts, read = plan.read;
  let lo = 0, hi = read.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (compareStep(read[m].ts, read[m].id, t, rid) <= 0) lo = m + 1; else hi = m; }
  return lo;
}

/** pageOf(V, before, limit) → the page ending just before the row `before` (the newest without it): ≤ limit rows and ≤ PAGE_BYTES
 *  of them, at least one, read by offset; its events from the same lines; its records the members of the cut at or below the mark
 *  in its span of step order (after the row before it, up to its last row; the newest page has no end, the oldest no start). */
export function pageOf(V, before, limit) {
  const { cols, log, f, plan, mark } = V, order = cols.order, end = before != null ? placeOf(cols, tsOf(cols, before), before) : order.length;
  let start = end, bytes = 0;
  const lines = [];
  while (start > 0 && end - start < limit) {
    const o = rowAt(log, order[start - 1], f), n = Buffer.byteLength(JSON.stringify(o.r));
    if (start < end && bytes + n > PAGE_BYTES) break;
    bytes += n; start--; lines.unshift(o);
  }
  const a = start > 0 ? upTo(plan, order[start - 1]) : 0, b = end < order.length && end > 0 ? upTo(plan, order[end - 1]) : plan.read.length;
  const records = [];
  for (let i = a; i < b; i++) if (mark != null && posCmp(String(plan.read[i].id), mark) <= 0) records.push(recOf(plan.read[i]));
  return { more: start > 0, lanes: V.lanes, calls: lines.map((o) => o.r), events: eventsOf(lines), records };
}

/** deltaOf(V, then, cands) → the rows and lane headers at V's frontier that are new or whose bytes differ from those of the log
 *  `then.log` at byte `then.off`, and what that had that V has not, among the candidates `cands: {rids, lanes}` (the shared log's
 *  changedSince, else every rid and lane of either log); their events and records (their index rows); `unknown` when it differs
 *  from the one at `then.mark` (null when it is gone). */
export function deltaOf(V, then, cands) {
  const calls = [], gone = [], lanes = new Set(), lanesGone = [];
  for (const rid of cands.rids) {
    const a = rowOf(rowAt(then.log, rid, then.off)), o = rowAt(V.log, rid, V.f), b = rowOf(o);
    if (b && (!a || JSON.stringify(a) !== JSON.stringify(b))) calls.push(o);
    else if (!b && a) gone.push(rid);
  }
  for (const key of cands.lanes) {
    const a = headOf(laneAt(then.log, key, then.off)), b = headOf(laneAt(V.log, key, V.f));
    if (b && (!a || JSON.stringify(a) !== JSON.stringify(b))) lanes.add(key);
    else if (!b && a) lanesGone.push(key);
  }
  calls.sort((x, y) => compareStep(x.r.ts ?? null, x.c, y.r.ts ?? null, y.c));
  const M = then.mark, upToM = (rid) => posCmp(rid, M) <= 0;
  const was = unknownOf(itemLines(V.log).filter((o) => upToM(o.i)), V.cols.order.some(upToM));
  return {
    ...(JSON.stringify(was) !== JSON.stringify(V.unknown) ? { unknown: V.unknown ?? null } : null),
    calls: calls.map((o) => o.r), gone: gone.sort(posCmp), lanes: V.lanes.filter((h) => lanes.has(h.lane)), lanes_gone: lanesGone.sort(posCmp),
    events: eventsOf(calls), records: calls.map((o) => recOf(V.plan.byId.get(o.c))),
  };
}

// The document form src/query/named/session.mjs answers from until it reads the fold log (removed with that switch).
const MARKS = 4;
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
const sizeOfLegacy = (s) => { let n = 0; for (const m of [s.rows, s.lanes]) for (const k of m.keys()) n += 2 * k.length + 48; return n; };

/** keep(kept, mark, s) → true when the serialized document `s` at `mark` is newly kept (the oldest past MARKS let go). */
export function keep(kept, mark, s) {
  if (!kept || mark == null || kept.marks.has(mark)) return false;
  kept.marks.set(mark, { rows: s.rows, lanes: s.lanes }); kept.markBytes += sizeOfLegacy(s);
  for (const [m, v] of kept.marks) { if (kept.marks.size <= MARKS) break; kept.marks.delete(m); kept.markBytes -= sizeOfLegacy(v); }
  return true;
}

/** deltaOf(D, now, then) → the rows, lanes, events and records of D that are new or differ from `then`, and what `then` had that D has not. */
export function legacyDeltaOf(D, now, then) {
  const calls = D.rows.filter((r) => then.rows.get(r.rid) !== now.rows.get(r.rid));
  const rids = new Set(calls.map((r) => r.rid));
  return { calls, gone: [...then.rows.keys()].filter((rid) => !now.rows.has(rid)),
    lanes: D.lanes.filter((l) => then.lanes.get(l.lane) !== now.lanes.get(l.lane)), lanes_gone: [...then.lanes.keys()].filter((key) => !now.lanes.has(key)),
    events: D.events.filter((e) => rids.has(e.rid)), records: D.records.filter((r) => rids.has(r.id)) };
}

/** pageOf(D, now, before, limit) → the page ending just before `before` (the newest without it): ≤ limit rows and ≤ PAGE_BYTES of
 *  them, at least one; its records are the members in its span of step order (after the row before it, up to its last row). */
export function legacyPageOf(D, now, before, limit) {
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
