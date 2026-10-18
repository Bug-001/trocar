// src/query/named/session.mjs — `asight query session --id <id>` (RFC 1.6 §4.1, 附录 C.5).
//
// One session's replay view: the board's own assembly (src/view/board.mjs sessionView → pageView) over
// the records of the raw segments. The view semantics are the board's; this module only picks the data
// source, drops what C.5 keeps off the wire and names the page the way every paged document does.
import { sessionView } from '../../view/board.mjs';
import { allRecords } from '../records.mjs';
import { pageSpec, QueryArgError } from './index.mjs';

export const params = Object.freeze(['id', 'cursor', 'limit']);

export async function run({ home, fs, params: p, errors }) {
  if (p.id == null || p.id === '') throw new QueryArgError('asight query session: --id is required (a session id; `asight query sessions` lists them)');
  const id = String(p.id);
  const view = sessionView(await allRecords({ home, fs, errors }), id, { page: pageSpec(p) });
  if (!view) {
    errors.push({ where: `session/${id}`, reason: 'no session with this id among the captured records' });
    return { meta: null, records: [], analyzed: null, logged: null, probes: null, truncated: null, page: null };
  }
  // `steps` and `streams` hold the SAME call objects as `lanes[].calls` — in process one object, on the
  // wire three copies (C.5). The board reads `lanes` and `stats`, so only those go out.
  const { steps, streams, ...analyzed } = view.analyzed || {};
  const { nextCursor, hasMore, ...page } = view.page;
  return { ...view, analyzed, page: { ...page, next: nextCursor == null ? null : String(nextCursor), has_more: hasMore } };
}
