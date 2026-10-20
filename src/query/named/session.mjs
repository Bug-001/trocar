// src/query/named/session.mjs — `trocar query session --id <id>` (RFC 1.6 §4.1, 附录 C.5).
//
// One session's replay view: the board's own assembly (src/view/board.mjs sessionFold → pageView) over the records of the raw
// segments. The view semantics are the board's; this module only picks the data source, drops what C.5 keeps off the wire and
// names the page the way every paged document does.
//
// FOLDED (3.5 §内存有界): the session's records are read in step order, a chunk of stored bytes at a time, and folded one by one;
// a record's body is let go once its call is assembled, so what a query holds is the SPINE — every call's timeline meta, each
// lane's previous call, the records a cross-record context stitches from — plus one chunk, never the session. A page then reads
// back, by id, only the calls it ships with their bodies (pageView: nearest the window's middle, within PAGE_BODY_BYTES).
// The reads are a scan (`remember: false`): the spine is what is remembered, not the records.
//
// WARM (D63 ①, 1.6 §4.1 附近的查询 ≤ 50 ms): the spine is kept against THIS session's own row list, so the next page and every later
// look at the session read only that page's bodies. A session that grew is folded on from where its spine stopped — unless a new
// record sorts before one already folded (a concurrent call that finished late), which folds it again from the start. Either way
// the document is the one a fold from scratch gives, and a hit and a miss are the same code path.
import { sessionFold, pageView } from '../../view/board.mjs';
import { recordsAt } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { rowsKey, warmCache, fsTag, heapBudget, hold } from '../warm.mjs';
import { sessionKeyOf } from '../../dissect/harnesses.mjs';
import { pageSpec, QueryArgError, PAGE_BODY_BYTES } from './index.mjs';

export const params = Object.freeze(['id', 'after', 'limit']);

// What the fold reads at once, in the rows' stored bytes (at least one row).
const CHUNK_STORED = 8 * 1048576;
// What a spine costs in the heap per row (a call's meta, its lane's events and resources). Measured 2026-10-21 on the generated
// Claude Code sessions of test/query/big-session.mjs (forced GC), rounded up.
export const SPINE_PER_ROW = 16 * 1024;
// What the records being worked on cost in the heap per stored byte: a chunk read and parsed, the lanes' previous calls, a page's
// bodies assembled and serialized (measured with the spine, above).
const WORK_PER_STORED = 6;

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
  return (CHUNK_STORED + 2 * max + PAGE_BODY_BYTES) * WORK_PER_STORED;
}
/** The rows a query folds: all of them while their spine fits the heap budget, else the newest that do, with the `truncated` the
 *  document carries — the same {shown, total, kept_mb, file_mb} the board draws (invariant 4, 1.5 K-06). */
function fitting(rows) {
  const n = Math.max(1, Math.floor((heapBudget() - working(rows)) / SPINE_PER_ROW));
  if (rows.length <= n) return { read: rows, bound: null };
  const read = rows.slice(-n);
  return { read, bound: { shown: calls(read), total: calls(rows), kept_mb: mb(stored(read)), file_mb: mb(stored(rows)) } };
}
// A keyless record is in this session because the segment index named it so (3.4 合成键): its refs carry that name.
function named(r, id) {
  if (sessionKeyOf(r).key == null) Object.defineProperty(r, '_synthKey', { value: id, enumerable: false, configurable: true, writable: true });
  return r;
}
/** The spine of `sorted` (the rows in step order): `old` folded on when it is a prefix of them, else a fold from scratch. */
function grow(old, { home, fs, id, sorted }) {
  const prefix = old && old.ids.length <= sorted.length && old.ids.every((x, i) => sorted[i].id === x);
  const s = prefix ? old : { fold: sessionFold(id), ids: [], errors: [], cost: 0 };
  for (let i = s.ids.length; i < sorted.length;) {
    let j = i, bytes = 0;
    while (j < sorted.length && (j === i || bytes + (sorted[j].stored_bytes || 0) <= CHUNK_STORED)) bytes += sorted[j++].stored_bytes || 0;
    for (const r of recordsAt({ home, fs, rows: sorted.slice(i, j), errors: s.errors, remember: false })) s.fold.push(named(r, id), r.id);
    for (; i < j; i++) s.ids.push(sorted[i].id);
  }
  // a record that did not read is said on every answer (D38) and the spine is not kept: the next query reads it again
  s.cost = s.errors.length ? Infinity : s.ids.length * SPINE_PER_ROW;
  return s;
}

export async function run({ home, fs, params: p, errors }) {
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
    const sp = spines.get(`${fsTag(fs)}\n${home}\n${id}`, rowsKey(sorted).id, (old) => grow(old, { home, fs, id, sorted }));
    errors.push(...sp.errors);
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
