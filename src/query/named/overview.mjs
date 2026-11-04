// src/query/named/overview.mjs — `trocar query overview` (RFC 1.6 §4.1, 附录 C.5 `overview`; 1.7 统计卡; 3.5 §访问模式).
//
// Everything but `usage` is ONE pass over the segment index rows: no record body is opened (3.5 MUST NOT). The window is
// C.5's: a session whose LAST call falls in [since, until] counts whole; a session-less row counts by its own ts.
// `usage` needs each call's token counters, which live in the replies: it takes them from the per-segment usage sidecars
// (src/query/usage.mjs, 4.2 §用量旁注) — every call they cover is summed — and computes the calls they do not cover yet
// through the same assembly, newest session first and newest call first, until the first one that would push those
// computed bytes past OVERVIEW_USAGE_BYTES: from there nothing more is computed, in this session or a later one.
// `coverage` says how many sessions and calls it read and why it stopped (invariant 4). With `later` (the query worker),
// every missing segment is filled after the answer is written.
// The money and the hit (D81④) are worked out from `usage.rows` and the current price table on every answer, never stored:
// a sum runs in row order, so the document depends only on the calls read and the table.
import { failedOf } from '../../dissect/endpoints.mjs';
import { recordsAt } from '../records.mjs';
import { readUsage, fillUsage, usageFacts, takeFillProblem } from '../usage.mjs';
import { asOf, indexRows, isModelCall, sessionFactsOf, sessionGroups } from '../rows.mjs';
import { rowsKey } from '../warm.mjs';
import { costOf, hitRatio, priceMatch } from '../../view/metrics.mjs';
import { OVERVIEW_USAGE_BYTES, tsFilter } from './index.mjs';
import { priceTable } from './pricing.mjs';

export const params = Object.freeze(['since', 'until']);

const add = (sum, v) => (v == null ? sum : (sum ?? 0) + v);

export async function run({ home, fs, env, now, params: p, errors, later = null, progress = null }) {
  const keep = tsFilter(p, now);
  const all = await indexRows({ home, fs, errors, progress });
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
      if (r.is_llm && failedOf({ status: r.status, ws: r.ws })) calls.failed++;
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

  return { as_of: asOf(all), calls, bytes, sessions: { total: inWindow.length }, harnesses, usage: usageOf({ home, fs, env, inWindow, errors, later }) };
}

const metered = (r) => r.calls - r.failed - r.no_usage;

/** A row with its price and dollars. A row with nothing metered has no dollars, priced or not. */
function priced(r, table) {
  const m = priceMatch(table, r.model);
  const usd = m && metered(r) > 0 ? costOf(m.row, { fresh: r.input, out: r.output, create: r.cache_write, read: r.cache_read }) : null;
  return { ...r, usd, price: m && { key: m.key, exact: m.exact } };
}

// 1.7 §估价规则: a failed call has no usage and no price, and does not make the sum a floor.
function costOfRows(rows, partial) {
  let usd = null, no_usage = 0, unpriced = 0;
  for (const r of rows) {
    usd = add(usd, r.usd);
    no_usage += r.no_usage;
    if (!r.price && metered(r) > 0) unpriced++;
  }
  return { usd, floor: no_usage > 0 || unpriced > 0 || partial, no_usage, unpriced, partial };
}

// 1.7 主对话缓存命中: a null cache_write stays out of the denominator and makes the ratio uncertain.
function hitOfRows(rows) {
  const main = rows.filter((r) => r.lane === 'main'), u = { read: 0, create: 0, fresh: 0 };
  for (const r of main) { u.read += r.cache_read; u.create += r.cache_write ?? 0; u.fresh += r.input; }
  return { ratio: hitRatio(u), uncertain: main.some((r) => !r.cache_known || r.cache_write == null), main_rows: main.length };
}

// `rows`: before their session sets become counts, for a session can sit in several rows of a model.
function unpricedOf(rows, table) {
  const by = new Map();
  for (const r of rows) {
    if (priceMatch(table, r.model) || metered(r) <= 0) continue;
    const model = r.model || null;
    by.set(model, new Set([...(by.get(model) ?? []), ...r.sessions]));
  }
  return [...by].map(([model, sessions]) => ({ model, sessions: sessions.size }));
}

