// src/query/named/session.mjs — `trocar query session --id <id> [--since M | --before R] [--limit N]` (RFC 3.5 §会话读, 1.6 §4.1 / C.5).
//
// A session's skeleton from its context projection (src/query/projection.mjs) and its FOLD LOG (src/query/fold-log.mjs): the members
// (the segment index's rows of this session, src/query/rows.mjs) are extracted into the projection in write order (src/view/extract.mjs
// extractMembers) and the extracted ones folded in the same order (src/view/reduce.mjs reduction), which writes each call's row, its
// events, the lane headers, the items and the failures into the fold log. Every answer is read from the fold log at its last frontier
// (`mark` = the reduction frontier, 3.5 归约前沿) through src/query/session-doc.mjs. No record is read but by extraction and, once per
// pair of diverging blocks, a break detail.
//
// SLICES (3.5 后台抽取与归约): the worker (`ctx.writer`) extracts ≤ 50 ms and then folds ≤ 50 ms in a request; extendSession() does
// the same in background slices. A state from scratch opens the session's fold log and answers from it when it was folded under
// this plan's cut (its last frontier's `n`), without folding: the worker's background rebuilds the reduction into a throwaway log
// and takes the file log over at its frontier, writing nothing before that; the local path (no writer: the log opened write:false,
// new lines in an off-heap arena, nothing on disk) folds nothing when the log covers every member, else everything in the request.
// A log folded under another cut is folded again from scratch (the worker deletes and rewrites it; the local path in memory).
//
// WARM (D63 ①; 3.5 §缓存按依赖失效): per (fs, home, session, writer) the projection store stays open and the state (the reduction,
// its log, the step-order columns) is kept; it is let go (take(): the only reference dropped) before a state from scratch, so the heap
// never holds two. The reduction frontier of each session is kept for version().
//
// THE CUT (3.5 §内存有界, a backstop): the reduction keeps SPINE_PER_ROW a row and SPINE_PER_BLOCK a distinct block of its store (the
// blocks reserved beside the steady caches); only when the rows past what the budget holds beside
// the work and the steady caches does it reduce the newest that fit, less one step, on a grid of steps (`truncated` says so). A
// reduction whose MEASURED heap passes what was reserved stops (HeapBound, checked per row folded) and the session is cut again
// by the rows it got through; a cut that moves restarts the fold and its log.
import nodeFs from 'node:fs';
import { reduction, memoryLog, REDUCE_HEAP } from '../../view/reduce.mjs';
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
import { columns, dumpColumns, loadColumns, sync, viewOf, pageOf, deltaOf, limitOf, markOf } from '../session-doc.mjs';

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
  for (const [kk, v] of stores) { if (stores.size <= STORES) break; stores.delete(kk); const st = states.take(kk); if (st) closeState(st); frontiers.delete(kk); v.close(); }
  return s;
}

const states = warmCache({ cost: (v) => v.cost });
// session key → its reduction frontier (the mark its answers are at), as every new state and every fold slice leaves it: version().
const frontiers = new Map();
// The store's notes that are D38 records besides (4.3 盘满): the worker passes `ctx.persist`, which sends each to the daemon. The store
// says each once per episode, so one episode is one record.
const PERSISTED = new Set(['projection-write-failed']);
const persisted = (ctx, errors) => { if (ctx.persist) for (const e of errors) if (PERSISTED.has(e.code)) ctx.persist(e); };
// A request's slice of extraction and of folding (3.5 后台抽取与归约).
const SLICE_MS = 50;

// The log the reduction writes into, whose target can be swapped: a rebuild folds into a throwaway log and takes the file log over
// once it reaches the file log's frontier (the lines it would write there are the ones already written).
function relayOf(log) {
  const r = { cur: log };
  for (const k of ['append', 'latest', 'lane', 'read', 'versionAt', 'changedSince', 'frontierAt', 'close']) r[k] = (...a) => r.cur[k](...a);
  for (const k of ['frontier', 'bytes', 'items', 'failures']) Object.defineProperty(r, k, { get: () => r.cur[k] });
  return r;
}
const reductionOf = (s, log) => { s.relay = relayOf(log); return reduction(s.store, { log: s.relay, resolve: (ref) => s.resolve(ref), errors: s.sink, progress: (rid) => s.hook(rid) }); };
function closeState(s) { if (fileLogs.get(s.store) === s) fileLogs.delete(s.store); s.log.close(); if (s.T) s.T.close(); }
// store → the state that holds its fold log file open (the worker's)
const fileLogs = new WeakMap();
/** saveIndexes(): the sidecars (4.3 §4 旁索引) of every open store and its fold log whose file grew since its last save, the store's
 *  first (the log's sidecar names the projection's bytes), the log's with the state's step-order columns synced to its frontier.
 *  The worker calls it once an idle period; the local path's are never written (opened write:false). A sidecar that cannot be
 *  written is not one: the next open scans. */
