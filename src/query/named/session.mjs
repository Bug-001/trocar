// src/query/named/session.mjs — `trocar query session --id <id>` (RFC 1.6 §4.1, 附录 C.5).
//
// One session's replay view: the board's own assembly (src/view/board.mjs sessionView → pageView) over
// the records of the raw segments. The view semantics are the board's; this module only picks the data
// source, drops what C.5 keeps off the wire and names the page the way every paged document does.
//
// WARM (D63 ①, 1.6 §4.1 附近的查询 ≤ 50 ms): the whole session's assembly is kept against THIS session's own row
// list, so the next page, and every later look at an open session, is pageView over an assembly already built —
// while the daemon goes on appending other sessions' records, which this entry does not depend on. A session that
// got a record of its own has another row list, so it is assembled again (never stale).
// A MISS renders the window only, which is what the one-shot CLI pays for and all it needs; the whole assembly is
// built after the answer was written, only in a process that will be asked again (`later`, the query worker), and only
// for a session that did not grow since the previous query (a growing one has a new row list on every poll, so the build
// could never be hit) and that fits the heap budget. The two are the same document byte for byte — a page of the whole
// assembly and the window assembled alone (which is why pageView slims `nonBlockKeys` too, src/view/board.mjs).
//
// MEMORY (3.5 §内存有界): a window still reads every record of the session (the prefix chain and the lanes are the whole
// session's), so what it costs is estimated from the rows' stored bytes BEFORE anything is read. A session whose estimate is
// past the heap budget is read from its tail, as far back as fits, and the document's `truncated` says so (invariant 4; the
// board's non-complete-view banner, 1.5 K-06). The worker never dies of a session's size. Streaming the assembly so that only
// the window's bodies are held is still open.
import { sessionView, pageView } from '../../view/board.mjs';
import { recordsAt } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { rowsKey, warmCache, fsTag, heapBudget, hold, HEAP_PER_STORED } from '../warm.mjs';
import { pageSpec, QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'after', 'limit']);

// The whole session, no window: `limit: Infinity` is what sessionView calls "the window is everything", which is
// the one assembly every page of it is cut from.
const FULL = Object.freeze({ cursor: 0, limit: Infinity });
// What an assembled session costs in the heap, per stored byte, on top of its records (HEAP_PER_STORED). Measured 2026-10-21 on
// generated Claude Code sessions (forced GC, and the peak of a worker at 128 and 384 MB): every call keeps its timeline meta,
// lanes and events — 1.1x the rows read; a call IN the window also keeps its block list and is serialized into the answer — 1.9x
// retained, 6.1x of the rows in all at the peak of a tail whose window is most of its bytes; the whole assembly kept for the
// next query, 1.89x. Rounded up, because a worker under load reaches its limit sooner than a quiet one.
export const VIEW_PER_STORED = 1.5, WINDOW_PER_STORED = 3, ASSEMBLY_PER_STORED = 2;
const assemblies = warmCache({ cost: (v) => v.cost });
const assemble = ({ home, fs, rows, id, cost }) => () => {
  const errs = [];
  return { full: sessionView(recordsAt({ home, fs, rows, errors: errs }), id, { page: FULL }), errors: errs, cost };
};
// The row list each session's last answer read: the whole assembly is built only for one that did not change since.
const lastRead = new Map();
const LAST_READ_MAX = 64;
const calls = (rs) => rs.reduce((n, r) => n + (r.is_llm && !r.log_only ? 1 : 0), 0);
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
/** What reading `rows` and assembling a window of `k` calls over them costs: the window's calls are not known before the
 *  assembly, so the k largest are counted — the same number in every process for the same rows and `--limit`. */
function estimate(rows, k) {
  let all = 0;
  const llm = [];
  for (const r of rows) { all += r.stored_bytes || 0; if (r.is_llm && !r.log_only) llm.push(r.stored_bytes || 0); }
  llm.sort((a, b) => b - a);
  let win = 0;
  for (let i = 0; i < Math.min(k, llm.length); i++) win += llm[i];
  return { all, view: all * VIEW_PER_STORED + win * WINDOW_PER_STORED };
}
/** The rows a window may read: all of them when their estimate fits the heap budget, else the newest that do (at least one),
 *  with the `truncated` the document carries — the same {shown, total, kept_mb, file_mb} the board draws (src/view/board.mjs). */
function fitting(rows, k) {
  const fits = (from) => { const e = estimate(rows.slice(from), k); return e.all * HEAP_PER_STORED + e.view <= heapBudget(); };
  if (rows.length < 2 || fits(0)) return { read: rows, view: estimate(rows, k).view, bound: null }; // one record past the budget is still answered
  let lo = 1, hi = rows.length - 1; // the fewest rows to drop: more rows only ever cost more, so this is a binary search
  while (lo < hi) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid + 1; }
  const read = rows.slice(lo), e = estimate(read, k), all = estimate(rows, 0).all;
  return { read, view: e.view, bound: { shown: calls(read), total: calls(rows), kept_mb: mb(e.all), file_mb: mb(all) } };
}

export async function run({ home, fs, params: p, errors, later = null }) {
  if (p.id == null || p.id === '') throw new QueryArgError('trocar query session: --id is required (a session id; `trocar query sessions` lists them)');
  const id = String(p.id);
  // Membership is the segment index's (src/query/rows.mjs — the same function `sessions` counts with), so only
  // THIS session's records are read back, not every record of every segment (1.6 §4.1 `session` 第一页 ≤ 1 s).
  const rows = sessionGroups(await indexRows({ home, fs, errors })).get(id) || [];
  if (!rows.length) {
    errors.push({ where: `session/${id}`, reason: 'no session with this id among the captured records' });
    return { meta: null, records: [], analyzed: null, logged: null, probes: null, truncated: null, page: null };
  }
  const key = rowsKey(rows);
  const cacheId = `${fsTag(fs)}\n${home}\n${id}`;
  const spec = pageSpec(p);
  const { read, view: viewCost, bound } = fitting(rows, spec.limit + 1); // + the baseline call before the window (board.mjs inPage)
  const built = bound ? undefined : assemblies.peek(cacheId, key.id);
  let view;
  if (built) {
    errors.push(...built.errors); // said on every answer, not only on the one that read the records (D38)
    view = pageView(built.full, spec);
  } else {
    const errs = [];
    const release = hold(viewCost); // the caches give way BEFORE the records are read and the window is built
    try { view = sessionView(recordsAt({ home, fs, rows: read, errors: errs }), id, { page: spec, bound }); } finally { release(); }
    errors.push(...errs);
    const grew = lastRead.get(cacheId) !== key.id;
    lastRead.delete(cacheId); lastRead.set(cacheId, key.id);
    if (lastRead.size > LAST_READ_MAX) lastRead.delete(lastRead.keys().next().value);
    const cost = key.bytes * ASSEMBLY_PER_STORED;
    if (later && !bound && !grew && key.bytes * HEAP_PER_STORED + cost <= heapBudget()) later(() => { assemblies.get(cacheId, key.id, assemble({ home, fs, rows, id, cost }), cost); });
  }
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
