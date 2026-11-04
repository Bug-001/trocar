// src/query/named/analysis.mjs — `trocar query analysis` (RFC 3.5 §会话读「`analysis`」; 1.6 C.5; D81④; D14).
//
// A session's cost and totals, summed over the whole session up to its mark, or with --from, --to or --since one window of what each
// step cost. Money is worked out per answer from the current price table and goes into no answer file (prices are not captured truth,
// D14), so this reads the session's columns and no row of its fold log. Sums run in step order: the same columns and
// prices give the same bytes. The default document stays the same size however long the session is; what grows with it is in windows.
// In the worker it is summed at most every ANALYSIS_EVERY_MS while the session moves; its `mark` says how old the sums are.
import { QueryArgError } from './index.mjs';
import { markOn, sayUnknown, sessionState, sinceAt, version as sessionVersion } from './session.mjs';
import { priceTable, pricingId } from './pricing.mjs';
import { CA, FLAG, modelAt, refAt, stateAt, usageAt } from '../session-doc.mjs';
import { axisOf } from '../ctx-files.mjs';
import { BREAK_STATES, breakUsd, bucketOf, costOf, missedOf, priceMatch } from '../../view/metrics.mjs';

export const about = Object.freeze({
  summary: "One session's estimated cost and totals: per bucket, the main lane's cache hit and break cost, failures, and how many steps are problems. While the answer has pending, the totals are the sums so far: wait until it is gone before using them. With --from, --to or --since, one page of each step's price and the breaks instead of the totals.",
  params: Object.freeze({
    id: 'The session: a session id, as the sessions query lists them. Required.',
    from: "A record id: gives the steps after it. One that is no step of the session gives the last page. Give at most one of --from, --to and --since.",
    to: 'A record id: gives the page that ends just before it. Give at most one of --from, --to and --since.',
    since: 'The mark of an earlier answer: gives the steps that are new or changed since it. One not recognised gives the last page. Give at most one of --from, --to and --since.',
  }),
});
export const params = Object.freeze(Object.keys(about.params));

/** The bound on a window's `usd` and `breaks` together (3.5 §会话读「`analysis`」). */
export const ANALYSIS_PAGE_BYTES = 64 * 1024;
/** How often the worker sums a session's default document while its version moves: the board's `INTERVAL.other` (3.5 节流). */
export const ANALYSIS_EVERY_MS = 30_000;
const EASE_ROWS = 2000; // the rows summed between two turns of the event loop
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v));
const EMPTY_PAGE = bytesOf({ usd: {}, breaks: [] });

const PROBLEM = FLAG.cacheBreak | FLAG.failed; // the bits of a problem step in the head's `cols`
const sums = () => ({ usd: 0, priced: 0, unpriced: 0, failed: 0, approx: 0, keys: new Set() });
const bucket = ({ keys, ...s }) => ({ ...s, usd: s.priced ? s.usd : null, approxKeys: [...keys].sort() });
const added = (list) => list.reduce((a, b) => ({ usd: a.usd + b.usd, priced: a.priced + b.priced, unpriced: a.unpriced + b.unpriced, failed: a.failed + b.failed,
  approx: a.approx + b.approx, keys: new Set([...a.keys, ...b.keys]) }), sums());

// The one rule for what a step costs, for the totals and the windows: step(rid) → the step's facts, its `usd` (microdollars or null)
// and its `brk`, the break on the main lane or null. `prices`: every model asked of it so far → its match.
function pricer({ cols, lanes }, table) {
  const kinds = new Map(lanes.map((l) => [cols.keys.get(l.lane), l.kind])), prices = new Map();
  const priceOf = (m) => { if (!prices.has(m)) prices.set(m, priceMatch(table, m)); return prices.get(m); };
  // what a break missed, as the row's `cache` says it (cacheFacts): the step's usage against its comparison step's
  const breakOf = (rid, k) => {
    const ref = refAt(cols, k), { missed, why } = missedOf(usageAt(cols, k), ref.usage, ref.has), p = priceOf(modelAt(cols, k));
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

// the whole session priced → the default document's pricing.models and totals. Every EASE_ROWS rows it yields the event loop and says progress; a background
// slice in flight may sync the columns meanwhile, so the walk is over the step order as it stands now.
async function totalsOf(ctx, V, { step, prices }) {
  const { cols, lanes } = V, axis = cols.keys.get(axisOf(V));
  const cost = { main: sums(), sub: sums(), bg: sums() }, breaks = [], failedIn = new Map(), order = cols.order.slice();
  let read = 0, tot = 0, hitSteps = 0, cacheUnknown = false, problems = 0;
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && i % EASE_ROWS === 0) { await ctx.ease?.(); ctx.progress?.(); }
    const s = step(order[i]), { rid, k, b, u } = s;
    if (s.kind === 'main') {
      if (cols.ca[k] & CA.UNKNOWN) cacheUnknown = true;
      const t = s.failed || !u ? 0 : (u.read || 0) + (u.create || 0) + (u.fresh || 0);
      if (t > 0) { read += u.read || 0; tot += t; hitSteps++; }
      if (s.brk) breaks.push(s.brk);
    }
    if (s.lane === axis && cols.fl[k] & PROBLEM) problems++;
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
      hit: tot > 0 ? read / tot : null, hitSteps, cacheUnknown,
      breakCost: { usd: counted.length ? counted.reduce((n, x) => n + x.usd, 0) : null, counted: counted.length, uncomputable: breaks.length - counted.length, worst },
      failed: total.failed, firstFailed: at ? { rid: failedIn.get(cols.keys.get(at.lane)), lane: at.lane } : null, unpricedSteps: total.unpriced, problems,
    },
  };
}