function usageOf({ home, fs, env, inWindow, errors, later }) {
  const newest = [...inWindow].sort((a, b) => (a[1].last_ts < b[1].last_ts ? 1 : a[1].last_ts > b[1].last_ts ? -1 : 0));
  const needed = isModelCall;
  const fill = takeFillProblem({ home, fs }); // what the fill after an earlier answer could not do, said once (D38)
  if (fill) errors.push(fill);
  const notes = new Map(); // segment → its sidecar (or null), read once per answer; its problems said on first use (D38)
  const note = (segment) => {
    if (!notes.has(segment)) {
      const n = readUsage({ home, segment, fs });
      notes.set(segment, n);
      if (n) for (const { where, reason } of n.problems) errors.push({ where, reason });
    }
    return notes.get(segment);
  };
  const rows = new Map(), toFill = new Set();
  const newer = (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.lineNo - a.lineNo);
  let spent = 0, read = 0, callsIn = 0, callsRead = 0, capped = false;
  for (const [id, facts, own] of newest) {
    const need = own.filter(needed);
    callsIn += need.length;
    const missing = need.filter((r) => { const n = note(r.segment); return !(n && r.lineNo <= n.lines); });
    for (const r of missing) toFill.add(r.segment);
    const taken = new Set();
    for (const r of [...missing].sort(newer)) {
      if (capped) break;
      const cost = rowsKey([r]).bytes;
      if (spent + cost > OVERVIEW_USAGE_BYTES) { capped = true; break; }
      spent += cost;
      taken.add(r);
    }
    const took = missing.filter((r) => taken.has(r));
    const computed = taken.size ? new Map(usageFacts({ rows: took, records: recordsAt({ home, fs, rows: took, errors, remember: false }) }).map((f) => [f.id, f])) : null;
    callsRead += need.length - missing.length + taken.size;
    if (taken.size === missing.length) read++;
    for (const r of need) {
      const n = note(r.segment);
      const f = (n && r.lineNo <= n.lines ? n.facts.get(r.lineNo) : computed && computed.get(r.id));
      if (!f) continue; // not a call `session` assembles (only counted in the coverage)
      const key = JSON.stringify([facts.harness, f.model, f.lane]);
      let row = rows.get(key);
      if (!row) rows.set(key, row = { harness: facts.harness, model: f.model, lane: f.lane, sessions: new Set(), calls: 0, failed: 0, no_usage: 0,
        input: 0, output: 0, cache_read: 0, cache_write: null, cache_known: true });
      row.sessions.add(id);
      row.calls++;
      if (!f.cache_known) row.cache_known = false;
      if (f.failed) { row.failed++; continue; }
      const u = f.usage;
      if (!u) { row.no_usage++; continue; }
      row.input += u[0]; row.output += u[1]; row.cache_read += u[2];
      row.cache_write = add(row.cache_write, u[3]);
    }
  }
  // After the answer is written, and only where there is a next query (the worker's `later`): the one-shot CLI never writes one.
  if (later && toFill.size) later(() => fillUsage({ home, fs, segments: [...toFill] }));
  const cmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : String(a) < String(b) ? -1 : 1);
  const { table, source } = priceTable({ home, env });
  const ordered = [...rows.values()].sort((a, b) => cmp(a.harness, b.harness) || cmp(a.model, b.model) || cmp(a.lane, b.lane));
  const sorted = ordered.map((r) => priced({ ...r, sessions: r.sessions.size }, table));
  const partial = callsRead < callsIn, groups = Map.groupBy(sorted, (r) => r.harness);
  return {
    coverage: { sessions_read: read, sessions_in_window: inWindow.length, calls_read: callsRead, calls_in_window: callsIn,
      capped_at: capped ? OVERVIEW_USAGE_BYTES : null, reason: capped ? 'byte-budget' : null },
    rows: sorted,
    cost: costOfRows(sorted, partial),
    hit: hitOfRows(sorted),
    harnesses: [...groups].map(([harness, own]) => ({ harness, cost: costOfRows(own, partial), hit: hitOfRows(own) })),
    unpriced: unpricedOf(ordered, table),
    pricing: { source },
  };
}
