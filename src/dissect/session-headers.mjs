// src/dissect/session-headers.mjs — the request headers that name a session, in priority order.
//
// RFC 3.4:21 wants ONE table of session keys shared by the ETL sharder, the D35 sealer and the board.
// That table (`src/dissect/harnesses.mjs`, D37) is not on main yet; until it lands, this is the list the
// board groups by (`src/view/assemble.mjs` SIDH), held here so the sealer — which may only import
// `src/dissect/` (0.1 §2) — reads the same keys. `test/raw/closed-and-key.test.mjs` fails if the two
// drift. Only HEADER keys belong here: the sealer never parses a request body (D20 的 D35 修订).
// Leaf module: imports nothing.

export const SESSION_HEADER_KEYS = Object.freeze(['x-claude-code-session-id', 'x-session-id', 'session-id', 'thread-id']);

export function sessionKeyOfHeaders(h) {
  if (!h || typeof h !== 'object') return null;
  for (const k of SESSION_HEADER_KEYS) if (h[k]) return h[k];
  return null;
}