// the steps of `rids` from `at` going `dir` that fit a page, one at least, in step order
function grown(rids, at, dir, step) {
  const page = [];
  let bytes = EMPTY_PAGE;
  for (let i = at; i >= 0 && i < rids.length; i += dir) {
    const s = step(rids[i]), w = bytesOf([s.rid, s.usd, s.brk]); // past what the entry and its break take in the page
    if (page.length && bytes + w > ANALYSIS_PAGE_BYTES) break;
    bytes += w; page.push(s);
  }
  return dir > 0 ? page : page.reverse();
}

// one window of the session: only its steps are priced. `--since` goes through the steps that changed past M's frontier line, a page
// of them, and `next` hands on to --from; a reset (a --from or M not known) is the tail page, as no parameter is.
function windowOf(st, { step }, { from, to, since }) {
  const { log } = st.st, order = st.V.cols.order;
  const M = since == null ? null : sinceAt(st.plan, since), off = M == null ? null : log.frontierAt(M);
  const changed = off == null ? null : new Set(log.changedSince(off).rids);
  const rids = changed ? order.filter((r) => changed.has(r)) : order;
  const after = from == null ? -1 : rids.indexOf(from), before = to == null ? -1 : rids.indexOf(to);
  const forward = changed != null || after >= 0, hi0 = before >= 0 ? before : rids.length;
  const page = forward ? grown(rids, after + 1, 1, step) : grown(rids, hi0 - 1, -1, step);
  const lo = forward ? after + 1 : hi0 - page.length, hi = lo + page.length;
  return {
    base: changed ? since : after >= 0 ? from : null, page,
    prev: !changed && lo > 0 && page.length ? rids[lo] : null, next: hi < rids.length && page.length ? rids[hi - 1] : null,
  };
}

const one = (v) => (v == null || v === '' ? null : String(v));
const windowsIn = ({ from, to, since }) => [from, to, since].filter((v) => one(v) != null).length;

// THE THROTTLE (3.5 节流): the sums the worker last made of a session's default document, by home and id, oldest out first. Between
// two sums `version` says null while the session has moved on: those sums are not this version's, so they must be neither kept under
// it nor tagged. Kept, they would stay the answer once the session stops growing; tagged, the daemon would answer 304 on them.
const HELD_SESSIONS = 8;
const held = new Map();
const heldAt = ({ home, params }) => `${home}\n${one(params.id)}`;
const priceOf = (ctx) => JSON.stringify(pricingId(ctx));
function standing(ctx, price) {
  if (ctx.writer !== true || windowsIn(ctx.params)) return null;
  const h = held.get(heldAt(ctx));
  return h && (ctx.now || Date.now)() - h.at < ANALYSIS_EVERY_MS && h.price === price ? h : null;
}
function hold(ctx, entry) {
  const at = heldAt(ctx);
  held.delete(at);
  held.set(at, entry);
  if (held.size > HELD_SESSIONS) held.delete(held.keys().next().value);
}

export async function run(ctx) {
  const { params: p, errors } = ctx, id = one(p.id), asked = { from: one(p.from), to: one(p.to), since: one(p.since) };
  if (id == null) throw new QueryArgError('trocar query analysis: --id is required (a session id; `trocar query sessions` lists them)');
  const windows = windowsIn(asked);
  if (windows > 1) throw new QueryArgError('trocar query analysis: give at most one of --from, --to and --since');
  const price = priceOf(ctx), { table, source, problem } = priceTable(ctx);
  if (problem) errors.push(problem);
  const st = await sessionState(ctx, id);
  if (!st) {
    await sayUnknown(ctx, id);
    const pricing = { source, models: [] };
    return windows ? { base: null, mark: null, truncated: null, pricing, usd: {}, breaks: [], prev: null, next: null } : { mark: null, truncated: null, pricing, totals: null };
  }
  errors.push(...st.errors, ...st.failed.map((f) => ({ where: f.id, code: f.code, reason: f.reason })));
  const priced = pricer(st.V, table), head = { mark: markOn(st.plan, st.mark), ...(st.pending ? { pending: st.pending } : null), truncated: st.truncated };
  if (!windows) {
    // only the sums are held: `pending` is this moment's, and sums made while folding end with it, so the answer without it is whole
    const h = standing(ctx, price);
    if (h && (st.pending || !h.partial)) return { mark: h.mark, ...(st.pending ? { pending: st.pending } : null), truncated: h.truncated, pricing: h.pricing, totals: h.totals };
    const { models, totals } = await totalsOf(ctx, st.V, priced), pricing = { source, models };
    if (ctx.writer === true) hold(ctx, { at: (ctx.now || Date.now)(), price, key: (await versionNow(ctx)).key, partial: !!st.pending, mark: head.mark, truncated: st.truncated, pricing, totals });
    return { ...head, pricing, totals };
  }
  const { base, page, prev, next } = windowOf(st, priced, asked);
  return {
    base, ...head, pricing: { source, models: modelsOf(new Map(page.map((s) => [s.model, s.p]))) },
    usd: Object.fromEntries(page.map((s) => [s.rid, s.usd])), breaks: page.flatMap((s) => (s.brk ? [s.brk] : [])), prev, next,
  };
}

async function versionNow(ctx) {
  const v = await sessionVersion(ctx);
  return v && { key: JSON.stringify([v.key, pricingId(ctx)]), errors: v.errors };
}

/** version(ctx) → the session's version and the price identity: a new price is a new answer, as the stamp says too (the stamp alone
 *  would let the worker answer 304 on an equal version, the version alone would let the daemon answer it on an equal stamp). null
 *  while the throttle holds sums of another version. */
export async function version(ctx) {
  const v = await versionNow(ctx), h = v && standing(ctx, priceOf(ctx));
  return h && h.key !== v.key ? null : v;
}
