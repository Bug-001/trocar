// src/query/named/session.mjs — `trocar query session --id <id> [--since M | --before R] [--limit N]` (RFC 3.5 §会话读, 1.6 §4.1 / C.5).
//
// A session's skeleton from its context projection (src/query/projection.mjs): the members (the segment index's rows of this
// session, src/query/rows.mjs) are extracted into the projection in write order (src/view/extract.mjs extractMembers; the worker
// writes it, the local path holds it in memory), and the members up to the extraction frontier (`mark`) are reduced
// (src/view/reduce.mjs reduction, written into the session's fold log, src/query/fold-log.mjs), whose rows, lane headers,
// events and records the answer ships (src/view/reduce.mjs skeletonDoc). No record is read but by extraction and, once per pair of diverging blocks, a break detail.
//
// WARM (D63 ①; 3.5 §缓存按依赖失效): per (fs, home, session, writer) the projection store stays open and the reduction state is kept,
// grown with the members the frontier passed since; it is let go (take(): the only reference dropped) before a reduction from
// scratch, so the heap never holds two. The serialized rows and lane headers of the last answered marks are kept (src/query/session-doc.mjs) for
// `--since`; any other member mark is reduced afresh for that answer only.
//
// THE CUT (3.5 §内存有界, a backstop): the reduction keeps SPINE_PER_ROW a row and SPINE_PER_BLOCK a distinct block of its store (the
// blocks reserved beside the steady caches); only when the rows past what the budget holds beside
// the work and the steady caches does it reduce the newest that fit, less one step, on a grid of steps (`truncated` says so). A
// reduction whose MEASURED heap passes what was reserved stops (HeapBound, checked per row folded) and the session is cut again
// by the rows it got through.
import nodeFs from 'node:fs';
import { reduction, skeletonOf, memoryLog, REDUCE_HEAP } from '../../view/reduce.mjs';
import { openFoldLog, foldLogFile, LOG_BYTES } from '../fold-log.mjs';
import { trocarHome } from '../../paths.mjs';
import { extractMembers, blockAt, CHUNK_STORED } from '../../view/extract.mjs';
import { compareStep } from '../../view/step-order.mjs';
import { recordsAt, STRETCH_HEAP } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { openProjection, posCmp, STORE_HEAP } from '../projection.mjs';
import { rowsKey, warmCache, fsTag, heapBudget, heapCeiling, hold, steadyBytes, liveHeap, usedHeap } from '../warm.mjs';
import { parseTextRef } from '../../raw/refs.mjs';
import { QueryArgError } from './index.mjs';
import { documentOf, serialOf, keep, legacyDeltaOf as deltaOf, legacyPageOf as pageOf, limitOf } from '../session-doc.mjs';

export const params = Object.freeze(['id', 'since', 'before', 'limit']);

/** What a session read keeps in the heap per call (the reduction's columns and its lanes' shares, the projection's row and shared
 *  value index, the plan's entry, the kept mark's digest), until a reduction of THIS session measured it (HeapBound below).
 *  Measured 2026-10-22 as what a cold read of a test/query/big-session.mjs live(0.48) session holds more than one of live(0.24),
 *  per call, after a forced GC, the objects each part dominates summed (a heap snapshot's dominator tree; the caches of K, the
 *  segment index rows and the blocks' columns left out): 633 B (the reduction state and its marks 346, the row and shared value
 *  index 203, the plan 84), × 1.25. */
export const SPINE_PER_ROW = 792;
/** What the reduction keeps in the heap per distinct block of the session (its store's slot, its block columns and interned keys:
 *  src/view/reduce.mjs, src/query/projection.mjs): 222 B measured (after a forced GC, in a heap of the worker's size) as what a
 *  read of a test/query/big-session.mjs live(0.004) session holds more with 1,500 fresh tool definitions a call than with none, per
 *  block more, × 1.25 (2026-10-22). */
export const SPINE_PER_BLOCK = 280;
// What extraction's work costs in the heap per stored byte of what it reads at once (CHUNK_STORED, src/view/extract.mjs).
const WORK_PER_STORED = 4;
// The cut moves by the rows 1/BOUND_STEPS of the budget holds, so a live session is not reduced from scratch on every new row.
const BOUND_STEPS = 10;
const STORES = 8;

