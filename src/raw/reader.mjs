// src/raw/reader.mjs — read a D35 sealed file (RFC 4.2 §原始层封存 「读」).
//
// Random access: (stream, id) → index entry → decode the frames it needs (v1: at most CHAIN_MAX steps back to a
// keyframe; v2: the record's splice frame, then the chunk frames its ranges name) → rebuild the line → check its sha256. Decoded frames go into a bounded LRU
// that SEVERAL sealed files can share, so a resolver over many files still holds one byte budget, not one per
// file. Sequential reads (`lines()`) keep only a bounded window of frames and recent lines, so a loader never holds a whole sealed file in memory (4.6 §日志体积预算).
//
// A caller that can wait fills the cache first (`warm(i)`): the frames a record still needs decode off the thread, several at
// once, and lineAt then rebuilds and checks from the cache exactly as it always does.
//
// Every check throws rather than returning bytes: a sealed file is the source truth, and a damaged
// one must surface as damaged, never as plausible wrong text (invariant 4).
import nodeFs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { applyOps, CHAIN_MAX, CANDIDATES } from './delta.mjs';
import { readIndex, readVarint, unzigzag, R, FLAG_NL, FLAG_UNPARSEABLE, HEADER_LEN, KIND_CHUNK, KIND_SPLICE, REC_SPLICE } from './format.mjs';
import { BIG, fileKey } from '../file-id.mjs';

export const AMBIGUOUS = -2;

// One LRU bounded in BYTES, for decoded frames and for rebuilt lines; the buffers are handed out shared and read-only.
// Frames are bounded by bytes, not by count: frames differ in size (a group's chunk frame, a small splice frame, a frame
// holding one over-frame record), and what a reader in record order needs at once is a set of frames, not a count —
// the newest 12 chunk frames + 1 splice frame of a v2 file (4.2 「读」; an 8-frame cache decoded the same frames over and
// over: 1,793 decodes for 33 frames on a real segment).
// `keepNewest`: the entry just set stays even when it alone is over the budget (a frame is about to be read; a line
// bigger than the whole budget is never resident).
function byteLru(maxBytes, counted, keepNewest) {
  const m = new Map();
  const stats = { hits: 0, [counted]: 0, maxResident: 0 };
  let held = 0;
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { stats.hits++; m.delete(k); m.set(k, v); } return v; },
    set(k, v) {
      stats[counted]++;
      if (!keepNewest && v.length > maxBytes) return;
      const was = m.get(k);
      if (was !== undefined) { m.delete(k); held -= was.length; }
      m.set(k, v); held += v.length;
      for (const [ek, ev] of m) { if (held <= maxBytes) break; if (ek === k) continue; m.delete(ek); held -= ev.length; }
      stats.maxResident = Math.max(stats.maxResident, m.size);
    },
    clear() { m.clear(); held = 0; },
    get size() { return m.size; },
    get bytes() { return held; },
    max: maxBytes,
    stats,
  };
}

const FRAME_CACHE_BYTES = 64 << 20;   // the frame budget of a reader: its shared cache, and the in-order window (4.2 「读」)
export const createFrameCache = ({ bytes = FRAME_CACHE_BYTES } = {}) => byteLru(bytes, 'decodes', true);

// Rebuilt LINES, shared the way the frame cache is. A record stored as a delta is rebuilt from its predecessor, which may
// itself be a delta (up to CHAIN_MAX steps), so N records of one session walked their chains independently: 112 records
// of the reference dataset cost 1 190 rebuilds — each one an applyOps plus a sha256 over a ~380 KB line — and `query
// session` over sealed segments paid 221 ms for 42 MB of bytes (D62 A2, the sealed half). Siblings of one chain now
// rebuild it once. Bounded in BYTES because one line can be megabytes (4.6 §日志体积预算).
export const createLineCache = (maxBytes = 16 << 20) => byteLru(maxBytes, 'builds', false);

