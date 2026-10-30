// src/query/session-doc.mjs — the session answer's page and delta (RFC 3.5 §会话读, 1.6 C.5), read from the session's FOLD LOG
// (src/query/fold-log.mjs) at its last frontier (`mark` = the reduction frontier): rows, their events and the lane headers by
// offset; logged / probes / unknown and the failures from the log's item and failed lines; records and meta from the segment
// index's rows. Pure over what it is handed: no record is read and nothing is folded here (src/query/named/session.mjs folds).
// Kept per call: its row's ts by its slot in the projection and its place in the step-order column and its lane's; per member that
// is no call, the facts of its item or failed line (itemsOf). An answer reads only the lines that changed since the last.
import { sessionMetaOfFacts, itemsView } from '../view/board.mjs';
import { unknownSummary } from '../view/assemble.mjs';
import { compareStep } from '../view/step-order.mjs';
import { COMP_KEYS } from '../view/blockmeta.mjs';
import { FLAG } from '../view/head-cols.mjs';
import { posCmp } from './projection.mjs';
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
export function laneAt(log, key, off) {
  let at = log.lane(key);
  while (at && at[0] > off) { const p = log.read(...at).p; at = p == null ? null : [p]; }
  return at ? log.read(...at) : null;
}
const rowOf = (o) => (o && o.c != null ? o.r : null);
const headOf = (o) => { if (!o || o.l == null) return null; const { l, p, ...h } = o; return h; };
export const recOf = (r) => ({ id: String(r.id), ts_request: r.ts ?? null, is_llm_call: !!r.is_llm, response: { status: r.status ?? null } });

/** columns(slotOf) → the step-order columns of a fold log's calls, by each call's slot in the projection (`slotOf`): its row's ts, its
 *  lane (`ln`, the lane keys interned in `keys`), how many `user` events it has (`uc`) and whether it has a compaction or summarize
 *  event (`cs`), its context bytes (`cx`), its largest composition bucket and share (`cb`) and its flag bits (`fl`, flagsOf); the rids in step order, and each lane's rids and slots in step order (`by`, by lane int); the live lane keys. sync()
 *  brings them to the log's frontier from the lines past the last sync (and keeps the lane headers it reads: `heads`), each moved row taken out and put back by binary search: a
 *  warm state and a cold open build the same columns. */
export const columns = (slotOf) => ({ at: -1, slotOf, ts: [], ln: new Int32Array(0), uc: new Int32Array(0), cs: new Uint8Array(0),
  cx: new Float64Array(0), cb: new Uint8Array(0), fl: new Uint8Array(0),
  keys: new Map(), order: [], by: [], lanes: new Set(), heads: new Map(), its: null, sorted: null });
const tsOf = (cols, rid) => cols.ts[cols.slotOf(rid)];
// The flag bits of a step: one definition with the board (src/view/head-cols.mjs). A cache break counts when its cause is outside the quiet
// ones (src/web/v2/core/metrics.mjs QUIET_CAUSES).
export { FLAG };
const QUIET = new Set(['append', 'first-call', 'volatile-nonce-only']);
const EVENT_FLAG = { user: FLAG.user, summarize: FLAG.summarize, spawn: FLAG.spawn };
function flagsOf(r, events) {
  let f = 0;
  for (const e of events) f |= e.type === 'compaction' ? FLAG.compaction | (e.inferred ? FLAG.inferred : 0) : EVENT_FLAG[e.type] || 0;
  const b = r.cacheBreak, failed = !!r.error || (r.status != null && r.status !== 200);
  if (b && b.cause && !b.firstCall && !QUIET.has(b.cause)) f |= FLAG.cacheBreak;
  if (failed) f |= FLAG.failed; else if (r.usage == null) f |= FLAG.noUsage;
  return f;
}
// The largest composition bucket (its index in COMP_KEYS, high 4 bits) and its share of the composition in 15ths (low 4 bits).
function compByte(comp) {
  let top = -1, max = 0, sum = 0;
  COMP_KEYS.forEach((k, i) => { const v = (comp && comp[k]) || 0; sum += v; if (v > max) { max = v; top = i; } });
  return top < 0 ? 0 : (top << 4) | Math.round((15 * max) / sum);
}
// The columns in a fold log's sidecar (4.3 §4 旁索引, its `extra`): `s.at` the frontier they were synced to; by slot `s.tk` whether the
// ts is undefined (0), null (1) or a string (2, in `s.ts` in slot order), `s.ln`, `s.uc`, `s.cs`, `s.cx`, `s.cb`, `s.fl`; `s.keys` the lane keys in int order;
// `s.order` the step order as slots; `s.lanes` the live lane keys. A string holding a newline, or a value of another type, saves none.
const strs = (a) => a.every((x) => typeof x === 'string' && !x.includes('\n'));
/** dumpColumns(cols) → the sidecar parts of synced columns ([] when they cannot be: never synced, or a key no `str` part holds). */
export function dumpColumns(cols) {
  const n = cols.ts.length, tk = new Uint8Array(n), ts = [];
  for (let k = 0; k < n; k++) { const t = cols.ts[k]; tk[k] = t === undefined ? 0 : t === null ? 1 : 2; if (tk[k] === 2) ts.push(t); }
  const keys = [...cols.keys.keys()], lanes = [...cols.lanes];
  if (cols.at < 0 || !strs(ts) || !strs(keys) || !strs(lanes)) return [];
  return [['s.at', Float64Array.of(cols.at)], ['s.tk', tk], ['s.ts', ts], ['s.ln', cols.ln.slice(0, n)], ['s.uc', cols.uc.slice(0, n)],
    ['s.cs', cols.cs.slice(0, n)], ['s.cx', cols.cx.slice(0, n)], ['s.cb', cols.cb.slice(0, n)], ['s.fl', cols.fl.slice(0, n)], ['s.keys', keys], ['s.order', Int32Array.from(cols.order, (rid) => cols.slotOf(rid))], ['s.lanes', lanes]];
}
/** loadColumns(rows, parts) → the columns dumpColumns saved, over the projection's rows (`slotOf`, `keyAt`, `size`): equal to a sync
 *  to their `at`; null when the parts are not of that shape or name a slot the rows do not have. */
