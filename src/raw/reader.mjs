// src/raw/reader.mjs — read a D35 sealed file (RFC 4.2 §原始层封存 「读」).
//
// Random access: (stream, id) → index entry → decode the frames it needs (v1: at most CHAIN_MAX steps back to a
// keyframe; v2: the record's splice frame, then the chunk frames its ranges name) → rebuild the line → check its sha256. Decoded frames go into a bounded LRU
// that SEVERAL sealed files can share, so a resolver over many files still holds one byte budget, not one per
// file. Sequential reads (`lines()`) keep only a bounded window of frames and recent lines, so a loader never holds a whole sealed file in memory (4.6 §日志体积预算).
//
// Every check throws rather than returning bytes: a sealed file is the source truth, and a damaged
// one must surface as damaged, never as plausible wrong text (invariant 4).
import nodeFs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { applyOps, CHAIN_MAX, CANDIDATES } from './delta.mjs';
import { readIndex, readVarint, unzigzag, R, FLAG_NL, FLAG_UNPARSEABLE, HEADER_LEN, KIND_CHUNK, KIND_SPLICE, REC_SPLICE } from './format.mjs';

export const AMBIGUOUS = -2;

// One LRU bounded in BYTES, for decoded frames and for rebuilt lines; the buffers are handed out shared and read-only.
// Frames are bounded by bytes, not by count: a v2 file interleaves up to OPEN stream groups' chunk frames plus RECENT
// flushed ones and the splice frame (src/raw/writer.mjs), most of them small, so a reader in record order needs ~40 frames
// live at once — an 8-frame window decoded the same frames over and over (1,793 decodes for 33 frames on a real segment).
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
    stats,
  };
}

export const FRAME_CACHE_BYTES = 64 << 20;   // ≥ the decoded working set of an in-order read (4.2 「读」)
export const createFrameCache = ({ bytes = FRAME_CACHE_BYTES } = {}) => byteLru(bytes, 'decodes', true);

// Rebuilt LINES, shared the way the frame cache is. A record stored as a delta is rebuilt from its predecessor, which may
// itself be a delta (up to CHAIN_MAX steps), so N records of one session walked their chains independently: 112 records
// of the reference dataset cost 1 190 rebuilds — each one an applyOps plus a sha256 over a ~380 KB line — and `query
// session` over sealed segments paid 221 ms for 42 MB of bytes (D62 A2, the sealed half). Siblings of one chain now
// rebuild it once. Bounded in BYTES because one line can be megabytes (4.6 §日志体积预算).
export const createLineCache = (maxBytes = 16 << 20) => byteLru(maxBytes, 'builds', false);

let fileSeq = 0;

export function openSealed(file, { fs = nodeFs, frameCache = createFrameCache(), lineCache = createLineCache() } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const { tables, indexOffset, version } = readIndex(fs, fd, st.size, path.basename(file));
    return makeReader({ fs, fd, file, st, tables, indexOffset, version, frameCache, lineCache });
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
}

// Line instances whose sha256 has been checked (a line cache hit hands out the same instance again).
const verified = new WeakSet();