// Frame decodes in flight, across every reader of this process (4.2 「读」). libuv's pool has 4 threads by default and file
// reads and other zlib work run on it too: 3 leaves them one, and 3 at once already takes a record of 6–8 frames from
// 49–60 ms to 23–39 ms on real segments. First come, first served.
export const DECODE_SLOTS = 3;
let decoding = 0;
const decodeQueue = [];
function nextDecode() {
  while (decoding < DECODE_SLOTS && decodeQueue.length) {
    decoding++;
    decodeQueue.shift()(() => { decoding--; nextDecode(); });
  }
}

// The output buffer of one async decode: the whole frame plus a byte, so it comes back in one trip through the pool. At the
// default 16 KiB a 4 MiB frame makes ~256 trips, each a turn of JS on the thread the decode was moved off, and is then
// concatenated: twice the wall time and 6–10× the event loop time on a 36 MB record. 64 is the least zlib takes, and it
// throws below that; the budget keeps a frame table that claims too much from reaching an allocation only the pool's
// callback would see fail, where nothing can catch it. A frame over the budget just takes more trips.
const chunkFor = (dlen) => Math.min(Math.max(64, dlen + 1), FRAME_CACHE_BYTES);

let fileSeq = 0;

export function openSealed(file, { fs = nodeFs, frameCache = createFrameCache(), lineCache = createLineCache() } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd), ident = fileKey(fs.fstatSync(fd, BIG));
    const { tables, indexOffset, version } = readIndex(fs, fd, st.size, path.basename(file));
    return makeReader({ fs, fd, file, st, ident, tables, indexOffset, version, frameCache, lineCache });
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
}

// Line instances whose sha256 has been checked (a line cache hit hands out the same instance again).
const verified = new WeakSet();