export function loadColumns(rows, p) {
  const at = p['s.at'], tk = p['s.tk'], n = tk ? tk.length : -1;
  if (!(at instanceof Float64Array) || at.length !== 1 || !(tk instanceof Uint8Array) || n > rows.size || !Array.isArray(p['s.ts'])) return null;
  for (const c of ['s.ln', 's.uc']) if (!(p[c] instanceof Int32Array) || p[c].length !== n) return null;
  for (const [c, T] of [['s.cs', Uint8Array], ['s.cx', Float64Array], ['s.cb', Uint8Array], ['s.fl', Uint8Array]]) if (!(p[c] instanceof T) || p[c].length !== n) return null;
  if (!(p['s.order'] instanceof Int32Array) || !Array.isArray(p['s.keys']) || !Array.isArray(p['s.lanes'])) return null;
  const cols = { ...columns(rows.slotOf), at: at[0], ln: p['s.ln'], uc: p['s.uc'], cs: p['s.cs'], cx: p['s.cx'], cb: p['s.cb'], fl: p['s.fl'], keys: new Map(p['s.keys'].map((k, i) => [k, i])), lanes: new Set(p['s.lanes']) };
  let j = 0;
  for (let k = 0; k < n; k++) if (tk[k]) cols.ts[k] = tk[k] === 1 ? null : p['s.ts'][j++];
  if (j !== p['s.ts'].length) return null;
  for (const k of p['s.order']) {
    if (!(k >= 0 && k < n && tk[k])) return null;
    const rid = rows.keyAt(k), l = byLane(cols, cols.ln[k]);
    cols.order.push(rid); l.rids.push(rid); l.slots.push(k);
  }
  return cols;
}
// where (t, rid) goes in a step-order column (the session's, else a lane's rids): the first place whose row sorts at or after it
function placeOf(cols, t, rid, order = cols.order) {
  let lo = 0, hi = order.length;
  while (lo < hi) { const m = (lo + hi) >> 1, r = order[m]; if (compareStep(tsOf(cols, r), r, t, rid) < 0) lo = m + 1; else hi = m; }
  return lo;
}
// the lane int `v`'s step order, made when first asked
const byLane = (cols, v) => cols.by[v] || (cols.by[v] = { v, rids: [], slots: [] });
// slot k of the typed columns, grown to hold it
function slot(cols, k) {
  if (k < cols.ln.length) return;
  const n = Math.max(k + 1, 2 * cols.ln.length, 64);
  for (const c of ['ln', 'uc', 'cs', 'cx', 'cb', 'fl']) { const a = new cols[c].constructor(n); a.set(cols[c]); cols[c] = a; }
}
const laneInt = (cols, key) => { let v = cols.keys.get(key); if (v === undefined) cols.keys.set(key, (v = cols.keys.size)); return v; };
export function sync(cols, log) {
  const f = log.frontier;
  if (f == null || f === cols.at) return cols;
  const ch = log.changedSince(cols.at);
  for (const rid of ch.rids) {
    const k = cols.slotOf(rid);
    if (k === undefined) throw new Error(`the fold log names ${rid}, which the context projection has no row for`);
    const old = cols.ts[k], o = log.peek(...log.latest(rid)), r = rowOf(o);
    if (old !== undefined) {
      const l = byLane(cols, cols.ln[k]), j = placeOf(cols, old, rid, l.rids);
      cols.order.splice(placeOf(cols, old, rid), 1); l.rids.splice(j, 1); l.slots.splice(j, 1);
    }
    slot(cols, k);
    if (r) {
      cols.ts[k] = r.ts ?? null; cols.order.splice(placeOf(cols, cols.ts[k], rid), 0, rid);
      cols.ln[k] = laneInt(cols, r.lane);
      const l = byLane(cols, cols.ln[k]), j = placeOf(cols, cols.ts[k], rid, l.rids);
      l.rids.splice(j, 0, rid); l.slots.splice(j, 0, k);
      cols.uc[k] = o.e.filter((e) => e.type === 'user').length;
      cols.cs[k] = o.e.some((e) => e.type === 'compaction' || e.type === 'summarize') ? 1 : 0;
      cols.cx[k] = r.ctx || 0; cols.cb[k] = compByte(r.comp); cols.fl[k] = flagsOf(r, o.e);
    } else { cols.ts[k] = undefined; cols.ln[k] = -1; cols.uc[k] = 0; cols.cs[k] = 0; cols.cx[k] = 0; cols.cb[k] = 0; cols.fl[k] = 0; }
  }
  // the kept lane order (viewOf) holds while every lane's first row is the one it was sorted by and kept its place; a new lane is
  // placed into it there
  const S = cols.sorted;
  if (S && ch.rids.some((rid) => S.firsts.has(rid))) cols.sorted = null;
  for (const key of ch.lanes) {
    const h = headOf(log.peek(...log.lane(key)));
    if (cols.sorted && h && !cols.lanes.has(key)) { S.fresh.push(key); S.firsts.add(h.first); }
    else if (cols.sorted && (!h || !S.firsts.has(h.first))) cols.sorted = null;
    if (h) { cols.lanes.add(key); cols.heads.set(key, h); } else { cols.lanes.delete(key); cols.heads.delete(key); }
  }
  cols.at = f;
  return cols;
}
/** laneOf(cols, key) → {v, rids, slots} of the lane `key` (its int, its rids and slots in step order), from the synced columns (the
 *  columns' own arrays: read only); empty for a lane they do not hold. */
