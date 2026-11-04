// src/query/named/sessions.mjs — `trocar query sessions` (RFC 1.6 §4.1, 附录 C.5).
//
// The session list, newest first — out of the SEGMENT INDEX, not the records: the index row of a call
// already carries which session it belongs to, which harness, when, and what kind of call it is, so this
// query reads no body and parses no record (1.6 §4.1 速度目标 `sessions` ≤ 1 s; reading every record back
// cost 4.5 s on the 1 GB dataset on Windows and 7.0 s on macOS).
// Membership is one function for this query and for `session` (src/query/rows.mjs), and the document shape
// is the board's own (src/view/board.mjs sessionMetaOfFacts), so the list and a replay cannot disagree.
// The TITLE is the main lane's first prompt (4.4 §人类标题的来源), which lives in a request body the index does not parse (D20): it comes
// from the title table (src/query/titles.mjs), and a session the table does not have is computed on the spot, so the list always knows
// it (3.5 §访问模式, D78 ①). A title is the whole session's, whatever the window: the window only picks which sessions are listed. With
// `later` (the daemon's query worker) the table is written after the answer; the one-shot CLI writes nothing.
// `stored`: the unwindowed list (only `limit` / `after`) is the answer the worker keeps on disk (3.5 §谁执行它「存下的答案」).
import { sessionMetaOfFacts } from '../../view/board.mjs';
import { titleOf, saveTitles } from '../titles.mjs';
import { asOf, indexRows, sessionGroups, sessionFactsOf } from '../rows.mjs';
import { listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['harness', 'since', 'until', 'limit', 'after']);
export const stored = (p) => Object.keys(p).every((k) => k === 'limit' || k === 'after');

export async function run({ home, fs, now, params: p, errors, later = null, progress = null }) {
  const keep = tsFilter(p, now), harness = listOf(p.harness);
  const index = await indexRows({ home, fs, errors, progress });
  const rows = p.since == null && p.until == null ? index : index.filter((r) => keep(r.ts)); // no window: the list and its session index
  const rowsOf = new Map();
  const all = [...sessionGroups(rows)]
    .map(([id, rs]) => { rowsOf.set(id, rs); return sessionFactsOf(id, rs); })
    // --harness filters on the harness the board DECIDED (proc, else the UA — and it says which), not on a field of its own.
    .filter((f) => !harness || harness.has(f.harness))
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
  const { items, next, has_more } = paginate(all, p);
  const whole = rows === index ? rowsOf : sessionGroups(index);
  const sessions = items.map((f) => sessionMetaOfFacts({ ...f, title: titleOf({ home, fs, id: f.session_id, members: whole.get(f.session_id), errors }) }));
  // After the answer is written, and only where there is a next query (the worker's `later`): the one-shot CLI never writes one.
  if (later) later(() => saveTitles({ home, fs }));
  return { as_of: asOf(index), sessions, next, has_more };
}
