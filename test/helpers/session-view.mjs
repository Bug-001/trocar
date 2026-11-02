// test/helpers/session-view.mjs — a TEST composition of production functions, not a production path. The tests that assert what
// the live assembler makes of a session read it through here: the session's records grouped by groupSessions(), folded by
// sessionFold() in step order, and every call put back with its body from its own record.
import { groupSessions, sessionFold } from '../../src/view/board.mjs';
import { stepOrder } from '../../src/view/analyze.mjs';

/** sessionView(records, sessionId) → the session document over `records` with every call bodied; null when no record has that key. */
export function sessionView(records, sessionId) {
  const recs = groupSessions(records).get(sessionId);
  if (!recs) return null;
  const f = sessionFold(sessionId);
  const recOf = new Map();
  for (const r of [...recs].sort(stepOrder)) { const c = f.push(r); if (c) recOf.set(c, r); }
  const view = f.view(recs);
  const A = view.analyzed;
  if (!A) return view;
  // `steps`, `lanes[].calls` and `streams[].calls` hold the SAME call objects (analyze() shares them): one map rewrites all three
  const done = new Map();
  const m = (c) => { if (!done.has(c)) done.set(c, f.filled(c, f.bodyOf(c, recOf.get(c)))); return done.get(c); };
  const lanes = (A.lanes || []).map((l) => ({ ...l, calls: (l.calls || []).map(m) }));
  const steps = (A.steps || []).map(m);
  const streams = (A.streams || []).map((st) => ({ ...st, calls: (st.calls || []).map(m) }));
  return { ...view, analyzed: { ...A, lanes, steps, streams } };
}
