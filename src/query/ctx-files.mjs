// src/query/ctx-files.mjs — the answer files of a session's directory (RFC 3.5 §会话读 `session --head`, §谁执行它「答案文件」; 4.3 §4 目录):
// `head.json.gz` = the gzip of the compact JSON of `trocar query session --id S --head`, the board's first screen in one file (D71①).
// The head is a function of the disk and the mark only (D69③): no wall clock, every list in step order or sorted, so the worker's
// file, the worker's answer and the local path's answer at one mark are the same bytes. Only the query worker writes (writeHead).
import nodeFs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { SCHEMA_VERSION } from '../cli/schema.mjs';
import { sessionMetaOfFacts } from '../view/board.mjs';
import { listOf } from '../view/reduce.mjs';
import { compareStep } from '../view/step-order.mjs';
import { sessionDir } from './projection.mjs';
import { isModelCall, sessionFactsOf } from './rows.mjs';
import { laneOf, FLAG } from './session-doc.mjs';

/** The answer files' format version (3.5 `v`). */
export const CTX_V = 1;
/** The lane headers a head lists at most, the axis lane first, then the most recently active (3.5 `lanes`, SHOULD 64). */
export const HEAD_LANES = 64;
// cells of `cols` at most (3.5 `bucket`), failed members `errors` names at most, tier-0 time buckets at most
const CELLS = 32_768, FAILED_SHOWN = 64, BUCKETS = 240;

/** headFile(home, id) → the session's head file. */
export const headFile = (home, id) => path.join(sessionDir(home, id), 'head.json.gz');

const docOf = (errors, body) => ({ schema: SCHEMA_VERSION, command: 'session', ok: !errors.some((e) => !e.level), errors, v: CTX_V, ...body });
// the index's problems (a note, `level`, is about the read that made it, never the disk's: index-build.mjs) and the first failed members
const errorsOf = (index, failed) => [...index.filter((e) => !e.level), ...failed.slice(0, FAILED_SHOWN).map((f) => ({ where: f.id, code: f.code, reason: f.reason }))];

/** headDoc(s) → the tier-1 head of a session state (named/session.mjs sessionState, `mark` already the wire's, `markTs` its member's
 *  index ts): the axis lane's steps as `cols` (the step-order columns' cx / cb / fl, session-doc.mjs), its chapters, the lane headers. */
export function headDoc(s) {
  const V = s.V, cols = V.cols;
  const ax = V.lanes.find((l) => l.kind === 'main') || V.lanes[0] || null; // no main lane: the first lane (1.3)
  const lane = ax ? laneOf(cols, ax.lane) : { rids: [], slots: [] }, n = lane.slots.length;
  let peak = 0;
  for (const k of lane.slots) if (cols.cx[k] > peak) peak = cols.cx[k];
  let bucket = 1;
  while (Math.ceil(n / bucket) > CELLS) bucket *= 2;
  const cells = Buffer.alloc(3 * Math.ceil(n / bucket)), chapters = [];
  for (let i = 0; i < n; i++) {
    const k = lane.slots[i], c = 3 * Math.floor(i / bucket), h = peak ? Math.round((255 * cols.cx[k]) / peak) : 0, f = cols.fl[k];
    if (i % bucket === 0 || h > cells[c]) { cells[c] = h; cells[c + 1] = cols.cb[k]; }
    cells[c + 2] |= f;
    let ch = chapters.at(-1);
    if (!ch || f & FLAG.compaction && i > 0) {
      ch = { k: chapters.length, s0: i, s1: i, rid0: lane.rids[i], ts0: cols.ts[k] ?? null, ts1: null, inferred: !!(ch && f & FLAG.inferred), peakCtx: 0 };
      chapters.push(ch);
    }
    ch.s1 = i + 1; ch.ts1 = cols.ts[k] ?? null;
    if (cols.cx[k] > ch.peakCtx) ch.peakCtx = cols.cx[k];
  }
  // the axis lane, then the others by their last step, the newest first
  const lastOf = (h) => { const k = cols.slotOf(h.last); return k === undefined ? null : cols.ts[k] ?? null; };
  const others = V.lanes.filter((h) => h !== ax).sort((a, b) => compareStep(lastOf(b), b.last, lastOf(a), a.last));
  const lanes = ax ? [ax, ...others.slice(0, HEAD_LANES - 1)] : [];
  const lastRid = n ? lane.rids[n - 1] : null, list = lastRid && listOf(s.store, lastRid);
  return docOf(errorsOf(s.indexErrors, s.failed), {
    id: s.id, tier: 1, mark: s.mark, markTs: s.markTs, pending: s.pending ? { done: s.pending.done, total: s.pending.total } : null,
    truncated: s.truncated, failed: s.failed.length, meta: V.meta, stats: V.stats, logged: V.logged, probes: V.probes,
    ...(V.unknown ? { unknown: V.unknown } : null),
    axis: ax ? ax.lane : null, steps: n, peak, cols: cells.toString('base64'), bucket, chapters, packs: [], open: { n: 0, s0: 0 },
    lanes, lanesMore: V.lanes.length - lanes.length, last: lastRid ? { rid: lastRid, n: list ? list.bids.length : 0 } : null,
  });
}

/** tier0Doc(id, members, errors) → the tier-0 head of a session with no reduction state: from its segment index rows only (meta as
 *  the `sessions` query has it, its model calls in ≤ BUCKETS equal spans of time). */
export function tier0Doc(id, members, errors) {
  const f = sessionFactsOf(id, members), calls = members.filter(isModelCall);
  const ts = calls.map((r) => Date.parse(r.ts)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b), buckets = [];
  if (ts.length) {
    const t0 = ts[0], t1 = ts.at(-1), m = t1 > t0 ? Math.min(BUCKETS, ts.length) : 1, w = (t1 - t0) / m;
    for (let i = 0; i < m; i++) buckets.push({ ts0: new Date(t0 + i * w).toISOString(), ts1: new Date(i === m - 1 ? t1 : t0 + (i + 1) * w).toISOString(), calls: 0 });
    for (const t of ts) buckets[Math.min(m - 1, w ? Math.floor((t - t0) / w) : 0)].calls++;
  }
  return docOf(errorsOf(errors, []), {
    id, tier: 0, mark: null, markTs: null, pending: { done: 0, total: members.length }, truncated: null, failed: 0,
    meta: sessionMetaOfFacts({ ...f, title: null }), stats: { calls: f.calls }, logged: f.logged, probes: f.probes,
    axis: null, steps: calls.length, peak: 0, cols: '', bucket: 1, chapters: [], packs: [], open: null, lanes: [], lanesMore: 0, last: null, buckets,
  });
}

/** writeHead(home, id, doc, fs) → whether the file changed: the gzip of the doc's compact JSON, written to a temporary file and renamed
 *  over the head (EPERM / EBUSY, a reader holding it on Windows: tried 3 times); nothing is written when the bytes are the file's. */
export function writeHead(home, id, doc, fs = nodeFs) {
  const file = headFile(home, id), bytes = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
  try { if (fs.readFileSync(file).equals(bytes)) return false; } catch { /* none yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return true; } catch (e) { if (i >= 2 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; } }
  }
}
