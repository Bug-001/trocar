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
import { lru, sessionDir } from './projection.mjs';
import { isModelCall, sessionFactsOf } from './rows.mjs';
import { laneOf, placeIn, recOf, FLAG } from './session-doc.mjs';
import { laneStepper } from './named/lane.mjs';

/** The answer files' format version (3.5 `v`). */
export const CTX_V = 2;
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
export const axisSpans = (s) => spansOf(s, axisSteps(s));
// the span of each axis step, in step order; `sp` (the writer's, of the last slice) is kept below place `j`: the axis rows before it
// did not move (dirtyOf), so a slice looks at the axis steps from its first changed one only
function axisSteps(s, sp = [], j = 0) {
  const ax = axisOf(s.V), rids = ax == null ? [] : laneOf(s.V.cols, ax).rids;
  sp.length = rids.length;
  for (let t = Math.min(j, rids.length); t < rids.length; t++) sp[t] = spanOf(s, rids[t]);
  return sp;
}
function spansOf(s, sp) {
  const N = sealedOf(s) + 1, lo = new Array(N).fill(Infinity), hi = new Array(N).fill(-1), below = new Array(N + 1).fill(0);
  for (let i = 0; i < sp.length; i++) { const n = sp[i]; if (n < 0 || n >= N) continue; if (i < lo[n]) lo[n] = i; hi[n] = i + 1; below[n + 1]++; }
  for (let n = 1; n <= N; n++) below[n] += below[n - 1];
  return lo.map((a, n) => (hi[n] < 0 ? [below[n], below[n]] : [a, hi[n]]));
}
// The lines of step i of the lane stepper S (lane.mjs laneStepper) against step `p` of it (−1: a keyframe): its row, the definitions
// its list and reply bring that `wrote` (the file's) does not hold yet, the step.
// The ids it brings that the file lacks are those its ops add, in list order, then its reply's: every id of its parent's list is in the
// file already. `memo` (the writer's, for the open span): a step and a definition are made once for the tail and the pack it is sealed
// into; a step is a function of the projection's rows of it and its parent (extracted once each), so the two rids key it. The lane
// steppers read the store's definitions through it too (by bid), so a list's tool_use is not read again at every slice.
// what a kept step or definition weighs in the heap, about: its JSON's bytes and the entry
const weigh = (v) => 96 + (v ? 2 * JSON.stringify(v).length : 0);
/** The open span's memo holds this much at most (the least recently used out): a fixed cache beside the reduction's (3.5 §内存有界). */
const MEMO_BYTES = 4 << 20;
function stepLines(S, key, i, p, wrote, memo = null) {
  const rid = S.rids[i], k = memo && `${rid}\n${p < 0 ? '' : S.rids[p]}`;
  let st = memo && memo.get(k);
  if (!st) { st = S.step(i, p); if (memo) memo.set(k, st, weigh(st)); }
  const out = [{ c: S.lineAt(i).r }];
  for (const bid of [...st.ops.flatMap((op) => (op[0] === 1 ? op.slice(1) : [])), ...st.reply]) {
    if (wrote.has(bid)) continue;
    wrote.add(bid);
    const dk = `${bid}\n${rid}`;
    let w = memo ? memo.get(dk) : undefined;
    if (w === undefined) { w = S.defOf(bid, S.listAt(i).bids); if (memo) memo.set(dk, w, weigh(w)); }
    if (w) out.push({ d: w });
  }
  out.push({ s: { rid: st.rid, lane: key, i, parent: st.parent, ops: st.ops, reply: st.reply, attrs: st.attrs, detail: st.detail, events: S.eventsAt(i) } });
  return out;
}
// the `{l}` lines of a tail: every lane header of its part (they follow the doc-head line); a pack has none (3.5 `{l}`)
const headsOf = (s, part) => { const ax = axisOf(s.V); return s.V.lanes.filter((h) => (h.lane === ax) === (part === 'main')).map((h) => ({ l: h })); };
const textOf = (lines) => lines.map((o) => `${JSON.stringify(o)}\n`).join('');
/** renderSpan(s, n, part, tail) → the NDJSON text of pack n's `part` (`main` = the axis lane's, `rest` = the rest), or of the open
 *  tail when `tail`: the doc-head line; a tail's `{l}` for every lane of the part; per call of the part in step order its row, the definitions not yet in the file, its step against
 *  the previous step of its lane in this file (none: a keyframe); `{r}` for the part's members in write order; `{x}` (rest) for
 *  the failed members of the span. A function of the state alone. */