export function saveIndexes() {
  for (const s of stores.values()) {
    try { s.saveIndex(); } catch { /* the next idle period */ }
    const st = fileLogs.get(s);
    try { if (st) st.log.saveIndex(dumpColumns(sync(st.cols, st.log))); } catch { /* the next idle period */ }
  }
}
const cutOf = (plan) => (plan.read.length ? String(plan.read[0].id) : null);
// Whether a fold log was folded under this plan's cut: its last frontier's `n` (the members folded) = the members of the cut up to
// its `f` that did not fail. A log folded under another cut would serve a reader that must cut a log folded uncut.
function foldedUnder(log, plan, f) {
  if (!plan.byId.has(f)) return false;
  let n = 0;
  for (const r of plan.read) { const rid = String(r.id); if (posCmp(rid, f) <= 0 && !log.failures.get(rid)) n++; }
  return n === log.read(log.frontier).n;
}
// A state from scratch: the session's fold log (the worker's file; the local path's opened write:false) when it was folded under this
// cut, answered at its frontier (`target`) with no reduction yet, its step-order columns seeded from the log's sidecar when they
// were synced at or before its frontier (sync() then reads only the lines past them); else a reduction from scratch into a fold log from scratch (3.5
// §内存有界: a cut that moves restarts the fold and its log), the worker's beside the projection (4.3 §4), the local path's in memory.
function stateOf(ctx, id, store, plan) {
  const s = { base: liveHeap(), store, perRow: plan.perRow, cut: cutOf(plan), n: 0, cost: 0, sink: [], hook: null, resolve: null,
    cols: columns(store.rows.slotOf), view: null, R: null, T: null, relay: null, target: null };
  const writer = ctx.writer === true, home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs;
  const open = () => openFoldLog({ home, fs, key: id, write: writer, projection: { id: store.id, bytes: store.bytes }, errors: s.sink });
  const log = open(), m = markOf(log);
  if (m != null && foldedUnder(log, plan, m)) {
    const c = log.saved && loadColumns(store.rows, log.saved.parts);
    if (c && c.at <= log.frontier) s.cols = c;
    s.log = log; s.target = m; if (writer) fileLogs.set(store, s);
    return s;
  }
  log.close();
  if (writer) {
    try { fs.rmSync(foldLogFile(home, id), { force: true }); } catch { /* the open below cuts what it cannot read */ }
    s.log = open();
  } else s.log = memoryLog(store);
  if (writer) fileLogs.set(store, s);
  s.R = reductionOf(s, s.log);
  return s;
}
// Fold the members of the cut up to the extraction frontier `F` for `ms`; a rebuild first up to the file log's frontier, then it
// takes the file log over and goes on.
function fold(s, plan, F, ms) {
  const t0 = performance.now();
  for (;;) {
    const upTo = s.target ?? F;
    if (upTo == null) return;
    if (!s.R) { s.T = memoryLog(s.store); s.R = reductionOf(s, s.T); }
    const want = [];
    for (const r of plan.read) { const rid = String(r.id); if (posCmp(rid, upTo) <= 0 && !s.R.has(rid) && s.store.rows.has(rid)) want.push(rid); }
    if (want.length) {
      const rest = s.R.add(want, { budgetMs: ms - (performance.now() - t0) });
      s.n += want.length - rest.length;
      if (rest.length) return;
    }
    if (s.target == null) return;
    s.relay.cur = s.log; s.T.close(); s.T = null; s.target = null;
  }
}
// The kept state grown when it was made over this store and cut (a state answering from its log: the same first row of the cut; a
// reduction: no row the cut dropped), else a state from scratch (the old state's only reference, `box.old`, dropped first). The
// worker's request folds nothing while a cold state is rebuilt (its background does); the local path folds when members lie past
// the log's frontier.
function grow(box, { ctx, id, store, plan, F, foldMs, request, resolve, progress, errors }) {
  let st = box.old;
  box.old = null;
  // in the cut: at or after its first row in step order (the cut reads a suffix of the members in step order)
  const inCut = (rid) => { const r = plan.byId.get(rid); return !!r && stepOrder(r, plan.read[0]) >= 0; };
  const same = st && st.store === store && st.perRow === plan.perRow && (st.target != null ? st.cut === cutOf(plan) : st.R.members().every(inCut));
  if (st && !same) { closeState(st); st = null; }
  if (!st) st = stateOf(ctx, id, store, plan);
  // a state grown across requests is held against the heap it began from
  const meter = { base: st.base, since: 0, gap: 0, limit: plan.limit, n: st.n };
  st.resolve = resolve;
  st.hook = (rid) => { progress(); bounded(meter, ++meter.n, (plan.byId.get(rid) || {}).stored_bytes || 0); };
  const past = () => plan.read.some((r) => posCmp(String(r.id), st.target) > 0 && store.rows.has(String(r.id)));
  const now = st.target == null || (ctx.writer === true ? !request : past());
  try { if (foldMs > 0 && now) fold(st, plan, F, foldMs); } catch (e) { closeState(st); throw e; }
  errors.push(...st.sink.splice(0));
  st.cost = costOf(st, plan.perRow);
  return st;
}
// What a kept state weighs: its calls and its store's blocks, the store's, the reduction's and the log's caches.
const costOf = (st, perRow) => Math.max(st.n, st.cols.order.length) * perRow + st.store.defCount * SPINE_PER_BLOCK + STORE_HEAP + REDUCE_HEAP + 2 * LOG_BYTES;

