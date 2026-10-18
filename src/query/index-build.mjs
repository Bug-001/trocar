// src/query/index-build.mjs — the SEGMENT INDEX (RFC 1.6 §4.1, 4.2 §段索引; D59).
//
// `asight query` reads the raw records themselves; the only thing it keeps beside them is one small
// index file per segment under ~/.asight/index/. It is a CACHE, nothing else: delete the directory and
// the next read rebuilds it, byte for byte the same (test/query/segment-index.test.mjs). Nothing else
// in the home is ever written by a query (V79).
//
// Per record it holds exactly what the list queries print (1.6 §4.1 「段索引每条记录存什么」): id, time,
// harness, class, host, path, status, stored and wire bytes, session key, and whether it is a model call.
// No body, no headers — those are read back from the segment itself (src/query/source.mjs).
//
// INVALIDATION is the identity rule of src/query/source.mjs (mtime / ctime + the first and last 4 KB
// before the last indexed line), not a rule of its own: a segment that only GREW is resumed from the
// byte offset where its last complete line ended, so the段 being written costs its new bytes, never a
// re-read; anything else (a rewrite, a truncation, a different file at the same name) rebuilds whole.
// A half line at the end of a segment (a crash) is not indexed and not rewritten — it becomes the next
// record once the writer completes it.
import nodeFs from 'node:fs';
import path from 'node:path';
import { parseSegment, recordId } from '../collector/core/record/segments.mjs';
import { fpRanges, readRangeSync, sameFileAs } from './source.mjs';
import { openSealed } from '../raw/reader.mjs';
import { R, FLAG_NL, FLAG_UNPARSEABLE } from '../raw/format.mjs';
import { asightHome, collectorHome } from '../paths.mjs';
import { readDaemonLock } from '../off/daemon-stop.mjs';

const rawDir = (home = asightHome()) => path.join(home, 'raw');
export const indexDir = (home = asightHome()) => path.join(home, 'index');
const INDEX_V = 1;
const CHUNK = 1 << 20;
const NL = 0x0a;
// The request headers that name a session, in priority order (RFC 3.4:21). Only HEADER keys: a query never
// judges identity from a body.
const SESSION_HEADER_KEYS = ['x-claude-code-session-id', 'x-session-id', 'session-id', 'thread-id'];
const sessionKeyOf = (e) => {
  const h = e.req_headers || e.request_headers;
  if (!h || typeof h !== 'object') return null;
  for (const k of SESSION_HEADER_KEYS) if (h[k]) return String(h[k]);
  return null;
};

// ── one line → one index record ───────────────────────────────────────────
// A line that is not JSON can never be indexed (its bytes are still on disk and `raw cat` still prints
// them): it is reported, and it keeps its line number so every later record's id stays what it was.
function recordOf(lineBuf, segment, lineNo, problems) {
  let e;
  try { e = JSON.parse(lineBuf.toString('utf8')); } catch (err) {
    problems.push({ code: 'record-unparseable', reason: `${recordId(segment, lineNo)} is not JSON (${err.message}); it is left out of the index` });
    return null;
  }
  const wire = e.body_wire_bytes || {};
  return {
    id: recordId(segment, lineNo),
    ts: e.ts_request ?? e.ts ?? null,
    harness: (e.proc && e.proc.agent) ?? null,
    class: e.traffic_class ?? null,
    host: e.host ?? null,
    path: e.endpoint ?? null,
    status: (e.resp && e.resp.status) ?? null,
    stored_bytes: lineBuf.length,
    wire_bytes: (Number(wire.req) || 0) + (Number(wire.resp) || 0),
    session_key: sessionKeyOf(e),
    is_llm: !!e.is_llm_call,
  };
}

// Byte-scan `file` from `from`, one record per complete line, holding one chunk + one line at a time.
// → { records, end, lines, bytesRead }: `end` = just past the last newline (where the next read resumes).
function scanNdjson(fs, file, from, firstLine, segment, problems) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.allocUnsafe(CHUNK);
    const records = [];
    let pos = from, lineStart = from, lineNo = firstLine - 1, pending = Buffer.alloc(0);
    const take = (lineBuf) => {
      lineNo++;
      if (lineBuf.length) { const r = recordOf(lineBuf, segment, lineNo, problems); if (r) records.push(r); }
      lineStart += lineBuf.length + 1;
    };
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
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
    }
    const end = lineStart;
    const mark = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, end, lines: lineNo,
      fp: fpRanges(end).map(([a, b]) => readRangeSync(fd, a, b).toString('base64')) };
    return { records, mark, bytesRead: pos - from };
  } finally { fs.closeSync(fd); }
}

// A sealed segment: its own index already knows every line's number and length, so the records come
// out with the ids they had before sealing (V88). A file that cannot be read is reported, never
// silently empty.
function scanSealed(fs, file, segment, problems) {
  let sf;
  try { sf = openSealed(file, { fs }); } catch (e) {
    problems.push({ code: 'segment-unreadable', reason: `${path.basename(file)}: ${String((e && e.message) || e)}` });
    return { records: [], mark: { size: fs.statSync(file).size, sealed: true }, bytesRead: 0 };
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
    const st = fs.statSync(file);
    return { records, mark: { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sealed: true }, bytesRead: st.size };
  } finally { sf.close(); }
}

