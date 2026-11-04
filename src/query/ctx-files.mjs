// src/query/ctx-files.mjs — the answer files of a session's directory (RFC 3.5 §会话读 `session --head`, §谁执行它「答案文件」; 4.3 §4 目录):
// `head.json.gz` (`head.pending.json.gz` while it folds: HEAD_FILES) = the gzip of the compact JSON of `trocar query session --id S --head`,
// the board's first screen in one file (D71①).
// The head is a function of the disk and the mark only (D69③): no wall clock, every list in step order or sorted, so the worker's
// file, the worker's answer and the local path's answer at one mark are the same bytes. Only the query worker writes (writeHead).
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as Z, deflateRawSync, gzipSync, gunzipSync } from 'node:zlib';
import { SCHEMA_VERSION } from '../cli/schema.mjs';
import { sessionMetaOfFacts } from '../view/board.mjs';
import { listOf } from '../view/reduce.mjs';
import { compareStep } from '../view/step-order.mjs';
import { HEAD_FILES } from './ctx-key.mjs';
import { lru, sessionDir } from './projection.mjs';
import { isModelCall, sessionFactsOf } from './rows.mjs';
import { laneOf, placeIn, recOf, wireRow, FLAG } from './session-doc.mjs';
import { laneStepper, weigh } from './named/lane.mjs';

/** The answer files' format version (3.5 `v`). */
export const CTX_V = 3;
/** The lane headers a head lists at most, the axis lane first, then the most recently active (3.5 `lanes`, SHOULD 64). */
export const HEAD_LANES = 64;
// cells of `cols` at most (3.5 `bucket`), failed members `errors` names at most, tier-0 time buckets at most
const CELLS = 32_768, FAILED_SHOWN = 64, BUCKETS = 240;

/** The members a pack holds: pack n = the plan's members at write positions [PACK_MEMBERS·n, PACK_MEMBERS·(n+1)) (3.5, SHOULD 512). */
export const PACK_MEMBERS = 512;

/** headFile(home, id, folding) → the session's head file under one of its two names (HEAD_FILES). */
export const headFile = (home, id, folding = false) => path.join(sessionDir(home, id), folding ? HEAD_FILES.folding : HEAD_FILES.rest);
/** hasHead(home, id, fs) → whether the session has a head file, under either name. */
export const hasHead = (home, id, fs = nodeFs) => fs.existsSync(headFile(home, id)) || fs.existsSync(headFile(home, id, true));
/** readHead(home, id, fs) → the parsed head under whichever name exists, else null (none, or torn). */
export function readHead(home, id, fs = nodeFs) {
  for (const folding of [false, true]) { try { return JSON.parse(gunzipSync(fs.readFileSync(headFile(home, id, folding))).toString('utf8')); } catch { /* the other name */ } }
  return null;
}

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

/** tier0Doc(id, members, errors, title) → the tier-0 head of a session with no reduction state: from its segment index rows and its title
 *  (src/query/titles.mjs; meta as the `sessions` query has it, its model calls in ≤ BUCKETS equal spans of time). */
export function tier0Doc(id, members, errors, title = null) {
  const f = sessionFactsOf(id, members), calls = members.filter(isModelCall);
  const ts = calls.map((r) => Date.parse(r.ts)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b), buckets = [];
  if (ts.length) {
    const t0 = ts[0], t1 = ts.at(-1), m = t1 > t0 ? Math.min(BUCKETS, ts.length) : 1, w = (t1 - t0) / m;
    for (let i = 0; i < m; i++) buckets.push({ ts0: new Date(t0 + i * w).toISOString(), ts1: new Date(i === m - 1 ? t1 : t0 + (i + 1) * w).toISOString(), calls: 0 });
    for (const t of ts) buckets[Math.min(m - 1, w ? Math.floor((t - t0) / w) : 0)].calls++;
  }
  return docOf(errorsOf(errors, []), {
    id, tier: 0, mark: null, markTs: null, pending: { done: 0, total: members.length }, truncated: null, failed: 0,
    meta: sessionMetaOfFacts({ ...f, title }), stats: { calls: f.calls }, logged: f.logged, probes: f.probes,
    axis: null, steps: calls.length, peak: 0, cols: '', bucket: 1, chapters: [], packs: [], open: null, lanes: [], lanesMore: 0, last: null, buckets,
  });
}

