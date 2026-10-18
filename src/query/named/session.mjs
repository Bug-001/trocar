// src/query/named/session.mjs — `asight query session --id <id>` (RFC 1.6 §4.1, 附录 C.5).
//
// One session's replay view: the board's own assembly (src/view/board.mjs sessionView → pageView) over
// the records of the raw segments. The view semantics are the board's; this module only picks the data
// source, drops what C.5 keeps off the wire and names the page the way every paged document does.
//
// WARM (D63 ①, 1.6 §4.1 附近的查询 ≤ 50 ms): the assembly is kept against THIS session's own row list, so
// the next page, and every later look at an open session, is pageView over an assembly already built —
// while the daemon goes on appending other sessions' records, which this entry does not depend on. A
// session that got a record of its own has another row list, so it is assembled again (never stale).
import { sessionView, pageView } from '../../view/board.mjs';
import { recordsAt } from '../records.mjs';
import { indexRows, sessionGroups } from '../rows.mjs';
import { rowsKey, warmCache } from '../warm.mjs';
import { pageSpec, QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'cursor', 'limit']);

// The whole session, no window: `limit: Infinity` is what sessionView calls "the window is everything", which is
// the one assembly every page of it is cut from. An entry is sized at four times the session's stored bytes (the
// assembly holds the decoded bodies and the blocks dissected out of them).
const FULL = Object.freeze({ cursor: 0, limit: Infinity });
const assemblies = warmCache({ maxBytes: 96 * 1024 * 1024, bytes: (v) => v.bytes });

export async function run({ home, fs, params: p, errors }) {
  if (p.id == null || p.id === '') throw new QueryArgError('asight query session: --id is required (a session id; `asight query sessions` lists them)');
  const id = String(p.id);
  // Membership is the segment index's (src/query/rows.mjs — the same function `sessions` counts with), so only
  // THIS session's records are read back, not every record of every segment (1.6 §4.1 `session` 第一页 ≤ 1 s).
  const rows = sessionGroups(await indexRows({ home, fs, errors })).get(id) || [];
  if (!rows.length) {
    errors.push({ where: `session/${id}`, reason: 'no session with this id among the captured records' });
    return { meta: null, records: [], analyzed: null, logged: null, probes: null, truncated: null, page: null };
  }
  const key = rowsKey(rows);
  const built = assemblies.get(`${home}\n${id}`, key.id, () => {
    const errs = [];
    return { full: sessionView(recordsAt({ home, fs, rows, errors: errs }), id, { page: FULL }), errors: errs, bytes: key.bytes * 4 };
  });
  errors.push(...built.errors); // said on every answer, not only on the one that read the records (D38)
  const view = pageView(built.full, pageSpec(p));
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