export const renderSpan = (s, n, part, tail = false) => render(s, n, part, tail).buf.toString('utf8');
// a span's doc-head line
const docLine = (s, n, part, tail, [s0, s1] = axisSpans(s)[n]) => docOf(errorsOf(s.indexErrors, []), { id: s.id, ...(tail ? { tail: { n, part, s0 } } : { pack: { n, part, s0, s1 } }) }, 'lane');
function render(s, n, part, tail, memo = null, spans = axisSpans(s)) {
  const V = s.V, { cols, log } = V, ax = axisOf(V), main = part === 'main', a = n * PACK_MEMBERS;
  const axV = ax == null ? -2 : cols.keys.get(ax), onAxis = (rid) => isRow(cols, rid) && cols.ln[cols.slotOf(rid)] === axV;
  const members = s.plan.members.slice(a, Math.min(a + PACK_MEMBERS, upToOf(s))).filter((r) => s.cut(r)), [s0, s1] = spans[n];
  // each line made into bytes at once (outside the heap): a span's text can be tens of MB
  const chunks = [], out = { push: (...os) => { for (const o of os) chunks.push(Buffer.from(`${JSON.stringify(o)}\n`, 'utf8')); } };
  out.push(docLine(s, n, part, tail, spans[n]));
  if (tail) out.push(...headsOf(s, part));
  const calls = members.map((r) => String(r.id)).filter((rid) => isRow(cols, rid) && onAxis(rid) === main);
  calls.sort((x, y) => compareStep(cols.ts[cols.slotOf(x)], x, cols.ts[cols.slotOf(y)], y));
  const steppers = new Map(), prev = new Map(), wrote = new Set();
  for (const rid of calls) {
    const key = log.read(...log.latest(rid)).r.lane, S = steppers.get(key) || steppers.set(key, laneStepper(s, key, memo || undefined)).get(key), i = placeIn(cols, S.L, rid);
    out.push(...stepLines(S, key, i, prev.has(key) ? prev.get(key) : -1, wrote, memo));
    prev.set(key, i);
    S.release(i);
  }
  for (const r of members) if (onAxis(String(r.id)) === main) out.push({ r: recOf(r) });
  if (!main) for (const f of V.failed) if (spanOf(s, f.id) === n) out.push({ x: { where: f.id, code: f.code, reason: f.reason } });
  return { buf: Buffer.concat(chunks), wrote };
}
const tagOf = (main, rest) => createHash('sha1').update(main).update('\n').update(rest).digest('hex').slice(0, 16);
/** packsOf(s) → {packs, open} of the head, each sealed pack rendered (the local path: no writer keeps them). */
export function packsOf(s) {
  if (s.mark == null) return { packs: [], open: null };
  const N = sealedOf(s), spans = axisSpans(s), packs = [];
  for (let n = 0; n < N; n++) packs.push({ n, s0: spans[n][0], s1: spans[n][1], tag: tagOf(render(s, n, 'main', false, null, spans).buf, render(s, n, 'rest', false, null, spans).buf) });
  return { packs, open: { n: N, s0: spans[N][0] } };
}