const readMark = (fs, file) => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && d.v === INDEX_V ? d : null; } catch { return null; } };
// Reusable as it is (nothing changed), resumable from mark.end (appended bytes only), or neither.
function usability(fs, source, mark) {
  if (!mark || !mark.mark) return 'rebuild';
  const m = mark.mark;
  let st;
  try { st = fs.statSync(source); } catch { return 'rebuild'; }
  if (!!m.sealed !== /\.sealed$/.test(source)) return 'rebuild';
  if (st.size === m.size && st.mtimeMs === m.mtimeMs && st.ctimeMs === m.ctimeMs) return 'reuse';
  if (m.sealed || st.size < m.size) return 'rebuild';  // a sealed file never grows
  return sameFileAs(source, { end: m.end, fp: m.fp.map((b) => Buffer.from(b, 'base64')) }) ? 'resume' : 'rebuild';
}

function writeIndex(fs, file, doc, problems) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    // The index is a cache: failing to store it costs speed, never an answer (D38 — and never silently).
    problems.push({ code: 'index-unwritable', reason: `${file}: ${String((e && e.message) || e)}; the answer is from the segment itself` });
  }
}

/**
 * segmentIndex({home, segment}) → { segment, source, records, problems, bytesRead }
 *   records: [{ id, ts, harness, class, host, path, status, stored_bytes, wire_bytes, session_key, is_llm }]
 *   bytesRead: what this call read from the segment (0 = the stored index was current).
 * Never throws for a segment it cannot read: the reason is in `problems` and the caller lists it in `errors`.
 */
export async function segmentIndex({ home = asightHome(), segment, fs = nodeFs } = {}) {
  const problems = [];
  const sealedPath = path.join(rawDir(home), `${segment}.sealed`);
  const plainPath = path.join(rawDir(home), `${segment}.ndjson`);
  const source = fs.existsSync(plainPath) ? plainPath : sealedPath;
  const idxFile = path.join(indexDir(home), `${segment}.json`);
  const stored = readMark(fs, idxFile);
  const how = usability(fs, source, stored);
  // A stored index remembers what it could NOT read, and says it again on every later read: a problem
  // that only the read which BUILT the index reports would go silent the second time (D38).
  if (how === 'reuse') return { segment, source, records: stored.records, problems: stored.problems || [], bytesRead: 0 };
  if (how === 'resume' && stored.problems) problems.push(...stored.problems); // carried over, so they are not said once only
  let got;
  try {
    got = /\.sealed$/.test(source)
      ? scanSealed(fs, source, segment, problems)
      : scanNdjson(fs, source, how === 'resume' ? stored.mark.end : 0, how === 'resume' ? stored.mark.lines + 1 : 1, segment, problems);
  } catch (e) {
    problems.push({ code: 'segment-unreadable', reason: `${path.basename(source)}: ${String((e && e.message) || e)}` });
    return { segment, source, records: stored && how === 'resume' ? stored.records : [], problems, bytesRead: 0 };
  }
  const records = how === 'resume' ? [...stored.records, ...got.records] : got.records;
  // what the scan found goes INTO the index, so a later reuse says it again; `index-unwritable` is about
  // this read, not about the file, so it stays out of the stored doc.
  const found = [...problems];
  writeIndex(fs, idxFile, { v: INDEX_V, segment, mark: got.mark, records, problems: found }, problems);
  return { segment, source, records, problems, bytesRead: got.bytesRead };
}

// WHICH SEGMENT IS BEING WRITTEN (main-session decision, 2026-10-18): there is no `.closed` marker.
// The running daemon records its current segment in its lock file (~/.asight/collector/lock), and a
// lock only counts when its pid + start time check out (src/off/daemon-stop.mjs readDaemonLock). Every
// other plaintext segment is closed; one with a `.sealed` beside it is sealed.
const defaultLockState = (home, fs) => readDaemonLock({ file: path.join(collectorHome(home), 'lock'), fs });

/** allSegments({home}) → [{ segment, state, path, records, bytes, sealed_bytes, from, to, problems }], oldest first. */
export async function allSegments({ home = asightHome(), fs = nodeFs, lockState = () => defaultLockState(home, fs) } = {}) {
  let names;
  try { names = fs.readdirSync(rawDir(home)); } catch { return []; }
  const seen = new Map();
  for (const n of names.sort()) {
    const p = parseSegment(n);
    if (!p) continue;
    const at = seen.get(p.segment) || { sealed: false, plain: false };
    at[p.sealed ? 'sealed' : 'plain'] = true;
    seen.set(p.segment, at);
  }
  const L = lockState() || {};
  const current = (L.state === 'running' || L.state === 'unresponsive') && L.lock ? L.lock.segment || null : null;
  const out = [];
  for (const [segment, at] of [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const { records, problems, source } = await segmentIndex({ home, segment, fs });
    const sealedBytes = at.sealed ? sizeOf(fs, path.join(rawDir(home), `${segment}.sealed`)) : null;
    const bytes = at.plain ? sizeOf(fs, path.join(rawDir(home), `${segment}.ndjson`)) : records.reduce((n, r) => n + r.stored_bytes + 1, 0);
    const stamps = records.map((r) => r.ts).filter(Boolean).sort();
    out.push({ segment, state: at.sealed ? 'sealed' : segment === current ? 'writing' : 'closed', path: source,
      records: records.length, bytes, sealed_bytes: sealedBytes, from: stamps[0] ?? null, to: stamps[stamps.length - 1] ?? null, problems });
  }
  return out;
}
const sizeOf = (fs, f) => { try { return fs.statSync(f).size; } catch { return 0; } };
