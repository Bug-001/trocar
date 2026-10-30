// src/query/index-build.mjs — the SEGMENT INDEX (RFC 1.6 §4.1, 4.2 §段索引; D59).
//
// `trocar query` reads the raw records themselves; the only thing it keeps beside them is one small
// index file per segment under ~/.trocar/index/. It is a CACHE, nothing else: delete the directory and
// the next read rebuilds it, byte for byte the same (test/query/segment-index.test.mjs). Nothing else
// in the home is ever written by a query (V79).
//
// Per record it holds exactly what the list queries print (1.6 §4.1 「段索引每条记录存什么」): id, time,
// harness, class, host, path, status, stored and wire bytes, session key, and whether it is a model call.
// No body, no headers — those are read back from the segment itself (src/query/source.mjs).
//
// INVALIDATION is the identity rule of src/query/source.mjs (size, mtime, ctime + the first and last 4 KB
// before the last indexed line), not a rule of its own: a segment that only GREW is resumed from the
// byte offset where its last complete line ended, so the段 being written costs its new bytes, never a
// re-read; anything else (a rewrite, a truncation, a different file at the same name) rebuilds whole.
// A half line at the end of a segment (a crash) is not indexed and not rewritten — it becomes the next
// record once the writer completes it.
//
// WHO KEEPS IT CURRENT (D62, 1.6 §4.1 随机取用 ≤ 0.5 s): the daemon, as a side effect of writing — it is the only
// writer of a segment, so it is the only thing that can index the bytes it just appended
// (src/collector/index-keeper.mjs for the segment it appends to, the seal worker for the sealed copy), and it does so
// by APPENDING to the index document, so the cost of being current is the new records' and not the segment's (the
// format below). The build here stays as the FALLBACK — no daemon ever wrote this segment, the user deleted index/,
// INDEX_V was bumped, the segment was rewritten — and a reader that pays for more than a chunk of it says so
// (`index-cold` in the document's errors, D38) instead of silently charging the query seconds. A reader never WRITES
// a plaintext segment's index (that file is the daemon's): it scans the tail no index covers in memory. `maxBytes` is
// what lets the keeper work in chunks: it stops at the first line boundary past that many bytes and reports
// `done: false`, and the next call resumes where it stopped.
import nodeFs from 'node:fs';
import path from 'node:path';
import { parseSegment, recordId } from '../collector/core/record/segments.mjs';
import { harnessOf, sessionKeyOf, headerOf } from '../dissect/harnesses.mjs';
import { synthFactsOf } from '../dissect/synth-key.mjs';
import { isLogOnly } from '../dissect/capture-labels.mjs';
import { expandRequestBody } from '../dissect/request-body.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { fpRanges, readRangeSync } from './source.mjs';
import { openSealed } from '../raw/reader.mjs';
import { R, FLAG_NL, FLAG_UNPARSEABLE } from '../raw/format.mjs';
import { trocarHome, collectorHome } from '../paths.mjs';
import { readDaemonLock } from '../off/daemon-stop.mjs';
import { statKey, warmCache, fsTag } from './warm.mjs';
import { rowTable, isRowTable, heapOf } from './row-table.mjs';

const rawDir = (home = trocarHome()) => path.join(home, 'raw');
export const indexDir = (home = trocarHome()) => path.join(home, 'index');
const INDEX_V = 6;
const CHUNK = 1 << 20;
// How many appended bytes one catch-up of the daemon's keeper takes (src/collector/index-keeper.mjs imports it): the
// unit of "a chunk of index work". A READER that had to read more than this from a segment is the honest definition of
// a cold index (D62 · D38): the keeper never leaves that much behind, so nothing was keeping this index current.
export const KEEPER_CHUNK_BYTES = 4 << 20;
const NL = 0x0a;
// One direction's wire bytes: the number when it is one, else null — not recorded is never 0 (4.2 §段索引, invariant 4).
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
// What a session is made of, per record, so `sessions` never reads a record back (1.6 §4.1 速度目标 ≤ 1 s).
// Each is a fact of THIS record; the grouping and the counting are the read side's (src/query/rows.mjs), and
// the session key is the ONE table's answer (3.4, body keys included), not a header list of this file's own.
const entrypointOf = (e) => {
  const app = String(headerOf(e, 'x-app') || '').toLowerCase(), ua = String(headerOf(e, 'user-agent') || headerOf(e, 'originator') || '').toLowerCase();
  if (app === 'desktop' || /desktop/.test(ua)) return 'desktop';
  if (app === 'cli' || /cli|sdk-cli/.test(ua)) return 'cli';
  return null;
};

// ── one line → one index record ───────────────────────────────────────────
// A line that is not JSON can never be indexed (its bytes are still on disk and `raw cat` still prints
// them): it is reported, and it keeps its line number so every later record's id stays what it was.
function recordOf(lineBuf, segment, lineNo, problems, offset = null) {
  let e;
  try { e = JSON.parse(lineBuf.toString('utf8')); } catch (err) {
    problems.push({ code: 'record-unparseable', reason: `${recordId(segment, lineNo)} is not JSON (${err.message}); it is left out of the index` });
    return null;
  }
  return indexEntryOf(e, { segment, lineNo, storedBytes: lineBuf.length, offset });
}

