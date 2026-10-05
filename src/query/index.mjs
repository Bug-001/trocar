// src/query/index.mjs — the single named-query contract face (RFC 3.5 · Phase-2 unit 13).
// The server/frontend call queries BY NAME through runNamed(); nobody assembles raw table/column
// names, so a schema change breaks in ONE place (here), not scattered across call sites. Every
// result already speaks provider-neutral CANONICAL vocabulary (invariant 3).
import {
  listSessions, sessionCalls, sessionComposition, sessionResources, callContext,
  filesEverInContext, cacheHitDistribution, breakKindComparison, unmappedFields,
  forkTree, resourceLifecycle,
} from './queries.mjs';

// name -> { fn, args } where args names the positional params after the connection (for validation).
export const NAMED_QUERIES = {
  // per-session
  sessions: { fn: listSessions, args: [] },
  sessionCalls: { fn: sessionCalls, args: ['sessionId'] },
  sessionComposition: { fn: sessionComposition, args: ['sessionId'] },
  sessionResources: { fn: sessionResources, args: ['sessionId'] },
  resourceLifecycle: { fn: resourceLifecycle, args: ['sessionId'] },
  forkTree: { fn: forkTree, args: ['rootId'] },
  callContext: { fn: callContext, args: ['callId', 'resolve'] },
  // cross-session analysis (signature ②)
  filesEverInContext: { fn: filesEverInContext, args: [] },
  cacheHitDistribution: { fn: cacheHitDistribution, args: [] },
  breakKindComparison: { fn: breakKindComparison, args: [] },
  unmappedFields: { fn: unmappedFields, args: [] },
};

// runNamed(conn, name, params?) — params is an object keyed by the query's arg names. Throws on an
// unknown name or a missing required arg (so a typo fails loudly at the contract, not as bad SQL).
export function runNamed(conn, name, params = {}) {
  const entry = NAMED_QUERIES[name];
  if (!entry) throw new Error(`unknown named query: ${name}`);
  const args = entry.args.map((a) => {
    if (!(a in params)) throw new Error(`named query ${name} missing arg: ${a}`);
    return params[a];
  });
  return entry.fn(conn, ...args);
}
