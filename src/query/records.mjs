// src/query/records.mjs — the raw records themselves, for the queries that need more than the index.
//
// The segment index (src/query/index-build.mjs) answers the list queries; `session`, `calls`
// and `block` need the envelope, so they read the lines back from the segment. This is the ONE
// place that does it: the records come out as the view layer's readers expect them (the same
// normalizeRecord / expandRequestBody the ETL and the resolver use), stamped with their id
// `<segment>:<line>` (D60) and the file they came from, and nothing else is derived here.
import nodeFs from 'node:fs';
import path from 'node:path';
import { recordId } from '../collector/core/record/segments.mjs';
import { normalizeRecord } from '../raw/ingest.mjs';
import { expandRequestBody } from '../dissect/request-body.mjs';
import { openSealed, createLineCache } from '../raw/reader.mjs';
import { R } from '../raw/format.mjs';
import { segmentIndex, segmentSource } from './index-build.mjs';
import { trocarHome } from '../paths.mjs';
import { warmCache, fsTag, HEAP_PER_STORED } from './warm.mjs';

// WARM (D63 ①, 1.6 §4.1 附近的查询; 3.5 §缓存): one entry per RECORD, keyed by its id. A record is appended once and never
// rewritten (invariant 2), so its id is its stamp. A session's pages, the block of one of its steps and its calls ask for the same
// records again, so the second query of an open session reads no record file at all; a session that got a new record reads that
// one record (a key per row LIST kept one whole copy of a growing session per version of it, which is what filled the worker's
// heap while the board followed a live session). Each entry costs its stored bytes × HEAP_PER_STORED in the one heap budget.
const readBack = warmCache({ cost: (v) => v.cost });

const NL = 0x0a;

/** Every stored line of one segment file as [lineNo, text] — sealed or plain, the line numbers it was written with.
 *  The lines that were not JSON when they were sealed are kept too: the index row names them, and the reader decides. */
function* lines(file, fs) {
  if (file.endsWith('.sealed')) {
    const sf = openSealed(file, { fs });
    try {
      for (let i = 0; i < sf.count; i++) {
        const r = sf.records[i];
        let b = sf.lineAt(i);
        if (b.length && b[b.length - 1] === NL) b = b.subarray(0, b.length - 1);
        if (b.length) yield [Number(r[R.lineNo]) + 1, b.toString('utf8')];
      }
    } finally { sf.close(); }
  } else {
    const parts = fs.readFileSync(file, 'utf8').split('\n');
    if (parts[parts.length - 1] !== '') parts.pop(); // a half line at the end is still being written (4.6 §记录)
    for (let i = 0; i < parts.length; i++) if (parts[i]) yield [i + 1, parts[i]];
  }
}

function recordOf(text, segment, lineNo, stream) {
  const rec = normalizeRecord(expandRequestBody(JSON.parse(text)));
  const out = { ...rec, id: recordId(segment, lineNo) };
  // `_stream` is non-enumerable everywhere it is stamped (src/raw/ingest.mjs): it says which file the
  // bytes are in, for a block's ref, and must never appear in a shipped document.
  Object.defineProperty(out, '_stream', { value: stream, enumerable: false, configurable: true });
  return out;
}

/**
 * recordsAt({home, rows}) → the raw records of the given index rows (src/query/rows.mjs), in the order given.
 * ONE record costs one seek: a plaintext segment is read at the row's byte offset for exactly its stored
 * bytes, a sealed one decodes that record's frame only — so `session` and `block` pay for the records they
 * answer with, never for the segment (1.6 §4.1 速度目标: `session` ≤ 1 s, `block` ≤ 0.3 s).
 * A row whose record cannot be read goes into `errors` (D38), never silently missing.
 */