/**
 * ONE record's index entry, from the record as an object — the single definition of what the index holds, used both by
 * the scan above (which parses the line back) and by the daemon's keeper, which hands over the envelope it just
 * serialized instead of re-reading and re-parsing its own bytes (D62; index-keeper.mjs `wrote`). Two callers, one
 * implementation, so the keeper's document stays what a fresh rebuild produces — test/query/segment-index.test.mjs
 * holds that, and test/collector/index-keeper-entries.test.mjs holds it for the keeper's path specifically.
 *   storedBytes: the line's bytes WITHOUT its newline (what `lineBuf.length` is above).
 *   offset: where the line starts in the plaintext segment (null: sealed).
 */
export function indexEntryOf(env, { segment, lineNo, storedBytes, offset = null }) {
  // the body as the board reads it: a request body stored compressed (req_body null + req_body_b64) still carries its session key
  const e = expandRequestBody(env);
  const wire = e.body_wire_bytes || {};
  const h = harnessOf(e);
  const synth = synthFactsOf(e);
  return {
    id: recordId(segment, lineNo),
    ts: e.ts_request ?? e.ts ?? null,
    harness: (e.proc && e.proc.agent) ?? null,
    class: e.traffic_class ?? null,
    host: e.host ?? null,
    path: e.endpoint ?? null,
    status: (e.resp && e.resp.status) ?? null,
    stored_bytes: storedBytes,
    sent_bytes: finite(wire.req),
    received_bytes: finite(wire.resp),
    session_key: sessionKeyOf(e).key ?? null,
    is_llm: !!e.is_llm_call,
    // the session facts: harness_id is the harness the BOARD decides (proc, else the UA — and it says which)
    harness_id: h.id,
    has_proc: !!(e.proc && typeof e.proc === 'object'),
    has_headers: !!(e.req_headers || e.request_headers),
    harness_inferred: !!h.inferred,
    entrypoint: entrypointOf(e),
    log_only: isLogOnly(e),
    subagent: !!String(headerOf(e, 'x-claude-code-agent-id') || '').trim(),
    synth_hash: synth && synth.hash != null ? synth.hash : null,
    // kinship (3.4 按内容认亲): any call of a `synth: true` harness → the user-text fingerprints its session is recognized by; a
    // keyless call that is its harness's compaction request → the ones it looks with. Space-joined strings ('' when none): a scalar row.
    kin_fp: synth && synth.fp ? synth.fp.join(' ') : null,
    kin_probe: synth && synth.probe ? synth.probe.join(' ') : null,
    offset,  // where this line starts in the plaintext segment, so one record is read by seek (null: sealed)
  };
}

// Byte-scan `file` from `from`, one record per complete line, holding one chunk + one line at a time.
// → { records, mark, bytesRead, done }: mark.end = just past the last newline (where the next read resumes).
// `maxBytes` stops the scan at the first line boundary past that many bytes (`done: false`); it always takes at least
// one whole line, so a caller that loops until `done` always makes progress, however long a single line is.
// `progress` is called after every chunk read: a scan of a cold segment is background work the query worker reports (3.5 后台抽取与归约).
function scanNdjson(fs, file, from, firstLine, segment, problems, maxBytes = Infinity, progress = null) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.allocUnsafe(CHUNK);
    const records = [];
    let pos = from, lineStart = from, lineNo = firstLine - 1, pending = Buffer.alloc(0);
    const take = (lineBuf) => {
      lineNo++;
      if (lineBuf.length) { const r = recordOf(lineBuf, segment, lineNo, problems, lineStart); if (r) records.push(r); }
      lineStart += lineBuf.length + 1;
    };
    while (pos < st.size && (lineStart === from || pos - from < maxBytes)) {
      // read no further than this call's budget; with no complete line yet the budget is ignored, so one line longer
      // than a chunk is still taken whole and the caller always makes progress
      const budget = maxBytes - (pos - from);
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, budget > 0 ? budget : CHUNK), pos);
      if (!n) break;
      let seg = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== NL) continue;
        take(pending.length ? Buffer.concat([pending, buf.subarray(seg, i)]) : Buffer.from(buf.subarray(seg, i)));
        pending = Buffer.alloc(0);
        seg = i + 1;
      }
      if (seg < n) pending = Buffer.concat([pending, buf.subarray(seg, n)]);
      pos += n;
      if (progress) progress();
    }
    const end = lineStart;
    const done = pos >= st.size;
    // the identity ranges as a DIGEST, not as bytes: every pass appends a mark, and two 4 KB ranges in base64 would
    // make each mark line 11 KB — more than the entries it marks (D62 写放大).
    // `size` is what the identity rule compares against (usability below). A scan that stopped early must NOT claim
    // the bytes past `end`: it records the file as far as it indexed it, so the next read sees a GROWN file and resumes.
    const mark = { size: done ? st.size : end, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, end, lines: lineNo, fp: fpDigest((a, b) => readRangeSync(fd, a, b), end) };
    return { records, mark, bytesRead: pos - from, done };
  } finally { fs.closeSync(fd); }
}

