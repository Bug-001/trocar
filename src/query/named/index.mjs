// src/query/named/index.mjs — the named queries (RFC 1.6 §4.1, 附录 C.5; D59).
//
// ONE table: every name, its parameters and its run function. `asight query`, the board's
// `GET /api/<name>` and `--json` all come through runQuery, so there is one answer per name and no
// second read path. Every document carries `schema` · `command` · `ok` · `errors` (C.5); what a
// query could not read goes into `errors` and the document is still produced (D38).
import nodeFs from 'node:fs';
import { asightHome } from '../../paths.mjs';
import { SCHEMA_VERSION } from '../../cli/schema.mjs';
import * as segments from './segments.mjs';
import * as classes from './classes.mjs';

/** A name or a parameter the table does not have (1.6 §4.1 退出码 2). */
export class QueryArgError extends Error { constructor(m) { super(m); this.name = 'QueryArgError'; } }

export const QUERIES = Object.freeze({
  segments: { params: segments.params, run: segments.run },
  classes: { params: classes.params, run: classes.run },
});

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

const REL = /^(\d+)([mhd])$/;
const MS = { m: 60e3, h: 3600e3, d: 86400e3 };
/** ISO 8601, or a relative `30m` / `24h` / `7d` before `now` → ms since the epoch. Throws QueryArgError. */
export function parseTime(v, { name = 'time', now = Date.now() } = {}) {
  const s = String(v).trim(), rel = REL.exec(s);
  if (rel) return now - Number(rel[1]) * MS[rel[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new QueryArgError(`--${name}: ${JSON.stringify(v)} is neither an ISO 8601 time nor a relative one (30m / 24h / 7d)`);
  return t;
}

/**
 * runQuery(name, params, {home, fs, now}) → the document.
 * Throws QueryArgError for an unknown name or parameter; everything else it cannot read is in `errors`.
 */
export async function runQuery(name, params = {}, { home = asightHome(), fs = nodeFs, now = Date.now } = {}) {
  const q = QUERIES[name];
  if (!q) throw new QueryArgError(`asight query: no query called ${JSON.stringify(name)} (names: ${Object.keys(QUERIES).join(', ')})`);
  for (const k of Object.keys(params)) if (!q.params.includes(k)) throw new QueryArgError(`asight query ${name}: no parameter --${k} (its parameters: ${q.params.length ? q.params.map((p) => '--' + p).join(' ') : 'none'})`);
  const errors = [];
  const body = await q.run({ home, fs, now, params, errors });
  return { schema: SCHEMA_VERSION, command: name, ok: errors.length === 0, ...body, errors };
}
