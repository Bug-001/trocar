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
// this plan's cut (its last frontier's `n`), without folding. When a member lies past that frontier the reduction is resumed from
// the state the log's sidecar holds (resumed(): over the log, or the worker's log cut back to what the state covers), else rebuilt
// into a throwaway log that takes the file log over at its frontier, writing nothing before that; the local path (no writer: the log
// opened write:false, new lines in an off-heap arena, nothing on disk) folds nothing when the log covers every member, else
// everything in the request. The worker saves the sidecars at idle, every max(256, n/8) calls folded and every CHECKPOINT_MS (sidecars()).
// A log folded under another cut is folded again from scratch (the worker deletes and rewrites it; the local path in memory).
//
// WARM (D63 ①; 3.5 §缓存按依赖失效): per (fs, home, session, writer) the projection store stays open and the state (the reduction,
// its log, the step-order columns) is kept; it is let go (take(): the only reference dropped) before a state from scratch, so the heap
// never holds two. The reduction frontier of each session is kept for version().
//
// THE CUT (3.5 §内存有界「截断只是兜底,按实测的堆截」, a backstop): the constants below are the design bound acceptance #11 measures,
// never a cut: a session is read whole until a fold of it in THIS process measured its live heap within half a step of the budget
// (HeapBound, checked per row folded); then it reads the newest rows that fold got through (at least half of those asked), less one
// step, on a grid of steps (`truncated` says so), and a cut that moves restarts the fold and its log. No room for one row, measured,
// is an error.
import nodeFs from 'node:fs';
import v8 from 'node:v8';
import { reduction, memoryLog, BlockUnread, REDUCE_HEAP, LEDGER_BYTES, REDUCE_V } from '../../view/reduce.mjs';
import { openFoldLog, LOG_BYTES } from '../fold-log.mjs';
import { trocarHome } from '../../paths.mjs';
import { extractMembers, extractSeed, blockAt, CHUNK_STORED, TAIL_HEAP, releaseTails } from '../../view/extract.mjs';
import { compareStep } from '../../view/step-order.mjs';
import { recordsAt, releaseDecoded, STRETCH_HEAP } from '../records.mjs';
import { indexRows, sessionGroups, sessionFacts } from '../rows.mjs';
import { openProjection, STORE_HEAP } from '../projection.mjs';
import { releaseParts } from '../line-file.mjs';
import { warmCache, fsTag, heapBudget, heapCeiling, hold, liveHeap, usedHeap, yieldCaches } from '../warm.mjs';
import { parseTextRef } from '../../raw/refs.mjs';
import { QueryArgError } from './index.mjs';
import { columns, dumpColumns, loadColumns, sync, viewOf, pageOf, deltaOf, limitOf, markOf } from '../session-doc.mjs';
import { filesAt, filesParts, forget, headDoc, headFile, packsOf, pendingHead, tier0Doc, writeFiles, writeHead, memoBytes, PACK_MEMBERS } from '../ctx-files.mjs';

export const params = Object.freeze(['id', 'since', 'before', 'limit', 'head']);

/** What a session read keeps in the heap per call (the reduction's columns and its lanes' shares, the projection's row and shared
 *  value index, the plan's entry, the kept mark's digest), until a reduction of THIS session measured it (HeapBound below).
 *  Measured 2026-10-22 as what a cold read of a test/query/big-session.mjs live(0.48) session holds more than one of live(0.24),
 *  per call, after a forced GC, the objects each part dominates summed (a heap snapshot's dominator tree; the caches of K, the
 *  segment index rows and the blocks' columns left out): 633 B (the reduction state and its marks 346, the row and shared value
 *  index 203, the plan 84), × 1.25. */
export const SPINE_PER_ROW = 792;
/** What the reduction keeps in the heap per distinct block of the session (its store's slot, its block columns and interned keys:
 *  src/view/reduce.mjs, src/query/projection.mjs): 222 B measured (after a forced GC, in a heap of the worker's size) as what a
 *  read of a test/query/big-session.mjs session holds more with 1,500 fresh tool definitions a call than with none, per block
 *  more, × 1.25 (2026-10-22, before K held the writer memo). Measured since between 750 and 1,500 fresh tool definitions a call,
 *  where K's byte-capped caches are full in both reads: 143–184 B (2026-10-29). */
export const SPINE_PER_BLOCK = 280;
/** What the plan keeps in the heap per member of the session, cut off or not (its member array's flyweight row with the cell the
 *  step-order sort decoded last, and its entry in the by-id map with the id's text): 209 B measured (2026-10-23, forced GC, a plan
 *  of a 20,000-member test/query/big-session.mjs session cut to 800 rows, in a 384 MB heap) × 1.25. Never cut: the plan holds every
 *  member (test/query/spine-heap.test.mjs). */
export const PLAN_PER_MEMBER = 260;
// What extraction's work costs in the heap per stored byte of what one append covers (CHUNK_STORED, src/view/extract.mjs).
const WORK_PER_STORED = 4;
// A step: 1/BOUND_STEPS of the budget for the measured bound, of the rows that fit for the cut, so a live session is not reduced from scratch on every new row.
const BOUND_STEPS = 10;
/** K (3.5 §内存有界): the fixed caches a session read fills and keeps beside its spine, each a byte cap of its own module (the store's
 *  rows and shared values, the reduction's lists and facts, the fold log's lines, the lane ledgers, extraction's lane tails, the answer files' writer memo), never given way to the ledger. */
export const CACHES = STORE_HEAP + REDUCE_HEAP + 2 * LOG_BYTES + LEDGER_BYTES + TAIL_HEAP + memoBytes();
const STORES = 8;

const stepOrder = (a, b) => compareStep(a.ts, a.id, b.ts, b.id);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
// the calls, stored bytes and largest stored bytes of some rows, added to one at a time
const sums = () => ({ n: 0, calls: 0, stored: 0, max: 1 });
const sum = (a, r) => { a.n++; a.calls += r.is_llm && !r.log_only ? 1 : 0; a.stored += r.stored_bytes || 0; a.max = Math.max(a.max, r.stored_bytes || 0); };
const workOf = (max) => (CHUNK_STORED + 2 ** Math.ceil(Math.log2(max))) * WORK_PER_STORED + STRETCH_HEAP;
/** What reducing `rows` costs besides its rows' spine, reserved before anything is read: a chunk being extracted (held until its append) and the largest
 *  row, rounded up to a power of two so a new largest row does not move the cut, and the read's shared caches (STRETCH_HEAP). */