// A sealed segment: its own index already knows every line's number and length, so the records come
// out with the ids they had before sealing (V88). A file that cannot be read is reported, never
// silently empty.
function scanSealed(fs, file, segment, problems) {
  let sf;
  try { sf = openSealed(file, { fs }); } catch (e) {
    problems.push({ code: 'segment-unreadable', reason: `${path.basename(file)}: ${String((e && e.message) || e)}` });
    return { records: [], mark: { size: fs.statSync(file).size, sealed: true }, bytesRead: 0, done: true };
  }
  try {
    const records = [];
    for (let i = 0; i < sf.count; i++) {
      const r = sf.records[i], lineNo = Number(r[R.lineNo]) + 1;
      if (r[R.flags] & FLAG_UNPARSEABLE) { problems.push({ code: 'record-unparseable', reason: `${recordId(segment, lineNo)} was not JSON when it was sealed; it is left out of the index` }); continue; }
      let line;
      try { line = sf.lineAt(i); } catch (e) { problems.push({ code: 'record-unreadable', reason: `${recordId(segment, lineNo)}: ${String((e && e.message) || e)}` }); continue; }
      if (line.length && line[line.length - 1] === NL) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      const rec = recordOf(line, segment, lineNo, problems);
      if (rec) records.push(rec);
    }
    return { records, mark: sealedMark(fs, file), bytesRead: fs.statSync(file).size, done: true };
  } finally { sf.close(); }
}

// ── the index document: append-only NDJSON (INDEX_V 6; 4.2 §段索引) ────────
// One file per segment, one line per fact: an entry (a record, bare), a problem (`{"p":…}`), or a mark
// (`{"m":…,"v":6}` = "the index covers this segment up to m.end"). A pass APPENDS its new entries and problems and
// then one mark; a reader takes everything up to the LAST complete mark and ignores what follows it (a torn batch).
// That is what makes keeping the index current cost the NEW records, never the whole segment: the whole-document
// format this replaces (v3) rewrote ≈ e·N²/2 bytes per segment, and real traffic gives nearly every record a pass of
// its own. A v3 document has no mark line, so it is simply stale and is rebuilt like any stale index.
const entryLine = (r) => `${JSON.stringify(r)}\n`;
const problemLine = (p) => `${JSON.stringify({ p })}\n`;
const markLine = (m) => `${JSON.stringify({ m, v: INDEX_V })}\n`;
const fpDigest = (read, end) => { const h = createHash('sha256'); for (const [a, b] of fpRanges(end)) h.update(read(a, b)); return h.digest('base64'); };

// The whole document, for a READER: everything up to the last complete mark line.
// → { mark, records, problems, read } | null (no usable index). `read` is where this read stopped: the file (its ino), the byte
// just past the last complete mark line, and that line's bytes. Given an earlier answer over the same file (`past`), a reader
// reads only the bytes past that mark while the file is still that one (same ino: a whole rewrite is a rename, a new file) and
// the mark line's bytes at its offset are unchanged (the keeper cuts a torn batch back to a mark, never before the last one it
// wrote); else whole. The entries are the whole read's either way (4.2:49): keeping them current costs the new lines (D62).
export function readIndex(fs, file, v = INDEX_V, past = null) {
  if (past && past.read) { const got = readPast(fs, file, v, past); if (got !== undefined) return got; }
  let ino = null, buf;
  try { ino = fs.statSync(file).ino } catch { /* read below says whether it is there */ }
  try { buf = fs.readFileSync(file) } catch { return null; }
  // ONE JSON.parse over the document, not one per line: a JSON line never holds a raw newline, so the document is an
  // array once every newline is a comma (≈ 1.5× faster than per line on a 20 k-entry index — this is the path every
  // query pays). A torn last batch makes that parse fail, and then the line loop takes what is complete.
  let lines;
  try { lines = JSON.parse(asArray(buf)); } catch { lines = completeLines(buf); }
  const got = { mark: null, records: [], problems: [], read: null };
  const upTo = lastMark(lines, v, got);
  if (upTo === null || !got.mark) return null;
  for (let i = 0; i < upTo; i++) {        // no spread: one segment can hold ~85 k entries
    const o = lines[i];
    if (o.m) continue;
    if (o.p) got.problems.push(o.p); else got.records.push(o);
  }
  got.read = readTo(buf, 0, upTo, ino);
  return got;
}
// The index of the last complete mark line of `lines` (its mark into got.mark), -1 when none; null when a mark is of another
// format (stale, rebuilt like any stale index). A line that is no object ends what is read.
function lastMark(lines, v, got) {
  let upTo = -1;
  for (let i = 0; i < lines.length; i++) {
    const o = lines[i];
    if (!o || typeof o !== 'object') break;
    if (!o.m) continue;
    if (o.v !== v) return null;
    got.mark = o.m; upTo = i;
  }
  return upTo;
}
// Where a read of `buf` (the file's bytes from `base`) that ends with line `upTo` stopped: { ino, at, line }.
function readTo(buf, base, upTo, ino) {
  if (ino == null) return null;
  let start = 0, at = 0;
  for (let i = 0; i <= upTo; i++) { const nl = buf.indexOf(NL, at); if (nl < 0) return null; start = at; at = nl + 1; }
  return { ino, at: base + at, line: Buffer.from(buf.subarray(start, at)) };
}
// The bytes past `past`'s mark → the answer a whole read gives, or undefined: the file is not the one `past` read (read whole).
function readPast(fs, file, v, past) {
  const { ino, at, line } = past.read;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const st = fs.fstatSync(fd);
    const from = at - line.length;
    if (st.ino !== ino || st.size < at) return undefined;
    const buf = Buffer.alloc(st.size - from);
    let n = 0;
    while (n < buf.length) { const r = fs.readSync(fd, buf, n, buf.length - n, from + n); if (!r) break; n += r; }
    if (n < line.length || !buf.subarray(0, line.length).equals(line)) return undefined;
    const tail = buf.subarray(line.length, n), lines = completeLines(tail);
    const got = { mark: past.mark, records: null, problems: null, read: null };
    const upTo = lastMark(lines, v, got);
    if (upTo === null) return null;
    if (upTo < 0) return past;                     // nothing new is asserted yet: the same answer
    const records = [], problems = [];
    for (let i = 0; i < upTo; i++) { const o = lines[i]; if (o.m) continue; if (o.p) problems.push(o.p); else records.push(o); }
    got.records = records.length ? past.records.concat(records) : past.records;
    got.problems = problems.length ? past.problems.concat(problems) : past.problems;
    got.read = readTo(tail, at, upTo, ino);
    continued.add(got);
    return got;
  } catch { return undefined; } finally { try { fs.closeSync(fd); } catch { /* gone */ } }
}
// The answers readPast built on an earlier one (with `past` itself): their records begin with that answer's records.
const continued = new WeakSet();
// Every complete line of a document whose end is torn (the fallback above).
function completeLines(buf) {
  const out = [];
  for (let at = 0; at < buf.length;) {
    const nl = buf.indexOf(NL, at);
    if (nl < 0) break;                     // the torn batch: not a fact yet
    try { out.push(JSON.parse(buf.subarray(at, nl))); } catch { break; }
    at = nl + 1;
  }
  return out;
}
// The NDJSON document as one JSON array, in one copy: `[`, the bytes with every newline turned into a comma, `]`.
function asArray(buf) {
  const end = buf.length && buf[buf.length - 1] === NL ? buf.length - 1 : buf.length;
  const out = Buffer.allocUnsafe(end + 2);
  out[0] = 0x5b; buf.copy(out, 1, 0, end); out[end + 1] = 0x5d;
  for (let i = out.indexOf(NL, 1); i > 0; i = out.indexOf(NL, i + 1)) out[i] = 0x2c;
  return out.toString('utf8');
}

