// src/query/retention.mjs — 「保存什么」 as ONE report (RFC 3.5 「保存什么」行, 4.4 GET /api/retention, 2.6 §D, 4.6 K6): what is kept of each call
// per harness × traffic class, what each class takes, what ~/.asight takes on disk. `asight keep` and the board's endpoint both call
// retentionReport(), so the CLI and the board cannot disagree. Every number names where it comes from:
//   settings   ~/.asight/retention.json, read now (src/capture/retention.mjs, the one reader both capture paths use)
//   changes    ~/.asight/logs/retention.ndjson, the tail of it
//   sizes      the DuckDB projection — AS OF the last `asight etl`, never live (`as_of`); NULL with a reason when there is no
//              projection (the answer is "run asight etl", never 0)
//   disk       lstat sizes of the files under ~/.asight, live
//   estimate   what a class would take once SEALED = its stored bytes × the sealed files' overall ratio, marked 估计: the ratio is
//              global, so it is a guess for any one class (non-LLM JSON delta-compresses worse than LLM requests, 4.6 §日志体积预算)
// It reads settings and files; it writes nothing (the one write path is setRetention(), src/capture/retention.mjs).
import fsp from 'node:fs/promises';
import { retentionFile, retentionLog, readRetentionFile, TRAFFIC_CLASSES } from '../capture/retention.mjs';
import { retentionHarnessIds } from '../dissect/traffic.mjs';
import { asightHome } from '../paths.mjs';
import { openDb } from '../db.mjs';
import { retentionSizes, SIZE_WINDOWS, SIZE_COLUMNS } from './queries.mjs';
import { diskUsage, sealStats } from './disk.mjs';

// the analytics store the sizes came from: where it is and how big (its write-ahead file counts); a store that cannot be stat'ed says why
async function statDb(dbPath, fs) {
  let bytes = 0;
  try {
    for (const f of [dbPath, `${dbPath}.wal`]) { try { bytes += (await fs.stat(f)).size; } catch (e) { if (!(e && e.code === 'ENOENT' && f.endsWith('.wal'))) throw e; } }
    return { path: dbPath, bytes };
  } catch (e) { return { path: dbPath, bytes: null, error: String((e && e.message) || e) }; }
}

const CHANGE_TAIL_BYTES = 256 * 1024; // the change log is a few hundred bytes a change; only its tail is read

// the last `limit` changes, oldest first: [{ts, harness, class, from, to, source}]. A line that is not a change is skipped; a log that
// cannot be read is an `error`, not "no changes".
export async function readChanges(file, { limit = 20, fs = fsp } = {}) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - CHANGE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    if (buf.length) await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line of a tail read is cut
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r && r.event === 'retention-set') out.push({ ts: r.ts, harness: r.harness, class: r.class, from: r.from, to: r.to, source: r.source }); } catch { /* not a change line */ }
    }
    return { changes: out.slice(-limit), error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { changes: [], error: null };
    return { changes: [], error: String((e && e.message) || e) };
  } finally { if (fh) await fh.close(); }
}

const zero = () => Object.fromEntries(SIZE_COLUMNS.map((c) => [c, 0]));
const addInto = (acc, w) => { for (const c of SIZE_COLUMNS) acc[c] += w[c]; return acc; };
// the same row sums, by class and by harness and overall, per window — the legacy-meta rows are summed apart from the rest
// (their class is an inference from today's table, their response size was never recorded)
function totalsOf(rows) {
  const t = { by_class: {}, by_harness: {}, all: {}, legacy_meta: {} };
  for (const [name] of SIZE_WINDOWS) { t.all[name] = zero(); t.legacy_meta[name] = zero(); }
  for (const r of rows) {
    const bucket = r.retention === 'legacy-meta' ? t.legacy_meta : null;
    for (const [name] of SIZE_WINDOWS) {
      const w = r.windows[name];
      if (bucket) { addInto(bucket[name], w); continue; }
      addInto(t.all[name], w);
      addInto(((t.by_class[r.class] ||= {})[name] ||= zero()), w);
      addInto(((t.by_harness[r.harness] ||= {})[name] ||= zero()), w);
    }
  }
  return t;
}

