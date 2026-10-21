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
import { rowsKey, warmCache, fsTag, heapBudget, hold } from '../warm.mjs';
import { sessionKeyOf } from '../../dissect/harnesses.mjs';
import { pageSpec, QueryArgError, PAGE_BODY_BYTES } from './index.mjs';

export const params = Object.freeze(['id', 'after', 'limit']);

// What the fold reads at once, in the rows' stored bytes (at least one row).
const CHUNK_STORED = 8 * 1048576;
// What a spine costs in the heap per row (a call's meta, its lane's events and resources, a stitched context's locators). Measured
// 2026-10-21 on the user's live session and the generated ones of test/query/big-session.mjs (forced GC).
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
// The cut of a session past the heap bound moves a 1/BOUND_STEPS of what fits at a time: a spine that lost a row is folded from
// scratch (grow), so a cut that moved with every new row made every poll of a live session that size a cold fold (30 s of worker CPU
// on the user's ~5 500-call session, 2026-10-21). Between steps the spine is folded on with the new rows only.
const BOUND_STEPS = 10;
/** The rows a query folds: all of them while their spine fits the heap budget, else the newest that do, cut at a multiple of a tenth
 *  of what fits (BOUND_STEPS) and at most nine tenths of it, with the `truncated` the document carries — the same {shown, total, kept_mb, file_mb} the board draws
 *  (invariant 4, 1.5 K-06). */
function fitting(rows) {
  const n = Math.max(1, Math.floor((heapBudget() - working(rows)) / SPINE_PER_ROW));
  if (rows.length <= n) return { read: rows, bound: null };
  // one step is left to the other caches (the segments' index rows refresh as the capture grows): a spine that filled the budget
  // to the byte was pushed out by the next of them, and the session folded cold on every poll all the same
  const step = Math.max(1, Math.floor(n / BOUND_STEPS)), cap = Math.max(1, n - step);
  const read = rows.slice(Math.ceil((rows.length - cap) / step) * step);
  return { read, bound: { shown: calls(read), total: calls(rows), kept_mb: mb(stored(read)), file_mb: mb(stored(rows)) } };
}
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
function grow(old, args) {
  if (old && [...old.ids].every((x) => args.rowOf.has(x))) {
    try { return foldOn(old, args.sorted.filter((r) => !old.ids.has(r.id)), args); } catch (e) { if (!(e instanceof OrderBound)) throw e; }
  }
  return foldOn(null, args.sorted, args);
}
function foldOn(old, rows, { home, fs, id, rowOf, progress }) {
  const s = old || { ids: new Set(), errors: [], cost: 0 };
  s.rowOf = rowOf; s.sink = s.errors; s.progress = progress;
  const read = function* (ids) {
    for (const part of chunks(ids.map((x) => s.rowOf.get(x)).filter(Boolean))) for (const r of recordsAt({ home, fs, rows: part, errors: s.sink, remember: false })) { s.progress(); yield named(r, id); }
  };
  if (!old) s.fold = sessionFold(id, { read });
  for (const part of chunks(rows)) {
    for (const r of recordsAt({ home, fs, rows: part, errors: s.errors, remember: false })) { progress(); s.fold.push(named(r, id), r.id); }
    for (const r of part) s.ids.add(r.id);
  }
  // a record that did not read is said on every answer (D38) and the spine is not kept: the next query reads it again
  s.cost = s.errors.length ? Infinity : s.ids.size * SPINE_PER_ROW;
  return s;
}

export async function run({ home, fs, params: p, errors, progress = () => {} }) {
  if (p.id == null || p.id === '') throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  const id = String(p.id);
  // Membership is the segment index's (src/query/rows.mjs — the same function `sessions` counts with), so only
  // THIS session's records are read back, not every record of every segment (1.6 §4.1 `session` 第一页 ≤ 1 s).
  const rows = sessionGroups(await indexRows({ home, fs, errors })).get(id) || [];
  if (!rows.length) {
    errors.push({ where: `session/${id}`, reason: 'no session with this id among the captured records' });
    return { meta: null, records: [], analyzed: null, logged: null, probes: null, truncated: null, page: null };
  }
  const spec = pageSpec(p);
  const { read, bound } = fitting(rows);
  const sorted = [...read].sort(stepOrder);
  const rowOf = new Map(read.map((r) => [r.id, r]));
  const release = hold(working(read)); // the caches give way BEFORE anything is read
  let view;
  try {
    const sp = spines.get(`${fsTag(fs)}\n${home}\n${id}`, rowsKey(sorted).id, (old) => grow(old, { home, fs, id, sorted, rowOf, progress }));
    errors.push(...sp.errors);
    sp.rowOf = rowOf; sp.sink = errors; sp.progress = progress;
    // the calls this page ships with their bodies, read back by id and given their bodies by the fold that assembled them
    const fill = (cs) => {
      const recs = recordsAt({ home, fs, rows: cs.map((c) => rowOf.get(c.id)).filter(Boolean), errors, remember: false });
      const byId = new Map(recs.map((r) => [r.id, named(r, id)]));
      return new Map(cs.filter((c) => byId.has(c.id)).map((c) => [c, sp.fold.filled(c, byId.get(c.id))]));
    };
    view = pageView(sp.fold.view(read.map((r) => r.id), { bound }), spec, { fill, budget: PAGE_BODY_BYTES });
  } finally { release(); }
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