let tmpSeq = 0; // see storeIndex: the temp name is unique per call, not only per pid
const TAIL = 64 << 10; // a mark line is a few hundred bytes: room for it plus a torn batch, and widened if not
// The last complete mark line WITHOUT the entries, for the keeper: all it needs is where its last pass ended (and
// what to cut back), so its CPU per pass does not grow with the segment's record count either (D62).
export function tailMark(fs, file, v = INDEX_V) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let win = TAIL; ; win *= 16) {
      const from = Math.max(0, size - win);
      const buf = Buffer.alloc(size - from);
      let n = 0;
      while (n < buf.length) { const r = fs.readSync(fd, buf, n, buf.length - n, from + n); if (!r) break; n += r; }
      const body = buf.subarray(0, n);
      let at = 0;
      if (from > 0) { const nl = body.indexOf(NL); if (nl < 0) continue; at = nl + 1; } // the first line is a partial one
      let found = null;
      for (;;) {
        const nl = body.indexOf(NL, at);
        if (nl < 0) break;
        let o;
        try { o = JSON.parse(body.subarray(at, nl)); } catch { break; }
        at = nl + 1;
        if (o && o.m) { if (o.v !== v) return null; found = { mark: o.m, covered: from + at }; }
      }
      if (found) return found;
      if (from === 0) return null;
    }
  } finally { fs.closeSync(fd); }
}

// ── the keeper's own lines, without re-reading them ───────────────────────
// The daemon serialized these records; parsing its own bytes back to learn what it already had cost a JSON.parse of
// the whole record per record (5.2 ms of the 9.4 ms a 500 KB exchange took, a macOS machine 2026-10-20). So the keeper hands
// over the entries, and this takes them — but ONLY when they account for the segment EXACTLY: contiguous line numbers
// from the stored mark, contiguous offsets from `mark.end`, and an end that equals the file's current size. Any gap,
// any line written by something else, any entry the keeper failed to build → null, and the scan is the truth. The
// result is byte-for-byte the scan's, which is what keeps the index a rebuildable projection (invariant 2).
function fromEntries(fs, source, stored, how, entries) {
  if (!entries || !entries.length) return null;
  const from = how === 'resume' ? { end: stored.mark.end, lines: stored.mark.lines } : (how === 'rebuild' && !stored ? { end: 0, lines: 0 } : null);
  if (!from) return null;                                 // the file was rewritten or truncated: scan it
  let end = from.end, lineNo = from.lines;
  for (const r of entries) {
    if (r.offset !== end || r.lineNo !== lineNo + 1) return null;
    end += r.storedBytes + 1; lineNo = r.lineNo;           // + its newline
  }
  let st;
  try { st = fs.statSync(source); } catch { return null; }
  if (st.size !== end) return null;                        // bytes nobody told us about: scan them
  let fd;
  try { fd = fs.openSync(source, 'r'); } catch { return null; }
  let fp;
  try { fp = fpDigest((a, b) => readRangeSync(fd, a, b), end); } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* gone */ } }
  return { records: entries.map((r) => r.entry), mark: { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, end, lines: lineNo, fp }, bytesRead: 0, done: true };
}