export function laneOf(cols, key) {
  const v = cols.keys.get(key);
  return v === undefined ? { v: -1, rids: [], slots: [] } : byLane(cols, v);
}
/** placeIn(cols, lane, rid) → the place of `rid` in the lane `laneOf` gave, or -1 when it is not a row of it: by binary search. */
export function placeIn(cols, lane, rid) {
  const k = cols.slotOf(rid);
  if (k === undefined || cols.ts[k] === undefined || cols.ln[k] !== lane.v) return -1;
  const i = placeOf(cols, cols.ts[k], rid, lane.rids);
  return lane.rids[i] === rid ? i : -1;
}

const itemCmp = (a, b) => compareStep(a.it ? a.it.ts_request : null, a.i, b.it ? b.it.ts_request : null, b.i);
const failCmp = (a, b) => posCmp(a.id, b.id);
// `fact` into the sorted list `list` (by `cmp`), in place of `was`
function put(list, cmp, was, fact) {
  const at = (x) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(list[m], x) < 0) lo = m + 1; else hi = m; } return lo; };
  if (was) list.splice(at(was), 1);
  list.splice(at(fact), 0, fact);
}
// the records no dissector read as a call (3.5 §会话读 `unknown`): with rows, the LLM ones; with none, those or else all
function unknownOf(lines, hasRows) {
  const llm = (o) => !!(o.it && o.it.is_llm_call);
  const a = lines.filter((o) => o.u && llm(o)).map((o) => o.u), b = lines.filter((o) => o.u && !llm(o)).map((o) => o.u);
  const list = hasRows ? a : a.length ? a : b;
  if (!list.length) return undefined;
  const s = unknownSummary(list, hasRows);
  return { records: s.records, reason: s.reason, endpoints: s.endpoints };
}
// The facts of the log's item lines ({i, it, u}, in step order) and failed lines ({id, reason, code}, by position), kept and brought to
// its frontier from the lines past the last time (each read once); logged, probes, unknown and the failed members made from them again
// only when they (or whether the log has rows) changed.
function itemsOf(cols, log) {
  const c = cols.its || (cols.its = { at: -1, items: new Map(), list: [], fails: new Map(), failed: [], view: null });
  const f = log.frontier ?? -1, rows = cols.order.length > 0;
  if (f !== c.at) {
    for (const rid of log.items.since(c.at)) {
      const { i, it, u } = log.peek(...log.items.get(rid)), o = { i, it, u };
      put(c.list, itemCmp, c.items.get(rid), o); c.items.set(rid, o); c.view = null;
    }
    for (const rid of log.failures.since(c.at)) {
      const { x, reason, code } = log.peek(...log.failures.get(rid)), o = { id: x, reason, code };
      put(c.failed, failCmp, c.fails.get(rid), o); c.fails.set(rid, o); c.view = null;
    }
    c.at = f;
  }
  if (!c.view || c.view.rows !== rows) {
    c.view = { rows, ...itemsView(c.list.filter((o) => o.it).map((o) => o.it)), unknown: unknownOf(c.list, rows), failed: c.failed.slice() };
  }
  return c.view;
}

