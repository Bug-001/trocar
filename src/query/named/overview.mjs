// src/query/named/overview.mjs — `asight query overview` (RFC 1.6 §4.1, 附录 C.5 `overview`; 1.7 统计卡; 3.5 §访问模式).
//
// Everything but `usage` is ONE pass over the segment index rows: no record body is opened (3.5 MUST NOT). The window is
// C.5's: a session whose LAST call falls in [since, until] counts whole; a session-less row counts by its own ts.
// `usage` is the one part that needs record bodies (the token counters live in the replies), so it reads the in-window
// sessions newest first through the same assembly `session` uses, and stops before the session that would push the
// stored bytes read past OVERVIEW_USAGE_BYTES — `coverage` says how far it got and why it stopped (invariant 4).
import { sessionView } from '../../view/board.mjs';
import { mapUsage } from '../../model/schema.mjs';
import { recordsAt } from '../records.mjs';
import { asOf, indexRows, sessionFactsOf, sessionGroups } from '../rows.mjs';
import { rowsKey } from '../warm.mjs';
import { OVERVIEW_USAGE_BYTES, tsFilter } from './index.mjs';

export const params = Object.freeze(['since', 'until']);

const add = (sum, v) => (v == null ? sum : (sum ?? 0) + v);
// No window: every call is slimmed to its cheap meta (norm.usage, wire, status, rec.request.model), no body assembled.
const META_ONLY = Object.freeze({ cursor: 0, limit: 0 });

export async function run({ home, fs, now, params: p, errors }) {
  const keep = tsFilter(p, now);
  const all = await indexRows({ home, fs, errors });
  const counted = []; // [harness, rows] — one entry per in-window session, and one per in-window session-less row
  const inWindow = []; // [id, facts, rows] of the sessions
  for (const [id, rows] of sessionGroups(all)) {
    const facts = sessionFactsOf(id, rows);
    if (!keep(facts.last_ts)) continue;
    counted.push([facts.harness, rows, true]);
    inWindow.push([id, facts, rows]);
  }
  for (const r of all) if (!r.session_id && keep(r.ts)) counted.push([r.harness_id ?? null, [r], false]);

  const calls = { total: 0, llm: 0, logged: 0, failed: 0 }, bytes = { wire: null, stored: 0 }, by = new Map();
  for (const [harness, rows, isSession] of counted) {
    // llm / logged: the one rule the `sessions` document counts with (sessionFactsOf), not a second copy of it
    const f = sessionFactsOf(null, rows);
    let wire = null;
    for (const r of rows) {
      calls.total++;
      if (r.is_llm && (r.status == null || r.status >= 400)) calls.failed++;
      wire = add(add(wire, r.sent_bytes), r.received_bytes);
      bytes.stored += r.stored_bytes || 0;
    }
    calls.llm += f.calls; calls.logged += f.logged;
    bytes.wire = add(bytes.wire, wire);
    let h = by.get(harness);
    if (!h) by.set(harness, h = { harness, sessions: 0, calls: 0, bytes: null, last_ts: null });
    if (isSession) h.sessions++;
    h.calls += f.calls;
    h.bytes = add(h.bytes, wire);
    if (f.last_ts && !(h.last_ts >= f.last_ts)) h.last_ts = f.last_ts;
  }
  const harnesses = [...by.values()].sort((a, b) => String(a.harness ?? '\uffff').localeCompare(String(b.harness ?? '\uffff')));

  return { as_of: asOf(all), calls, bytes, sessions: { total: inWindow.length }, harnesses, usage: usageOf({ home, fs, inWindow, errors }) };
}

function usageOf({ home, fs, inWindow, errors }) {
  const newest = [...inWindow].sort((a, b) => (a[1].last_ts < b[1].last_ts ? 1 : a[1].last_ts > b[1].last_ts ? -1 : 0));
  const rows = new Map();
  let spent = 0, read = 0, capped = false;
  for (const [id, facts, own] of newest) {
    const cost = rowsKey(own).bytes;
    if (spent + cost > OVERVIEW_USAGE_BYTES) { capped = true; break; }
    spent += cost;
    read++;
    const view = sessionView(recordsAt({ home, fs, rows: own, errors }), id, { page: META_ONLY });
    if (!view) { errors.push({ where: `session/${id}`, reason: 'no record of this session could be read back' }); continue; }
    for (const lane of view.analyzed.lanes || []) for (const c of lane.calls || []) {
      const model = (c.rec && c.rec.request && c.rec.request.model) ?? null;
      const key = JSON.stringify([facts.harness, model, lane.kind]);
      let row = rows.get(key);
      if (!row) rows.set(key, row = { harness: facts.harness, model, lane: lane.kind, sessions: new Set(), calls: 0, failed: 0, no_usage: 0,
        input: 0, output: 0, cache_read: 0, cache_write: null, cache_known: true });
      row.sessions.add(id);
      row.calls++;
      if (!(c.wire && c.wire.cacheSemanticsKnown)) row.cache_known = false;
      if (c.status == null || c.status >= 400) { row.failed++; continue; }
      const u = canonical(c);
      if (!u) { row.no_usage++; continue; }
      row.input += u.input_uncached; row.output += u.output; row.cache_read += u.cache_read;
      row.cache_write = add(row.cache_write, u.cache_write);
    }
  }
  return {
    coverage: { sessions_read: read, sessions_in_window: inWindow.length, capped_at: capped ? OVERVIEW_USAGE_BYTES : null, reason: capped ? 'byte-budget' : null },
    rows: [...rows.values()].map((r) => ({ ...r, sessions: r.sessions.size })),
  };
}

// The 3.2 canonical usage of one call, by the wire it arrived in and the vendor that answered (the NULL-write rule is
// schema.mjs's, per vendor); null when the reply reported none, or in a wire format no mapping exists for.
function canonical(c) {
  const raw = c.norm && c.norm.usage;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length || !c.wire) return null;
  try { return mapUsage(c.wire.format, raw, { vendor: c.wire.vendor }); } catch { return null; }
}
