// src/query/named/index.mjs — the named queries (RFC 1.6 §4.1, 附录 C.5; D59).
//
// ONE table: every name, its parameters and its run function. `trocar query`, the board's
// `GET /api/<name>` and `--json` all come through runQuery, so there is one answer per name and no
// second read path. Every document carries `schema` · `command` · `ok` · `errors` (C.5); what a
// query could not read goes into `errors` and the document is still produced (D38).
import nodeFs from 'node:fs';
import { trocarHome } from '../../paths.mjs';
import { SCHEMA_VERSION } from '../../cli/schema.mjs';
import * as segments from './segments.mjs';
import * as classes from './classes.mjs';
import * as sessions from './sessions.mjs';
import * as session from './session.mjs';
import * as calls from './calls.mjs';
import * as block from './block.mjs';
import * as pricing from './pricing.mjs';
import * as traffic from './traffic.mjs';
import * as overview from './overview.mjs';
import { createHash } from 'node:crypto';
import * as src from '../stamp.mjs';

/** A name or a parameter the table does not have (1.6 §4.1 退出码 2). */
export class QueryArgError extends Error { constructor(m) { super(m); this.name = 'QueryArgError'; } }

export const QUERIES = Object.freeze({
  // `status` and `doctor` are the same documents the two commands print: the query IS that document
  // (src/cli/status.mjs statusDoc / doctor.mjs doctorDoc), so the two can never disagree.
  status: { params: Object.freeze(['harness']), run: (c) => verdict('status', c), stamp: () => null },
  doctor: { params: Object.freeze(['harness']), run: (c) => verdict('doctor', c), stamp: () => null },
  sessions: { params: sessions.params, run: sessions.run, stamp: src.usage }, // its titles come from the usage sidecars (4.4 §人类标题的来源)
  session: { params: session.params, run: session.run, version: session.version, stamp: src.corpus },
  calls: { params: calls.params, run: calls.run, stamp: src.corpus },
  traffic: { params: traffic.params, run: traffic.run, stamp: src.corpus },
  overview: { params: overview.params, run: overview.run, stamp: src.usage },
  block: { params: block.params, run: block.run, stamp: src.corpus },
  classes: { params: classes.params, run: classes.run, stamp: src.classes, clock: true },
  segments: { params: segments.params, run: segments.run, stamp: src.corpus },
  pricing: { params: pricing.params, run: pricing.run, stamp: src.pricing },
});

/**
 * The two documents a command produces, asked for by name, with the same `--harness` the command takes.
 * The module is imported on use, so a read of captured data does not pull the whole CLI in.
 */
async function verdict(name, { params, errors, userHome, env, platform, deps }) {
  const { resolveHarnesses } = await import('../../cli/harness-names.mjs');
  const named = resolveHarnesses(params.harness == null ? [] : [...listOf(params.harness)]);
  if (!named.ok) throw new QueryArgError(`trocar query ${name}: --harness: no agent called ${named.unknown.join(', ')} (known: ${named.known.join(', ')})`);
  const mod = await import(name === 'status' ? '../../cli/status.mjs' : '../../cli/doctor.mjs');
  // `exit` is the command's own exit code, not part of the document (runDoctor drops it too).
  const { errors: own = [], exit: _exit, ...doc } = await (name === 'status' ? mod.statusDoc : mod.doctorDoc)({ names: named.ids, home: userHome, env, platform, deps });
  errors.push(...own);
  return doc;
}

// ── parameters every list query shares (§4.1 参数) ────────────────────────────
export const LIMIT_DEFAULT = 50, LIMIT_MAX = 500;
/** What `overview` may compute for its `usage` beyond the usage sidecars (3.5 §访问模式: bounded by a byte budget, never
 *  O(corpus)): stored bytes of the in-window model calls no sidecar covers yet, newest session first. */
export const OVERVIEW_USAGE_BYTES = 16 * 1024 * 1024;
const whole = (v, name, dflt) => {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new QueryArgError(`--${name}: ${JSON.stringify(v)} is not a whole number`);
  return n;
};
/** `--limit` (default 50, at most 500) and `--after` as one window (the parameter is `--after` on the CLI and
 *  `?after=` on the board — ONE name, §4.1). */
