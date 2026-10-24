// src/query/ctx-files.mjs — the answer files of a session's directory (RFC 3.5 §会话读 `session --head`, §谁执行它「答案文件」; 4.3 §4 目录):
// `head.json.gz` = the gzip of the compact JSON of `trocar query session --id S --head`, the board's first screen in one file (D71①).
// The head is a function of the disk and the mark only (D69③): no wall clock, every list in step order or sorted, so the worker's
// file, the worker's answer and the local path's answer at one mark are the same bytes. Only the query worker writes (writeHead).
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SCHEMA_VERSION } from '../cli/schema.mjs';
import { sessionMetaOfFacts } from '../view/board.mjs';
import { listOf } from '../view/reduce.mjs';
import { compareStep } from '../view/step-order.mjs';
import { sessionDir } from './projection.mjs';
import { isModelCall, sessionFactsOf } from './rows.mjs';
import { laneOf, laneAt, placeIn, recOf, FLAG } from './session-doc.mjs';
import { laneStepper } from './named/lane.mjs';

/** The answer files' format version (3.5 `v`). */
export const CTX_V = 1;
/** The lane headers a head lists at most, the axis lane first, then the most recently active (3.5 `lanes`, SHOULD 64). */
export const HEAD_LANES = 64;
// cells of `cols` at most (3.5 `bucket`), failed members `errors` names at most, tier-0 time buckets at most
const CELLS = 32_768, FAILED_SHOWN = 64, BUCKETS = 240;

/** The members a pack holds: pack n = the plan's members at write positions [PACK_MEMBERS·n, PACK_MEMBERS·(n+1)) (3.5, SHOULD 512). */
export const PACK_MEMBERS = 512;

/** headFile(home, id) → the session's head file. */
export const headFile = (home, id) => path.join(sessionDir(home, id), 'head.json.gz');

const docOf = (errors, body, command = 'session') => ({ schema: SCHEMA_VERSION, command, ok: !errors.some((e) => !e.level), errors, v: CTX_V, ...body });
// the index's problems (a note, `level`, is about the read that made it, never the disk's: index-build.mjs) and the first failed members
const errorsOf = (index, failed) => [...index.filter((e) => !e.level), ...failed.slice(0, FAILED_SHOWN).map((f) => ({ where: f.id, code: f.code, reason: f.reason }))];

/** headDoc(s) → the tier-1 head of a session state (named/session.mjs sessionState, `mark` already the wire's, `markTs` its member's
 *  index ts, `packs` and `open` those of packsOf / the writer): the axis lane's steps as `cols` (the step-order columns' cx / cb / fl, session-doc.mjs), its chapters, the lane headers. */
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
    axis: ax ? ax.lane : null, steps: n, peak, cols: cells.toString('base64'), bucket, chapters, packs: s.packs, open: s.open,
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

/** writeHead(home, id, doc, fs) → whether the file changed: the gzip of the doc's compact JSON (putFile); nothing is written when the
 *  bytes are the file's. */
export function writeHead(home, id, doc, fs = nodeFs) {
  const file = headFile(home, id), bytes = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
  try { if (fs.readFileSync(file).equals(bytes)) return false; } catch { /* none yet */ }
  putFile(fs, file, bytes);
  return true;
}
// A whole file written to a temporary file and renamed over (EPERM / EBUSY, a reader holding it on Windows: tried 3 times).
function putFile(fs, file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) { if (i >= 2 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; } }
  }
}

// ── Packs and the open tail (3.5 §会话读 `lane --pack` / `--tail`) ──────────────────────────────────────────────────────────────
// A session state `s` (named/session.mjs stateAt) carries `pos(rid)` (a member's write position, −1: none) and `cut(row)` (in the
// cut). Every member at or below the mark is folded, so span n is sealed once the mark's position reaches PACK_MEMBERS·(n+1) − 1.
const axisOf = (V) => (V.lanes.find((l) => l.kind === 'main') || V.lanes[0] || { lane: null }).lane; // as headDoc's axis
const upToOf = (s) => (s.mark == null ? 0 : s.pos(s.mark) + 1);
/** sealedOf(s) → how many packs are sealed = the open span's n. */
export const sealedOf = (s) => Math.floor(upToOf(s) / PACK_MEMBERS);
const spanOf = (s, rid) => { const p = s.pos(rid); return p < 0 ? -1 : Math.floor(p / PACK_MEMBERS); };
const isRow = (cols, rid) => { const k = cols.slotOf(rid); return k !== undefined && cols.ts[k] !== undefined; };
/** axisSpans(s) → [s0, s1] per span 0..sealedOf(s): the axis steps its members cover (smallest, largest + 1); a span with none
 *  covers the empty range at the count of axis steps in the spans before it. */
