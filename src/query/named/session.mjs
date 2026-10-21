// src/query/named/session.mjs — `trocar query session --id <id>` (RFC 1.6 §4.1, 附录 C.5).
//
// One session's replay view: the board's own assembly (src/view/board.mjs sessionFold → pageView) over the records of the raw
// segments. The view semantics are the board's; this module only picks the data source, drops what C.5 keeps off the wire and
// names the page the way every paged document does.
//
// FOLDED (3.5 §内存有界): the session's records are read in step order, a chunk of stored bytes at a time, and folded one by one;
// a record's body is let go once its call is assembled, so what a query holds is the SPINE — every call's timeline meta, the lanes'
// baselines up to BASELINE_BYTES (the rest rebuilt by id), the records a cross-record context stitches from — plus one chunk, never
// the session. A page then reads
// back, by id, only the calls it ships with their bodies (pageView: nearest the window's middle, within PAGE_BODY_BYTES).
// The reads are a scan (`remember: false`): the spine is what is remembered, not the records. Every record read is reported to
// `progress()` (the worker passes it on to the daemon, whose deadline measures silence: a long fold is not a wedged worker, 3.5:42).
//
// WARM (D63 ①, 1.6 §4.1 附近的查询 ≤ 50 ms): the spine is kept against THIS session's own row list, so the next page and every later
// look at the session read only that page's bodies. A session that grew is folded on with the records it did not hold, whatever
// their place in step order: a call is written when it ends, so a subagent's call lands after calls that started after it, and it
// goes on its own lane (src/view/assemble.mjs createAssembler: a record that sorts before its lane's last call folds that lane
// again, never the session). Only a session whose subagents are told apart by order alone, or one whose spine lost a record (the
// heap bound moved, below), is folded from scratch. Either way the document is the one a fold from scratch gives, and a hit and a
// miss are the same code path.
import { sessionFold, pageView } from '../../view/board.mjs';
import { BASELINE_BYTES } from '../../view/assemble.mjs';
import { OrderBound } from '../../view/analyze.mjs';
import { recordsAt } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { rowsKey, warmCache, fsTag, heapBudget, heapCeiling, hold, steadyBytes, liveHeap, usedHeap } from '../warm.mjs';
import { sessionKeyOf } from '../../dissect/harnesses.mjs';
import { pageSpec, QueryArgError, PAGE_BODY_BYTES } from './index.mjs';

export const params = Object.freeze(['id', 'after', 'limit']);

// What the fold reads at once, in the rows' stored bytes (at least one row).
const CHUNK_STORED = 8 * 1048576;
// What a spine costs in the heap per row (a call's meta, its lane's events and resources, a stitched context's locators), until a
// fold of THIS session measured it (HeapBound below). Measured 2026-10-21 on the user's live session and the generated ones of
// test/query/big-session.mjs (forced GC).
export const SPINE_PER_ROW = 32 * 1024;
// What the records being worked on cost in the heap per stored byte (and the lanes' baselines per character of their blocks): a
// chunk read and parsed, a page's bodies assembled and serialized (measured with the spine, above).
const WORK_PER_STORED = 4;
/** What the lanes' cache baselines (src/view/assemble.mjs BASELINE_BYTES: the blocks, prefix chain and block keys of each lane's
 *  last prefix-establishing call, the most recently used held, the rest rebuilt by record id) cost in the heap at most, beside the spine. */
export const BASELINE_HEAP = BASELINE_BYTES * WORK_PER_STORED;

const spines = warmCache({ cost: (v) => v.cost });
// analyze()'s step order (src/view/analyze.mjs stepOrder) over the index rows: `ts` is the record's ts_request
const stepOrder = (a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id));
const calls = (rs) => rs.reduce((n, r) => n + (r.is_llm && !r.log_only ? 1 : 0), 0);
const stored = (rs) => rs.reduce((n, r) => n + (r.stored_bytes || 0), 0);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
/** What folding `rows` and answering one page costs besides the spine, reserved before anything is read. */
function working(rows) {
  let max = 0;
  for (const r of rows) max = Math.max(max, r.stored_bytes || 0);
  // the baselines may hold one lane's past BASELINE_BYTES (the one in use is always held): `max` covers it
  return (CHUNK_STORED + max + PAGE_BODY_BYTES) * WORK_PER_STORED + BASELINE_HEAP;
}
// The cut of a session past the heap bound moves by the rows a 1/BOUND_STEPS of the budget holds: a spine that lost a row is folded
// from scratch (grow), so a cut that moved with every new row made every poll of a live session that size a cold fold (30 s of
// worker CPU on the user's ~5 500-call session, 2026-10-21). Between steps the spine is folded on with the new rows only.
const BOUND_STEPS = 10;
/** The rows a query folds: all of them while their spine (`perRow` each) fits the heap budget beside what every query reads again
 *  (`others`: the steady caches; the rest give way), else the newest that do less one step, cut on a grid of steps, with the
 *  `truncated` the document carries — the same {shown, total, kept_mb, file_mb} the board draws (invariant 4, 1.5 K-06). → also
 *  `room`, the bytes the spine may take (the measured bound, bounded()). */