const stepOrder = (a, b) => compareStep(a.ts, a.id, b.ts, b.id);
const calls = (rs) => rs.reduce((n, r) => n + (r.is_llm && !r.log_only ? 1 : 0), 0);
const stored = (rs) => rs.reduce((n, r) => n + (r.stored_bytes || 0), 0);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
/** What reducing `rows` costs besides its rows' spine, reserved before anything is read: a chunk being extracted and the largest
 *  row, rounded up to a power of two so a new largest row does not move the cut, and the read's shared caches (STRETCH_HEAP). */
export function working(rows) {
  let max = 1;
  for (const r of rows) max = Math.max(max, r.stored_bytes || 0);
  return (CHUNK_STORED + 2 ** Math.ceil(Math.log2(max))) * WORK_PER_STORED + STRETCH_HEAP;
}
/** The rows (in step order) a reduction reads: all while their spine fits the budget beside the work and the steady caches
 *  (`others`, counted in whole steps so their refreshes do not move it; the other caches give way), else the newest that do less
 *  one step, on a grid of steps → {read, bound (the document's `truncated`), room}. A step is the rows a tenth of the budget holds,
 *  at most a quarter of the rows that fit: the cut moves once a step and shows at least half of what fits (a session's index rows
 *  and blocks, never cut, can leave its spine less than two budget steps). */
function fitting(rows, perRow, others) {
  const stepBytes = heapBudget() / BOUND_STEPS;
  const room = heapBudget() - working(rows) - Math.ceil(others / stepBytes) * stepBytes;
  const n = Math.floor(room / perRow);
  if (rows.length <= n) return { read: rows, bound: null, room };
  const step = Math.max(1, Math.min(Math.floor(stepBytes / perRow), Math.floor(n / 4))), cap = Math.max(1, n - step);
  const read = rows.slice(Math.min(Math.ceil((rows.length - cap) / step) * step, rows.length - 1));
  return { read, room, bound: { shown: calls(read), total: calls(rows), kept_mb: mb(stored(read)), file_mb: mb(stored(rows)) } };
}
/** A reduction stopped by the MEASURED bound after `rows` rows. */
class HeapBound extends Error {
  constructor(rows) { super('the session reduction passed the heap ceiling'); this.rows = rows; }
}
// Per row folded: the live heap (a full collection) is looked at when the stored bytes folded since the last look reach `m.gap` (half
// of what is left of the reservation at WORK_PER_STORED a byte), by the members' stored bytes, never by the allocated heap, so two
// processes look at the same rows. What the reduction holds is what the heap grew by since it began (`m.base`, measured for a
// reduction from scratch, and kept by a state grown across requests), held against the whole reservation (`m.limit`) and the ceiling.
function bounded(m, rows, bytes) {
  const used = usedHeap();
  m.since += bytes;
  if (used <= heapCeiling() && (m.base == null || m.since < m.gap)) return;
  const live = liveHeap(), grew = live - (m.base || 0);
  if (live > heapCeiling() || (m.base != null && grew > m.limit - heapBudget() / BOUND_STEPS / 2)) throw new HeapBound(rows);
  m.since = 0; m.gap = (m.limit - grew) / 2 / WORK_PER_STORED;
}
// What a row of each session costs as a reduction of it measured (session key → bytes), at most PER_ROW_KEPT sessions.
const perRows = new Map();
const PER_ROW_KEPT = 64;