/** viewOf({id, log, cols, members, plan, mark}) → what every answer at the log's frontier reads besides its page: the rows' order
 *  (cols), the lane headers in the order of their first row, stats (the last frontier line's `st`), logged, probes, unknown, the
 *  failed members, meta (the plan's facts of the index rows, src/query/rows.mjs sessionFacts), and the cut (`plan.read`, the index rows the reduction reads, in step order) and mark the
 *  records are taken from. */
export function viewOf({ id, log, cols, members, plan, mark }) {
  sync(cols, log);
  const f = log.frontier, its = itemsOf(cols, log);
  const at = (rid) => (tsOf(cols, rid) === undefined ? Infinity : placeOf(cols, tsOf(cols, rid), rid));
  const head = (k) => cols.heads.get(k) || cols.heads.set(k, headOf(log.read(...log.lane(k)))).get(k); // a loaded column's: read once
  // in the order of their first row, sorted again only when a lane came, went or has another first row (sync): the lanes grow with
  // the session, an answer's work does not (3.5:42)
  if (!cols.sorted) {
    const keys = [...cols.lanes].sort((a, b) => at(head(a).first) - at(head(b).first));
    cols.sorted = { keys, firsts: new Set(keys.map((k) => head(k).first)), fresh: [] };
  }
  for (const k of cols.sorted.fresh.splice(0)) { // after the lanes that sort with it, as the stable sort puts a lane that came later
    const keys = cols.sorted.keys, t = at(head(k).first);
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (at(head(keys[m]).first) <= t) lo = m + 1; else hi = m; }
    keys.splice(lo, 0, k);
  }
  const lanes = cols.sorted.keys.map(head);
  const main = lanes.find((l) => l.kind === 'main'), fl = f == null ? null : log.read(f);
  return {
    log, f, cols, plan, mark, lanes, failed: its.failed, logged: its.logged, probes: its.probes, unknown: its.unknown,
    stats: fl ? fl.st : { calls: 0, streams: 0, subagents: 0, monitors: 0, compactions: 0, totalIn: 0, totalOut: 0, peakCtx: 0 },
    meta: sessionMetaOfFacts({ ...plan.facts.facts(), title: main ? main.task ?? null : null }),
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

// the records of the members `added` and of the rows `calls`, each once, in step order
function recordsOf(V, added, calls) {
  const rows = new Map(added.map((r) => [String(r.id), r]));
  for (const o of calls) rows.set(o.c, V.plan.byId.get(o.c));
  return [...rows.values()].sort((a, b) => compareStep(a.ts ?? null, String(a.id), b.ts ?? null, String(b.id))).map(recOf);
}

/** deltaOf(V, then, cands) → the rows and lane headers at V's frontier that are new or whose bytes differ from those of the log
 *  `then.log` at byte `then.off`, and what that had that V has not, among the candidates `cands: {rids, lanes}` (the shared log's
 *  changedSince, else every rid and lane of either log); their events; the records (index rows) of those rows and of the members
 *  `then.added` (the cut's members past `then.mark` up to V's mark, calls or not: what a full page holds of them), in step order;
 *  `unknown` when it differs from the one at `then.mark` (null when it is gone). */
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
  // `unknown` at M is the one now when, on the shared log, no item line past M's frontier has a record no dissector read and whether
  // a row exists is the same at M (no call changed past it, else a row at or below M): an item line is written once per rid
  const M = then.mark, upToM = (rid) => posCmp(rid, M) <= 0, its = V.cols.its, order = V.cols.order;
  const same = then.log === V.log && !V.log.items.since(then.off).some((rid) => its.items.get(rid).u)
    && (cands.rids.length === 0 || order.some(upToM) === order.length > 0);
  const was = same ? V.unknown : unknownOf(its.list.filter((o) => upToM(o.i)), order.some(upToM));
  return {
    ...(JSON.stringify(was) !== JSON.stringify(V.unknown) ? { unknown: V.unknown ?? null } : null),
    calls: calls.map((o) => o.r), gone: gone.sort(posCmp), lanes: V.lanes.filter((h) => lanes.has(h.lane)), lanes_gone: lanesGone.sort(posCmp),
    events: eventsOf(calls), records: recordsOf(V, then.added, calls),
  };
}