export function working(rows) {
  const a = sums();
  for (const r of rows) sum(a, r);
  return workOf(a.max);
}
/** A reduction stopped by the MEASURED bound after `rows` rows. */
class HeapBound extends Error {
  constructor(rows) { super('the session reduction passed the heap ceiling'); this.rows = rows; }
}
// Per row folded: the live heap (a full collection) is looked at when the stored bytes folded since the last look reach `m.gap` (half
// of what is left of the budget at WORK_PER_STORED a byte), by the members' stored bytes, never by the allocated heap, so two
// processes look at the same rows. The fold stops when the live heap comes within half a step of the budget or passes the ceiling.
// What the reduction holds (`m.held`, its weight in the shared ledger: costOf) is what the heap grew by since it began (`m.base`,
// measured for a state from scratch, and kept by a state grown across requests).
function bounded(m, rows, bytes) {
  m.since += bytes;
  if (usedHeap() <= heapCeiling() && m.since < m.gap) return;
  const line = heapBudget() - heapBudget() / BOUND_STEPS / 2;
  let live = liveHeap();
  if (live > line) { yieldCaches(); live = liveHeap(); } // every other kept entry but the steady ones gives way before this fold is cut
  m.held = live - m.base;
  if (live > line || live > heapCeiling()) throw new HeapBound(rows);
  m.since = 0; m.gap = (line - live) / 2 / WORK_PER_STORED;
}
// The rows of each session a fold of it measured to fit (session key → rows), at most FITS_KEPT sessions.
const fits = new Map();
const FITS_KEPT = 64;

// THE PLAN of a session's member list, kept with its store (`store.plan`): the members by id, their facts (src/query/rows.mjs
// sessionFacts), the version key, the cut, the extraction cursor `ex` and the write-order column `pos`. A member's place in write order
// is its place in the list (indexRows: segments in segmentCmp order, lines in order; sessionGroups keeps it), so `pos` maps a row's
// slot in the projection to that place (-1: none yet), filled as the cursor passes members with rows. A list that extends the last
// one (its first member and the last one's last member at the same places) extends the plan by its new members; any other (a segment
// indexed again, a store opened again) makes it afresh. So a slice and an answer cost by the new members (3.5 后台抽取与归约).
// Exported for test/query/cut-grows.test.mjs, which grows a plan without records.
export function planOf(members, k, store, id, fit = fits.get(k) ?? Infinity) {
  let p = store.plan;
  if (p && p.members === members && p.n === members.length && p.fit === fit) return p;
  const n0 = p ? p.n : 0; // a member array grows in place (rows.mjs sessionGroups): the plan counts what it took
  if (!p || n0 > members.length || String(members[0].id) !== p.first || String(members[n0 - 1].id) !== p.last) {
    p = store.plan = { store, members: [], first: String(members[0].id), last: null, all: sums(), byId: new Map(), facts: sessionFacts(String(id)),
      ex: 0, pos: new Int32Array(0), gen: 0, start: -1, read: [], shown: null };
  }
  const added = members.slice(p.n || 0);
  for (const r of added) { p.byId.set(String(r.id), r); sum(p.all, r); p.facts.add(r); }
  p.members = members; p.n = members.length; p.last = String(members[members.length - 1].id);
  p.key = `${p.all.n}:${p.first}:${p.last}:${p.all.stored + p.all.n}`;
  cut(p, fit, added);
  p.gen++;
  return p;
}
/** The rows (in step order) a reduction reads: all until a fold of this session measured `fit` rows to fit (3.5 §内存有界), else the
 *  newest `fit` less one step, on a grid of steps → p.read, p.bound (the document's `truncated`). A step is a tenth of the rows that
 *  fit, rounded down to a power of two (the grids nest). The cut only moves forward, and stays while it shows the fit less two steps,
 *  so a finer grid does not refold: a cut session shows at least half of what fits. While the cut's first place stays and the new
 *  rows sort after its first row, they are put into the kept order. */
function cut(p, fit, added) {
  const a = p.all, n = fit;
  let start = 0;
  if (a.n > n) {
    const step = 2 ** Math.floor(Math.log2(Math.max(1, n / BOUND_STEPS))), cap = n - step;
    start = Math.min(Math.ceil((a.n - cap) / step) * step, a.n - 1);
    if (p.start > start && a.n - p.start >= cap - step) start = p.start;
  }
  if (start === p.start && (start === 0 || added.every((r) => stepOrder(r, p.read[0]) > 0))) for (const r of added) { placeIn(p.read, r); sum(p.shown, r); }
  else {
    p.read = [...p.members].sort(stepOrder).slice(start);
    p.shown = sums();
    for (const r of p.read) sum(p.shown, r);
  }
  Object.assign(p, { start, fit, work: workOf(p.shown.max),
    bound: start ? { shown: p.shown.calls, total: a.calls, kept_mb: mb(p.shown.stored), file_mb: mb(a.stored) } : null });
}
// `r` put into `read` (in step order) after the rows it does not sort before, searched from the end: a new row lands near the end
function placeIn(read, r) {
  let lo = read.length - 1, hi = read.length;
  for (let d = 1; lo >= 0 && stepOrder(read[lo], r) > 0; d *= 2) { hi = lo; lo -= d; }
  for (lo = Math.max(lo + 1, 0); lo < hi;) { const m = (lo + hi) >> 1; if (stepOrder(read[m], r) > 0) hi = m; else lo = m + 1; }
  read.splice(lo, 0, r);
}
// the extraction cursor moved to `to`: the members it passed (each with a row) get their place in `pos`
function passed(p, to) {
  for (; p.ex < to; p.ex++) {
    const s = p.store.rows.slotOf(String(p.members[p.ex].id));
    if (s >= p.pos.length) { const g = new Int32Array(Math.max(256, 2 * (s + 1))).fill(-1); g.set(p.pos); p.pos = g; }
    p.pos[s] = p.ex;
  }
}
/** posOf(p, rid) → the member's place in write order (its place in the list), -1 when it is no member. */
function posOf(p, rid) {
  const s = p.store.rows.slotOf(rid);
  if (s !== undefined && s < p.pos.length && p.pos[s] >= 0) return p.pos[s];
  return p.byId.has(rid) ? p.members.findIndex((r) => String(r.id) === rid) : -1; // a member past the extraction cursor
}
// in the cut: at or after its first row in step order (the cut reads a suffix of the members in step order)
const inCut = (p, r) => p.start === 0 || stepOrder(r, p.read[0]) >= 0;
const keyOf = ({ fs, home, writer }, id) => `${fsTag(fs)}\n${home}\n${id}\n${writer === true ? 'w' : 'r'}`;