/**
 * retentionReport({home, conn, dbError, dbPath, control, now, changes}) → the report (JSON-able; metadata only, no record bytes)
 *   conn      an open (read-only) DuckDB connection, or null when there is no store; dbError why it is unreadable, if it is
 *   control   whether the board may change settings (serve --control): decided by the caller, only reported here
 */
export async function retentionReport({ home = asightHome(), conn = null, dbError = null, dbPath = null, control = false, now = Date.now(), changes = 20, fs = fsp } = {}) {
  const file = retentionFile(home);
  const cur = readRetentionFile(file);
  const settings = { file, missing: cur.missing, ok: cur.problems.length === 0, problems: cur.problems };
  const log = await readChanges(retentionLog(home), { limit: changes, fs });

  let sizes = null, sizesReason = null;
  if (!conn) sizesReason = dbError ? `${dbError}` : '需要先跑 asight etl · run `asight etl <capture dir>` first: there is no analytics store to read the sizes from';
  else {
    try { sizes = await retentionSizes(conn, { now }); } catch (e) {
      sizesReason = e && e.code === 'predates-d40' ? `需要重建 · ${e.message}` : `analytics store unreadable: ${String((e && e.message) || e)}`;
    }
  }

  const disk = await diskUsage({ home, fs, now: () => now });
  const seal = await sealStats(disk.sealed_paths);
  const { sealed_paths, ...diskOut } = disk;

  let totals = null;
  if (sizes) {
    totals = totalsOf(sizes.rows);
    // 估计: stored bytes × the overall seal ratio — one number applied to every cell, which is why it is only ever shown as an estimate
    if (seal.ratio != null) {
      for (const r of sizes.rows) for (const [name] of SIZE_WINDOWS) r.windows[name].sealed_estimate_bytes = Math.round(r.windows[name].stored_bytes * seal.ratio);
      for (const [name] of SIZE_WINDOWS) totals.all[name].sealed_estimate_bytes = Math.round(totals.all[name].stored_bytes * seal.ratio);
    }
    sizes.estimate = seal.ratio != null ? { estimate: true, ratio: seal.ratio, basis: 'stored bytes × the overall seal ratio of the sealed files (one global number: an estimate for any one class)' } : { estimate: false, reason: 'no readable sealed file to take a ratio from' };
  }

  const ids = retentionHarnessIds();
  const seen = new Set([...Object.keys(cur.levels), ...(sizes ? sizes.rows.map((r) => r.harness) : [])]);
  const harnesses = [...ids.filter((h) => seen.has(h)), ...[...seen].filter((h) => !ids.includes(h)).sort()];
  return {
    generated_at: new Date(now).toISOString(),
    control: !!control,
    classes: [...TRAFFIC_CLASSES], levels: cur.levels, harnesses, known_harnesses: ids,
    settings, changes: log.changes, ...(log.error ? { changes_error: log.error } : {}),
    sizes, sizes_reason: sizesReason, totals,
    seal, disk: diskOut, db: dbPath ? await statDb(dbPath, fs) : null,
    note: '改动只影响之后开始的调用;已存的数据不删 · a change reaches the calls that start after it; what is already stored is never deleted or rewritten',
  };
}

/**
 * retentionReportFromStore({dbPath, ...opts}) → the report, with the store at `dbPath` opened read-only for the sizes and closed again
 * (`asight keep` has no server holding one). A store that does not exist is "no store" (run asight etl); one that is there and cannot be
 * opened is said to be unreadable — the same two answers the server gives (src/server.mjs createServer).
 */
export async function retentionReportFromStore({ dbPath, ...opts } = {}) {
  let db = null, dbError = null;
  try { db = await openDb(dbPath, { readOnly: true }); } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/database does not exist/i.test(msg)) dbError = `analytics store unreadable (${dbPath}): ${msg}`;
  }
  try { return await retentionReport({ ...opts, conn: db ? db.connection : null, dbError, dbPath }); } finally { if (db) await db.close(); }
}
