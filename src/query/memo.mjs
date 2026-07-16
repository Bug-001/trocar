// src/query/memo.mjs — server-process memoization (RFC 4.3 · D21). The board's per-session view
// (assembleSession = a full analyze over the session) would otherwise re-run on EVERY /api/session
// poll (~1.5s). Under the stateless-HTTP transport (D11-A) the cache is a SERVICE-process LRU keyed
// by (sessionId, source-signature, render-strategy-version); a source append changes the signature →
// key miss → recompute; unchanged polls are O(1). Miss recomputes from source (rebuildable → eviction
// is lossless). Bump RENDER_STRATEGY_VERSION to invalidate everything when the baked view shape changes.
export const RENDER_STRATEGY_VERSION = 'v1';

export function createLru(max = 8) {
  const m = new Map(); // insertion-ordered → front = LRU
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, // touch → MRU
    set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    has(k) { return m.has(k); },
    clear() { m.clear(); },
    get size() { return m.size; },
  };
}

export function memoKey(sessionId, sourceSig) {
  return `${sessionId}|${sourceSig}|${RENDER_STRATEGY_VERSION}`;
}

// memoize(lru, keyFn, fn): returns a function that caches fn's result under keyFn(...args).
export function memoize(lru, keyFn, fn) {
  return (...args) => {
    const k = keyFn(...args);
    if (lru.has(k)) return lru.get(k);
    const v = fn(...args);
    lru.set(k, v);
    return v;
  };
}