// `remember: false` is a SCAN (the usage sidecar's fill, src/query/usage.mjs): it neither reads from nor stores into
// the warm cache, so filling a segment never evicts the records of the sessions the board has open.
export function recordsAt({ home = trocarHome(), fs = nodeFs, rows = [], errors = [], remember = true } = {}) {
  const tag = `${fsTag(fs)}\n${home}\n`;
  const out = new Array(rows.length);
  const missing = [];
  for (let i = 0; i < rows.length; i++) {
    const hit = remember ? readBack.peek(tag + rows[i].id, true) : undefined;
    if (hit) out[i] = hit.rec; else missing.push(i);
  }
  if (missing.length) {
    const got = readRows({ home, fs, rows: missing.map((i) => rows[i]) });
    errors.push(...got.errors);
    missing.forEach((i, k) => {
      const rec = got.out[k];
      if (!rec) return; // its read failed: said in errors, and NEVER remembered (3.5 不答陈旧 — a read in the seal rename window or
      // one EIO would otherwise pin its absence for the life of a resident worker; not caching it costs the next query one re-read)
      out[i] = rec;
      if (remember) { const cost = (rows[i].stored_bytes || 0) * HEAP_PER_STORED; readBack.get(tag + rows[i].id, true, () => ({ rec, cost }), cost); }
    });
  }
  return out.filter(Boolean);
}

// A read that failed: `io` says the bytes could not be read (a transient EIO / EMFILE / a seal rename window),
// as against a line whose content does not parse. It is NON-ENUMERABLE, like `_stream` above: `errors` ships as
// [{where, reason}] (3.5:42), and only the usage fill looks at it (it never remembers a failed read).
const failedRead = (where, reason, io) => Object.defineProperty({ where, reason }, 'io', { value: io });

// → { out, errors }: `out[k]` is the record of `rows[k]`, or undefined when it could not be read (said in `errors`).
function readRows({ home, fs, rows }) {
  const errors = [];
  const bySegment = new Map();
  rows.forEach((r, k) => { if (!bySegment.has(r.segment)) bySegment.set(r.segment, []); bySegment.get(r.segment).push(k); });
  const out = new Array(rows.length);
  for (const [segment, ks] of bySegment) {
    const file = segmentFile({ home, fs, segment });
    const stream = path.basename(file);
    let read;
    try { read = file.endsWith('.sealed') ? sealedReader(file, fs) : plainReader(file, fs); }
    catch (e) { for (const k of ks) errors.push(failedRead(rows[k].id, `cannot be read: ${String((e && e.message) || e)}`, true)); continue; }
    try {
      for (const k of ks) {
        const r = rows[k];
        try { out[k] = recordOf(read(r), segment, r.lineNo, read.stream ? read.stream(r) : stream); }
        catch (e) { errors.push(failedRead(r.id, `cannot be read back: ${String((e && e.message) || e)}`, !(e instanceof SyntaxError))); }
      }
    } finally { read.close(); }
  }
  return { out, errors };
}
// The plaintext at a row's own offset, exactly its stored bytes; a row from an index that has no offset
// (a segment sealed when the row was written) falls back to the line scan.
function plainReader(file, fs) {
  const fd = fs.openSync(file, 'r');
  let all = null;
  const scan = (r) => {
    if (!all) all = [...lines(file, fs)];
    const hit = all.find(([no]) => no === r.lineNo);
    if (!hit) throw new Error(`line ${r.lineNo} is not in ${path.basename(file)}`);
    return hit[1];
  };
  const read = (r) => {
    if (r.offset == null || r.stored_bytes == null) return scan(r);
    // a seek lands between two newlines or is not trusted: an index that no longer matches the file never
    // lends one record another record's bytes — it costs the scan instead
    const from = r.offset > 0 ? r.offset - 1 : 0, len = r.stored_bytes + 1 + (r.offset - from);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    if (n !== len || buf[len - 1] !== NL || (r.offset > 0 && buf[0] !== NL)) return scan(r);
    return buf.toString('utf8', r.offset - from, r.offset - from + r.stored_bytes);
  };
  read.close = () => fs.closeSync(fd);
  return read;
}