function fitting(rows, perRow, others) {
  const stepBytes = heapBudget() / BOUND_STEPS;
  // what the spine may take: the budget less the work and the segments' index rows, these counted in whole steps so their every
  // refresh does not move the cut
  const room = heapBudget() - working(rows) - Math.ceil(others / stepBytes) * stepBytes;
  const n = Math.floor(room / perRow);
  if (rows.length <= n) return { read: rows, bound: null, room };
  // one step is left for the spine to grow into between steps: a spine that filled the budget to the byte was pushed out by the
  // next refresh of the other caches, and the session folded cold on every poll all the same
  const step = Math.max(1, Math.floor(stepBytes / perRow)), cap = Math.max(1, n - step);
  const read = rows.slice(Math.min(Math.ceil((rows.length - cap) / step) * step, rows.length - 1));
  return { read, room, bound: { shown: calls(read), total: calls(rows), kept_mb: mb(stored(read)), file_mb: mb(stored(rows)) } };
}
/** A fold stopped by the MEASURED bound after `rows` rows: what it held passed what the plan reserved for it, or the process's heap
 *  its ceiling. */
class HeapBound extends Error {
  constructor(rows) { super('the session fold passed the heap ceiling'); this.rows = rows; }
}
// Checked after every record folded. The live heap (a full collection) is looked at when the stored bytes folded since the last look
// reach `s.gap`: half of what is left of the reservation at WORK_PER_STORED heap bytes a stored byte — by bytes, not rows (a run of
// large records late in a session, a long main-thread context ~2.8 MB a call on the user's, grows the fold far faster than its
// average row), and by the records alone, never by the allocated heap, so two processes look at the same records. The allocated
// heap (cheap, garbage included) only guards the ceiling. What the fold holds is what the heap grew by since it began (`s.base`,
// measured for a fold from scratch big enough to matter), so a process holding other things — a CLI, a test — cuts where the
// worker does. It is held against the whole reservation (`s.limit`: the spine's room AND the working set, working() — a parsed
// chunk, the baselines, the chain tips' contexts are in the heap too); a fold grown on a kept spine has no base of its own and is
// held against the ceiling only.
function bounded(s, rows, bytes) {
  const used = usedHeap();
  s.since += bytes;
  if (used <= heapCeiling() && (s.base == null || s.since < s.gap)) return;
  const live = liveHeap(), grew = live - (s.base || 0);
  // within half a step of the limit counts as there: the cut leaves a step anyway, and creeping up to the byte is a full
  // collection every record
  if (live > heapCeiling() || (s.base != null && grew > s.limit - heapBudget() / BOUND_STEPS / 2)) throw new HeapBound(rows);
  s.since = 0; s.gap = (s.limit - grew) / 2 / WORK_PER_STORED;
}
// What a row of each session costs as a fold of it measured — its room over the rows that fold got through (session key → bytes),
// at most PER_ROW_KEPT sessions.
const perRows = new Map();
const PER_ROW_KEPT = 64;
// A keyless record is in this session because the segment index named it so (3.4 合成键): its refs carry that name.
function named(r, id) {
  if (sessionKeyOf(r).key == null) Object.defineProperty(r, '_synthKey', { value: id, enumerable: false, configurable: true, writable: true });
  return r;
}
// `rows` in chunks of at most CHUNK_STORED stored bytes (at least one row each).
function* chunks(rows) {
  for (let i = 0; i < rows.length;) {
    let j = i, bytes = 0;
    while (j < rows.length && (j === i || bytes + (rows[j].stored_bytes || 0) <= CHUNK_STORED)) bytes += rows[j++].stored_bytes || 0;
    yield rows.slice(i, j);
    i = j;
  }
}
/** The spine of `sorted` (the rows in step order): `old` folded on with the rows it does not hold when it holds no row the query
 *  does not read, else a fold from scratch. A record the fold asks for again (a cross-record context whose items it no longer holds:
 *  src/dissect/chain.mjs; a lane folded again) is read back by id, in the order asked, a chunk at a time, through the rows of the
 *  query at hand (`s.rowOf`), its problems said in `s.sink` (D38). */