/** headDone(d, members) → the members head `d` has done: its `pending.done`, else the members at or below its mark. */
export function headDone(d, members) {
  const rid = d.mark == null ? null : String(d.mark).replace(/@.*$/, ''); // a cut's mark is `rid@cut` (named/session.mjs markOn)
  return d.pending ? d.pending.done : rid == null ? 0 : members.findIndex((r) => String(r.id) === rid) + 1;
}
/** pendingHead(home, id, members, errors, pending, fs, title) → the head on disk (else the tier-0 head of `members`, saying `title`) with `pending` put in,
 *  the rest as it was written (3.5 §会话读「`session --head`」 pending): `pending(d, done)` → the pending of head `d`, `done` the
 *  members at or below its mark. A stopped fold's (`stopped`) and the progress of a backlog no answer file is written in. */
export function pendingHead(home, id, members, errors, pending, fs = nodeFs, title = null) {
  let d = readHead(home, id, fs);
  if (!d || d.v !== CTX_V) d = tier0Doc(id, members, errors, title);
  return { ...d, pending: pending(d, headDone(d, members)) };
}

/** writeHead(home, id, doc, fs) → whether the file changed: the gzip of the doc's compact JSON (putFile) under the name its `pending`
 *  says (HEAD_FILES), the other name removed first, so at most one exists; nothing is written when the bytes are the file's. */