// The segment index of THIS request, read once whether version() asked first (src/query/answers.mjs) or not; the worker's
// background reads it through here too, once per kick (src/query/worker.mjs kickedSessions).
export async function indexed({ home, fs, once, progress }) {
  if (once && once.index) return once.index;
  const errors = [], got = { rows: await indexRows({ home, fs, errors, progress }), errors };
  if (once) once.index = got;
  return got;
}
// A hand-off lets the read-only store go: the worker writes the members it lacks, which a store opened before cannot see.
function letGo(k, e) { closeStore(k); return e; }
/** openSessions() → the ids of the sessions whose projection store is open here (and with it any fold log of theirs): the GC never
 *  deletes their directories (4.3 §4 回收), whoever opened them. */
export const openSessions = () => [...stores.values()].map((s) => s.session);
// Every store closes here (a hand-off, the eviction past STORES): its reduction state with it, and its `work` stays with the worker.
function closeStore(k) { const s = stores.get(k), st = states.take(k); if (st) closeState(st); stores.delete(k); frontiers.delete(k); if (s) { works.set(k, s.work); s.close(); } }
/** again(ctx, id, f) → f(), and f() once more when it threw ELINEPART (line-file.mjs: a part first decoded after the open, which
 *  a sidecar lets skip the scan, did not decode): the session's warm store and its state (fold log, reduction) are let go first,
 *  so the second opens them again and rebuilds that line file with its projection-rebuilt note (4.3 §4 分片). Any other error is
 *  thrown as it is. In the same request: the next one would do the same rebuild, and this answer already says it. */