// One slice: extraction, then folding with what is left of `budgetMs` (a request: SLICE_MS of each; the local path: everything).
async function advance(ctx, id, { budgetMs, request }) {
  const t0 = performance.now(), index = await indexed(ctx);
  const members = sessionGroups(index.rows).get(id);
  if (!members) return null;
  const errors = [...index.errors], k = keyOf(ctx, id), progress = ctx.progress || (() => {});
  const store = storeOf(ctx, id, k);
  if (request) errors.push(...store.opened.splice(0));
  // extraction errors are the member's own (its row says why, on every answer), not this request's
  const read = (rs) => { progress(); return recordsAt({ home: ctx.home, fs: ctx.fs, rows: rs.filter(Boolean), errors: [], remember: false }); };
  const exErrors = [];
  const ex = extractMembers({ store, members, recordsAt: read, sessionId: id, budgetMs: request ? budgetMs : Math.max(1, budgetMs - (performance.now() - t0)), errors: exErrors });
  persisted(ctx, exErrors);
  errors.push(...exErrors);
  const foldMs = request ? budgetMs : budgetMs - (performance.now() - t0);
  const resolve = (ref) => {
    const row = planOf(members, k, store.defCount).byId.get(parseTextRef(ref).recordId);
    const rec = row && recordsAt({ home: ctx.home, fs: ctx.fs, rows: [row], errors: [], remember: false })[0];
    return rec ? blockAt(rec, ref) : null;
  };
  for (;;) {
    const plan = planOf(members, k, store.defCount);
    const box = { old: states.take(k) };
    const release = hold(working(plan.read));
    let st;
    try {
      st = grow(box, { ctx, id, store, plan, F: ex.frontier, foldMs, request, resolve, progress, errors });
      frontiers.set(k, markOf(st.log));
      if (usedHeap() > heapCeiling() && liveHeap() > heapCeiling()) { closeState(st); throw new HeapBound(st.n); }
    } catch (e) {
      if (!(e instanceof HeapBound)) throw e;
      // the measured bound: the rows the stopped fold got through fill the room, never fewer than half those asked for, the cost
      // rounded up to a quarter power of two (3.5 §内存有界); the stopped state is closed and garbage by now
      const fit = Math.max(e.rows, Math.floor(plan.read.length / 2)) - 1;
      if (fit < 1) throw new Error(`the heap holds no room for this session (${mb(heapCeiling())} MB ceiling)`);
      perRows.delete(k);
      perRows.set(k, 2 ** (Math.ceil(Math.log2(plan.room / fit) * 4) / 4));
      if (perRows.size > PER_ROW_KEPT) perRows.delete(perRows.keys().next().value);
      continue;
    } finally { release(); }
    states.get(k, st, () => st); // kept once the work's reservation is given back: the next slice grows it
    return { st, plan, members, ex, errors };
  }
}

/** extendSession(ctx, id, budgetMs) → whether the session still has members to extract or fold (3.5 后台抽取与归约): one background
 *  slice of the query worker (`ctx.writer`), the index read included: extraction in write order, then folding (or a cold state's
 *  rebuild) with what is left of `budgetMs`. */
export async function extendSession(ctx, id, budgetMs) {
  const r = await advance(ctx, String(id), { budgetMs, request: false });
  if (!r) return false;
  const { st, plan, ex } = r;
  return ex.done < ex.total || st.target != null || plan.read.some((row) => !st.R.has(String(row.id)));
}

