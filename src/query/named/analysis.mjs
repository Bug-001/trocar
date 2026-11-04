// src/query/named/analysis.mjs — `trocar query analysis` (RFC 3.5 §会话读「`analysis`」; 1.6 C.5; D81④; D14).
//
// A session's cost and totals, summed over the whole session up to its mark. Money is worked out per answer from the current price
// table and goes into no answer file (prices are not captured truth, D14), so this reads the session's columns, and a row's line only
// for a cache break. Sums run in step order: the same columns and prices give the same bytes.
import { QueryArgError } from './index.mjs';
import { markOn, sessionState, version as sessionVersion } from './session.mjs';
import { priceTable, pricingId } from './pricing.mjs';
import { CA, FLAG, modelAt, stateAt, usageAt, wireRow } from '../session-doc.mjs';
import { BREAK_STATES, breakUsd, bucketOf, costOf, priceMatch } from '../../view/metrics.mjs';

export const about = Object.freeze({
  summary: "One session's estimated cost and totals: per bucket, the main lane's cache hit and breaks, failures, and each step's price.",
  params: Object.freeze({
    id: 'The session: a session id, as the sessions query lists them. Required.',
  }),
});
export const params = Object.freeze(Object.keys(about.params));

const EASE_ROWS = 2000; // the rows summed between two turns of the event loop

const sums = () => ({ usd: 0, priced: 0, unpriced: 0, failed: 0, approx: 0, keys: new Set() });
const bucket = ({ keys, ...s }) => ({ ...s, usd: s.priced ? s.usd : null, approxKeys: [...keys].sort() });
const added = (list) => list.reduce((a, b) => ({ usd: a.usd + b.usd, priced: a.priced + b.priced, unpriced: a.unpriced + b.unpriced, failed: a.failed + b.failed,
  approx: a.approx + b.approx, keys: new Set([...a.keys, ...b.keys]) }), sums());

// The one rule for what a step costs, for the totals and the windows: step(rid) → the step's facts, its `usd` (microdollars or null)
// and its `brk`, the break on the main lane or null. `prices`: every model asked of it so far → its match.
function pricer({ cols, log, lanes }, table) {
  const kinds = new Map(lanes.map((l) => [cols.keys.get(l.lane), l.kind])), prices = new Map();
  const priceOf = (m) => { if (!prices.has(m)) prices.set(m, priceMatch(table, m)); return prices.get(m); };
  // a break's line says its comparison step, the one thing the columns do not hold
  const breakOf = (rid, k) => {
    const { missed, why } = wireRow(cols, log.read(...log.latest(rid)).r).cache, p = priceOf(modelAt(cols, k));
    if (why) return { rid, usd: null, why };
    return p ? { rid, usd: breakUsd(usageAt(cols, k), missed, p.row), why: null } : { rid, usd: null, why: 'no-price' };
  };
  const step = (rid) => {
    const k = cols.slotOf(rid), lane = cols.ln[k], kind = kinds.get(lane), model = modelAt(cols, k), p = priceOf(model), u = usageAt(cols, k);
    const failed = (cols.fl[k] & FLAG.failed) !== 0, b = cols.ca[k] & CA.PROBE ? null : bucketOf(kind);
    const cost = b == null || failed ? null : costOf(p && p.row, u);
    const brk = kind === 'main' && BREAK_STATES.has(stateAt(cols, k)) ? breakOf(rid, k) : null;
    return { rid, k, lane, kind, model, p, u, failed, b, cost, usd: cost == null ? null : Math.round(cost * 1e6), brk };
  };
  return { step, prices };
}
const modelsOf = (prices) => [...prices].filter(([m]) => m != null).sort(([a], [b]) => (a < b ? -1 : 1)).map(([model, p]) => ({ model, key: p ? p.key : null, exact: !!p && p.exact }));

// the whole session priced → the document's pricing.models, totals and usd. A slice gives way every EASE_ROWS rows; a background
// slice in flight may sync the columns meanwhile, so the walk is over the step order as it stands now.
async function totalsOf(ctx, { cols, lanes }, { step, prices }) {
  const cost = { main: sums(), sub: sums(), bg: sums() }, usd = {}, breaks = [], failedIn = new Map(), order = cols.order.slice();
  let read = 0, tot = 0, hitSteps = 0, cacheUnknown = false;
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && i % EASE_ROWS === 0) { await ctx.ease?.(); ctx.progress?.(); }
    const s = step(order[i]), { rid, k, b, u } = s;
    usd[rid] = s.usd;
    if (s.kind === 'main') {
      if (cols.ca[k] & CA.UNKNOWN) cacheUnknown = true;
      const t = s.failed || !u ? 0 : (u.read || 0) + (u.create || 0) + (u.fresh || 0);
      if (t > 0) { read += u.read || 0; tot += t; hitSteps++; }
      if (s.brk) breaks.push(s.brk);
    }
    if (b == null) continue;
    if (s.failed) { cost[b].failed++; if (!failedIn.has(s.lane)) failedIn.set(s.lane, rid); continue; }
    if (s.cost == null) { cost[b].unpriced++; continue; }
    cost[b].usd += s.cost; cost[b].priced++;
    if (!s.p.exact) { cost[b].approx++; cost[b].keys.add(s.p.key); }
  }
  const total = bucket(added([cost.main, cost.sub, cost.bg]));
  const counted = breaks.filter((x) => x.usd != null);
  const worst = counted.reduce((w, { rid, usd: v }) => (!w || v > w.usd ? { rid, usd: v } : w), null);
  const at = lanes.find((l) => failedIn.has(cols.keys.get(l.lane)));
  return {
    models: modelsOf(prices),
    totals: {
      cost: { main: bucket(cost.main), sub: bucket(cost.sub), bg: bucket(cost.bg), total },
      hit: tot > 0 ? read / tot : null, hitSteps, cacheUnknown, breaks,
      breakCost: { usd: counted.length ? counted.reduce((n, x) => n + x.usd, 0) : null, counted: counted.length, uncomputable: breaks.length - counted.length, worst },
      failed: total.failed, firstFailed: at ? { rid: failedIn.get(cols.keys.get(at.lane)), lane: at.lane } : null, unpricedSteps: total.unpriced,
    },
    usd,
  };
}

export async function run(ctx) {
  const { params: p, errors } = ctx, id = p.id == null || p.id === '' ? null : String(p.id);
  if (id == null) throw new QueryArgError('trocar query analysis: --id is required (a session id; `trocar query sessions` lists them)');
  const { table, source, problem } = priceTable(ctx);
  if (problem) errors.push(problem);
  const st = await sessionState(ctx, id);
  if (!st) {
    errors.push({ where: `session/${id}`, code: 'session-unknown', reason: 'no session with this id among the captured records' });
    return { mark: null, truncated: null, pricing: { source, models: [] }, totals: null, usd: {} };
  }
  errors.push(...st.errors, ...st.failed.map((f) => ({ where: f.id, code: f.code, reason: f.reason })));
  const { models, totals, usd } = await totalsOf(ctx, st.V, pricer(st.V, table));
  return { mark: markOn(st.plan, st.mark), ...(st.pending ? { pending: st.pending } : null), truncated: st.truncated, pricing: { source, models }, totals, usd };
}

/** version(ctx) → the session's version and the price identity: a new price is a new answer, as the stamp says too (the stamp alone
 *  would let the worker answer 304 on an equal version, the version alone would let the daemon answer it on an equal stamp). */
export async function version(ctx) {
  const v = await sessionVersion(ctx);
  return v && { key: JSON.stringify([v.key, pricingId(ctx)]), errors: v.errors };
}
