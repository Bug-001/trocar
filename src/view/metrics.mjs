// src/view/metrics.mjs — the cache verdict and the cost arithmetic of the query layer (spec 2.2 §缓存判定 · §多花怎么算 · §花费; 3.5).
// Pure: no I/O, no node modules. Price-free facts (cacheState, missedOf, cacheFacts) may go into answers; anything that takes a price
// row is computed per answer from the current table.
//
// The algorithm exists twice for now: web/legacy/core/metrics.mjs is the board's copy. Delete that one when the board moves to the
// query fields; test/view/metrics.test.mjs holds a guard against drift until then.

// The causes that say nothing changed in the cache prefix.
export const QUIET_CAUSES = new Set(['append', 'first-call', 'volatile-nonce-only']);

export const CACHE_STATES = Object.freeze(['failed', 'no-usage', 'first', 'ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit', 'reused', 'unjudged']);
export const BREAK_STATES = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit']);
const LOW_HIT = 0.3;

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** A row's usage {read, create, fresh, out}, or null when the wire returned none. `create` stays null when the vendor has no cache-write counter. */
export const usageOf = (row) => (row && row.usage && typeof row.usage === 'object' ? row.usage : null);

/** read / (read + create + fresh); null when there is no usage or nothing was measured, never a zero hit. */
export function hitRatio(u) {
  if (!u) return null;
  const tot = (u.read || 0) + (u.create || 0) + (u.fresh || 0);
  return tot > 0 ? (u.read || 0) / tot : null;
}

const gtOf = (row) => (row.gt !== undefined ? row.gt : (row.cacheBreak && row.cacheBreak.gt) || null);

/** The state of a step, by the table in 2.2 §缓存判定; the first match wins. → {state, isBreak, hit, warm, quiet, zeroInput}
 *  `unjudged` = usage but no cacheBreak: nothing to compare, neither a break nor reused. */
export function cacheState(row) {
  const mk = (state, extra) => ({ state, isBreak: BREAK_STATES.has(state), hit: null, warm: false, quiet: null, zeroInput: false, ...extra });
  if (row.error) return mk('failed');
  const u = usageOf(row);
  const hit = hitRatio(u);
  if (hit == null) return mk('no-usage', { zeroInput: !!u });
  const b = row.cacheBreak;
  if (!b) return mk('unjudged', { hit });
  if (b.firstCall || b.cause === 'first-call') return mk('first', { hit, warm: (u.read || 0) > 0 });
  const gt = gtOf(row);
  if (gt === 'ttl-rebuild' || gt === 'provider-contradiction') return mk(gt, { hit });
  if (b.cause && !QUIET_CAUSES.has(b.cause)) return mk('changed', { hit });
  if (hit < LOW_HIT) return mk('low-hit', { hit });
  return mk('reused', { hit, quiet: b.cause === 'volatile-nonce-only' ? 'volatile-nonce-only' : 'append' });
}

/** Tokens the comparison step had cached that this step did not read. `u` / `r` = the two usages, `hasRef` = a comparison step exists.
 *  → {missed, why}: a value it needs is NULL → missed null with the reason, never 0. */
export function missedOf(u, r, hasRef) {
  const none = (why) => ({ missed: null, why });
  if (!hasRef) return none('no-ref');
  if (!u || !r || !num(u.read)) return none('no-usage');
  if (!num(r.read) || !num(r.create)) return none('no-write-counter');
  return { missed: Math.max(0, r.read + r.create - u.read), why: null };
}

/** A row's `cache` (3.5). `ref` = {has, usage}: whether the row names a comparison step, and that step's usage or null. Absent facts are left out. */
export function cacheFacts(row, ref) {
  const c = cacheState(row);
  const out = { state: c.state };
  if (c.hit != null) out.hit = c.hit;
  if (c.warm) out.warm = true;
  if (c.quiet) out.quiet = c.quiet;
  if (c.zeroInput) out.zeroInput = true;
  if (c.isBreak) {
    out.break = true;
    const { missed, why } = missedOf(usageOf(row), ref.usage, ref.has);
    if (why) out.why = why; else out.missed = missed;
  }
  return out;
}

const isRow = (v) => Array.isArray(v) && v.length === 4;

/** table = {key: [input, output, cache_write, cache_read]} in $/Mtok. → {row, key, exact} | null. The same name first; otherwise the
 *  longest key that occurs in the model id (equal lengths: lexical order), exact:false. An empty key is no key; no key → null, never a guess. */
export function priceMatch(table, model) {
  if (!table || !model) return null;
  if (Object.prototype.hasOwnProperty.call(table, model) && isRow(table[model])) return { row: table[model], key: model, exact: true };
  const id = String(model);
  const key = Object.keys(table).filter((k) => k && isRow(table[k]) && id.includes(k)).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0];
  return key == null ? null : { row: table[key], key, exact: false };
}

/** Estimated dollars of one call. NULL counters count as 0 only inside a priced row; no row or no usage → null, not $0. */
export function costOf(row, u) {
  if (!row || !u) return null;
  return ((u.fresh || 0) * row[0] + (u.out || 0) * row[1] + (u.create || 0) * row[2] + (u.read || 0) * row[3]) / 1e6;
}

/** Dollars a break cost: the missed tokens at what was paid (cache write when `create` is a number, else uncached input) minus a cache read. */
export const breakUsd = (u, missed, row) => (missed * ((num(u.create) ? row[2] : row[0]) - row[3])) / 1e6;

/** The cost bucket of a lane kind: main, sub, null (not billed), and bg for every other kind, known or not. */
export const bucketOf = (kind) => (kind === 'main' ? 'main' : kind === 'subagent' ? 'sub' : kind === 'token-count' ? null : 'bg');