/** sessionState(ctx, id) → null (no such session) | {id, rows, store, mark, pending, truncated, V, failed, errors, plan}: the
 *  session after this request's slice (the local path: everything), read from its fold log at the reduction frontier `mark` (V:
 *  src/query/session-doc.mjs viewOf, its columns synced to that frontier), `pending:
 *  {done, total}` while members are above the mark (`done` = the members at or below it), the cut. `errors`: the index's problems
 *  and the store's notes. The state stays warm. */
export async function sessionState(ctx, id) {
  const r = await advance(ctx, String(id), { budgetMs: ctx.writer === true ? SLICE_MS : Infinity, request: true });
  if (!r) return null;
  const { st, plan, members, ex, errors } = r, mark = markOf(st.log);
  if (!(st.view && st.view.f === st.log.frontier && st.view.members === members && st.view.plan === plan)) {
    st.view = null; // the old view let go before the new one is built
    st.view = { f: st.log.frontier, members, plan, V: viewOf({ id: String(id), log: st.log, cols: st.cols, members, plan, mark }) };
  }
  const V = st.view.V, at = (rid) => mark != null && posCmp(rid, mark) <= 0;
  const above = ex.done < ex.total || plan.read.some((row) => !at(String(row.id)));
  return { id: String(id), rows: members, store: st.store, mark, pending: above ? { done: members.filter((m) => at(String(m.id))).length, total: members.length } : null,
    truncated: plan.bound, V, failed: V.failed, errors, st, plan };
}

/** version(ctx) → {key, errors} | null (3.5 §谁执行它 答案缓存): the session's member rows, its reduction frontier as it is now, the
 *  cut and the index's problems — the index rows and a string, never a record. null: no such session. */
export async function version(ctx) {
  const p = ctx.params;
  if (p.id == null || p.id === '') return null;
  const { rows, errors } = await indexed(ctx);
  const members = sessionGroups(rows).get(String(p.id));
  if (!members) return null;
  const k = keyOf(ctx, p.id), store = storeOf(ctx, String(p.id), k), plan = planOf(members, k, store.defCount);
  return { key: JSON.stringify([plan.key, frontiers.get(k) ?? null, plan.bound]), errors };
}

const one = (v) => (v == null || v === '' ? null : String(v));
// The candidates and the log `--since M` is taken against: this log at M's frontier line (only what changed past it), else the
// members of the cut up to M folded into a throwaway log (every rid and lane of either log).
function thenOf(s, M) {
  const { st, plan } = s, off = st.log.frontierAt(M);
  if (off != null) return { then: { log: st.log, off, mark: M }, cands: st.log.changedSince(off), close: () => {} };
  const T = memoryLog(st.store), R = reduction(st.store, { log: T, resolve: st.resolve, errors: [] });
  R.add(plan.read.map((r) => String(r.id)).filter((rid) => posCmp(rid, M) <= 0 && st.store.rows.has(rid)));
  const a = T.changedSince(-1), b = st.log.changedSince(-1);
  return { then: { log: T, off: T.frontier ?? -1, mark: M }, cands: { rids: new Set([...a.rids, ...b.rids]), lanes: new Set([...a.lanes, ...b.lanes]) }, close: () => T.close() };
}

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), since = one(p.since), before = one(p.before);
  if (id == null) throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  if (since != null && before != null) throw new QueryArgError('trocar query session: --since and --before cannot be given together');
  const limit = limitOf(p.limit);
  const s = await sessionState(ctx, id);
  if (!s) {
    const idx = await indexed(ctx);
    errors.push(...idx.errors, { where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return { base: null, mark: null, truncated: null, more: false, meta: null, stats: null, logged: null, probes: null, lanes: [], calls: [], events: [], records: [] };
  }
  errors.push(...s.errors, ...s.failed.map((f) => ({ where: f.id, code: f.code, reason: f.reason })));
  const { V } = s;
  if (before != null && !V.has(before)) throw new QueryArgError(`trocar query session: --before ${JSON.stringify(before)} is not a call of this session`);
  const head = { mark: s.mark, ...(s.pending ? { pending: s.pending } : null), truncated: s.truncated };
  const body = { meta: V.meta, stats: V.stats, logged: V.logged, probes: V.probes };
  if (since != null && s.plan.byId.has(since) && s.mark != null && posCmp(since, s.mark) <= 0) {
    const { then, cands, close } = thenOf(s, since);
    try {
      const { unknown, ...d } = deltaOf(V, then, cands);
      return { base: since, ...head, ...body, ...(unknown !== undefined ? { unknown } : null), ...d };
    } finally { close(); }
  }
  const { more, ...page } = pageOf(V, before, limit);
  return { base: null, ...head, more, ...body, ...(V.unknown ? { unknown: V.unknown } : null), ...page };
}
