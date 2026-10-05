// src/raw/reader.mjs — read a D35 sealed file (RFC 4.2 §原始层封存 「读」).
//
// Random access: (stream, id) → index entry → decode the frames it needs (at most CHAIN_MAX steps
// back to a keyframe) → rebuild the line → check its sha256. Decoded frames go into a bounded LRU
// that SEVERAL sealed files can share, so a resolver over many files still holds ~8 frames, not 8 per
// file. Sequential reads (`lines()`) decode one frame at a time and keep only a short window of
// recent lines, so a loader never holds a whole sealed file in memory (4.6 §日志体积预算).
//
// Every check throws rather than returning bytes: a sealed file is the source truth, and a damaged
// one must surface as damaged, never as plausible wrong text (invariant 4).
import nodeFs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { applyOps, CHAIN_MAX, CANDIDATES } from './delta.mjs';
import { readIndex, R, FLAG_NL, FLAG_UNPARSEABLE, HEADER_LEN } from './format.mjs';

export const AMBIGUOUS = -2;

export function createFrameCache(max = 8) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    clear() { m.clear(); },
    get size() { return m.size; },
  };
}

let fileSeq = 0;

export function openSealed(file, { fs = nodeFs, frameCache = createFrameCache(8) } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const { tables, indexOffset } = readIndex(fs, fd, st.size, path.basename(file));
    return makeReader({ fs, fd, file, st, tables, indexOffset, frameCache });
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
}

function makeReader({ fs, fd, file, st, tables, indexOffset, frameCache }) {
  const { frames, shards, streams, records } = tables;
  const name = path.basename(file);
  const bad = (msg) => new Error(`${name}: ${msg} — the sealed file is corrupt`);
  // Structural checks up front, so a malformed index fails at open, not halfway through a render.
  let end = HEADER_LEN;
  for (const [off, clen] of frames) { if (off !== end || clen <= 0) throw bad(`frame table out of order at ${off}`); end += clen; }
  if (end !== indexOffset) throw bad('frames do not end where the index tail begins');
  const depth = new Uint8Array(records.length);
  let deltas = 0;
  for (let i = 0; i < records.length; i++) {
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
    while (got < clen) { const n = fs.readSync(fd, c, got, clen - got, off + got); if (!n) break; got += n; }
    if (got !== clen) throw bad(`frame ${f} is truncated`);
    let out;
    try { out = zlib.brotliDecompressSync(c); } catch (e) { throw bad(`frame ${f} does not decode (${e.message})`); }
    if (out.length !== dlen) throw bad(`frame ${f} decodes to ${out.length} bytes, index says ${dlen}`);
    return out;
  }
  const check = (i, line) => {
    const r = records[i];
    if (line.length !== r[R.len] || createHash('sha256').update(line).digest('base64') !== r[R.sha]) throw bad(`record ${i} fails its sha256 check`);
    return line;
  };
  // getLine(j) supplies a predecessor; random access recurses, sequential reads use their window.
  const build = (i, enc, getLine) => {
    const r = records[i];
    const line = r[R.kind] === 0 ? Buffer.from(enc) : applySafe(i, getLine(r[R.back]), enc);
    return check(i, line);
  };
  const applySafe = (i, pred, enc) => { try { return applyOps(pred, enc); } catch (e) { throw bad(`record ${i}: ${e.message}`); } };
  const encOf = (fb, r) => fb.subarray(r[R.off], r[R.off] + r[R.enc]);

  function lineAt(i) {
    if (!(i >= 0 && i < records.length)) throw new RangeError(`${name}: no record ${i}`);
    const r = records[i];
    return build(i, encOf(frameAt(r[R.frame]), r), lineAt);   // depth bounded by the open-time check
  }

  // Sequential iteration in file order (= source line order). Memory: one frame + ≤ CANDIDATES lines.
  function* lines() {
    const win = new Map();
    let f = -1, fb = null;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r[R.frame] !== f) { f = r[R.frame]; fb = decodeFrame(f); }
      const line = build(i, encOf(fb, r), (j) => win.get(j) || lineAt(j));
      win.set(i, line); win.delete(i - CANDIDATES);
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
    close() { try { fs.closeSync(fd); } catch {} },
  };
}
