// src/raw/writer.mjs — encode records into one format-v2 sealed file (RFC 4.2 §封存格式).
//
// A record = byte ranges of chunk frames in this same file, spliced in order. Each line is cut (src/raw/chunk.mjs,
// cutPoints), every chunk is stored once (by sha256) in an open chunk buffer (its group's, or the shared one), and the record's splice list goes
// into the one splice buffer, in record order. The heuristics below are SHOULD (4.2 编码器) and only steer the ratio:
// any ranges that splice back the exact line are valid.
//   · groups: a group key gets its own chunk buffer once frameBytes of its records have gone through the shared buffer
//     (until then its records share one buffer, in arrival order — a stream that never fills a frame is no stream);
//     at most OPEN own buffers are open, the least recently used is flushed when another opens;
//   · a stored chunk is reused only from a chunk frame among the newest WINDOW frame numbers (open or flushed), counting
//     the number the record's own buffer is about to take; an open buffer whose frame falls out of that window is flushed
//     first. Every frame one record names therefore lies within WINDOW consecutive numbers, and a read in record order
//     holds at most WINDOW chunk frames plus the splice frame at once, whatever the number of groups;
//   · per record at most MAX_FRAMES frames: its own buffer, its splice frame, and the MAX_FRAMES − 2 other frames it
//     takes the most bytes from; a reusable chunk anywhere else, and a run of reusable chunks shorter than MIN_RUN bytes,
//     is stored again next to the record's new bytes (where brotli sees it in context) and the dedup map points at the copy;
//   · buffers flush once they are ≥ frameBytes after a record, never mid-record.
//
// The caller opens the destination (0600, in the target directory) and owns fsync / rename; this module only turns
// lines into header · frames · index tail · trailer on that fd, at increasing positions. Every write goes through the
// injected `fs`, so the sealer's crash-order tests see every byte that reaches disk.
import nodeFs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { cutPoints } from './chunk.mjs';
import { headerBytes, indexTailBytes, trailerBytes, pushVarint, zigzag, FLAG_NL, FLAG_UNPARSEABLE, KIND_CHUNK, KIND_SPLICE, REC_SPLICE } from './format.mjs';

export const FRAME_BYTES = 4 << 20;   // ~4 MiB of decoded bytes per frame (D35 ④)
// 4.2 编码器 · D35 ③ (SHOULD, not exported): reuse only from the newest WINDOW frames, at most MAX_FRAMES frames per
// record — 4.2 「读」 bounds an in-order read by them; OPEN own buffers; reusable runs < MIN_RUN bytes are stored again.
const WINDOW = 12, MAX_FRAMES = 9, OPEN = 8, MIN_RUN = 256;
const SHARED = Symbol('shared');          // the buffer of the groups that have not filled a frame yet
const MINE = Symbol('mine');              // a chunk the record being added stores earlier in itself
const BROTLI = { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 };

