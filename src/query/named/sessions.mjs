// src/query/named/sessions.mjs — `trocar query sessions` (RFC 1.6 §4.1, 附录 C.5).
//
// The session list, newest first — out of the SEGMENT INDEX, not the records: the index row of a call
// already carries which session it belongs to, which harness, when, and what kind of call it is, so this
// query reads no body and parses no record (1.6 §4.1 速度目标 `sessions` ≤ 1 s; reading every record back
// cost 4.5 s on the 1 GB dataset on Windows and 7.0 s on macOS).
// Membership is one function for this query and for `session` (src/query/rows.mjs), and the document shape
// is the board's own (src/view/board.mjs sessionMetaOfFacts), so the list and a replay cannot disagree.
// The TITLE is the main lane's first prompt (4.4 §人类标题的来源), which lives in a request body the index does not parse (D20):
// it comes from the usage sidecar (4.2 §用量旁注 `ask`) — the earliest main call of the session it covers — and is null until one
// does. With `later` (the query worker), a page's segments without a sidecar are filled after the answer, as `overview` does.
import { sessionMetaOfFacts } from '../../view/board.mjs';
import { readUsage, fillUsage } from '../usage.mjs';
import { asOf, indexRows, isModelCall, sessionGroups, sessionFactsOf } from '../rows.mjs';
import { listOf, paginate, tsFilter } from './index.mjs';

export const params = Object.freeze(['harness', 'since', 'until', 'limit', 'after']);

export async function run({ home, fs, now, params: p, errors, later = null }) {
  const keep = tsFilter(p, now), harness = listOf(p.harness);
  const index = await indexRows({ home, fs, errors });
  const rows = p.since == null && p.until == null ? index : index.filter((r) => keep(r.ts)); // no window: the list and its session index
  const rowsOf = new Map();
  const all = [...sessionGroups(rows)]
    .map(([id, rs]) => { rowsOf.set(id, rs); return sessionFactsOf(id, rs); })
    // --harness filters on the harness the board DECIDED (proc, else the UA — and it says which), not on a field of its own.
    .filter((f) => !harness || harness.has(f.harness))
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)));
  const { items, next, has_more } = paginate(all, p);
  const notes = new Map(), toFill = new Set(); // segment → its sidecar (or null), read once per answer
  const note = (segment) => {
    if (!notes.has(segment)) {
      const n = readUsage({ home, segment, fs });
      notes.set(segment, n);
      if (n) for (const { where, reason } of n.problems) errors.push({ where, reason }); // said by every reader (D38)
    }
    return notes.get(segment);
  };
  const titleOf = (id) => {
    const calls = rowsOf.get(id).filter(isModelCall).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.lineNo - b.lineNo));
    let title = null, found = false;
    for (const r of calls) {
      const n = note(r.segment), f = n && r.lineNo <= n.lines ? n.facts.get(r.lineNo) : null;
      if (!n || r.lineNo > n.lines) toFill.add(r.segment);
      if (!found && f && f.lane === 'main') { title = f.ask ?? null; found = true; }
    }
    return title;
  };
  const sessions = items.map((f) => sessionMetaOfFacts({ ...f, title: titleOf(f.session_id) }));
  // After the answer is written, and only where there is a next query (the worker's `later`): the one-shot CLI never writes one.
  if (later && toFill.size) later(() => fillUsage({ home, fs, segments: [...toFill] }));
  return { as_of: asOf(index), sessions, next, has_more };
}