// The file a segment's bytes are read from: the plaintext while it exists (4.2:30), else the sealed copy.
export function segmentSource(home, segment, fs = nodeFs) {
  const plainPath = path.join(rawDir(home), `${segment}.ndjson`);
  return fs.existsSync(plainPath) ? plainPath : path.join(rawDir(home), `${segment}.sealed`);
}

// The mark of a plaintext segment covered up to byte `end` (just past line `lines`), the way a scan builds it: `size`
// claims only what was covered, so a file that is longer reads as GROWN and resumes from `end` (usability below).
export function plainMark(fs, source, end, lines) {
  const fd = fs.openSync(source, 'r');
  try {
    const st = fs.fstatSync(fd);
    return { size: end, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, end, lines, fp: fpDigest((a, b) => readRangeSync(fd, a, b), end) };
  } finally { fs.closeSync(fd); }
}

// The mark of a sealed segment (the index, or the usage sidecar, covers it whole): its fp is over the whole file.
export function sealedMark(fs, file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    return { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, end: st.size, fp: fpDigest((a, b) => readRangeSync(fd, a, b), st.size), sealed: true };
  } finally { fs.closeSync(fd); }
}

// Reusable as it is (nothing changed), resumable from mark.end (appended bytes only), or neither. Size and mtime the
// same but ctime not: the file was copied, restored or moved (a clone, a backup, Migration Assistant — a new inode and
// ctime over the same bytes), or only its mode changed; the fp says whether the bytes are still the indexed ones, and
// the same bytes reuse the index (4.2 §段索引 失效与增量). A mark with no fp (written before marks had one) is rebuilt.
export function usability(fs, source, stored) {
  if (!stored) return 'rebuild';
  const m = stored.mark;
  let st;
  try { st = fs.statSync(source); } catch { return 'rebuild'; }
  if (!!m.sealed !== /\.sealed$/.test(source)) return 'rebuild';
  if (st.size === m.size && st.mtimeMs === m.mtimeMs && (st.ctimeMs === m.ctimeMs || sameBytesBefore(fs, source, m))) return 'reuse';
  if (m.sealed || st.size < m.size) return 'rebuild';  // a sealed file never grows
  return sameBytesBefore(fs, source, m) ? 'resume' : 'rebuild';
}
// The identity rule of src/query/source.mjs, over the digest the mark stores: the file is the one that was indexed
// only when the bytes before the last indexed line are still the bytes that were indexed (an append).
function sameBytesBefore(fs, source, m) {
  if (typeof m.fp !== 'string' || !Number.isFinite(m.end)) return false;
  let fd;
  try { fd = fs.openSync(source, 'r'); } catch { return false; }
  try { return fpDigest((a, b) => readRangeSync(fd, a, b), m.end) === m.fp; } catch { return false; } finally { try { fs.closeSync(fd); } catch { /* already gone */ } }
}