export function createSealWriter({ fd, fs = nodeFs, frameBytes = FRAME_BYTES } = {}) {
  let pos = 0;
  const write = (buf) => { let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, pos + off); pos += buf.length; };
  write(headerBytes());

  const frames = [], records = [], streams = [], streamIdx = new Map();
  let rawBytes = 0;
  // A buffer: { frame (number, assigned at the first byte), parts, len, kind }.
  const newBuf = (kind) => ({ frame: -1, parts: [], len: 0, kind });
  const append = (b, bytes) => { if (b.frame < 0) b.frame = frames.push(null) - 1; const off = b.len; b.parts.push(bytes); b.len += bytes.length; return off; };
  const flush = (b) => {
    if (b.frame < 0) return;
    const raw = b.parts.length === 1 ? b.parts[0] : Buffer.concat(b.parts, b.len);
    const out = zlib.brotliCompressSync(raw, { params: { ...BROTLI, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    frames[b.frame] = [pos, out.length, raw.length, b.kind];
    write(out);
    b.frame = -1; b.parts = []; b.len = 0;
  };
  const groups = new Map();             // group key (or SHARED) → open chunk buffer, least recently used first
  const through = new Map();            // group key → bytes of its records so far
  const splice = newBuf(KIND_SPLICE);
  const seen = new Map();               // sha256 of a chunk → [frame, offset]

  // line: the record's exact bytes INCLUDING its "\n" (if any). A chunk buffer keeps a view of the line until its frame is
  // written, so callers MUST NOT reuse the buffer; a line whose new bytes are under half of it is copied instead, so a
  // buffer that fills slowly does not pin hundreds of mostly-reused lines.
  function add(line, { id = null, stream, shard = 0, lineNo, unparseable = false, group = '' }) {
    const idx = records.length;
    const sofar = through.get(group) || 0;
    through.set(group, sofar + line.length);
    const key = sofar >= frameBytes ? group : SHARED;
    let buf = groups.get(key);
    if (buf) groups.delete(key);
    else {
      if (groups.size >= OPEN) { const [k, old] = groups.entries().next().value; flush(old); groups.delete(k); }
      buf = newBuf(KIND_CHUNK);
    }
    groups.set(key, buf);
    // chunks are reused only from frames numbered ≥ low; a fresh own buffer takes number frames.length, inside the window
    const low = frames.length + (buf.frame < 0 ? 1 : 0) - WINDOW;
    for (const b of groups.values()) if (b.frame >= 0 && b.frame < low) flush(b);

    const list = [];
    let pf = 0, pe = 0, cf = -1, cs = 0, cl = 0;   // the open range (frame, start, length), merged while contiguous
    const emit = () => { if (cl) { pushVarint(list, zigzag(cf - pf)); pushVarint(list, zigzag(cs - pe)); pushVarint(list, cl); pf = cf; pe = cs + cl; } };
    const range = (f, off, len) => {
      if (f === cf && off === cs + cl) { cl += len; return; }
      emit(); cf = f; cs = off; cl = len;
    };
    if (line.length) {
      const cuts = cutPoints(line), n = cuts.length - 1, size = (j) => cuts[j + 1] - cuts[j];
      // at[j]: the [frame, offset] chunk j reuses, MINE (a chunk this record stores earlier), or null (store it);
      // from: each other frame → the bytes this record could take from it
      const hs = [], at = [], mine = new Set(), from = new Map();
      for (let j = 0; j < n; j++) {
        const h = hs[j] = createHash('sha256').update(line.subarray(cuts[j], cuts[j + 1])).digest('base64');
        const a = mine.has(h) ? MINE : seen.get(h);
        if (a === MINE || a?.[0] >= low) at[j] = a;
        else { at[j] = null; mine.add(h); }
        if (at[j] && a !== MINE && a[0] !== buf.frame) from.set(a[0], (from.get(a[0]) || 0) + size(j));
      }
      // Keep a reuse only in a run of ≥ MIN_RUN bytes of kept reuses (own buffer, or one of the MAX_FRAMES − 2 frames it
      // takes the most from); everything else is stored again.
      const keep = new Set([...from].sort((x, y) => y[1] - x[1]).slice(0, MAX_FRAMES - 2).map((x) => x[0]));
      const kept = (a) => a && (a === MINE || a[0] === buf.frame || keep.has(a[0]));
      for (let j = 0; j < n; j++) {
        let e = j, run = 0;
        while (e < n && kept(at[e])) run += size(e++);
        if (run < MIN_RUN) at.fill(null, j, e);
        if (e < n) at[e] = null;
        j = e;
      }
      let fresh = 0;
      for (let j = 0; j < n; j++) if (!at[j]) fresh += size(j);
      const own = fresh * 2 < line.length ? (x) => Buffer.from(x) : (x) => x;
      for (let j = 0; j < n; j++) {
        const a = at[j] === MINE ? seen.get(hs[j]) : at[j];
        if (a) { range(a[0], a[1], size(j)); continue; }
        const off = append(buf, own(line.subarray(cuts[j], cuts[j + 1])));
        seen.set(hs[j], [buf.frame, off]);
        range(buf.frame, off, size(j));
      }
      emit();
    }
    const enc = Buffer.from(list);
    const off = append(splice, enc);

    let s = streamIdx.get(stream);
    if (s === undefined) { s = streams.length; streams.push(stream); streamIdx.set(stream, s); }
    const flags = (line.length && line[line.length - 1] === 0x0a ? FLAG_NL : 0) | (unparseable ? FLAG_UNPARSEABLE : 0);
    const sha = createHash('sha256').update(line).digest('base64');
    records.push([id == null ? null : String(id), s, splice.frame, off, enc.length, line.length, REC_SPLICE, -1, sha, flags, shard, lineNo]);
    rawBytes += line.length;
    if (buf.len >= frameBytes) flush(buf);
    if (splice.len >= frameBytes) flush(splice);
    return idx;
  }

  // shards: the source-shard table (4.2), known in full only after the whole source has been read.
  function finish(shards) {
    for (const b of groups.values()) flush(b);
    groups.clear();
    flush(splice);
    const tail = indexTailBytes({ frames, shards, streams, records });
    const indexOffset = pos;
    write(tail);
    write(trailerBytes(indexOffset, tail.length));
    return { bytes: pos, records: records.length, frames: frames.length, rawBytes };
  }

  return { add, finish, get count() { return records.length; } };
}
