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
import * as sessions from './sessions.mjs';
import * as session from './session.mjs';
import * as calls from './calls.mjs';
import * as block from './block.mjs';
import * as pricing from './pricing.mjs';

/** A name or a parameter the table does not have (1.6 §4.1 退出码 2). */
export class QueryArgError extends Error { constructor(m) { super(m); this.name = 'QueryArgError'; } }

export const QUERIES = Object.freeze({
  // `status` and `doctor` are the same documents the two commands print: the query IS that document
  // (src/cli/status.mjs statusDoc / doctor.mjs doctorDoc), so the two can never disagree.
  status: { params: Object.freeze(['harness']), run: (c) => verdict('status', c) },
  doctor: { params: Object.freeze(['harness']), run: (c) => verdict('doctor', c) },
  sessions: { params: sessions.params, run: sessions.run },
  session: { params: session.params, run: session.run },
  calls: { params: calls.params, run: calls.run },
  block: { params: block.params, run: block.run },
  classes: { params: classes.params, run: classes.run },
  segments: { params: segments.params, run: segments.run },
  pricing: { params: pricing.params, run: pricing.run },
});

/**
 * The two documents a command produces, asked for by name, with the same `--harness` the command takes.
 * The module is imported on use, so a read of captured data does not pull the whole CLI in.
 */
async function verdict(name, { params, errors, userHome, env, platform, deps }) {
  const { resolveHarnesses } = await import('../../cli/harness-names.mjs');
  const named = resolveHarnesses(params.harness == null ? [] : [...listOf(params.harness)]);
  if (!named.ok) throw new QueryArgError(`asight query ${name}: --harness: no agent called ${named.unknown.join(', ')} (known: ${named.known.join(', ')})`);
  const mod = await import(name === 'status' ? '../../cli/status.mjs' : '../../cli/doctor.mjs');
  // `exit` is the command's own exit code, not part of the document (runDoctor drops it too).
  const { errors: own = [], exit: _exit, ...doc } = await (name === 'status' ? mod.statusDoc : mod.doctorDoc)({ names: named.ids, home: userHome, env, platform, deps });
  errors.push(...own);
  return doc;
}

// ── parameters every list query shares (§4.1 参数) ────────────────────────────
export const LIMIT_DEFAULT = 50, LIMIT_MAX = 500;
const whole = (v, name, dflt) => {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new QueryArgError(`--${name}: ${JSON.stringify(v)} is not a whole number`);
  return n;
};
/** `--limit` (default 50, at most 500) and `--cursor` as one window. */
export const pageSpec = (p = {}) => ({
  cursor: whole(p.cursor, 'cursor', 0),
  limit: Math.min(LIMIT_MAX, Math.max(1, whole(p.limit, 'limit', LIMIT_DEFAULT))),
});
/** One page of `list` → {items, next, has_more}: `next` IS the next page's `--cursor`. */
export function paginate(list, p = {}) {
  const { cursor, limit } = pageSpec(p);
  const to = cursor + limit;
  return { items: list.slice(cursor, to), next: to < list.length ? String(to) : null, has_more: to < list.length };
}
/** A list parameter: comma-separated values, or null when it was not given. */
export const listOf = (v) => (v == null ? null : new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean)));
/** `--since` / `--until` as one predicate over a record's timestamp. A record with no time is kept only when neither was given. */
export function tsFilter(p = {}, now = Date.now) {
  if (p.since == null && p.until == null) return () => true;
  const since = p.since == null ? null : parseTime(p.since, { name: 'since', now: now() });
  const until = p.until == null ? null : parseTime(p.until, { name: 'until', now: now() });
  return (ts) => {
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isNaN(t)) return false;
    return (since == null || t >= since) && (until == null || t <= until);
  };
}

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
 * runQuery(name, params, {home, fs, now, userHome, env, platform, deps}) → the document.
 * `home` is ~/.asight; the rest of the context is handed to the query as it is, for `status` / `doctor`,
 * which read the machine (`userHome` = the user's home, and whatever a test injects in `deps`).
 * Throws QueryArgError for an unknown name or parameter; everything else it cannot read is in `errors`.
 */
export async function runQuery(name, params = {}, ctx = {}) {
  const { home = asightHome(), fs = nodeFs, now = Date.now } = ctx;
  const q = QUERIES[name];
  if (!q) throw new QueryArgError(`asight query: no query called ${JSON.stringify(name)} (names: ${Object.keys(QUERIES).join(', ')})`);
  for (const k of Object.keys(params)) if (!q.params.includes(k)) throw new QueryArgError(`asight query ${name}: no parameter --${k} (its parameters: ${q.params.length ? q.params.map((p) => '--' + p).join(' ') : 'none'})`);
  const errors = [];
  const body = await q.run({ ...ctx, home, fs, now, params, errors });
  return { schema: SCHEMA_VERSION, command: name, ok: errors.length === 0, ...body, errors };
}
