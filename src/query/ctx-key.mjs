// src/query/ctx-key.mjs — the name of a session's directory under index/ctx/ (RFC 4.3 §4 目录): the first 32 hex of sha256(session id).
// Its own module so the daemon's board face (src/server.mjs, /api/d/*) names the same directory without loading the query core.
import { createHash } from 'node:crypto';

/** ctxKey(id) → the 32 hex characters that name the session's directory ctx/<k>/. */
export const ctxKey = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);

/** The two names of a session's head file (3.5 §会话读「`session --head`」): `folding` while it has a `pending` that is not `stopped`,
 *  `rest` otherwise; at most one exists. The daemon tells them apart by name alone (it parses no file, D63①). */
export const HEAD_FILES = Object.freeze({ rest: 'head.json.gz', folding: 'head.pending.json.gz' });