function makeReader({ fs, fd, file, st, ident, tables, indexOffset, version, frameCache, lineCache }) {
  // close() releases only the fd: the tables stay, and the next frame read reopens the file and checks it is
  // still the file they describe (dev, ino, size, mtime), so a kept reader never reads another file's bytes.
  const fdOf = () => {
    if (fd !== null) return fd;
    const nfd = fs.openSync(file, 'r');
    let now;
    try { now = fileKey(fs.fstatSync(nfd, BIG)); } catch (e) { try { fs.closeSync(nfd); } catch {} throw e; }
    if (now !== ident) {
      try { fs.closeSync(nfd); } catch {}
      throw new Error(`${path.basename(file)}: the sealed file changed since its reader was opened`);
    }
    return (fd = nfd);
  };
  const { frames, shards, streams, records } = tables;
  const name = path.basename(file);
  const bad = (msg) => new Error(`${name}: ${msg} — the sealed file is corrupt`);
  // Structural checks up front, so a malformed index fails at open, not halfway through a render.
  const v2 = version === 2;
  if (v2) checkV2();
  let end = HEADER_LEN;
  if (!v2) for (const [off, clen] of frames) { if (off !== end || clen <= 0) throw bad(`frame table out of order at ${off}`); end += clen; }
  if (!v2 && end !== indexOffset) throw bad('frames do not end where the index tail begins');
  const depth = new Uint8Array(records.length);
  let deltas = 0;
  for (let i = 0; !v2 && i < records.length; i++) {
    const r = records[i];
    const fr = frames[r[R.frame]];
    if (!fr || r[R.off] + r[R.enc] > fr[2] || !streams[r[R.stream]] || !shards[r[R.shard]]) throw bad(`record ${i} points outside its frame or tables`);
    if (i && r[R.frame] < records[i - 1][R.frame]) throw bad(`record ${i} is out of frame order`);
    if (r[R.kind] === 1) {
      deltas++;
      const b = r[R.back];
      if (!(b >= 0 && b < i)) throw bad(`record ${i} refers forward or nowhere (back ${b})`);
      const d = depth[b] + 1;
      if (d > CHAIN_MAX) throw bad(`record ${i} sits ${d} steps from its keyframe; the chain limit is ${CHAIN_MAX}`);
      depth[i] = d;
    } else if (r[R.kind] !== 0) throw bad(`record ${i} has unknown kind ${r[R.kind]}`);
  }
  // v2 (4.2 文件布局 · 拼接表): frames sorted by offset tile [HEADER_LEN, indexOffset) exactly, each a chunk or splice
  // frame; every record is a splice whose list lies inside a splice frame, in non-decreasing frame order.
  function checkV2() {
    let end = HEADER_LEN;
    for (const f of frames.map((x, n) => [x, n]).sort((a, b) => a[0][0] - b[0][0])) {
      const [off, clen, dlen, kind] = f[0];
      if (off !== end || !(clen > 0) || !(dlen >= 0) || (kind !== KIND_CHUNK && kind !== KIND_SPLICE)) throw bad(`frame ${f[1]} overlaps, leaves a gap or has an unknown kind`);
      end += clen;
    }
    if (end !== indexOffset) throw bad('frames do not end where the index tail begins');
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const fr = frames[r[R.frame]];
      if (r[R.kind] !== REC_SPLICE || r[R.back] !== -1) throw bad(`record ${i} has unknown kind ${r[R.kind]}`);
      if (!fr || fr[3] !== KIND_SPLICE || !(r[R.off] >= 0 && r[R.enc] >= 0) || r[R.off] + r[R.enc] > fr[2] || !streams[r[R.stream]] || !shards[r[R.shard]]) throw bad(`record ${i} points outside its splice frame or tables`);
      if (i && r[R.frame] < records[i - 1][R.frame]) throw bad(`record ${i} is out of frame order`);
    }
  }
  // v2: walk a record's splice list, check every range against its chunk frame, visit(frame, offset, length) each one.
  function eachRange(i, list, visit) {
    const r = records[i];
    let p = 0, f = 0, e = 0, total = 0;
    try {
      while (p < list.length) {
        let df, dof, len;
        [df, p] = readVarint(list, p); [dof, p] = readVarint(list, p); [len, p] = readVarint(list, p);
        f += unzigzag(df); const off = e + unzigzag(dof);
        const fr = frames[f];
        if (!fr || fr[3] !== KIND_CHUNK || !(len >= 1) || off < 0 || off + len > fr[2]) throw new Error(`range ${f}:${off}+${len} is outside its chunk frame`);
        if ((total += len) > r[R.len]) throw new Error(`splices past its ${r[R.len]}-byte length`);
        visit(f, off, len);
        e = off + len;
      }
    } catch (err) { throw bad(`record ${i}: ${err.message}`); }
    if (total !== r[R.len]) throw bad(`record ${i} splices ${total} bytes, index says ${r[R.len]}`);
  }
  const spliceList = (fb, r) => fb.subarray(r[R.off], r[R.off] + r[R.enc]);
  // v2 build: the record's ranges, spliced.
  function spliced(i, getFrame) {
    const r = records[i];
    const parts = [];
    eachRange(i, spliceList(getFrame(r[R.frame]), r), (f, off, len) => parts.push(getFrame(f).subarray(off, off + len)));
    return Buffer.concat(parts, r[R.len]);
  }

  const key = `${++fileSeq}:${ident}`;

  const frameAt = (f) => {
    const ck = key + ':' + f;
    let buf = frameCache.get(ck);
    if (buf) return buf;
    buf = decodeFrame(f);
    frameCache.set(ck, buf);
    return buf;
  };
  function readFrame(f) {
    const [off, clen] = frames[f];
    const c = Buffer.alloc(clen);
    let got = 0;
    while (got < clen) { const n = fs.readSync(fdOf(), c, got, clen - got, off + got); if (!n) break; got += n; }
    if (got !== clen) throw bad(`frame ${f} is truncated`);
    return c;
  }
  function decodeFrame(f) {
    const c = readFrame(f);
    const dlen = frames[f][2];
    let out;
    try { out = zlib.brotliDecompressSync(c); } catch (e) { throw bad(`frame ${f} does not decode (${e.message})`); }
    if (out.length !== dlen) throw bad(`frame ${f} decodes to ${out.length} bytes, index says ${dlen}`);
    return out;
  }
  // Frame f off the thread, into the frame cache: its bytes, or null when it cannot be had — nothing is cached then, and
  // decodeFrame says why when lineAt gets there. Callers of one frame share one decode. The file read is synchronous and
  // leaves the fd as it found it: a kept reader's fd may have been closed while this waited its turn, and nothing closes
  // one reopened here.
  const inFlight = new Map();
  function frameAsync(f) {
    const ck = key + ':' + f;
    const had = frameCache.get(ck);
    if (had) return had;
    let p = inFlight.get(f);
    if (p) return p;
    p = new Promise((done) => decodeQueue.push((free) => {
      const end = (out) => { inFlight.delete(f); free(); done(out); };
      const held = fd !== null;
      let c = null;
      try { c = readFrame(f); } catch { /* lineAt reports it */ }
      if (!held) close();
      if (!c) return end(null);
      zlib.brotliDecompress(c, { chunkSize: chunkFor(frames[f][2]) }, (err, out) => {
        if (err || out.length !== frames[f][2]) return end(null);
        frameCache.set(ck, out);
        end(out);
      });
    }));
    inFlight.set(f, p);
    nextDecode();
    return p;
  }
  // 4.2 「读」: a line's sha256 is checked before it is handed out, once per rebuilt instance. A predecessor
  // rebuilt only to rebuild its successor is not checked on its own: were it wrong, the successor's check fails.
  const check = (i, line) => {
    if (verified.has(line)) return line;
    const r = records[i];
    if (line.length !== r[R.len] || createHash('sha256').update(line).digest('base64') !== r[R.sha]) throw bad(`record ${i} fails its sha256 check`);
    verified.add(line);
    return line;
  };
  const predOf = (r) => (r[R.kind] === 0 ? -1 : r[R.back]);   // v1: the record a delta is rebuilt from; -1 at a keyframe
  // getLine(j) supplies a predecessor, unchecked; random access recurses, sequential reads use their window.
  const build = (i, enc, getLine) => {
    const j = predOf(records[i]);
    return j < 0 ? Buffer.from(enc) : applySafe(i, getLine(j), enc);
  };
  const applySafe = (i, pred, enc) => { try { return applyOps(pred, enc); } catch (e) { throw bad(`record ${i}: ${e.message}`); } };
  const encOf = (fb, r) => fb.subarray(r[R.off], r[R.off] + r[R.enc]);

  function rebuilt(i) {
    if (!(i >= 0 && i < records.length)) throw new RangeError(`${name}: no record ${i}`);
    const ck = key + ':' + i;
    const was = lineCache.get(ck);
    if (was) return was;
    const r = records[i];
    const line = v2 ? spliced(i, frameAt) : build(i, encOf(frameAt(r[R.frame]), r), rebuilt);   // depth bounded by the open-time check
    lineCache.set(ck, line);
    return line;
  }
  const lineAt = (i) => check(i, rebuilt(i));

  // The frames rebuilding record i still needs, decoded in parallel into the frame cache. It never fails and hands out no
  // bytes: whatever it could not decode stays out of the cache, and lineAt, which it only ever saves work, reports it.
  async function warm(i) {
    if (!records[i]) return;
    const need = new Set();
    try {
      if (v2) {
        if (lineCache.get(key + ':' + i)) return;
        const fb = await frameAsync(records[i][R.frame]);
        if (!fb) return;
        eachRange(i, spliceList(fb, records[i]), (f) => need.add(f));
      } else {
        for (let j = i; j >= 0 && !lineCache.get(key + ':' + j); j = predOf(records[j])) need.add(records[j][R.frame]);
      }
    } catch { return; }
    // more than the cache holds: the last frames would push out the first before lineAt reads them, and it would decode them all again
    let bytes = 0;
    for (const f of need) bytes += frames[f][2];
    if (bytes > frameCache.max) return;
    await Promise.all([...need].map(frameAsync));
  }

  // Sequential iteration in file order (= source line order). Memory: one frame + ≤ CANDIDATES lines.
  // With `onError(i, err, entry)`, a record that cannot be decoded is reported and skipped instead of
  // ending the iteration — later frames are independent, so the rest still reads, and every loss is
  // counted by the caller (no silent failure). Without it, the first error throws.
  function* lines({ onError = null, windowBytes = FRAME_CACHE_BYTES } = {}) {
    if (v2) { yield* linesV2(onError, windowBytes); return; }
    const win = new Map();
    let f = -1, fb = null, fErr = null;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      let line;
      try {
        if (r[R.frame] !== f) { f = r[R.frame]; fb = null; fErr = null; try { fb = decodeFrame(f); } catch (e) { fErr = e; } }
        if (fErr) throw fErr;
        line = check(i, build(i, encOf(fb, r), (j) => win.get(j) || rebuilt(j)));
      } catch (e) {
        if (!onError) throw e;
        onError(i, e, entry(i));
        continue;
      }
      win.set(i, line); win.delete(i - CANDIDATES);
      yield { i, line, entry: entry(i) };
    }
  }

  // v2 in order: its own window of chunk frames, each held from its first use to its last (a first pass over the splice
  // lists finds the last), so it holds the frames later records still need — for a file this writer made, at most the
  // newest 12 (4.2 「读」). The window is also capped at windowBytes whatever the file: over it, the frames held longest
  // go first and are decoded again if a later record names them, so any valid file reads, in bounded memory. Splice
  // frames go through the shared byte-bounded cache, so that pass decodes them for both.
  function* linesV2(onError, windowBytes) {
    const last = new Int32Array(frames.length).fill(-1);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      try {
        const list = spliceList(frameAt(r[R.frame]), r);
        for (let p = 0, f = 0, x; p < list.length;) { [x, p] = readVarint(list, p); f += unzigzag(x); [, p] = readVarint(list, p); [, p] = readVarint(list, p); last[f] = i; }
      } catch { /* a bad list or splice frame fails below, at its record */ }
    }
    const live = new Map();
    let held = 0;
    const drop = (f) => { held -= live.get(f).length; live.delete(f); };
    const getFrame = (f) => {
      if (frames[f][3] === KIND_SPLICE) return frameAt(f);
      let b = live.get(f);
      if (b) return b;
      b = decodeFrame(f);
      for (const k of live.keys()) { if (held + b.length <= windowBytes) break; drop(k); }
      live.set(f, b); held += b.length;
      return b;
    };
    for (let i = 0; i < records.length; i++) {
      let line;
      try { line = check(i, spliced(i, getFrame)); } catch (e) {
        if (!onError) throw e;
        onError(i, e, entry(i));
        continue;
      } finally { for (const f of live.keys()) if (last[f] <= i) drop(f); }
      yield { i, line, entry: entry(i) };
    }
  }

  let byKey = null;
  function find(stream, id) {
    if (!byKey) {
      byKey = new Map();
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r[R.id] == null) continue;
        const k = streams[r[R.stream]] + '\n' + r[R.id];
        byKey.set(k, byKey.has(k) ? AMBIGUOUS : i);
      }
    }
    const v = byKey.get(stream + '\n' + String(id));
    return v === undefined ? -1 : v;
  }

  function entry(i) {
    const r = records[i];
    return {
      i, id: r[R.id], stream: streams[r[R.stream]], frame: r[R.frame], kind: r[R.kind], back: r[R.back],
      length: r[R.len], sha256: r[R.sha], newline: !!(r[R.flags] & FLAG_NL), unparseable: !!(r[R.flags] & FLAG_UNPARSEABLE),
      shard: r[R.shard], lineNo: r[R.lineNo],
    };
  }

  function close() { if (fd === null) return; try { fs.closeSync(fd); } catch {} fd = null; }

  return {
    file, size: st.size, ident, indexOffset, frames, shards, streams, records, deltas,
    get count() { return records.length; },
    entry, lineAt, warm, lines, find, close,
  };
}