export function axisSpans(s) {
  const V = s.V, N = sealedOf(s) + 1, lo = new Array(N).fill(Infinity), hi = new Array(N).fill(-1), below = new Array(N + 1).fill(0), ax = axisOf(V);
  if (ax != null) laneOf(V.cols, ax).rids.forEach((rid, i) => { const n = spanOf(s, rid); if (n < 0 || n >= N) return; lo[n] = Math.min(lo[n], i); hi[n] = i + 1 > hi[n] ? i + 1 : hi[n]; below[n + 1]++; });
  for (let n = 1; n <= N; n++) below[n] += below[n - 1];
  return lo.map((a, n) => (hi[n] < 0 ? [below[n], below[n]] : [a, hi[n]]));
}
// The lines of step i of the lane stepper S (lane.mjs laneStepper) against step `p` of it (−1: a keyframe): its row, the definitions
// its list and reply bring that `wrote` (the file's) does not hold yet, the step.
// The ids it brings that the file lacks are those its ops add, in list order, then its reply's: every id of its parent's list is in the
// file already. `memo` (the writer's, for the open span): a step and a definition are made once for the tail and the pack it is sealed
// into; a step is a function of the projection's rows of it and its parent (extracted once each), so the two rids key it.
function stepLines(S, key, i, p, wrote, memo = null) {
  const rid = S.rids[i], k = memo && `${rid}\n${p < 0 ? '' : S.rids[p]}`;
  let st = memo && memo.steps.get(k);
  if (!st) { st = S.step(i, p); if (memo) memo.steps.set(k, st); }
  const out = [{ c: S.lineAt(i).r }];
  for (const bid of [...st.ops.flatMap((op) => (op[0] === 1 ? op.slice(1) : [])), ...st.reply]) {
    if (wrote.has(bid)) continue;
    wrote.add(bid);
    const dk = `${bid}\n${rid}`;
    let w = memo ? memo.defs.get(dk) : undefined;
    if (w === undefined) { w = S.defOf(bid, S.listAt(i).bids); if (memo) memo.defs.set(dk, w); }
    if (w) out.push({ d: w });
  }
  out.push({ s: { rid: st.rid, lane: key, i, parent: st.parent, ops: st.ops, reply: st.reply, attrs: st.attrs, detail: st.detail, events: S.eventsAt(i) } });
  return out;
}
// the `{l}` lines of a span's part: the part's lanes whose last step lies in it (they follow the doc-head line)
const headsOf = (s, n, part) => { const ax = axisOf(s.V); return s.V.lanes.filter((h) => (h.lane === ax) === (part === 'main') && spanOf(s, h.last) === n).map((h) => ({ l: h })); };
const textOf = (lines) => lines.map((o) => `${JSON.stringify(o)}\n`).join('');
/** renderSpan(s, n, part, tail) → the NDJSON text of pack n's `part` (`main` = the axis lane's, `rest` = the rest), or of the open
 *  tail when `tail`: the doc-head line; `{l}` for the part's lanes whose last step lies in the span (each lane's header in the one
 *  file holding its last step); per call of the part in step order its row, the definitions not yet in the file, its step against
 *  the previous step of its lane in this file (none: a keyframe); `{r}` for the part's members in write order; `{x}` (rest) for
 *  the failed members of the span. A function of the state alone. */
export const renderSpan = (s, n, part, tail = false) => render(s, n, part, tail).text;
function render(s, n, part, tail, memo = null) {
  const V = s.V, { cols, log } = V, ax = axisOf(V), main = part === 'main', a = n * PACK_MEMBERS;
  const axV = ax == null ? -2 : cols.keys.get(ax), onAxis = (rid) => isRow(cols, rid) && cols.ln[cols.slotOf(rid)] === axV;
  const members = s.plan.members.slice(a, Math.min(a + PACK_MEMBERS, upToOf(s))).filter((r) => s.cut(r)), [s0, s1] = axisSpans(s)[n];
  const out = [docOf(errorsOf(s.indexErrors, []), { id: s.id, ...(tail ? { tail: { n, part, s0 } } : { pack: { n, part, s0, s1 } }) }, 'lane')];
  out.push(...headsOf(s, n, part));
  const calls = members.map((r) => String(r.id)).filter((rid) => isRow(cols, rid) && onAxis(rid) === main);
  calls.sort((x, y) => compareStep(cols.ts[cols.slotOf(x)], x, cols.ts[cols.slotOf(y)], y));
  const steppers = new Map(), prev = new Map(), wrote = new Set();
  for (const rid of calls) {
    const key = log.read(...log.latest(rid)).r.lane, S = steppers.get(key) || steppers.set(key, laneStepper(s, key)).get(key), i = placeIn(cols, S.L, rid);
    out.push(...stepLines(S, key, i, prev.has(key) ? prev.get(key) : -1, wrote, memo));
    prev.set(key, i);
  }
  for (const r of members) if (onAxis(String(r.id)) === main) out.push({ r: recOf(r) });
  if (!main) for (const f of V.failed) if (spanOf(s, f.id) === n) out.push({ x: { where: f.id, code: f.code, reason: f.reason } });
  return { text: textOf(out), wrote };
}
const tagOf = (main, rest) => createHash('sha1').update(`${main}\n${rest}`).digest('hex').slice(0, 16);
/** packsOf(s) → {packs, open} of the head, each sealed pack rendered (the local path: no writer keeps them). */
export function packsOf(s) {
  if (s.mark == null) return { packs: [], open: null };
  const N = sealedOf(s), spans = axisSpans(s), packs = [];
  for (let n = 0; n < N; n++) packs.push({ n, s0: spans[n][0], s1: spans[n][1], tag: tagOf(renderSpan(s, n, 'main'), renderSpan(s, n, 'rest')) });
  return { packs, open: { n: N, s0: spans[N][0] } };
}