// A sealed segment knows where every record is: its own index names the line number of each frame.
// A cold fold asks for a long session's records in chunks, one synchronous stretch at a time. A sealed file's reader (its index
// tables and line map) is kept across stretches by the file's identity — reopening it re-read and re-hashed the index tail every
// slice (579 MB on the user's live session, measured 2026-10-24). Its fd is not: the first read of a stretch schedules one
// setImmediate that closes every kept reader's fd, so no fd outlives the stretch (a sealed file may be replaced or deleted;
// Windows refuses that while an fd is open). A reader reopens its fd at its next frame read and checks the identity again.
// The decoded frames and the rebuilt lines outlive the stretch (3.5 §冷路径, D71 ②): the fold runs in slices, and a slice that ends
// inside a frame made the next one decode it again (4 216 brotli decodes for 1 113 frames). They are keyed by the file's identity
// (dev:ino:size:mtime) and the frame / record number — a replaced file is another identity — and byte-capped; releaseDecoded()
// empties them when the worker goes idle.
const SHARED_FRAME_BYTES = 48 << 20;
const SHARED_LINE_BYTES = 16 << 20;
const SHARED_FILES = 32;               // kept readers; past it the least recently used one is dropped
// a kept reader's line maps (its index's record table and the line → record map): 15.75 MB for 32 readers over the user's
// sealed segments (a heap diagnosis, 2026-10-22)
const READER_HEAP = 512 << 10;
/** What the kept sealed readers hold at most in the V8 heap: their tables and line maps, a fixed term of the heap a read
 *  reserves before it reads (src/query/named/session.mjs working()). The frames and lines are Buffers, external memory outside
 *  the V8 heap (12 decoded frames and 64 lines of 0.5 MB: heapUsed +0.11 MB, external +78 MB, 2026-10-22): their byte caps
 *  bound the process's resident memory, not its heap. */
export const STRETCH_HEAP = SHARED_FILES * READER_HEAP;
const decoded = { frames: createLineCache(SHARED_FRAME_BYTES), lines: createLineCache(SHARED_LINE_BYTES) };
const shared = { files: new Map(), armed: false };
const dropReader = (e) => { try { e.sf.close(); } catch { /* already closed: nothing to release */ } };
// the end of a stretch: every kept reader's fd closes, the readers stay
function closeFds() { for (const e of shared.files.values()) dropReader(e); shared.armed = false; }
/** releaseDecoded(): drops the kept sealed readers and empties the decoded frames and rebuilt lines (the worker's idle point). */
export function releaseDecoded() { closeFds(); shared.files.clear(); decoded.frames.clear(); decoded.lines.clear(); }
// the file's identity: a replaced file (rename, rewrite) is a different reader, even within one stretch
const statKey = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
// an injected fs (tests) is another file system: its dev:ino may name another file
const fsIds = new WeakMap();
let fsSeq = 0;
const fsId = (fs) => { let n = fsIds.get(fs); if (n === undefined) fsIds.set(fs, n = fsSeq++); return n; };
// the reader keys its entries by its open (`<seq>:<dev>:<ino>:<n>`); the shared caches key them by the file's bytes
const byIdentity = (cache, id) => {
  const k = (ck) => id + ck.slice(ck.lastIndexOf(':'));
  return { get: (ck) => cache.get(k(ck)), set: (ck, v) => cache.set(k(ck), v) };
};

function sharedSealed(file, fs) {
  const key = statKey(fs.statSync(file));
  let e = shared.files.get(file);
  if (e && (e.key !== key || e.fs !== fs)) { dropReader(e); shared.files.delete(file); e = undefined; }
  if (!shared.armed) { shared.armed = true; setImmediate(closeFds); }
  if (e) { shared.files.delete(file); shared.files.set(file, e); return e; }
  const id = `${fsId(fs)}:${key}`;
  const sf = openSealed(file, { fs, frameCache: byIdentity(decoded.frames, id), lineCache: byIdentity(decoded.lines, id) });
  const at = new Map();
  for (let i = 0; i < sf.count; i++) at.set(Number(sf.records[i][R.lineNo]) + 1, i);
  if (shared.files.size >= SHARED_FILES) { const [f, old] = shared.files.entries().next().value; dropReader(old); shared.files.delete(f); }
  e = { sf, at, key, fs };
  shared.files.set(file, e);
  return e;
}