// This pass's lines → disk. `at` null: the whole document, through a temp file and a rename (a sealed segment's
// index, or a plaintext one being rebuilt), so two writers of the same content cannot interleave. `at` a number: the
// keeper appending to the index it owns, after cutting the file back to its last mark (4.2 §段索引 谁写哪一笔).
//
// WHAT A CRASH CAN LEAVE, exactly: this file is never fsync'd (it is a cache; paying fsync per pass would put the
// index on the record's own cost). So a crash or a power cut can leave the page cache's tail unwritten — including
// HOLES: zeroed pages before bytes that did reach the disk. Cutting back to `at` therefore does NOT mean the file is
// "truncated back to the last mark": the next pass appends after the last mark it can still PARSE, and whatever came
// after that mark (hole or garbage) is simply dead weight in the file, ignored by every reader (readIndex and
// tailMark both stop at the last complete mark). The ANSWER stays right — the records those lost entries describe are
// re-indexed from the segment — and the cost is that the segment reads cold until sealing rewrites its index whole.
export function storeIndex(fs, file, lines, problems, at = null) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (at === null) {
      // unique per writer AND per call: two processes with the same pid in different namespaces (or one process
      // rebuilding two indexes at once) must not share a temp name
      const tmp = `${file}.tmp-${process.pid}-${(tmpSeq++).toString(36)}-${randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, lines.join(''), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } else {
      // BY FD, never by path (4.2 §段索引 谁写哪一笔): the seal worker renames a freshly built index over this one
      // the moment the segment is handed over, and a path-based truncate + append that loses that race would cut the
      // NEW file down to this pass's idea of its length. One fd, opened before the checks and written through:
      // whatever the rename does, these bytes land on the inode this pass opened — the old one, by then unlinked.
      const fd = fs.openSync(file, 'r+');
      try {
        if (at !== fs.fstatSync(fd).size) fs.ftruncateSync(fd, at); // the tail after the last parsable mark: a torn or holed batch
        const buf = Buffer.from(lines.join(''));
        for (let off = 0; off < buf.length;) {
          const n = fs.writeSync(fd, buf, off, buf.length - off, at + off);
          if (!n) throw new Error(`${path.basename(file)}: the write made no progress at ${at + off}`);
          off += n;
        }
      } finally { fs.closeSync(fd); }
    }
  } catch (e) {
    // The index is a cache: failing to store it costs speed, never an answer (D38 — and never silently).
    problems.push({ code: 'index-unwritable', reason: `${file}: ${String((e && e.message) || e)}; the answer is from the segment itself` });
  }
}

/** problemEntry(where, p) → one `errors` entry of a query document: the closed-set code, the level when there is one
 *  (`note` = a fact about this read, not a loss — 3.5 读不全), and the reason in words. */
export const problemEntry = (where, p) => ({ where, code: p.code, ...(p.level ? { level: p.level } : {}), reason: p.reason });

/**
 * segmentIndex({home, segment, maxBytes, owner, past}) → { segment, source, records, problems, bytesRead, done, stored, grown }
 *   past / stored: a reader's index read (readIndex) — the one it went on from, and the one it made (null for the owner).
 *   grown: these records begin, line by line, with those of the answer `past` came with.
 *   records: [{ id, ts, harness, class, host, path, status, stored_bytes, sent_bytes, received_bytes, session_key, is_llm }]
 *     — every record of the segment for a reader; for an `owner` resuming, only the ones THIS pass indexed (it reads
 *     the stored mark alone, never the stored entries, so that its cost stays proportional to the new bytes).
 *   bytesRead: what this call read from the segment (0 = the stored index was current).
 *   done: the index now covers the segment to its last complete line (false only with `maxBytes`: call again).
 *   maxBytes: index at most this many appended bytes (the daemon's keeper works in chunks; a reader never does).
 *   owner: the caller is the daemon, keeping the index current — it is the only one that writes a PLAINTEXT segment's
 *     index (by appending; whole only when the identity rule says rebuild). A reader writes nothing there: it answers
 *     from the covered part plus an in-memory scan of the tail, and reports `index-cold` when that tail cost it more
 *     than KEEPER_CHUNK_BYTES, because the daemon is supposed to have done it (D62, D38). A SEALED segment's index is
 *     written whole by whoever finds it missing (the seal child, else the reading query): the same content either way.
 *     Like `index-unwritable`, `index-cold` is about this read, so it is not stored in the document.
 *   entries: what the daemon's keeper already knows about the lines it just wrote ([{lineNo, offset, storedBytes,
 *     entry}], in line order; see fromEntries). Taken ONLY when they account for the segment exactly from the stored
 *     mark to its current size, so the answer is the scan's answer; anything else falls back to the scan.
 *   progress: called after every chunk the scan reads (a reader's; scanNdjson).
 * Never throws for a segment it cannot read: the reason is in `problems` and the caller lists it in `errors`.
 */
export async function segmentIndex({ home = trocarHome(), segment, fs = nodeFs, maxBytes = Infinity, owner = false, entries = null, past = null, progress = null } = {}) {
  const problems = [];
  const source = segmentSource(home, segment, fs);
  const sealed = /\.sealed$/.test(source);
  const idxFile = path.join(indexDir(home), `${segment}.json`);
  // the keeper needs the stored mark and where it ended (only it appends); a reader needs the entries behind it
  const stored = owner && !sealed ? tailMark(fs, idxFile) : readIndex(fs, idxFile, INDEX_V, past);
  const how = usability(fs, source, stored);
  // A stored index remembers what it could NOT read, and says it again on every later read: a problem
  // that only the read which BUILT the index reports would go silent the second time (D38).
  // a reader's answer that carries on from `past`'s (the index file read on from its mark, the segment only appended to): its records
  // begin with the records of the answer `past` came with, line by line (warmSegmentIndex below)
  const grown = !owner && !!past && (stored === past || continued.has(stored)) && how !== 'rebuild';
  const kept = owner ? null : stored;
  if (how === 'reuse') return { segment, source, records: stored.records || [], problems: stored.problems || [], bytesRead: 0, done: true, stored: kept, grown };
  const prior = how === 'resume' && stored.problems ? stored.problems : []; // stored by an earlier pass, said again
  let got;
  try {
    got = sealed
      ? scanSealed(fs, source, segment, problems)
      : (owner && fromEntries(fs, source, stored, how, entries))
        || scanNdjson(fs, source, how === 'resume' ? stored.mark.end : 0, how === 'resume' ? stored.mark.lines + 1 : 1, segment, problems, maxBytes, progress);
  } catch (e) {
    problems.push({ code: 'segment-unreadable', reason: `${path.basename(source)}: ${String((e && e.message) || e)}` });
    return { segment, source, records: stored && how === 'resume' ? stored.records || [] : [], problems: [...prior, ...problems], bytesRead: 0, done: true, stored: kept, grown: false };
  }
  const records = how === 'resume' && stored.records ? stored.records.concat(got.records) : got.records;
  // what this pass found goes INTO the document, so a later read says it again; `index-unwritable` is about
  // this write, not about the file, so it stays out of the lines.
  if (sealed || owner) {
    const lines = [...got.records.map(entryLine), ...problems.map(problemLine), markLine(got.mark)];
    storeIndex(fs, idxFile, lines, problems, !sealed && how === 'resume' ? stored.covered : null);
  }
  const said = [...prior, ...problems];
  // after the write, so it is never stored: this is about THIS read. A reader that had to index more than one of the
  // keeper's chunks did work the daemon should have done, and the seconds it cost are its own (D62 · D38).
  if (!owner && got.bytesRead > KEEPER_CHUNK_BYTES) {
    const mb = Math.round(got.bytesRead / (1 << 20));
    said.push({ code: 'index-cold', level: 'note', reason: `This read indexed ${mb} MB of capture file ${segment} itself (${how === 'rebuild' ? 'all of it' : 'the part not indexed yet'}), which is why it was slow. Nothing is missing. trocar's background service normally does this while it captures; it was not running when these records arrived, the index was deleted, or trocar was updated.` });
  }
  return { segment, source, records, problems: said, bytesRead: got.bytesRead, done: got.done, stored: kept, grown };
}

