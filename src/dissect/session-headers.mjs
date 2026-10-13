// src/dissect/session-headers.mjs — the request headers that name a session, in priority order.
//
// RFC 3.4:21 wants ONE table of session keys shared by the ETL sharder, the D35 sealer and the board.
// That table is `src/dissect/harnesses.mjs` (D37): the sharder (`src/etl/shard.mjs`) and the board
// (`sessionIdOf` in `src/view/assemble.mjs`) read it. The sealer (`src/raw/session-key.mjs`) reads the
// fixed list below instead, which holds four of the table's header keys, and `test/raw/closed-and-key.test.mjs`
// fails if the two disagree on those four. Only HEADER keys belong here: the sealer never parses a request body (D20 的 D35 修订).
// Leaf module: imports nothing.

export const SESSION_HEADER_KEYS = Object.freeze(['x-claude-code-session-id', 'x-session-id', 'session-id', 'thread-id']);

export function sessionKeyOfHeaders(h) {
  if (!h || typeof h !== 'object') return null;
  for (const k of SESSION_HEADER_KEYS) if (h[k]) return h[k];
  return null;
}