export function writeHead(home, id, doc, fs = nodeFs) {
  const folding = !!doc.pending && !doc.pending.stopped, file = headFile(home, id, folding), bytes = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
  try { if (fs.readFileSync(file).equals(bytes)) return false; } catch { /* none yet */ }
  try { fs.unlinkSync(headFile(home, id, !folding)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  putFile(fs, file, bytes);
  return true;
}
/** writeSkip(home, id, rid, fs): the upgrade queue's marker (3.5 §谁执行它「答案文件」, 4.3 §4「目录」): this session, whose last member
 *  was `rid`, was folded to its end (or stopped) and still has no tail file. */
export const skipFile = (home, id) => path.join(sessionDir(home, id), 'upgrade.skip');
export const writeSkip = (home, id, rid, fs = nodeFs) => putFile(fs, skipFile(home, id), Buffer.from(rid, 'utf8'));
/** The re-read marker (3.5 §访问模式「版本变更的重读」, 4.3 §4「目录」): an empty file, there while the session's answer files are the last
 *  version's whole answer and the fold that replaces them is not at its end. */
export const rereadFile = (home, id) => path.join(sessionDir(home, id), 'reread');
export const hasReread = (home, id, fs = nodeFs) => fs.existsSync(rereadFile(home, id));
export const markReread = (home, id, fs = nodeFs) => putFile(fs, rereadFile(home, id), Buffer.alloc(0));
export function clearReread(home, id, fs = nodeFs) { try { fs.unlinkSync(rereadFile(home, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
// A whole file written to a temporary file and renamed over (EPERM / EBUSY, a reader holding it on Windows: tried 3 times).
export function putFile(fs, file, bytes) {
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
export const axisOf = (V) => (V.lanes.find((l) => l.kind === 'main') || V.lanes[0] || { lane: null }).lane; // as headDoc's axis
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
// steppers keep each block's tool_use facts in it too (by bid: lane.mjs laneStepper `uses`), so a list is not read again at every slice.
/** memoBytes() → what the open span's memo holds at most (the least recently used out): one of K's fixed caches (3.5 §内存有界). A
 *  function, hoisted: named/session.mjs reads it while it is evaluated, which can be before this module is (the cycle through lane.mjs). */
export function memoBytes() { return 4 << 20; }
function stepLines(cols, S, key, i, p, wrote, memo = null) {
  const rid = S.rids[i], k = memo && `${rid}\n${p < 0 ? '' : S.rids[p]}`;
  let st = memo && memo.get(k);
  if (!st) { st = S.step(i, p); if (memo) memo.set(k, st, weigh(st)); }
  const out = [{ c: wireRow(cols, S.lineAt(i).r) }];
  for (const bid of [...st.ops.flatMap((op) => (op[0] === 1 ? op.slice(1) : [])), ...st.reply]) {
    if (wrote.has(bid)) continue;
    wrote.add(bid);
    const dk = `${bid}\n${rid}`;
    let w = memo ? memo.get(dk) : undefined;
    if (w === undefined) { w = S.defOf(bid, S.listAt(i)); if (memo) memo.set(dk, w, weigh(w)); }
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
export const renderSpan = (s, n, part, tail = false) => drain(rendering(s, n, part, tail)).buf.toString('utf8');
// A generator's work to its end (the local path and the requests: no budget).
const drain = (it) => { for (;;) { const r = it.next(); if (r.done) return r.value; } };
// a span's doc-head line
const docLine = (s, n, part, tail, [s0, s1] = axisSpans(s)[n]) => docOf(errorsOf(s.indexErrors, []), { id: s.id, ...(tail ? { tail: { n, part, s0 } } : { pack: { n, part, s0, s1 } }) }, 'lane');
// → {buf, wrote}: the span's text, rendered a call at a time (it yields after each: the writer's unit, 3.5 后台抽取与归约)
function* rendering(s, n, part, tail, memo = null, spans = axisSpans(s)) {
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
    out.push(...stepLines(cols, S, key, i, prev.has(key) ? prev.get(key) : -1, wrote, memo));
    prev.set(key, i);
    S.release(i);
    yield;
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
  for (let n = 0; n < N; n++) packs.push({ n, s0: spans[n][0], s1: spans[n][1], tag: tagOf(drain(rendering(s, n, 'main', false, null, spans)).buf, drain(rendering(s, n, 'rest', false, null, spans)).buf) });
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
export const forget = (log) => { writers.delete(log); jobs.delete(log); };
// fold log → {f, ax, it}: the writer's work toward the state at frontier `f` that a slice's budget did not cover (writeFiles)
const jobs = new WeakMap();
// The gzip of a file's text ~1 MiB at a time (one piece a unit): each piece deflated with the 32 KiB before it as its dictionary and
// flushed to a byte boundary, the last one finished, so the pieces make one deflate stream; they are cut by offset only, so the
// bytes do not depend on how the work was sliced (3.5 后台抽取与归约). One gzip member: the header, the stream, CRC-32, the length.
const GZ_PIECE = 1 << 20, GZ_HEAD = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
const CRC = Int32Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b, c) => { c = ~c; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
function* gzipping(text) {
  const out = [GZ_HEAD];
  let crc = 0;
  for (let a = 0; a === 0 || a < text.length; a += GZ_PIECE) {
    const x = text.subarray(a, a + GZ_PIECE), last = a + GZ_PIECE >= text.length;
    out.push(deflateRawSync(x, { ...(a ? { dictionary: text.subarray(a - 32_768, a) } : null), ...(last ? null : { finishFlush: Z.Z_SYNC_FLUSH }) }));
    crc = crc32(x, crc);
    yield;
  }
  const t = Buffer.alloc(8);
  t.writeUInt32LE(crc, 0); t.writeUInt32LE(text.length % 2 ** 32, 4);
  return Buffer.concat([...out, t]);
}
// a file's bytes (gunzipped), or null when it is missing, does not gunzip, is torn or its head line has another v
function readText(fs, file, gz) {
  try {
    const b = gz ? gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
    return b[b.length - 1] === 10 && JSON.parse(b.subarray(0, b.indexOf(10)).toString('utf8')).v === CTX_V ? b : null;
  } catch { return null; }
}
const same = (a, b) => !!a && a.equals(b);
// a file's text begins with the doc-head line `o`
const headed = (t, o) => { const h = Buffer.from(textOf([o]), 'utf8'); return !!t && t.subarray(0, h.length).equals(h); };
// The tail `part` of span n a worker before this one wrote, carried on by appends: whole, of the size its checkpoint says (nothing
// was written to it after the checkpoint), its doc-head line the one a render now writes (same v, span, s0, errors); the definitions
// it holds read back from its `{d}` lines. Else (a line that does not parse too) null: it is written afresh (a fresh render is as
// valid at any time).
function carried(s, fs, file, n, part, size) {
  const t = readText(fs, file, false);
  if (!t || t.length !== size || !headed(t, docLine(s, n, part, true))) return null;
  const defs = new Set(), D = Buffer.from('\n{"d":');
  try {
    for (let j = t.indexOf(D); j >= 0; j = t.indexOf(D, j + 1)) defs.add(JSON.parse(t.subarray(j + 1, t.indexOf(10, j + 1)).toString('utf8')).d.bid);
  } catch { return null; }
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
  // the headers of V.lanes by key are the columns' (session-doc.mjs viewOf): no map of every lane is made for the few that changed
  for (const key of ch.lanes) if (cols.lanes.has(key)) lanes.push(cols.heads.get(key));
  const failing = log.failures.since(off), failed = failing.length ? new Map(V.failed.map((f) => [f.id, f])) : null;
  for (const rid of failing) { const n = spanOf(s, rid); if (n >= 0 && n < open) packs.add(n); else if (failed.has(rid)) fails.push(failed.get(rid)); }
  return { packs, opens, gone, lanes, fails, axis: from.get(ax) };
}

/** writeFiles(ctx, s, deadline = Infinity) → {packs, open} of the head: brings the session's pack and tail files to the state `s`
 *  (the worker's, after a slice); null when `deadline` (a performance.now() time) passed first: what is left goes on at the next call
 *  at the same state, a unit at a time (a call's render, a piece of a gzip, a file: 3.5 后台抽取与归约); a call at another state
 *  goes on from the packs the last one finished. The first slice of a session in this worker (or of a fold log opened again) re-renders the packs with fold-log lines past
 *  the offset its sidecar says the files stood at, takes the others from their files when whole and written under the axis it has
 *  (its checkpoint's; else renders them), and carries
 *  on the tails its sidecar's checkpoint vouches for (carried), writing the others afresh; later slices seal the spans the mark passed
 *  (and start the next tail), re-render the packs whose rows or doc head ([s0, s1]) changed and append to the tails.
 *  A file is written only when its text differs. */
export function writeFiles(ctx, s, deadline = Infinity) {
  if (s.mark == null) return { packs: [], open: null };
  const log = s.V.log, ax = axisOf(s.V);
  let j = jobs.get(log);
  // the frontier moved under it: the packs it finished stay (W), the rest is written at the new state (3.5 后台抽取与归约)
  if (j && (j.f !== log.frontier || j.ax !== ax)) { jobs.delete(log); j = null; }
  if (!j) {
    const W = writers.get(log);
    if (W && W.ax === ax && W.f === log.frontier) return W.files;
    jobs.set(log, (j = { f: log.frontier, ax, it: writing(ctx, s) }));
  }
  for (;;) {
    const r = j.it.next();
    if (r.done) { jobs.delete(log); return r.value; }
    if (performance.now() >= deadline) return null;
  }
}
function* writing(ctx, s) {
  const home = ctx.home, fs = ctx.fs || nodeFs, id = s.id, log = s.V.log, N = sealedOf(s), ax = axisOf(s.V);
  let W = writers.get(log);
  const first = !W || W.ax !== ax;
  if (first) {
    let c = null; // the checkpoint of the worker before this one: the axis its files were written under (else unknown: none is kept)
    const parts = (log.saved && log.saved.parts) || {}, w = parts['w.f'], f = w && w.length ? w[0] : -1;
    // a worker that starts again: the tails the last one wrote, carried on where whole and as its checkpoint says (D71②③)
    let tails = null;
    try { c = !W && f >= 0 ? JSON.parse(parts['w.t'][0]) : null; } catch { /* no checkpoint: afresh */ }
    if (c && c.ax === ax) {
      const got = PARTS.map((p, i) => carried(s, fs, tailFile(home, id, p), N, p, c.size?.[i]));
      if (got.some(Boolean)) tails = Object.fromEntries(PARTS.map((p, i) => [p, got[i] || { size: NaN, defs: new Set() }])); // NaN: no size, a missing file's −1 neither, is it: afresh
    }
    W = { ax, f, open: N, packs: [], tails, rec: tails ? c.rec : 0, files: null, memo: lru(memoBytes()), mn: N, sp: [], c };
    writers.set(log, W);
  }
  const c = W.c, d = dirtyOf(s, W.f, Math.min(W.open, N)), spans = spansOf(s, axisSteps(s, W.sp, first ? 0 : d.axis ?? W.sp.length));
  W.packs.length = Math.min(W.packs.length, N);
  for (let n = 0; n < N; n++) {
    const k = W.packs[n];
    if (k && !d.packs.has(n) && k.s0 === spans[n][0] && k.s1 === spans[n][1]) continue; // its rows and its doc head as written
    // a pack whose writing a moved frontier cut short goes on where it stood while no member folded since touched its rows or its doc
    // head (3.5 后台抽取与归约): calls arriving faster than one seal do not start it over
    let P = W.part;
    if (!(P && P.n === n && P.s0 === spans[n][0] && P.s1 === spans[n][1] && (P.f === log.frontier || !dirtyOf(s, P.f, n + 1).packs.has(n))))
      W.part = P = { n, s0: spans[n][0], s1: spans[n][1], it: sealing(s, { home, fs, ax, memo: n >= W.open ? W.memo : null }, n, spans, c && c.ax === ax && !d.packs.has(n), k) };
    P.f = log.frontier;
    let r;
    while (!(r = P.it.next()).done) yield;
    W.packs[n] = r.value;
    W.part = null;
  }
  // a tail written afresh → its {size, defs}
  const fresh = function* (part) {
    const { buf, wrote } = yield* rendering(s, N, part, true, W.memo, spans), file = tailFile(home, id, part);
    if (!same(readText(fs, file, false), buf)) putFile(fs, file, buf);
    yield;
    return { size: buf.length, defs: wrote };
  };
  const upTo = upToOf(s);
  if (N !== W.mn) { W.memo = lru(memoBytes()); W.mn = N; } // the sealed span's steps let go, once a seal (not at each start over)
  // the tails are no checkpoint while they are written (W.tails null): a frontier that moves before they are done has them written
  // afresh, as has a worker that starts again from a save between the units
  const t = N !== W.open ? null : W.tails;
  W.tails = null;
  if (!t) { const t = {}; for (const p of PARTS) t[p] = yield* fresh(p); W.tails = t; }
  else { yield* appendTails(s, { ...W, tails: t }, d, N, upTo, fs, (part) => tailFile(home, id, part), fresh); W.tails = t; }
  W.rec = upTo; W.open = N; W.f = log.frontier; W.c = null;
  W.files = { packs: W.packs.map(({ n, s0, s1, tag }) => ({ n, s0, s1, tag })), open: { n: N, s0: spans[N][0] } };
  return W.files;
}
// pack n's files brought to the state `s` (`kept`: its files may be taken as they are) → its W.packs entry
function* sealing(s, { home, fs, ax, memo }, n, spans, kept, k) {
  const files = PARTS.map((p) => packFile(home, s.id, n, p));
  // a pack sealed before this worker and unchanged since, its files written under this axis (a pack's main / rest split is the
  // axis's): its files, when whole and their doc head ([s0, s1]) the one a render now writes
  let texts = null;
  if (kept) { texts = files.map((f, i) => { const t = readText(fs, f, true); return headed(t, docLine(s, n, PARTS[i], false, spans[n])) ? t : null; }); yield; }
  if (!texts || texts.includes(null)) {
    texts = [];
    for (const p of PARTS) texts.push((yield* rendering(s, n, p, false, memo, spans)).buf);
    for (let i = 0; i < PARTS.length; i++) {
      const t = texts[i], due = k ? k.h[i] !== sha(t) : !same(readText(fs, files[i], true), t);
      yield;
      if (due) { putFile(fs, files[i], yield* gzipping(t)); yield; }
    }
  }
  return { n, s0: spans[n][0], s1: spans[n][1], tag: tagOf(texts[0], texts[1]), h: texts.map(sha) };
}
// The tails' appends: the lanes whose header changed, the changed steps of the span in step
// order (each against the step of its lane before it in the span: they are all in the file; none within 64 steps → a keyframe), the
// records of the members past the last append, the failed members, the rids no longer a call. A tail whose size is not the one
// written (torn, removed, replaced, or not carried on from the last worker) is written afresh instead.
function* appendTails(s, W, d, N, upTo, fs, fileOf, fresh) {
  const { cols, log } = s.V, ax = W.ax, add = { main: [], rest: [] }, partOf = (key) => (key === ax ? 'main' : 'rest');
  for (const h of d.lanes) add[partOf(h.lane)].push({ l: h });
  const calls = [...d.opens].filter((rid) => isRow(cols, rid)).sort((x, y) => compareStep(cols.ts[cols.slotOf(x)], x, cols.ts[cols.slotOf(y)], y));
  const steppers = new Map();
  for (const rid of calls) {
    const key = log.read(...log.latest(rid)).r.lane, S = steppers.get(key) || steppers.set(key, laneStepper(s, key, W.memo)).get(key), i = placeIn(cols, S.L, rid);
    let p = -1;
    for (let t = i - 1; t >= 0 && t >= i - 64; t--) if (spanOf(s, S.rids[t]) >= N) { p = t; break; }
    add[partOf(key)].push(...stepLines(cols, S, key, i, p, W.tails[partOf(key)].defs, W.memo));
    yield;
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
    if (size !== W.tails[part].size) { W.tails[part] = yield* fresh(part); continue; }
    if (!add[part].length) continue;
    const t = textOf(add[part]);
    fs.appendFileSync(file, t);
    W.tails[part].size += Buffer.byteLength(t);
  }
}