// ── The writer (3.5 §谁执行它「答案文件」): the query worker only, after each slice ─────────────────────────────────────────────────
/** packFile / tailFile (home, id, …) → a pack's and a tail's file in the session's directory. */
export const packFile = (home, id, n, part) => path.join(sessionDir(home, id), `p${n}.${part}.ndjson.gz`);
export const tailFile = (home, id, part) => path.join(sessionDir(home, id), `open.${part}.ndjson`);
const PARTS = ['main', 'rest'];
const sha = (t) => createHash('sha1').update(t).digest('hex');
// fold log → {f: the log's frontier offset the files stand at, open, packs[n]: {n, s0, s1, tag, h: [sha main, sha rest]}, tails, rec}
const writers = new WeakMap();
/** filesAt(log) → the fold-log offset the session's answer files stand at (−1: none). filesParts(log) → the fold sidecar's parts
 *  that say so (named/session.mjs sidecars): `w.f` that offset, so a worker that starts again re-renders the packs that changed past
 *  it; `w.t` the tails' checkpoint (the axis, the records appended up to, each tail's size), so it appends to the tails. */
export const filesAt = (log) => (writers.has(log) ? writers.get(log).f : -1);
export function filesParts(log) {
  const W = writers.get(log);
  return [['w.f', Float64Array.of(W ? W.f : -1)], ...(W && W.tails ? [['w.t', [JSON.stringify({ ax: W.ax, rec: W.rec, size: PARTS.map((p) => W.tails[p].size) })]]] : [])];
}
/** forget(log): the files are written afresh at the next slice (a write that failed). */
export const forget = (log) => { writers.delete(log); };
// a file's bytes (gunzipped), or null when it is missing, does not gunzip, is torn or its head line has another v
function readText(fs, file, gz) {
  try {
    const b = gz ? gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
    return b[b.length - 1] === 10 && JSON.parse(b.subarray(0, b.indexOf(10)).toString('utf8')).v === CTX_V ? b : null;
  } catch { return null; }
}
const same = (a, b) => !!a && a.equals(b);
// The tail `part` of span n a worker before this one wrote, carried on by appends: whole, of the size its checkpoint says (nothing
// was written to it after the checkpoint), its doc-head line the one a render now writes (same v, span, s0, errors); the definitions
// it holds read back from its `{d}` lines. Else null: it is written afresh (a fresh render is as valid at any time).
function carried(s, fs, file, n, part, size) {
  const t = readText(fs, file, false), head = Buffer.from(textOf([docLine(s, n, part, true)]), 'utf8');
  if (!t || t.length !== size || !t.subarray(0, head.length).equals(head)) return null;
  const defs = new Set(), D = Buffer.from('\n{"d":');
  for (let j = t.indexOf(D); j >= 0; j = t.indexOf(D, j + 1)) defs.add(JSON.parse(t.subarray(j + 1, t.indexOf(10, j + 1)).toString('utf8')).d.bid);
  return { size, defs };
}
// first place in lane L whose step does not sort before (ts, rid)
function lowerBound(cols, L, ts, rid) {
  let lo = 0, hi = L.rids.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (compareStep(cols.ts[L.slots[m]], L.rids[m], ts, rid) < 0) lo = m + 1; else hi = m; }
  return lo;
}
// What changed in the fold log past byte `off`, for the spans below `open` (sealed) and the open one: a row that came, went, moved or
// changed moves every later step of its lane (old and new) — their `i`, the `k` of their user events, the axis numbers — so the
// packs holding those steps are dirty and those steps in the open span are appended again; a lane whose header changed is appended
// to its tail; a failed member dirties its span. `axis`: the first place of the axis lane that moved (undefined: none).
function dirtyOf(s, off, open) {
  const V = s.V, { cols, log } = V, ax = axisOf(V), packs = new Set(), opens = new Set(), gone = [], lanes = [], fails = [], from = new Map();
  const touch = (key, ts, rid) => { const L = laneOf(cols, key); if (L.v < 0) return; const j = lowerBound(cols, L, ts, rid); if (!(from.get(key) <= j)) from.set(key, j); };
  const rowOf = (at) => { const o = at && log.read(...at); return o && o.c != null ? o.r : null; };
  const ch = log.changedSince(off);
  for (const rid of ch.rids) {
    const r = rowOf(log.latest(rid)), w = off < 0 ? null : rowOf(log.versionAt(rid, off)), n = spanOf(s, rid);
    if (r) touch(r.lane, r.ts ?? null, rid);
    if (w) touch(w.lane, w.ts ?? null, rid);
    if (n >= 0 && n < open) packs.add(n);
    else if (n >= open && !r && w) gone.push([rid, w.lane === ax ? 'main' : 'rest']);
  }
  for (const [key, j] of from) {
    const L = laneOf(cols, key);
    for (let t = j; t < L.rids.length; t++) { const n = spanOf(s, L.rids[t]); if (n >= open) opens.add(L.rids[t]); else if (n >= 0) packs.add(n); }
  }
  const heads = new Map(V.lanes.map((h) => [h.lane, h]));
  for (const key of ch.lanes) if (heads.has(key)) lanes.push(heads.get(key));
  const failed = new Map(V.failed.map((f) => [f.id, f]));
  for (const rid of log.failures.since(off)) { const n = spanOf(s, rid); if (n >= 0 && n < open) packs.add(n); else if (failed.has(rid)) fails.push(failed.get(rid)); }
  return { packs, opens, gone, lanes, fails, axis: from.get(ax) };
}