// `box.old` is the only reference to the previous spine (warmCache take()): it is let go BEFORE a fold from scratch, so the heap
// never holds two spines at once.
function grow(box, args) {
  let old = box.old;
  box.old = null;
  if (old && ![...old.ids].every((x) => args.rowOf.has(x))) old = null;
  if (old) {
    try { return foldOn(old, args.sorted.filter((r) => !old.ids.has(r.id)), args); } catch (e) { if (!(e instanceof OrderBound)) throw e; }
    old = null;
  }
  return foldOn(null, args.sorted, args);
}
function foldOn(old, rows, { home, fs, id, rowOf, progress, perRow, limit }) {
  // what the heap held before this spine, measured only for a fold from scratch that may matter (a full collection costs)
  const s = old || { ids: new Set(), errors: [], cost: 0, bodies: new Map(), bodyBytes: 0,
    base: rows.length * perRow > heapBudget() / BOUND_STEPS ? liveHeap() : null, since: 0, gap: 0 };
  if (old) s.base = null;
  s.rowOf = rowOf; s.sink = s.errors; s.progress = progress; s.limit = limit;
  let folded = s.ids.size;
  const read = function* (ids) {
    for (const part of chunks(ids.map((x) => s.rowOf.get(x)).filter(Boolean))) for (const r of recordsAt({ home, fs, rows: part, errors: s.sink, remember: false })) { s.progress(); yield named(r, id); }
  };
  if (!old) s.fold = sessionFold(id, { read });
  for (const part of chunks(rows)) {
    for (const r of recordsAt({ home, fs, rows: part, errors: s.errors, remember: false })) { progress(); s.fold.push(named(r, id), r.id); bounded(s, ++folded, (rowOf.get(r.id) || {}).stored_bytes || 0); }
    for (const r of part) s.ids.add(r.id);
  }
  // a record that did not read is said on every answer (D38) and the spine is not kept: the next query reads it again
  s.cost = s.errors.length ? Infinity : s.ids.size * perRow + PAGE_BODY_BYTES * WORK_PER_STORED; // + the bodies it keeps (bodiesOf)
  return s;
}

// The work a row list asks for before anything is read — what fits, in step order, by id — done once per list: indexRows hands back
// the same frozen array while no segment moved, so sessionGroups does too, and a poll of a session that did not grow redoes none of it.
// Made again only when a fold measured this session's rows dearer than the plan reckoned.
const plans = new WeakMap();
function planOf(rows, k) {
  const perRow = perRows.get(k) || SPINE_PER_ROW;
  let p = plans.get(rows);
  if (!p || p.perRow !== perRow) {
    const { read, bound, room } = fitting(rows, perRow, steadyBytes());
    const sorted = [...read].sort(stepOrder);
    plans.set(rows, (p = { read, bound, room, limit: room + working(read), sorted, perRow, rowOf: new Map(read.map((r) => [r.id, r])), key: rowsKey(sorted).id }));
  }
  return p;
}
const spineKey = ({ fs, home }, id) => `${fsTag(fs)}\n${home}\n${id}`;
// The segment index of THIS request, read once whether version() asked first (src/query/answers.mjs) or not: a note about the
// read that built it (`index-cold`) reaches the answer that read was for (3.5 读不全), and the answer is the one its version names.
async function indexed({ home, fs, once }) {
  if (once && once.index) return once.index;
  const errors = [], got = { rows: await indexRows({ home, fs, errors }), errors };
  if (once) once.index = got;
  return got;
}
/** version(ctx) → {key, errors} | null (3.5 §谁执行它 答案缓存): the identity of the index rows this answer reads, where it is cut
 *  (`truncated`) and the index's problems — read from the warm index rows only, never a record. null: no such session. */
export async function version(ctx) {
  const p = ctx.params;
  if (p.id == null || p.id === '') return null;
  const { rows, errors } = await indexed(ctx);
  const mine = sessionGroups(rows).get(String(p.id));
  if (!mine) return null;
  const { key, bound } = planOf(mine, spineKey(ctx, p.id));
  return { key: JSON.stringify([key, bound]), errors };
}

/** The bodies a spine keeps for the calls its pages shipped (3.5 §缓存按依赖失效): a poll reads back only the calls new to the page.
 *  Keyed by the call OBJECT — a lane folded again makes new ones, and a new spine starts empty — and holding the body only, never the
 *  filled call (gi / streamId / cacheBreak.refGi are set in place when the fold finishes). Least recently shipped go first. */