// The plan of a member list — its write order, what fits, by id — made once per list: indexRows hands back the same frozen array
// while no segment moved, so sessionGroups does too. Made again when a reduction measured the session's rows dearer.
const plans = new WeakMap();
// The store's distinct blocks are reserved beside the steady caches, in whole steps so the plan is made again only when a step is passed.
function planOf(members, k, blocks) {
  const perRow = perRows.get(k) || SPINE_PER_ROW, stepBytes = heapBudget() / BOUND_STEPS;
  const blockSteps = Math.ceil((blocks * SPINE_PER_BLOCK) / stepBytes);
  let p = plans.get(members);
  if (!p || p.perRow !== perRow || p.blockSteps !== blockSteps) {
    const { read, bound, room } = fitting([...members].sort(stepOrder), perRow, steadyBytes() + blockSteps * stepBytes);
    p = { perRow, blockSteps, read, bound, room, limit: room + working(read),
      byId: new Map(members.map((r) => [String(r.id), r])), order: members.map((r) => String(r.id)).sort(posCmp), key: rowsKey(members).id };
    plans.set(members, p);
  }
  return p;
}
const keyOf = ({ fs, home, writer }, id) => `${fsTag(fs)}\n${home}\n${id}\n${writer === true ? 'w' : 'r'}`;

// The segment index of THIS request, read once whether version() asked first (src/query/answers.mjs) or not.
async function indexed({ home, fs, once }) {
  if (once && once.index) return once.index;
  const errors = [], got = { rows: await indexRows({ home, fs, errors }), errors };
  if (once) once.index = got;
  return got;
}
// The projection store of a session, open across requests (the least recently used closed past STORES). What opening it said (a
// rebuild) stays with the store (`opened`) until the next answer of that session says it, whoever opened it: a background slice
// has no caller to tell.
const stores = new Map();
function storeOf(ctx, id, k) {
  let s = stores.get(k);
  if (s) { stores.delete(k); stores.set(k, s); return s; }
  const opened = [];
  s = openProjection({ home: ctx.home, fs: ctx.fs, key: id, write: ctx.writer === true, errors: opened });
  s.opened = opened;
  stores.set(k, s);
  for (const [kk, v] of stores) { if (stores.size <= STORES) break; stores.delete(kk); states.take(kk); v.close(); }
  return s;
}
// The extraction frontier: the largest member (write order) such that every member up to it has a row.
function frontierOf(store, order) {
  let f = null;
  for (const rid of order) { if (!store.rows.has(rid)) break; f = rid; }
  return f;
}

const states = warmCache({ cost: (v) => v.cost });
// The store's notes that are D38 records besides (4.3 盘满): the worker passes `ctx.persist`, which sends each to the daemon. The store
// says each once per episode, so one episode is one record.
const PERSISTED = new Set(['projection-write-failed']);
const persisted = (ctx, errors) => { if (ctx.persist) for (const e of errors) if (PERSISTED.has(e.code)) ctx.persist(e); };

/** extendSession(ctx, id, budgetMs) → whether members of the session are still without a row (3.5 后台抽取): one background slice of
 *  the query worker (`ctx.writer`), the members extracted in write order into the session's warm store until `budgetMs` is spent,
 *  the index read included. Nothing is reduced here; the next answer reduces what the frontier passed. */
export async function extendSession(ctx, id, budgetMs) {
  const t0 = performance.now();
  const members = sessionGroups((await indexed(ctx)).rows).get(String(id));
  if (!members) return false;
  const errors = [], store = storeOf(ctx, String(id), keyOf(ctx, id));
  const read = (rs) => recordsAt({ home: ctx.home, fs: ctx.fs, rows: rs.filter(Boolean), errors: [], remember: false });
  const ex = extractMembers({ store, members, recordsAt: read, sessionId: String(id), budgetMs: Math.max(1, budgetMs - (performance.now() - t0)), errors });
  persisted(ctx, errors);
  return ex.done < ex.total;
}

/** sessionState(ctx, id) → null (no such session) | {id, rows, store, mark, pending, truncated, doc, errors}: the session's members
 *  (`rows`, its index rows), its projection store, the extraction frontier `mark`, `pending: {done, total}` while members above it
 *  exist, the cut, and the reduced document at the mark (src/view/reduce.mjs; with `failed` for members ≤ mark that did not extract).
 *  `errors`: the index's problems and the store's notes. The reduction state stays warm for the next request. */