// WARM (D63 ①, 1.6 §4.1 附近的查询): THE one reading of a segment's index rows — everything that wants them
// (src/query/rows.mjs for every row list, `allSegments` below for the `segments` document) goes through here, so a
// nearby query re-reads and re-parses no index file. One entry per segment, kept against that segment's own source
// file: a closed or sealed segment is read once per process, the live one again when it grew (never stale). It lives
// in this file and not in the readers because `allSegments` is in this file: a warm wrapper in rows.mjs that
// `allSegments` also called would be a cycle between the two modules.
// What an entry holds in the V8 heap: its row store (row-table.mjs heapOf, charged once when `stored.records` shares it) and the
// answer around it, SEGMENT_HEAP: the answer, `stored`, the stamp and the cache entry, 7,200 B measured with liveHeap() over 400
// and 800 generated segments (forced GC before and after, less the stores' heapOf, divided by the segments) × 1.25.
const SEGMENT_HEAP = 9_000;
const segRows = warmCache({ cost: (v) => SEGMENT_HEAP + heapOf(v.records, v.stored && v.stored.records), steady: true });
// Which records array a row list was built from, and which one a segment's newer answer extends line by line: rows.mjs adds
// only the new rows when only the newest segment grew (3.5:45). Numbers, so a newer answer never keeps an older one alive.
const ids = new WeakMap(), grew = new WeakMap();
let idSeq = 0;
export const recordsId = (records) => { let n = ids.get(records); if (n == null) ids.set(records, (n = ++idSeq)); return n; };
/** grownFrom(records) → the recordsId of the earlier answer of the same segment whose records these begin with, else undefined. */
export const grownFrom = (records) => grew.get(records);
// Both files, so a plaintext that is sealed (or a sealed file rebuilt) is a new stamp: the plaintext wins while it exists (4.2:30).
// `at` ({plain, sealed}, segmentFiles): which of the two the caller's raw/ listing just named; a file it did not name is stamped as
// absent without a stat (a reader stamps every segment on every read: the stats were 1.8 ms of a followed call's 12, 2026-10-24).
const stampFiles = new Map(); // home + segment → its two files' paths (built once: a read stamps every segment)
export const segStamp = (home, segment, fs, at = null) => {
  const k = `${home}\n${segment}`;
  let f = stampFiles.get(k);
  if (!f) stampFiles.set(k, (f = [path.join(rawDir(home), `${segment}.ndjson`), path.join(rawDir(home), `${segment}.sealed`)]));
  return `${!at || at.plain ? statKey(f[0], fs) : null}|${!at || at.sealed ? statKey(f[1], fs) : null}`;
};
/** warmSegmentIndex({home, segment, fs, at}) → the same `segmentIndex()` answer, read from disk only when that segment's
 *  file moved. For READERS only: a pass of the daemon's keeper (`owner`) writes, so it is never served from memory.
 *  A note (`level`, e.g. `index-cold`) is about the read that RAN segmentIndex, so it is never kept: a later read
 *  served from memory did none of that work, and an index write does not move the stamp (3.5 读不全 #17). */
export const warmSegmentIndex = async ({ home = trocarHome(), segment, fs = nodeFs, at = null, progress = null } = {}) => {
  let notes = [];
  const kept = await segRows.get(`${fsTag(fs)}\n${home}\n${segment}`, segStamp(home, segment, fs, at), async (old) => {
    // the answer this segment had: its index read goes on from where that one stopped (4.2:49)
    const prev = old ? await Promise.resolve(old).catch(() => null) : null; // kept as the promise it was computed as
    const got = columnar(await segmentIndex({ home, segment, fs, past: prev && prev.stored, progress }), segment);
    if (got.grown && got.records !== prev.records && got.records.length >= prev.records.length) grew.set(got.records, recordsId(prev.records));
    notes = got.problems.filter((p) => p.level);
    return notes.length ? { ...got, problems: got.problems.filter((p) => !p.level) } : got;
  });
  return notes.length ? { ...kept, problems: [...kept.problems, ...notes] } : kept;
};

// The rows a warm entry keeps, as one column store per segment (src/query/row-table.mjs): `records` is a view on it, and so is
// `stored.records` (what the next read concatenates onto, readPast · the resume above) when it is a prefix of `records` — the
// same array, or resume's `stored.records.concat(…)` — so a row is held once. A view's concat answers a view, so once both are
// views they stay views; plain arrays come only from a whole read.
const prefixOf = (s, r) => { if (s.length > r.length) return false; for (let i = 0; i < s.length; i++) if (s[i] !== r[i]) return false; return true; };
function columnar(got, segment) {
  const { records: r, stored } = got, s = stored && stored.records;
  if (isRowTable(r)) return got;
  if (s && !isRowTable(s) && prefixOf(s, r)) {
    const sv = rowTable(s, segment);
    return { ...got, records: r === s ? sv : sv.concat(r.slice(s.length)), stored: { ...stored, records: sv } };
  }
  return { ...got, records: rowTable(r, segment), ...(s && !isRowTable(s) ? { stored: { ...stored, records: rowTable(s, segment) } } : {}) };
}

