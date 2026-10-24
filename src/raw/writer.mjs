// src/raw/writer.mjs — encode records into one format-v2 sealed file (RFC 4.2 §封存格式).
//
// A record = byte ranges of chunk frames in this same file, spliced in order. Each line is cut (src/raw/chunk.mjs,
// cutPoints), every chunk is stored once (by sha256) in its group's open chunk buffer, and the record's splice list goes
// into the one splice buffer, in record order. The heuristics below are SHOULD (4.2 编码器) and only steer the ratio:
// any ranges that splice back the exact line are valid.
//   · groups: each group key has an open chunk buffer; at most OPEN of them are open (the least recently used is
//     flushed when another opens);
//   · a stored chunk is reused only from this group's open buffer or one of the last RECENT flushed chunk frames;
//     otherwise its bytes are stored again and the dedup map points at the copy — so a record touches at most
//     1 splice frame + 1 open + RECENT flushed chunk frames;
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
const OPEN = 32, RECENT = 7;   // OPEN ≥ the stream groups a real segment interleaves (13–24 measured); 4 thrashed into tiny frames
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
  const recent = [];                    // the last RECENT flushed chunk frames, oldest first
  const flush = (b) => {
    if (b.frame < 0) return;
    const raw = b.parts.length === 1 ? b.parts[0] : Buffer.concat(b.parts, b.len);
    const out = zlib.brotliCompressSync(raw, { params: { ...BROTLI, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    frames[b.frame] = [pos, out.length, raw.length, b.kind];
    write(out);
    if (b.kind === KIND_CHUNK) { recent.push(b.frame); if (recent.length > RECENT) recent.shift(); }
    b.frame = -1; b.parts = []; b.len = 0;
  };
  const groups = new Map();             // group key → open chunk buffer, least recently used first
  const splice = newBuf(KIND_SPLICE);
  const seen = new Map();               // sha256 of a chunk → [frame, offset]

  // line: the record's exact bytes INCLUDING its "\n" (if any). Chunk buffers keep references to it until their frame
  // is written, so callers MUST NOT reuse the buffer.
  function add(line, { id = null, stream, shard = 0, lineNo, unparseable = false, group = '' }) {
    const idx = records.length;
    let buf = groups.get(group);
    if (buf) groups.delete(group);
    else {
      if (groups.size >= OPEN) { const [k, old] = groups.entries().next().value; flush(old); groups.delete(k); }
      buf = newBuf(KIND_CHUNK);
    }
    groups.set(group, buf);

    const list = [];
    let pf = 0, pe = 0, cf = -1, cs = 0, cl = 0;   // the open range (frame, start, length), merged while contiguous
    const emit = () => { if (cl) { pushVarint(list, zigzag(cf - pf)); pushVarint(list, zigzag(cs - pe)); pushVarint(list, cl); pf = cf; pe = cs + cl; } };
    const range = (f, off, len) => {
      if (f === cf && off === cs + cl) { cl += len; return; }
      emit(); cf = f; cs = off; cl = len;
    };
    if (line.length) {
      const cuts = cutPoints(line);
      for (let k = 1; k < cuts.length; k++) {
        const c = line.subarray(cuts[k - 1], cuts[k]);
        const h = createHash('sha256').update(c).digest('base64');
        const at = seen.get(h);
        if (at && (at[0] === buf.frame || recent.includes(at[0]))) { range(at[0], at[1], c.length); continue; }
        const off = append(buf, c);
        seen.set(h, [buf.frame, off]);
        range(buf.frame, off, c.length);
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