export async function sessionState(ctx, id) {
  const index = await indexed(ctx);
  const members = sessionGroups(index.rows).get(String(id));
  if (!members) return null;
  const errors = [...index.errors], k = keyOf(ctx, id), progress = ctx.progress || (() => {});
  const store = storeOf(ctx, String(id), k);
  errors.push(...store.opened.splice(0));
  // extraction errors are the member's own (its row says why, on every answer), not this request's
  const read = (rs) => { progress(); return recordsAt({ home: ctx.home, fs: ctx.fs, rows: rs.filter(Boolean), errors: [], remember: false }); };
  const ex = extractMembers({ store, members, recordsAt: read, sessionId: String(id), budgetMs: ctx.writer === true ? 50 : Infinity, errors });
  persisted(ctx, errors);
  const mark = ex.frontier;
  const last = planOf(members, k, store.defCount).order.at(-1);
  const pending = mark == null || posCmp(mark, last) < 0 ? { done: ex.done, total: ex.total } : null;
  const resolve = (ref) => {
    const row = planOf(members, k, store.defCount).byId.get(parseTextRef(ref).recordId);
    const rec = row && recordsAt({ home: ctx.home, fs: ctx.fs, rows: [row], errors: [], remember: false })[0];
    return rec ? blockAt(rec, ref) : null;
  };
  for (;;) {
    const plan = planOf(members, k, store.defCount);
    const want = plan.read.map((r) => String(r.id)).filter((rid) => mark != null && posCmp(rid, mark) <= 0);
    const box = { old: states.take(k) };
    const release = hold(working(plan.read));
    try {
      const st = grow(box, { ctx, id: String(id), store, plan, want, resolve, progress, errors });
      const doc = skeletonOf(st.R);
      // the document is built beside the state: past the ceiling, the session is cut as if its reduction had stopped here
      if (usedHeap() > heapCeiling() && liveHeap() > heapCeiling()) throw new HeapBound(st.R.members().length);
      states.get(k, st, () => st);
      return { id: String(id), rows: members, store, mark, pending, truncated: plan.bound, doc, R: st.R, errors, kept: st, plan, key: k };
    } catch (e) {
      if (!(e instanceof HeapBound)) throw e;
      // the measured bound: the rows the stopped reduction got through fill the room, never fewer than half those asked for, the
      // cost rounded up to a quarter power of two (3.5 §内存有界); the stopped state is garbage by now
      const fit = Math.max(e.rows, Math.floor(plan.read.length / 2)) - 1;
      if (fit < 1) throw new Error(`the heap holds no room for this session (${mb(heapCeiling())} MB ceiling)`);
      perRows.delete(k);
      perRows.set(k, 2 ** (Math.ceil(Math.log2(plan.room / fit) * 4) / 4));
      if (perRows.size > PER_ROW_KEPT) perRows.delete(perRows.keys().next().value);
    } finally { release(); }
  }
}
// What a kept state weighs: its rows and its store's blocks, the marks kept, the store's and the reduction's caches.
const costOf = (st, perRow) => st.n * perRow + st.store.defCount * SPINE_PER_BLOCK + st.markBytes + STORE_HEAP + REDUCE_HEAP + 2 * LOG_BYTES;
// A reduction from scratch writes a fold log from scratch (3.5 §内存有界: a cut that moves restarts the fold and its log): the
// worker's beside the projection (4.3 §4), the local path's in memory only.
function freshLog(ctx, id, store, errors) {
  if (ctx.writer !== true) return memoryLog(store);
  const home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs;
  try { fs.rmSync(foldLogFile(home, id), { force: true }); } catch { /* the open below cuts what it cannot read */ }
  return openFoldLog({ home, fs, key: id, write: true, projection: { id: store.id, bytes: store.bytes }, errors });
}
// The kept state grown with `want` when it holds no row the cut dropped and was made over this store, else a reduction from scratch
// (the old state's only reference, `box.old`, dropped first).
function grow(box, { ctx, id, store, plan, want, resolve, progress, errors }) {
  let st = box.old;
  box.old = null;
  // in the cut: at or after its first row in step order (the cut reads a suffix of the members in step order)
  const inCut = (rid) => { const r = plan.byId.get(rid); return !!r && stepOrder(r, plan.read[0]) >= 0; };
  if (st && !(st.store === store && st.perRow === plan.perRow && st.R.members().every(inCut))) { st.R.log.close(); st = null; }
  if (!st) {
    st = { base: liveHeap(), store, perRow: plan.perRow, n: 0, marks: new Map(), markBytes: 0, cost: 0, sink: [], hook: null, resolve: null };
    const s = st;
    s.R = reduction(store, { log: freshLog(ctx, id, store, s.sink), resolve: (ref) => s.resolve(ref), errors: s.sink, progress: (rid) => s.hook(rid) });
  }
  // a state grown across requests is held against the heap it began from (the extraction of a session read for the first time
  // grows it a slice at a time: no one reduction of it is from scratch)
  const meter = { base: st.base, since: 0, gap: 0, limit: plan.limit, n: st.n };
  st.resolve = resolve;
  st.hook = (rid) => { progress(); bounded(meter, ++meter.n, (plan.byId.get(rid) || {}).stored_bytes || 0); };
  const fresh = want.filter((rid) => !st.R.has(rid));
  if (fresh.length) { st.R.add(fresh); st.n += fresh.length; }
  errors.push(...st.sink.splice(0));
  st.cost = costOf(st, plan.perRow);
  return st;
}