export const pageSpec = (p = {}) => ({
  cursor: whole(p.after, 'after', 0),
  limit: Math.min(LIMIT_MAX, Math.max(1, whole(p.limit, 'limit', LIMIT_DEFAULT))),
});
/** What one page of a list that reads its records back may hold, in the rows' stored bytes (3.5 §分页): 500 rows of multi-MB
 *  records parsed at once is past the worker's heap, so a page is cut by bytes as well as by `--limit`. */
export const PAGE_STORED_BYTES = 32 * 1024 * 1024;
/** What one `session` page may ship of request bodies (3.5 §分页 正文预算): the calls of the window nearest its middle carry their block
 *  lists while their request bodies sum to at most this many bytes, and always one; the rest ride as meta, `paged_out`. */
export const PAGE_BODY_BYTES = 4 * 1024 * 1024;
/** One page of `list` → {items, next, has_more}: `next` IS the next page's `--after`. With `bytes(item)` the page also stops
 *  before the item that would take it past `cap` — never before its first item, so every page moves on. */
export function paginate(list, p = {}, { bytes = null, cap = PAGE_STORED_BYTES } = {}) {
  const { cursor, limit } = pageSpec(p);
  let to = Math.min(list.length, cursor + limit);
  if (bytes) for (let i = cursor, sum = 0; i < to; i++) if ((sum += bytes(list[i])) > cap && i > cursor) { to = i; break; }
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
 * `home` is ~/.trocar; the rest of the context is handed to the query as it is, for `status` / `doctor`,
 * which read the machine (`userHome` = the user's home, and whatever a test injects in `deps`).
 * Throws QueryArgError for an unknown name or parameter; everything else it cannot read is in `errors`.
 */
export async function runQuery(name, params = {}, ctx = {}) {
  const { home = trocarHome(), fs = nodeFs, now = Date.now } = ctx;
  const q = checked(name, params);
  const errors = [];
  const body = await q.run({ ...ctx, home, fs, now, params, errors });
  return { schema: SCHEMA_VERSION, command: name, ok: !errors.some((e) => !e.level), ...body, errors };
}

/**
 * versionOf(name, params, ctx) → { key, errors } | null: what that answer depends on, read from the warm segment index rows only —
 * never a record (3.5 §谁执行它 答案缓存). Two equal keys = the same answer; `errors` are the index problems the answer carries.
 * null = this name declares no version (or names nothing it could answer). Throws what runQuery throws.
 */
export async function versionOf(name, params = {}, ctx = {}) {
  const q = checked(name, params);
  if (!q.version) return null;
  const { home = trocarHome(), fs = nodeFs } = ctx;
  return q.version({ ...ctx, home, fs, params });
}

function checked(name, params) {
  const q = Object.hasOwn(QUERIES, name) ? QUERIES[name] : null;
  if (!q) throw new QueryArgError(`trocar query: no query called ${JSON.stringify(name)} (names: ${Object.keys(QUERIES).join(', ')})`);
  for (const k of Object.keys(params)) {
    if (!q.params.includes(k)) throw new QueryArgError(`trocar query ${name}: no parameter --${k} (its parameters: ${q.params.length ? q.params.map((p) => '--' + p).join(' ') : 'none'})`);
    // A parameter given more than once is a list; only the entry's `lists` take one (1.6 §4.1 参数).
    if (Array.isArray(params[k]) && !(q.lists || []).includes(k)) throw new QueryArgError(`trocar query ${name}: --${k} takes one value, and it was given ${params[k].length}`);
  }
  return q;
}

/**
 * stampOf(name, params, {home, fs, now, env}) → the ETag value (sha1 hex) of that answer, or null for a name that
 * reads the machine rather than the disk (4.4 §条件 GET). Stat only: the files the answer depends on, plus
 * `floor(now / 60 s)` when the answer reads the clock (`classes`, or a relative `--since` / `--until`), so an
 * answer that is stale only because time passed is stale by at most one minute. Throws what runQuery throws.
 */
export function stampOf(name, params = {}, ctx = {}) {
  const { home = trocarHome(), fs = nodeFs, now = Date.now, env = process.env } = ctx;
  const q = checked(name, params);
  const parts = q.stamp({ home, fs, env });
  if (parts == null) return null;
  let clock = !!q.clock;
  for (const k of ['since', 'until']) if (params[k] != null) { parseTime(params[k], { name: k, now: 0 }); clock ||= REL.test(String(params[k]).trim()); }
  if (clock) parts.push(`tick:${Math.floor(now() / 60e3)}`);
  return createHash('sha1').update(JSON.stringify([name, params, ...parts])).digest('hex');
}
