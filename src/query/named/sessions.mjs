// src/query/named/sessions.mjs — `asight query sessions` (RFC 1.6 §4.1, 附录 C.5).
//
// The session list, newest first. Membership is computed HERE, on the read side (3.4): the board's
// own grouping (src/view/board.mjs sessionMetasOf) over the records of the raw segments, so the list
// and a session's replay answer from one rule.
import { sessionMetasOf } from '../../view/board.mjs';
import { allRecords } from '../records.mjs';
import { listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['harness', 'since', 'until', 'limit', 'cursor']);

export async function run({ home, fs, now, params: p, errors }) {
  const keep = tsFilter(p, now), harness = listOf(p.harness);
  const recs = (await allRecords({ home, fs, errors })).filter((r) => keep(r.ts_request ?? r.ts));
  const all = sessionMetasOf(recs)
    // --harness filters on the harness the board DECIDED (proc, else the UA — and it says which), not on a field of its own.
    .filter((m) => !harness || harness.has(m.harness))
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
  const { items, next, has_more } = paginate(all, p);
  return { sessions: items, next, has_more };
}