export async function again(ctx, id, f) {
  try { return await f(); } catch (e) {
    if (!e || e.code !== 'ELINEPART' || id == null) throw e;
    closeStore(keyOf(ctx, String(id))); lagging.delete(String(id));
    return f();
  }
}
// session key → `pending.work` (3.5 §会话读): the members extracted and handed to a reduction for it in this worker, across its store's
// close and reopen, so it only grows while the worker lives (3.5:43). One number per session the worker opened.
const works = new Map();
// The projection store of a session, open across requests (the least recently used closed past STORES). What opening it said (a
// rebuild) stays with the store (`opened`) until the next answer of that session says it, whoever opened it: a background slice
// has no caller to tell.
const stores = new Map();
function storeOf(ctx, id, k) {
  let s = stores.get(k);
  if (s) { stores.delete(k); stores.set(k, s); return s; }
  const opened = [];
  s = openProjection({ home: ctx.home, fs: ctx.fs, key: id, write: ctx.writer === true, errors: opened });
  s.opened = opened; s.session = id;
  s.work = works.get(k) || 0; // `pending.work`, counted on the open store and kept by closeStore
  stores.set(k, s);
  for (const kk of stores.keys()) { if (stores.size <= STORES) break; closeStore(kk); }
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
// A rebuild up to the file log's frontier (`s.target`) keeps the members that log has failed failed (3.5 §读不全不静默).
const reductionOf = (s, log, from = null) => {
  s.relay = relayOf(log);
  const file = s.target != null ? s.log : null;
  const failedBefore = file && ((rid) => { const at = file.failures.get(rid); return at ? file.peek(...at) : null; });
  return reduction(s.store, { log: s.relay, resolve: (ref) => s.resolve(ref), errors: s.sink, progress: (rid) => s.hook(rid), failedBefore, from });
};
function closeState(s) { if (fileLogs.get(s.store) === s) fileLogs.delete(s.store); s.log.close(); if (s.T) s.T.close(); }
// store → the state that holds its fold log file open (the worker's)
const fileLogs = new WeakMap();
/** saveIndexes(deadline = Infinity) → whether parts are left to seal (sealParts): the sidecars (4.3 §4 旁索引) of every open store
 *  and its fold log whose file grew since its last save (sidecars()), then the heads a slice left behind (headAt), then the parts.
 *  The worker calls it once an idle period; the local path's are never written (opened write:false). The decoded frames and lines of
 *  the sealed segments are let go too: an idle worker does not hold them (3.5 §冷路径). */
export function saveIndexes(deadline = Infinity) {
  releaseDecoded();
  releaseTails();
  for (const s of stores.values()) sidecars(s);
  // then the heads behind their session's state (headAt): the checkpoint first; one that failed is written by the next slice
  for (const { s, home, fs } of lagging.values()) putHead({ home, fs }, s);
  lagging.clear();
  return sealParts(deadline);
}
/** sealParts(deadline = Infinity) → whether parts are left to seal at `deadline` (a performance.now() time): every open projection's
 *  and fold log's settled tail sealed into parts (4.3 §4 分片), a frame a unit; the worker goes on in its next idle slice (3.5
 *  后台抽取与归约). A seal that fails is tried at the next idle period. */
export function sealParts(deadline = Infinity) {
  for (const s of stores.values()) {
    for (const lf of [s, fileLogs.get(s)?.log]) {
      let r = false;
      try { r = lf ? lf.seal({ deadline }) : false; } catch { /* the next idle period */ }
      if (r === null || (r && performance.now() >= deadline)) return true;
    }
  }
  releaseParts();
  return false;
}
// The store's sidecar first (the log's names the projection's bytes); then, when it covers every line of the store (none while the
// store holds `t` rows: an open cuts them off, and the state's rows with them), the fold log's: the state's step-order columns synced to
// its frontier and, when the state is a live reduction writing into this file log (never a rebuild's, before it takes the log over),
// that reduction's state (`r.s`, v8.serialize of R.snapshot()) and what it was folded under (`r.m`: REDUCE_V, the cut). Between adds
// the log ends at the frontier line the sidecar covers to, so the state is the one the sidecar's indexes describe. A sidecar that
// cannot be written is not one: the next open scans, the next fold rebuilds.
function sidecars(store) {
  try { if (!store.indexed) store.saveIndex(extractSeed(store)); } catch { /* the next idle period */ }
  const st = fileLogs.get(store);
  if (!st || !store.indexed) return;
  try {
    const live = st.R && st.target == null && st.relay.cur === st.log;
    st.log.saveIndex([...dumpColumns(sync(st.cols, st.log)),
      ...(live ? [['r.s', v8.serialize(st.R.snapshot())], ['r.m', [JSON.stringify({ rv: REDUCE_V, cut: st.cut })]]] : []),
      ...filesParts(st.log)], filesAt(st.log)); // where the answer files stand (ctx-files.mjs writeFiles)
  } catch { /* the next idle period */ }
  st.saved = st.n; st.savedAt = performance.now();
}
// During a fold the worker saves both sidecars once it folded max(SAVE_MIN, folded / SAVE_PART) calls since the last save: a worker
// killed in a long fold resumes near where it was, and the saves of a first fold write O(n log n) bytes, not O(n²) (4.3 §4 旁索引).
// And once CHECKPOINT_MS passed since the last save, whatever was folded: a kill loses at most that much of a slow fold (3.5
// 后台抽取与归约). A save writes the whole reduction state, so at most once a minute it is a small part of the fold's own work.
// TROCAR_CHECKPOINT_MS, read once, shortens it for a test.
const SAVE_MIN = 256, SAVE_PART = 8, CHECKPOINT_MS = Number(process.env.TROCAR_CHECKPOINT_MS) || 60_000;
const cutOf = (plan) => (plan.start ? String(plan.read[0].id) : null);
/** markOn(plan, rid) → the mark on the wire (3.5 id): the frontier rid, and when the plan is cut `@` and its cut's first rid, so a
 *  mark names the cut its document was answered under. sinceAt(plan, M) → the rid M names when its cut is this plan's, else null:
 *  a document under another cut has members the cut's move let in or out that no delta carries (3.5 #19), so M is not known. */
export const markOn = (plan, rid) => (rid == null || !cutOf(plan) ? rid : `${rid}@${cutOf(plan)}`);
export function sinceAt(plan, M) {
  const i = M.indexOf('@');
  return (i < 0 ? null : M.slice(i + 1)) === cutOf(plan) ? (i < 0 ? M : M.slice(0, i)) : null;
}
// Whether a fold log was folded under this plan's cut: its last frontier's `n` (the members folded) = the members of the cut up to
// its `f` that did not fail. A log folded under another cut would serve a reader that must cut a log folded uncut.
function foldedUnder(log, plan, f) {
  if (!plan.byId.has(f)) return false;
  let n = 0;
  for (let i = 0, to = posOf(plan, f); i <= to; i++) { const r = plan.members[i]; if (inCut(plan, r) && !log.failures.get(String(r.id))) n++; }
  return n === log.read(log.frontier).n;
}
// A state from scratch: the session's fold log (the worker's file; the local path's opened write:false) when it was folded under this
// cut, answered at its frontier (`target`) with no reduction yet, its step-order columns seeded from the log's sidecar when they
// were synced at or before its frontier (sync() then reads only the lines past them); else a reduction from scratch into a fold log from scratch (3.5
// §内存有界: a cut that moves restarts the fold and its log), the worker's beside the projection (4.3 §4), the local path's in memory.
function stateOf(ctx, id, store, plan) {
  const writer = ctx.writer === true, home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs;
  const open = (upTo) => openFoldLog({ home, fs, key: id, write: writer, projection: { id: store.id, bytes: store.bytes }, errors: s.sink, upTo });
  const s = { base: liveHeap(), meter: null, store, cut: cutOf(plan), n: 0, cost: 0, sink: [], hook: null, resolve: null,
    cols: columns(store.rows.slotOf), view: null, R: null, T: null, relay: null, target: null, fc: 0, fp: null, writer, open, saved: 0, savedAt: performance.now() };
  const log = open(), m = markOf(log);
  if (m != null && foldedUnder(log, plan, m)) {
    s.log = log; s.target = m; seed(s);
    if (writer) fileLogs.set(store, s);
    return s;
  }
  if (writer) log.remove(); // every file of it (4.3 §4 分片)
  log.close();
  s.log = writer ? open() : memoryLog(store);
  if (writer) fileLogs.set(store, s);
  s.R = reductionOf(s, s.log);
  return s;
}
// the state's step-order columns from its log's sidecar when they were synced at or before its frontier (sync() then reads only the
// lines past them), else from scratch
function seed(s) {
  const sv = s.log.saved, c = sv && loadColumns(s.store.rows, sv.parts);
  s.cols = c && c.at <= s.log.frontier ? c : columns(s.store.rows.slotOf);
}
// v8.deserialize, every typed array in its own bytes: the default makes an aligned one a view over the whole serialized state, which
// would stay alive (as large as the state itself) for as long as the reduction holds that array.
function thaw(buf) {
  const d = new v8.DefaultDeserializer(buf);
  d._readHostObject = function () { const v = v8.DefaultDeserializer.prototype._readHostObject.call(this); return Buffer.isBuffer(v) ? Buffer.from(v) : new v.constructor(v); };
  d.readHeader();
  return d.readValue();
}
// A cold state's reduction resumed from the state its log's sidecar holds (4.3 §4 旁索引) when it was folded under this cut and
// REDUCE_V: it covers the log's last frontier → over the log as it is; it covers less (a worker killed after a save) and this is the
// worker → over the log opened again cut back to what it covers. The members it folded are `R.has`, so the fold cursor walks past
// them. Else false (the local path's log past it, a mismatch, a state that does not read back or is not of this store): the caller
// rebuilds up to the log's frontier (`target`), as without one.
function resumed(s) {
  const sv = s.log.saved, meta = sv && sv.parts['r.m'], state = sv && sv.parts['r.s'];
  if (sv) delete sv.parts['r.s']; // read once here, whether taken or not: not held while the state lives
  if (!meta || !(state instanceof Uint8Array)) return false;
  let from;
  try {
    const m = JSON.parse(meta[0]);
    if (m.rv !== REDUCE_V || m.cut !== s.cut) return false;
    from = thaw(state);
  } catch { return false; }
  if (!(sv.bytes > s.log.frontier)) {
    if (!s.writer) return false;
    s.log.close(); s.log = s.open(sv.bytes); seed(s); s.view = null; s.target = markOf(s.log);
    if (s.log.saved) delete s.log.saved.parts['r.s'];
    if (s.log.bytes !== sv.bytes) return false;
  }
  const target = s.target;
  s.target = null;
  try { s.R = reductionOf(s, s.log, from); } catch { s.target = target; return false; }
  s.n = s.saved = from.n; s.fc = 0;
  if (s.meter) s.meter.n = s.n;
  return true;
}
// Fold the members of the cut before the extraction cursor `F` for `ms`, in write order from the fold cursor `fc` (the first member
// not yet handed to the reduction, by the plan `fp` it was walked under: another plan walks again from the start); a rebuild first up
// to the file log's frontier, then it takes the file log over and goes on. Handed BATCH at a time, so a slice's work is by what it folds.
const BATCH = 256;
function fold(s, plan, F, ms) {
  const t0 = performance.now();
  if (s.fp !== plan) { s.fp = plan; s.fc = 0; }
  if (!s.R && !resumed(s)) { s.T = s.target != null ? memoryLog(s.store) : null; s.R = reductionOf(s, s.T || s.log); s.fc = 0; }
  for (let added = false; ;) {
    const to = s.target != null ? posOf(plan, s.target) + 1 : F, end = Math.min(to, F);
    while (s.fc < end) {
      if (added && performance.now() - t0 >= ms) return;
      const want = [];
      for (; s.fc < end && want.length < BATCH; s.fc++) { const r = plan.members[s.fc], rid = String(r.id); if (inCut(plan, r) && !s.R.has(rid)) want.push(rid); }
      if (!want.length) continue;
      const rest = s.R.add(want, { budgetMs: ms - (performance.now() - t0) });
      s.n += want.length - rest.length; s.store.work += want.length - rest.length; added = true;
      if (s.writer && s.target == null && (s.n - s.saved >= Math.max(SAVE_MIN, s.n / SAVE_PART) || performance.now() - s.savedAt >= CHECKPOINT_MS)) sidecars(s.store);
      if (rest.length) { s.fc = posOf(plan, rest[0]); return; }
    }
    if (s.target == null || end < to) return;
    s.relay.cur = s.log; s.T.close(); s.T = null; s.target = null;
  }
}
// Whether a member of the cut extracted (before `F`) lies past the log's frontier `target`: only then is a cold state rebuilt.
const pastOf = (plan, target, F) => { for (let i = posOf(plan, target) + 1; i < F; i++) if (inCut(plan, plan.members[i])) return true; return false; };
// The kept state grown when it was made over this store and cut (a state answering from its log: the same first row of the cut; a
// reduction: no row the cut dropped), else a state from scratch (the old state's only reference, `box.old`, dropped first). A cold
// state is rebuilt only when a member of the cut lies past the log's frontier (an unchanged session is answered from its log), and
// never in the worker's request (its background does); the local path rebuilds in the request.
function grow(box, { ctx, id, store, plan, F, foldMs, request, resolve, progress, errors }) {
  let st = box.old;
  box.old = null;
  const same = st && st.store === store && st.cut === cutOf(plan);
  if (st && !same) { closeState(st); st = null; }
  if (!st) st = stateOf(ctx, id, store, plan);
  // a state grown across requests is held against the heap it began from; its meter is kept with it, so the live heap is looked at
  // by the stored bytes folded since the last look across slices, not once per slice
  const meter = Object.assign(st.meter ||= { base: st.base, since: 0, gap: 0, held: null }, { n: st.n });
  st.resolve = resolve;
  st.hook = (rid) => { progress(); bounded(meter, ++meter.n, (plan.byId.get(rid) || {}).stored_bytes || 0); };
  const now = st.target == null || (!(ctx.writer === true && request) && pastOf(plan, st.target, F));
  try {
    if (foldMs > 0 && now && ctx.handOff && ctx.writer !== true && (st.target != null || unfolded(st, plan, F))) throw new HandOff(id);
    if (foldMs > 0 && now) fold(st, plan, F, foldMs);
  } catch (e) { closeState(st); throw e; }
  errors.push(...st.sink.splice(0));
  if (st.meter.held == null) st.meter.held = liveHeap() - st.base; // a state just made: what it holds, measured once
  st.cost = costOf(st);
  return st;
}
// Whether a reduction (target null) has a member of the cut before `F` still to take.
const unfolded = (st, plan, F) => { for (let i = st.fp === plan ? st.fc : 0; i < F; i++) { const r = plan.members[i]; if (inCut(plan, r) && !st.R.has(String(r.id))) return true; } return false; };
/** Thrown on the local path when `ctx.handOff` is set and this read would extract or fold a member (3.5 §谁执行它): the caller asks
 *  the daemon's worker, which is building it, instead of building it a second time beside it. */
export class HandOff extends Error {
  constructor(id) { super(`session ${id}: its projection or fold log does not cover every member yet`); this.name = 'HandOff'; this.code = 'hand-off'; }
}
// What a kept state weighs in the shared ledger: the heap it was measured to hold (3.5 §内存有界: never an estimate past the budget,
// which would leave it unkept and rebuilt from scratch every slice).
const costOf = (st) => Math.max(0, st.meter.held);

// One slice: extraction, then folding (a request: SLICE_MS of each; a background slice: half of `budgetMs` each, the fold also what
// extraction left; the local path: everything).
async function advance(ctx, id, { budgetMs, request }) {
  const t0 = performance.now(), index = await indexed(ctx);
  const members = sessionGroups(index.rows).get(id);
  if (!members) return null;
  const errors = [...index.errors], k = keyOf(ctx, id), progress = ctx.progress || (() => {});
  const store = storeOf(ctx, id, k);
  if (request) errors.push(...store.opened.splice(0));
  // extraction errors are the member's own (its row says why, on every answer), not this request's
  const read = (rs) => { progress(); return recordsAt({ home: ctx.home, fs: ctx.fs, rows: rs.filter(Boolean), errors: [], remember: false }); };
  const exErrors = [], from = planOf(members, k, store, id).ex, had = store.rows.size;
  if (ctx.handOff && ctx.writer !== true) for (let i = from; i < members.length; i++) if (!store.rows.has(String(members[i].id))) throw letGo(k, new HandOff(id));
  const ex = extractMembers({ store, members, recordsAt: read, sessionId: id, budgetMs: request ? budgetMs : Math.max(1, budgetMs / 2 - (performance.now() - t0)), errors: exErrors, from });
  passed(planOf(members, k, store, id), ex.done);
  store.work += store.rows.size - had;
  persisted(ctx, exErrors);
  errors.push(...exErrors);
  // a background slice: extraction has half of it, the fold at least the other half, so the frontier moves from the first slice
  const foldMs = request ? budgetMs : Math.max(budgetMs / 2, budgetMs - (performance.now() - t0));
  // a block's text read back for a cache-break detail, or BlockUnread with a BLOCK_PROBLEMS code; a definition's ref names a record
  // this store extracted (a stitched block's too: extraction stitches from the store's own rows), so a member's
  // within the slice the records read back stay by id, their stored bytes at most CHUNK_STORED, the least recently used first out
  // (a break's two blocks and the lane's next break read one record once); let go when the slice's fold ends
  const kept = new Map();
  let keptBytes = 0, keeping = true;
  const resolve = (ref) => {
    const rid = parseTextRef(ref).recordId, row = planOf(members, k, store, id).byId.get(rid);
    if (!row) throw new BlockUnread('record-missing', `no member of this session is record ${rid}`);
    let e = kept.get(rid);
    if (e) kept.delete(rid);
    else {
      const errs = [], rec = recordsAt({ home: ctx.home, fs: ctx.fs, rows: [row], errors: errs, remember: false })[0];
      if (!rec) throw new BlockUnread('record-unreadable', `record ${rid} could not be read back: ${errs.map((x) => x.reason).join('; ') || 'no record'}`);
      e = { rec, bytes: row.stored_bytes || 0 };
      keptBytes += e.bytes;
      for (const [old, o] of kept) { if (keptBytes <= CHUNK_STORED) break; kept.delete(old); keptBytes -= o.bytes; }
    }
    if (keeping) kept.set(rid, e); else keptBytes = 0;
    const rec = e.rec, b = blockAt(rec, ref);
    if (!b) throw new BlockUnread('field-missing', `record ${rid} has no block at ${ref}`);
    return b;
  };
  for (;;) {
    keeping = true; // a HeapBound retry keeps what it reads again
    const plan = planOf(members, k, store, id);
    lagging.delete(String(id)); // its state holds the old one: let go before this one grows (headAt keeps the new one)
    const box = { old: states.take(k) };
    const release = hold(plan.work);
    let st;
    try {
      st = grow(box, { ctx, id, store, plan, F: ex.done, foldMs, request, resolve, progress, errors });
      frontiers.set(k, markOf(st.log));
      if (usedHeap() > heapCeiling() && liveHeap() > heapCeiling()) { closeState(st); throw new HeapBound(st.n); }
    } catch (e) {
      if (e instanceof HandOff) throw letGo(k, e);
      if (!(e instanceof HeapBound)) throw e;
      // the measured bound: the rows the stopped fold got through are the rows that fit, never fewer than half those asked for,
      // rounded down to a quarter power of two (3.5 §内存有界); the stopped state is closed and garbage by now
      const got = Math.max(e.rows, Math.floor(plan.read.length / 2)) - 1, fit = got < 1 ? 0 : Math.floor(2 ** (Math.floor(Math.log2(got) * 4) / 4));
      if (fit < 1) throw Object.assign(new Error(`the heap holds no room for this session (${mb(heapBudget())} MB budget)`), { code: 'heap-no-room' });
      fits.delete(k);
      fits.set(k, fit);
      if (fits.size > FITS_KEPT) fits.delete(fits.keys().next().value);
      continue;
    } finally { release(); kept.clear(); keptBytes = 0; keeping = false; }
    states.get(k, st, () => st); // kept once the work's reservation is given back: the next slice grows it
    return { st, plan, members, ex, errors, indexErrors: index.errors };
  }
}

/** extendSession(ctx, id, budgetMs) → whether the session still has members to extract or fold, or answer files to write (3.5
 *  后台抽取与归约): one background slice of the query worker (`ctx.writer`), the index read included: extraction in write order, then
 *  folding (or a cold state's rebuild, when a member lies past its log's frontier): half of `budgetMs` each, the fold also what
 *  extraction left; once no member is left past the frontier, the answer files at the state in what is left of `budgetMs`, the
 *  rest in the next slices, and the head once they reach the state (files written while members are left past the frontier would be
 *  written again at the next one); meanwhile only the head's `pending` (backlog). */
export async function extendSession(ctx, id, budgetMs) {
  const end = performance.now() + budgetMs;
  let r;
  try { r = await again(ctx, id, () => advance(ctx, String(id), { budgetMs, request: false })); } catch (e) { await stopped(ctx, String(id), e); throw e; }
  if (!r) return false;
  const { st, plan, ex } = r;
  if (ex.done < ex.total || (st.target != null ? pastOf(plan, st.target, ex.done) : st.fp !== plan || st.fc < plan.n)) { backlog(ctx, String(id), r); return true; }
  const s = stateAt(r, String(id));
  shown.delete(s.id);
  if (!files(ctx, s, end)) return true;
  if (stops.delete(s.id)) putHead(ctx, s); else headAt(ctx, s); // a stop is cleared at once
  releaseParts(); // folded to its frontier: between calls the worker holds no decoded part (3.5:40 ⑤)
  return false;
}

// The head file (3.5 §谁执行它「答案文件」): the worker writes it at the end of a request or background slice of the session when the
// file is absent, when it wrote none of it yet, or when a part only the head carries changed (shapeOf); never on a timer. The parts
// every call moves (mark, steps, cols, lane heads, stats …) do not make it due: the tails carry them. The state of a slice that did
// not write it is kept (the last one per session, dropped once written) and the idle save (saveIndexes) writes it. A head at the mark
// (and cut) it was last written at is not made again while its file is there.
const heads = new Map(); // session id → {sig, shape} of its last head write in this worker
const lagging = new Map(); // session id → {s, home, fs}: the state whose head a slice did not write (advance lets it go before a slice)
const sigOf = (s) => JSON.stringify([s.mark, s.pending && s.pending.done, s.truncated]);
// the parts only the head carries, in O(packs): tier, axis, the packs (with their tags) and the open span, the compactions (a new
// chapter on the axis; one on another lane too), the cut, pending's presence, the failures and the index's codes, and the meta the
// board takes from the head alone (src/web/v2/replay/header.mjs) — never a count that grows with each call
const META = ['title', 'title_source', 'session_id', 'harness', 'harnesses', 'project_slug', 'project_path'];
function shapeOf(s) {
  if (s.mark == null) return JSON.stringify([0, s.indexErrors.map((e) => e.code)]);
  const V = s.V, ax = V.lanes.find((l) => l.kind === 'main') || V.lanes[0] || null;
  return JSON.stringify([1, ax && ax.lane, s.files || null, V.stats.compactions, s.truncated, !!s.pending, s.failed.length,
    s.indexErrors.filter((e) => !e.level).map((e) => e.code), META.map((k) => V.meta && V.meta[k])]);
}
// A background fold that stopped (3.5 §会话读「`session --head`」 pending.stopped, D38②): the slice that threw writes the head at once,
// with the stop's code (FOLD_STOPS) and the first line of its message; the same stop again writes nothing. The session's next slice
// that does not throw clears it (extendSession). A request's own failure is its answer (a 500), not a stop.
const stops = new Set(); // the session ids whose last background slice threw
async function stopped(ctx, id, e) {
  if (ctx.writer !== true || e instanceof HandOff) return;
  const stop = { code: e && e.code === 'heap-no-room' ? 'heap-no-room' : 'fold-failed', reason: String((e && e.message) || e).split('\n')[0] };
  const home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs, sig = JSON.stringify(['stopped', stop]), h = heads.get(id);
  stops.add(id);
  lagging.delete(id);
  if (h && h.sig === sig && fs.existsSync(headFile(home, id))) return;
  try {
    const index = await indexed(ctx), members = sessionGroups(index.rows).get(id);
    if (members) { writeHead(home, id, pendingHead(home, id, members, index.errors, (d, done) => ({ done, total: members.length, stopped: stop }), fs), fs); heads.set(id, { sig, shape: null }); }
  } catch { /* a head not written is written at the next stop or slice */ }
}
// A slice that leaves members past the frontier writes no answer file (3.5 §后台抽取与归约); the head's `pending` alone is brought to
// the frontier (the rest of the head as written: pendingHead) on the first such slice, each time the frontier passes a multiple of
// PACK_MEMBERS and when a stop is cleared, so the board sees pending.done grow and the stop go (D64, D69). O(1) per 512 members.
const shown = new Map(); // session id → the pending.done this worker last put into its head while members were left
function backlog(ctx, id, { st, plan, members, indexErrors }) {
  if (ctx.writer !== true) return;
  const home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs, mark = markOf(st.log), done = mark == null ? 0 : posOf(plan, mark) + 1;
  const was = shown.get(id), cleared = stops.delete(id);
  if (!cleared && was != null && Math.floor(was / PACK_MEMBERS) === Math.floor(done / PACK_MEMBERS) && fs.existsSync(headFile(home, id))) return;
  try { writeHead(home, id, pendingHead(home, id, members, indexErrors, () => ({ done, total: members.length }), fs), fs); } catch { if (cleared) stops.add(id); return; } // tried again next slice
  shown.set(id, done);
  heads.set(id, { sig: JSON.stringify(['pending', done]), shape: null });
  lagging.delete(id);
}
function headAt(ctx, s) {
  if (ctx.writer !== true) return;
  const h = heads.get(s.id), home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs;
  if (!h || h.shape !== shapeOf(s) || !fs.existsSync(headFile(home, s.id))) putHead(ctx, s);
  else lagging.set(s.id, { s, home, fs });
}
/** files(ctx, s, deadline) → false while the session's pack and tail files are short of the state `s` at `deadline` (the next slice
 *  goes on: ctx-files.mjs writeFiles), else true: brought to it (the worker only), their `packs` / `open` kept on `s` for its head; a
 *  write that failed is done afresh at the next slice. */
export function files(ctx, s, deadline = Infinity) {
  if (ctx.writer !== true || s.mark == null) return true;
  try { s.files = writeFiles({ home: ctx.home ?? trocarHome(), fs: ctx.fs || nodeFs }, s, deadline); } catch { forget(s.V.log); return true; }
  return s.files != null;
}
/** headOf(s) → the session's `session --head` document: tier 1 at its mark, tier 0 while it has none (ctx-files.mjs). */
const headOf = (s) => (s.mark == null ? tier0Doc(s.id, s.rows, s.indexErrors)
  : headDoc({ ...s, ...(s.files || packsOf(s)), mark: markOn(s.plan, s.mark), markTs: s.plan.byId.get(s.mark)?.ts ?? null }));
function putHead(ctx, s, doc = null) {
  const h = heads.get(s.id), sig = sigOf(s), home = ctx.home ?? trocarHome(), fs = ctx.fs || nodeFs;
  if (!(h && h.sig === sig && fs.existsSync(headFile(home, s.id)))) {
    try { writeHead(home, s.id, doc || headOf(s), fs); } catch { return; } // a head not written is written at the next slice
    heads.set(s.id, { sig, shape: shapeOf(s) });
  }
  lagging.delete(s.id);
}

/** sessionState(ctx, id) → null (no such session) | {id, rows, store, mark, pending, truncated, V, failed, errors, plan}: the
 *  session after this request's slice (the local path: everything), read from its fold log at the reduction frontier `mark` (V:
 *  src/query/session-doc.mjs viewOf, its columns synced to that frontier), `pending:
 *  {done, total, work}` while members are above the mark (`done` = the members at or below it; `work` = the store's members
 *  extracted and handed to a reduction so far, a rebuild's included), the cut. `errors`: the index's problems
 *  and the store's notes. The state stays warm. */
export async function sessionState(ctx, id) {
  const r = await advance(ctx, String(id), { budgetMs: ctx.writer === true ? SLICE_MS : Infinity, request: true });
  return r && stateAt(r, String(id));
}
// the session state of one slice's result (advance)
function stateAt(r, id) {
  const { st, plan, members, ex, errors, indexErrors } = r, mark = markOf(st.log);
  if (!(st.view && st.view.f === st.log.frontier && st.view.plan === plan && st.view.gen === plan.gen)) {
    st.view = null; // the old view let go before the new one is built
    st.view = { f: st.log.frontier, plan, gen: plan.gen, V: viewOf({ id: String(id), log: st.log, cols: st.cols, members, plan, mark }) };
  }
  // the members at or below the mark are the first `done` of the list; any of the cut past them is above it
  const V = st.view.V, done = mark == null ? 0 : posOf(plan, mark) + 1;
  let above = ex.done < ex.total;
  for (let i = done; !above && i < members.length; i++) above = inCut(plan, members[i]);
  return { id, rows: members, store: st.store, mark, pending: above ? { done, total: members.length, work: st.store.work } : null,
    truncated: plan.bound, V, failed: V.failed, errors, indexErrors, st, plan, pos: (rid) => posOf(plan, rid), cut: (row) => inCut(plan, row) };
}

/** version(ctx) → {key, errors} | null (3.5 §谁执行它 答案缓存): the session's member rows, its reduction frontier as it is now, the
 *  cut and the index's problems — the index rows and a string, never a record. null: no such session. */
export async function version(ctx) {
  const p = ctx.params;
  if (p.id == null || p.id === '') return null;
  const { rows, errors } = await indexed(ctx);
  const members = sessionGroups(rows).get(String(p.id));
  if (!members) return null;
  const k = keyOf(ctx, p.id), store = storeOf(ctx, String(p.id), k), plan = planOf(members, k, store, p.id);
  return { key: JSON.stringify([plan.key, frontiers.get(k) ?? null, plan.bound]), errors };
}

const one = (v) => (v == null || v === '' ? null : String(v));
// The candidates and the log `--since M` is taken against: this log at M's frontier line (only what changed past it), else the
// members of the cut up to M folded into a throwaway log (every rid and lane of either log); `added`: the cut's members past M up to
// the mark, whose records the delta carries.
function thenOf(s, M) {
  const { st, plan } = s, off = st.log.frontierAt(M), added = [];
  for (let i = posOf(plan, M) + 1, to = posOf(plan, s.mark); i <= to; i++) if (inCut(plan, plan.members[i])) added.push(plan.members[i]);
  if (off != null) return { then: { log: st.log, off, mark: M, added }, cands: st.log.changedSince(off), close: () => {} };
  const T = memoryLog(st.store), R = reduction(st.store, { log: T, resolve: st.resolve, errors: [] });
  const upTo = [];
  for (let i = 0, to = posOf(plan, M); i <= to; i++) { const r = plan.members[i], rid = String(r.id); if (inCut(plan, r) && st.store.rows.has(rid)) upTo.push(rid); }
  R.add(upTo);
  const a = T.changedSince(-1), b = st.log.changedSince(-1);
  return { then: { log: T, off: T.frontier ?? -1, mark: M, added }, cands: { rids: new Set([...a.rids, ...b.rids]), lanes: new Set([...a.lanes, ...b.lanes]) }, close: () => T.close() };
}

export async function run(ctx) {
  const { params: p, errors } = ctx;
  const id = one(p.id), since = one(p.since), before = one(p.before);
  if (id == null) throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  if (since != null && before != null) throw new QueryArgError('trocar query session: --since and --before cannot be given together');
  const asHead = p.head != null && p.head !== false && p.head !== 'false' && p.head !== '0';
  if (asHead && (since != null || before != null || p.limit != null)) throw new QueryArgError('trocar query session: --head cannot be given with --since, --before or --limit');
  const limit = limitOf(p.limit);
  const s = await sessionState(ctx, id);
  if (!s) {
    const idx = await indexed(ctx);
    errors.push(...idx.errors, { where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return { base: null, mark: null, truncated: null, more: false, meta: null, stats: null, logged: null, probes: null, lanes: [], calls: [], events: [], records: [] };
  }
  files(ctx, s);
  if (asHead) {
    const doc = headOf(s);
    if (ctx.writer === true) putHead(ctx, s, doc); // the answer is the file (writeHead: the same bytes are not written)
    errors.push(...doc.errors);
    return doc;
  }
  headAt(ctx, s);
  errors.push(...s.errors, ...s.failed.map((f) => ({ where: f.id, code: f.code, reason: f.reason })));
  const { V } = s;
  if (before != null && !V.has(before)) throw new QueryArgError(`trocar query session: --before ${JSON.stringify(before)} is not a call of this session`);
  const head = { mark: markOn(s.plan, s.mark), ...(s.pending ? { pending: s.pending } : null), truncated: s.truncated };
  const body = { meta: V.meta, stats: V.stats, logged: V.logged, probes: V.probes };
  const M = since == null ? null : sinceAt(s.plan, since);
  if (M != null && s.mark != null && s.plan.byId.has(M) && posOf(s.plan, M) <= posOf(s.plan, s.mark)) {
    const { then, cands, close } = thenOf(s, M);
    try {
      const { unknown, ...d } = deltaOf(V, then, cands);
      return { base: since, ...head, ...body, ...(unknown !== undefined ? { unknown } : null), ...d };
    } finally { close(); }
  }
  const { more, ...page } = pageOf(V, before, limit);
  return { base: null, ...head, more, ...body, ...(V.unknown ? { unknown: V.unknown } : null), ...page };
}