function sealedReader(file, fs) {
  const { sf, at } = sharedSealed(file, fs);
  const read = (r) => {
    const i = at.get(r.lineNo);
    if (i === undefined) throw new Error(`line ${r.lineNo} is not in ${path.basename(file)}`);
    let b = sf.lineAt(i);
    if (b.length && b[b.length - 1] === NL) b = b.subarray(0, b.length - 1);
    return b.toString('utf8');
  };
  // a sealed record keeps the stream it was written to, so a text_ref minted on the plaintext names it still (4.2 #3)
  read.stream = (r) => sf.streams[sf.records[at.get(r.lineNo)][R.stream]];
  read.close = () => {};   // a release: the kept reader's fd is closed by closeFds, at the end of this stretch
  return read;
}

/**
 * readRecord({home, segment, lineNo}) → the raw envelope of that record (decoded bodies, nothing else
 * derived), or null when the segment holds no such line. The segment index says where the record is, so
 * neither the segment nor its index is scanned for it.
 */
export async function readRecord({ home = trocarHome(), fs = nodeFs, segment, lineNo } = {}) {
  const { records } = await segmentIndex({ home, segment, fs });
  const row = records.find((r) => r.id === recordId(segment, lineNo));
  if (!row) return null;
  const file = segmentFile({ home, fs, segment });
  const read = file.endsWith('.sealed') ? sealedReader(file, fs) : plainReader(file, fs);
  try { return expandRequestBody(JSON.parse(read({ ...row, lineNo }))); } finally { read.close(); }
}

/** The file a segment's bytes are in (segmentSource: the plaintext while it exists, 4.2:30 明文为准), or throws
 *  when there is none — this path reads records back, so a missing segment is an error, not an empty index. */
function segmentFile({ home, fs, segment }) {
  const file = segmentSource(home, segment, fs);
  if (!fs.existsSync(file)) throw new Error(`there is no segment ${segment} in ${path.join(home, 'raw')}`);
  return file;
}

/**
 * segmentLines({home, segment, from, to}) → [lineNo, bytes] of one segment, the bytes exactly as they are stored
 * (`trocar raw`, 1.6 §5.1): each line with its newline, a half line a crash left without one, an empty line as
 * itself; a sealed segment is decoded first, and nothing is parsed or re-encoded. Throws when there is no such
 * segment.
 * `from`/`to` are the RECORD NUMBERS the caller will print (1-based, inclusive). They are not a filter over the
 * whole file: a sealed segment decodes only the frames those records sit in (plus their delta chains, which its
 * own index names), so printing the last record of a 128 MB segment costs one frame instead of all 32 — which is
 * what made `trocar raw <seg:N>` on a sealed segment 5× slower than on the plaintext one (D62 A1).
 */
export function* segmentLines({ home = trocarHome(), fs = nodeFs, segment, from = 1, to = Infinity } = {}) {
  const file = segmentFile({ home, fs, segment });
  if (file.endsWith('.sealed')) {
    const sf = openSealed(file, { fs });
    try {
      for (let i = 0; i < sf.count; i++) {
        const no = Number(sf.records[i][R.lineNo]) + 1;
        if (no < from || no > to) continue;   // its frame is never decoded: this record is not in the answer
        yield [no, sf.lineAt(i)];
      }
    } finally { sf.close(); }
    return;
  }
  const buf = fs.readFileSync(file);
  for (let start = 0, no = 1; start < buf.length; no++) {
    const nl = buf.indexOf(NL, start), end = nl === -1 ? buf.length : nl + 1;
    if (no >= from && no <= to) yield [no, buf.subarray(start, end)];
    start = end;
  }
}