function makeReader({ fs, fd, file, st, tables, indexOffset, version, frameCache, lineCache }) {
  // close() releases only the fd: the tables stay, and the next frame read reopens the file and checks it is
  // still the file they describe (dev, ino, size, mtime), so a kept reader never reads another file's bytes.
  const fdOf = () => {
    if (fd !== null) return fd;
    const nfd = fs.openSync(file, 'r');
    let now;
    try { now = fs.fstatSync(nfd); } catch (e) { try { fs.closeSync(nfd); } catch {} throw e; }
    if (now.dev !== st.dev || now.ino !== st.ino || now.size !== st.size || now.mtimeMs !== st.mtimeMs) {
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
  // v2 build: decode the splice list, check every range against its chunk frame, splice the bytes.
  function spliced(i, getFrame) {
    const r = records[i];
    const list = getFrame(r[R.frame]).subarray(r[R.off], r[R.off] + r[R.enc]);
    const parts = [];
    let p = 0, f = 0, e = 0, total = 0;
    try {
      while (p < list.length) {
        let df, dof, len;
        [df, p] = readVarint(list, p); [dof, p] = readVarint(list, p); [len, p] = readVarint(list, p);
        f += unzigzag(df); const off = e + unzigzag(dof);
        const fr = frames[f];
        if (!fr || fr[3] !== KIND_CHUNK || !(len >= 1) || off < 0 || off + len > fr[2]) throw new Error(`range ${f}:${off}+${len} is outside its chunk frame`);
        if ((total += len) > r[R.len]) throw new Error(`splices past its ${r[R.len]}-byte length`);
        parts.push(getFrame(f).subarray(off, off + len));
        e = off + len;
      }
    } catch (err) { throw bad(`record ${i}: ${err.message}`); }
    if (total !== r[R.len]) throw bad(`record ${i} splices ${total} bytes, index says ${r[R.len]}`);
    return Buffer.concat(parts, total);
  }

  const key = `${++fileSeq}:${st.dev}:${st.ino}`;

  const frameAt = (f) => {
    const ck = key + ':' + f;
    let buf = frameCache.get(ck);
    if (buf) return buf;
    buf = decodeFrame(f);
    frameCache.set(ck, buf);
    return buf;
  };
  function decodeFrame(f) {
    const [off, clen, dlen] = frames[f];
    const c = Buffer.alloc(clen);
    let got = 0;
    while (got < clen) { const n = fs.readSync(fdOf(), c, got, clen - got, off + got); if (!n) break; got += n; }
    if (got !== clen) throw bad(`frame ${f} is truncated`);
    let out;
    try { out = zlib.brotliDecompressSync(c); } catch (e) { throw bad(`frame ${f} does not decode (${e.message})`); }
    if (out.length !== dlen) throw bad(`frame ${f} decodes to ${out.length} bytes, index says ${dlen}`);
    return out;
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
  // getLine(j) supplies a predecessor, unchecked; random access recurses, sequential reads use their window.
  const build = (i, enc, getLine) => {
    const r = records[i];
    return r[R.kind] === 0 ? Buffer.from(enc) : applySafe(i, getLine(r[R.back]), enc);
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

  // Sequential iteration in file order (= source line order). Memory: one frame + ≤ CANDIDATES lines.
  // With `onError(i, err, entry)`, a record that cannot be decoded is reported and skipped instead of
  // ending the iteration — later frames are independent, so the rest still reads, and every loss is
  // counted by the caller (no silent failure). Without it, the first error throws.
  function* lines({ onError = null } = {}) {
    if (v2) { yield* linesV2(onError); return; }
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
  // lists finds the last), so it holds exactly the frames later records still need — the writer keeps that to the
  // newest 12 (4.2 「读」). Splice frames go through the shared byte-bounded cache, so that pass decodes them for both.
  function* linesV2(onError) {
    const last = new Int32Array(frames.length).fill(-1);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      try {
        const list = frameAt(r[R.frame]).subarray(r[R.off], r[R.off] + r[R.enc]);
        for (let p = 0, f = 0, x; p < list.length;) { [x, p] = readVarint(list, p); f += unzigzag(x); [, p] = readVarint(list, p); [, p] = readVarint(list, p); last[f] = i; }
      } catch { /* a bad list or splice frame fails below, at its record */ }
    }
    const live = new Map();
    const getFrame = (f) => {
      if (frames[f][3] === KIND_SPLICE) return frameAt(f);
      let b = live.get(f);
      if (!b) { b = decodeFrame(f); live.set(f, b); }
      return b;
    };
    for (let i = 0; i < records.length; i++) {
      let line;
      try { line = check(i, spliced(i, getFrame)); } catch (e) {
        if (!onError) throw e;
        onError(i, e, entry(i));
        continue;
      } finally { for (const f of live.keys()) if (last[f] <= i) live.delete(f); }
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

  return {
    file, size: st.size, dev: st.dev, ino: st.ino, indexOffset, frames, shards, streams, records, deltas,
    get count() { return records.length; },
    entry, lineAt, lines, find,
    close() { if (fd === null) return; try { fs.closeSync(fd); } catch {} fd = null; },
  };
}