/** writeFiles(ctx, s) → {packs, open} of the head: brings the session's pack and tail files to the state `s` (the worker's, after a
 *  slice). The first slice of a session in this worker (or of a fold log opened again) re-renders the packs with fold-log lines past
 *  the offset its sidecar says the files stood at, takes the others from their files when whole (else renders them), and carries
 *  on the tails its sidecar's checkpoint vouches for (carried), writing the others afresh; later slices seal the spans the mark passed
 *  (and start the next tail), re-render dirty packs and append to the tails.
 *  A file is written only when its text differs. */
export function writeFiles(ctx, s) {
  if (s.mark == null) return { packs: [], open: null };
  const home = ctx.home, fs = ctx.fs || nodeFs, id = s.id, log = s.V.log, N = sealedOf(s), ax = axisOf(s.V);
  let W = writers.get(log);
  if (W && W.ax === ax && W.f === log.frontier) return W.files;
  const first = !W || W.ax !== ax;
  if (first) {
    const parts = (log.saved && log.saved.parts) || {}, w = parts['w.f'], f = w && w.length ? w[0] : -1;
    // a worker that starts again: the tails the last one wrote, carried on where whole and as its checkpoint says (D71②③)
    let c = null, tails = null;
    try { c = !W && f >= 0 ? JSON.parse(parts['w.t'][0]) : null; } catch { /* no checkpoint: afresh */ }
    if (c && c.ax === ax) {
      const got = PARTS.map((p, i) => carried(s, fs, tailFile(home, id, p), N, p, c.size?.[i]));
      if (got.some(Boolean)) tails = Object.fromEntries(PARTS.map((p, i) => [p, got[i] || { size: -1, defs: new Set() }])); // −1: afresh
    }
    W = { ax, f, open: N, packs: [], tails, rec: tails ? c.rec : 0, files: null, memo: lru(MEMO_BYTES), sp: [] };
    writers.set(log, W);
  }
  const d = dirtyOf(s, W.f, Math.min(W.open, N)), spans = spansOf(s, axisSteps(s, W.sp, first ? 0 : d.axis ?? W.sp.length));
  if (d.axis !== undefined) for (const p of W.packs) if (p && p.s0 === p.s1) d.packs.add(p.n);
  W.packs.length = Math.min(W.packs.length, N);
  for (let n = 0; n < N; n++) {
    const k = W.packs[n];
    if (k && !d.packs.has(n)) continue;
    const files = PARTS.map((p) => packFile(home, id, n, p));
    // a pack sealed before this worker and unchanged since: its files, when whole
    let texts = first && !d.packs.has(n) ? files.map((f) => readText(fs, f, true)) : null;
    if (!texts || texts.includes(null)) {
      texts = PARTS.map((p) => render(s, n, p, false, n >= W.open ? W.memo : null, spans).buf);
      texts.forEach((t, i) => { if (k ? k.h[i] !== sha(t) : !same(readText(fs, files[i], true), t)) putFile(fs, files[i], gzipSync(t)); });
    }
    W.packs[n] = { n, s0: spans[n][0], s1: spans[n][1], tag: tagOf(texts[0], texts[1]), h: texts.map(sha) };
  }
  const fresh = (part) => {
    const { buf, wrote } = render(s, N, part, true, W.memo, spans), file = tailFile(home, id, part);
    if (!same(readText(fs, file, false), buf)) putFile(fs, file, buf);
    W.tails[part] = { size: buf.length, defs: wrote };
  };
  const upTo = upToOf(s);
  if (N !== W.open) W.memo = lru(MEMO_BYTES); // the sealed span's steps let go
  if (N !== W.open || !W.tails) { W.tails = {}; for (const p of PARTS) fresh(p); }
  else appendTails(s, W, d, N, upTo, fs, (part) => tailFile(home, id, part), fresh);
  W.rec = upTo; W.open = N; W.f = log.frontier;
  W.files = { packs: W.packs.map(({ n, s0, s1, tag }) => ({ n, s0, s1, tag })), open: { n: N, s0: spans[N][0] } };
  return W.files;
}
// The tails' appends: the lanes whose header changed, the changed steps of the span in step
// order (each against the step of its lane before it in the span: they are all in the file; none within 64 steps → a keyframe), the
// records of the members past the last append, the failed members, the rids no longer a call. A tail whose size is not the one
// written (torn, removed, replaced, or not carried on from the last worker) is written afresh instead.
function appendTails(s, W, d, N, upTo, fs, fileOf, fresh) {
  const { cols, log } = s.V, ax = W.ax, add = { main: [], rest: [] }, partOf = (key) => (key === ax ? 'main' : 'rest');
  for (const h of d.lanes) add[partOf(h.lane)].push({ l: h });
  const calls = [...d.opens].filter((rid) => isRow(cols, rid)).sort((x, y) => compareStep(cols.ts[cols.slotOf(x)], x, cols.ts[cols.slotOf(y)], y));
  const steppers = new Map();
  for (const rid of calls) {
    const key = log.read(...log.latest(rid)).r.lane, S = steppers.get(key) || steppers.set(key, laneStepper(s, key, W.memo)).get(key), i = placeIn(cols, S.L, rid);
    let p = -1;
    for (let t = i - 1; t >= 0 && t >= i - 64; t--) if (spanOf(s, S.rids[t]) >= N) { p = t; break; }
    add[partOf(key)].push(...stepLines(S, key, i, p, W.tails[partOf(key)].defs, W.memo));
  }
  const axV = ax == null ? -2 : cols.keys.get(ax);
  for (let q = W.rec; q < upTo; q++) {
    const r = s.plan.members[q], rid = String(r.id);
    if (s.cut(r)) add[isRow(cols, rid) && cols.ln[cols.slotOf(rid)] === axV ? 'main' : 'rest'].push({ r: recOf(r) });
  }
  for (const f of d.fails) add.rest.push({ x: { where: f.id, code: f.code, reason: f.reason } });
  for (const [rid, part] of d.gone) add[part].push({ g: rid });
  for (const part of PARTS) {
    const file = fileOf(part);
    let size = -1;
    try { size = fs.statSync(file).size; } catch { /* gone */ }
    if (size !== W.tails[part].size) { fresh(part); continue; }
    if (!add[part].length) continue;
    const t = textOf(add[part]);
    fs.appendFileSync(file, t);
    W.tails[part].size += Buffer.byteLength(t);
  }
}