// WHICH SEGMENT IS BEING WRITTEN: there is no `.closed` marker.
// The running daemon records its current segment in its lock file (~/.trocar/collector/lock), and a
// lock only counts when its pid is alive and the lock is fresh (src/off/daemon-stop.mjs readDaemonLock).
//
// A READER ASKS NO QUESTION ABOUT A PROCESS, and takes only a FRESH lock as "being written"
// (`identity: NO_IDENTITY`, and `state === 'running'` below). The identity pair (a pid's creation time + the
// machine's boot time) is there so that `off` cannot act on a REUSED pid; on Windows every such question costs
// one powershell.exe start — ~450 ms on a Windows test machine (src/off/proc.mjs winIdentity) — when it is asked outside
// the memo scope a command gives it. `allSegments` asks it once per `query segments` / `query classes`, so each
// of those paid it: 673 / 703 ms through the daemon against 223 / 256 ms in a HOME with no lock file at all
// (a Windows test machine, 2026-10-19), with the whole difference in that one question.
// Without the pair `readDaemonLock` reports `verified: false` and judges the lock by its age alone, which is
// exactly the evidence a LABEL needs and is strictly MORE faithful than the identity check was: the lock is
// refreshed every second (daemon.mjs lockRefreshMs) and only by the daemon that holds the segment, so a lock
// fresh within DAEMON_LOCK_FRESH_MS names the segment being written, and a lock nobody refreshes any more
// (the daemon died, the machine rebooted) names nothing — where before, an `unresponsive` lock kept its
// segment labelled `writing` for ever and only a pid that was gone or provably reused took the label off.
const NO_IDENTITY = () => ({});
const defaultLockState = (home, fs) => readDaemonLock({ file: path.join(collectorHome(home), 'lock'), fs, identity: NO_IDENTITY });

// A segment that has BOTH files was interrupted after the rename and before the plaintext was deleted: the plaintext
// wins (4.2:30), so it is the source, it gives the bytes, and the state is `closed` — not `sealed`, which would say the
// long-term copy is the sealed one while 128 MB of plaintext is still on disk (tested 2026-10-18).
/** allSegments({home}) → [{ segment, state, path, records, bytes, sealed_bytes, from, to, problems }], oldest first. `progress`: called
 *  after every segment and every chunk a cold segment's scan reads (as indexRows). */
export async function allSegments({ home = trocarHome(), fs = nodeFs, lockState = () => defaultLockState(home, fs), progress = null } = {}) {
  const seen = segmentFiles(home, fs);
  const L = lockState() || {};
  const current = L.state === 'running' && L.lock ? L.lock.segment || null : null;
  const out = [];
  for (const [segment, at] of seen) {
    const { records, problems, source } = await warmSegmentIndex({ home, segment, fs, at, progress });
    if (progress) progress();
    const sealedBytes = at.sealed ? sizeOf(fs, path.join(rawDir(home), `${segment}.sealed`)) : null;
    // one pass through the accessor: the summed stored bytes (a sealed segment), and the first and last call time as strings sort
    let stored = 0, from = null, to = null;
    for (const r of records) {
      stored += r.stored_bytes + 1;
      const ts = r.ts;
      if (!ts) continue;
      if (from === null || String(ts) < String(from)) from = ts;
      if (to === null || String(ts) > String(to)) to = ts;
    }
    const bytes = at.plain ? sizeOf(fs, path.join(rawDir(home), `${segment}.ndjson`)) : stored;
    out.push({ segment, state: at.plain ? (segment === current ? 'writing' : 'closed') : 'sealed', path: source,
      records: records.length, bytes, sealed_bytes: sealedBytes, from, to, problems });
  }
  return out;
}
/** segmentCmp(a, b): the order segments were opened in — the opening instant, then the collision suffix as a number (`-10` after
 *  `-9`); the one rule segmentFiles lists segments by and posCmp (src/query/projection.mjs) orders record ids by, so a session's
 *  member list (src/query/rows.mjs) is in write order. */
export function segmentCmp(a, b) {
  const [sa, na = 1] = String(a).split('-'), [sb, nb = 1] = String(b).split('-');
  return sa < sb ? -1 : sa > sb ? 1 : Number(na) - Number(nb);
}
/** segmentFiles(home, fs) → [[segment, {plain, sealed}]], oldest first (segmentCmp): which segments raw/ holds, from the names alone. */
export function segmentFiles(home = trocarHome(), fs = nodeFs) {
  let names;
  try { names = fs.readdirSync(rawDir(home)); } catch { return []; }
  const seen = new Map();
  for (const n of names) {
    const p = parseSegment(n);
    if (!p) continue;
    const at = seen.get(p.segment) || { sealed: false, plain: false };
    at[p.sealed ? 'sealed' : 'plain'] = true;
    seen.set(p.segment, at);
  }
  return [...seen].sort(([a], [b]) => segmentCmp(a, b));
}
const sizeOf = (fs, f) => { try { return fs.statSync(f).size; } catch { return 0; } };