function bodiesOf(s, cs, fresh) {
  const out = new Map(), missing = [];
  for (const c of cs) {
    const b = s.bodies.get(c);
    if (b) { s.bodies.delete(c); s.bodies.set(c, b); out.set(c, b.body); } else missing.push(c);
  }
  for (const [c, body] of fresh(missing)) {
    const bytes = Object.values(c.comp || {}).reduce((n, v) => n + v, 0);
    s.bodies.set(c, { body, bytes });
    s.bodyBytes += bytes;
    out.set(c, body);
  }
  for (const [c, b] of s.bodies) { if (s.bodyBytes <= PAGE_BODY_BYTES) break; s.bodies.delete(c); s.bodyBytes -= b.bytes; }
  return out;
}

export async function run(ctx) {
  const { home, fs, params: p, errors, progress = () => {} } = ctx;
  if (p.id == null || p.id === '') throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  const id = String(p.id);
  // Membership is the segment index's (src/query/rows.mjs — the same function `sessions` counts with), so only
  // THIS session's records are read back, not every record of every segment (1.6 §4.1 `session` 第一页 ≤ 1 s).
  const index = await indexed(ctx);
  errors.push(...index.errors);
  const rows = sessionGroups(index.rows).get(id) || [];
  if (!rows.length) {
    errors.push({ where: `session/${id}`, reason: 'no session with this id among the captured records' });
    return { meta: null, records: [], analyzed: null, logged: null, probes: null, truncated: null, page: null };
  }
  const spec = pageSpec(p), k = spineKey(ctx, id);
  for (;;) {
    const { read, bound, sorted, rowOf, key, perRow, room, limit } = planOf(rows, k);
    let sp = spines.peek(k, key);
    // a spine that is grown, or let go, is taken out of the cache before the room is made: the caches give way for it, never it
    const box = sp ? null : { old: spines.take(k) };
    const release = hold(working(read)); // the caches give way BEFORE anything is read
    try {
      if (!sp) sp = spines.get(k, key, () => grow(box, { home, fs, id, sorted, rowOf, progress, perRow, limit }));
      return answerOf(sp, { home, fs, id, rowOf, read, bound, spec, errors, progress });
    } catch (e) {
      if (!(e instanceof HeapBound)) throw e;
      // the measured bound: as many rows as the stopped fold got through fill the room — a count, not a cost divided out of a heap
      // that also holds the working set, so a fold that stops early is not cut harder for it — but never fewer than half the rows
      // it was asked for: a fold that began inside a run of large records (a long main-thread context) stops early for where it
      // began, not for what the newest rows cost (the user's session, 2026-10-21: 85 calls shown where 420 fit). The newest of
      // them less one step are folded from scratch (fitting): fewer rows every round, even for a fold that stopped on its last row
      // (so - 1). The cost is rounded up to a quarter power of two, so the heap's noise between two processes (a look a few records
      // later) does not move the plan: the same records are cut in the same place. The stopped fold is garbage by now.
      const fit = Math.max(e.rows, Math.floor(read.length / 2)) - 1;
      if (fit < 1) throw new Error(`the heap holds no room for this session (${mb(heapCeiling())} MB ceiling)`);
      perRows.delete(k);
      perRows.set(k, 2 ** (Math.ceil(Math.log2(room / fit) * 4) / 4));
      if (perRows.size > PER_ROW_KEPT) perRows.delete(perRows.keys().next().value);
    } finally { release(); }
  }
}
// One page of the spine `sp`: the calls it ships with their bodies are those the spine kept, the rest read back by id and given
// their bodies by the fold that assembled them.
function answerOf(sp, { home, fs, id, rowOf, read, bound, spec, errors, progress }) {
  errors.push(...sp.errors);
  sp.rowOf = rowOf; sp.sink = errors; sp.progress = progress;
  const fresh = (cs) => {
    if (!cs.length) return [];
    const recs = recordsAt({ home, fs, rows: cs.map((c) => rowOf.get(c.id)).filter(Boolean), errors, remember: false });
    const byId = new Map(recs.map((r) => [r.id, named(r, id)]));
    return cs.filter((c) => byId.has(c.id)).map((c) => [c, sp.fold.bodyOf(c, byId.get(c.id))]);
  };
  const fill = (cs) => new Map([...bodiesOf(sp, cs, fresh)].map(([c, body]) => [c, sp.fold.filled(c, body)]));
  const view = pageView(sp.fold.view(read.map((r) => r.id), { bound }), spec, { fill, budget: PAGE_BODY_BYTES });
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