/** version(ctx) → {key, errors} | null (3.5 §谁执行它 答案缓存): the session's member rows, its extraction frontier, the cut and
 *  the index's problems — the index rows and the projection's row keys only, never a record. null: no such session. */
export async function version(ctx) {
  const p = ctx.params;
  if (p.id == null || p.id === '') return null;
  const { rows, errors } = await indexed(ctx);
  const members = sessionGroups(rows).get(String(p.id));
  if (!members) return null;
  const k = keyOf(ctx, p.id), store = storeOf(ctx, String(p.id), k), plan = planOf(members, k, store.defCount);
  return { key: JSON.stringify([plan.key, frontierOf(store, plan.order), plan.bound]), errors };
}

const one = (v) => (v == null || v === '' ? null : String(v));
// The document at M: the kept one, else the reduction over the members of the cut with pos ≤ M, for this answer only.
function serialAt(st, M) {
  const hit = st.kept && st.kept.marks.get(M);
  if (hit) return hit;
  const want = st.plan.read.map((r) => String(r.id)).filter((rid) => posCmp(rid, M) <= 0 && st.store.rows.has(rid));
  const log = memoryLog(st.store), R = reduction(st.store, { log, resolve: st.kept ? st.kept.resolve : null, errors: [] });
  R.add(want);
  const doc = skeletonOf(R);
  log.close();
  return serialOf(documentOf({ ...st, doc }));
}

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), since = one(p.since), before = one(p.before);
  if (id == null) throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  if (since != null && before != null) throw new QueryArgError('trocar query session: --since and --before cannot be given together');
  const limit = limitOf(p.limit);
  const st = await sessionState(ctx, id);
  if (!st) {
    const idx = await indexed(ctx);
    errors.push(...idx.errors, { where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return { base: null, mark: null, truncated: null, more: false, meta: null, stats: null, logged: null, probes: null, lanes: [], calls: [], events: [], records: [] };
  }
  errors.push(...st.errors);
  const D = documentOf(st);
  errors.push(...D.errors);
  const head = { mark: st.mark, ...(st.pending ? { pending: st.pending } : null), truncated: st.truncated };
  const body = { meta: D.meta, stats: D.stats, logged: D.logged, probes: D.probes };
  const now = serialOf(D);
  const member = (rid) => st.plan.byId.has(rid);
  if (before != null && !(member(before) && now.rows.has(before))) throw new QueryArgError(`trocar query session: --before ${JSON.stringify(before)} is not a call of this session`);
  const known = since != null && member(since) && st.mark != null && posCmp(since, st.mark) <= 0;
  const out = { base: known ? since : null, ...head, ...(known ? null : { more: false }), ...body,
    ...(known ? deltaOf(D, now, serialAt(st, since)) : pageOf(D, now, before, limit)) };
  if (keep(st.kept, st.mark, now) && states.take(st.key) === st.kept) { st.kept.cost = costOf(st.kept, st.kept.perRow); states.get(st.key, st.kept, () => st.kept); }
  return out;
}
