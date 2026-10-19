// src/query/named/sessions.mjs — `asight query sessions` (RFC 1.6 §4.1, 附录 C.5).
//
// The session list, newest first — out of the SEGMENT INDEX, not the records: the index row of a call
// already carries which session it belongs to, which harness, when, and what kind of call it is, so this
// query reads no body and parses no record (1.6 §4.1 速度目标 `sessions` ≤ 1 s; reading every record back
// cost 4.5 s on the 1 GB dataset on Windows and 7.0 s on macOS).
// Membership is one function for this query and for `session` (src/query/rows.mjs), and the document shape
// is the board's own (src/view/board.mjs sessionMetaOfFacts), so the list and a replay cannot disagree.
import { sessionMetaOfFacts } from '../../view/board.mjs';
import { indexRows, sessionGroups, sessionFactsOf } from '../rows.mjs';
import { listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['harness', 'since', 'until', 'limit', 'cursor']);

export async function run({ home, fs, now, params: p, errors }) {
  const keep = tsFilter(p, now), harness = listOf(p.harness);
  const rows = (await indexRows({ home, fs, errors })).filter((r) => keep(r.ts));
  const all = [...sessionGroups(rows)]
    .map(([id, rs]) => sessionMetaOfFacts(sessionFactsOf(id, rs)))
    // --harness filters on the harness the board DECIDED (proc, else the UA — and it says which), not on a field of its own.
    .filter((m) => !harness || harness.has(m.harness))
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
  const { items, next, has_more } = paginate(all, p);
  return { sessions: items, next, has_more };
}
