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
// A MISS renders the window only, which is what the one-shot CLI pays for and all it needs (measured: the window
// 13-28 ms / 294 KB against the whole session's 43 ms / 3.08 MB, growing with the session); the whole assembly is
// built after the answer went out, and only in a process that will be asked again (`warm`, the query worker). The
// two are the same document byte for byte — a page of the whole assembly and the window assembled alone (which is
// why pageView slims `nonBlockKeys` too, src/view/board.mjs).
import { sessionView, pageView } from '../../view/board.mjs';
import { recordsAt } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { rowsKey, warmCache, fsTag } from '../warm.mjs';
import { pageSpec, QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'after', 'limit']);

// The whole session, no window: `limit: Infinity` is what sessionView calls "the window is everything", which is
// the one assembly every page of it is cut from.
const FULL = Object.freeze({ cursor: 0, limit: Infinity });
// The real heap decides what fits, not an estimate of the serialized bytes: an assembly holds the decoded bodies and
// the blocks dissected out of them, and that costs several times what it serializes to (measured: 30 records =
// 3.08 MB of JSON), so a budget in stored bytes × 4 let the worker reach its --max-old-space-size and die.
const assemblies = warmCache({ heapFraction: 1 / 3, bytes: (v) => v.bytes });
const assemble = ({ home, fs, rows, id, bytes }) => () => {
  const errs = [];
  return { full: sessionView(recordsAt({ home, fs, rows, errors: errs }), id, { page: FULL }), errors: errs, bytes };
};

export async function run({ home, fs, params: p, errors, warm = false }) {
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
  const built = assemblies.peek(cacheId, key.id);
  let view;
  if (built) {
    errors.push(...built.errors); // said on every answer, not only on the one that read the records (D38)
    view = pageView(built.full, spec);
  } else {
    const errs = [];
    view = sessionView(recordsAt({ home, fs, rows, errors: errs }), id, { page: spec });
    errors.push(...errs);
    // After the answer, never before it, and only where there will be a next query: the one-shot CLI exits instead.
    if (warm) setImmediate(() => { try { assemblies.get(cacheId, key.id, assemble({ home, fs, rows, id, bytes: key.bytes * 4 })); } catch { /* the next query assembles it */ } });
  }
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
