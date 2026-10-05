// src/raw/writer.mjs — encode records into one sealed file (RFC 4.2 §原始层封存 「记录编码」「分帧」).
//
// The caller opens the destination (0600, in the target directory) and owns fsync / rename; this
// module only turns lines into header · frames · index tail · trailer on that fd. Every write goes
// through the injected `fs`, so the sealer's crash-order tests see every byte that reaches disk.
import nodeFs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { encodeOps, pickPredecessor, CANDIDATES, CHAIN_MAX } from './delta.mjs';
import { headerBytes, indexTailBytes, trailerBytes, FLAG_NL, FLAG_UNPARSEABLE } from './format.mjs';

export const FRAME_BYTES = 4 << 20;   // ~4 MiB of encoded bytes per frame (D35 ④)
const RING_BYTES = 128 << 20;         // cap on predecessor lines kept for matching (memory bound)
// One shard split by session feeds one writer per session, each with its own ring: without a shared
// cap, memory grows with the number of sessions (review F15). All writers of one seal share this
// budget; past it, the largest ring gives up its oldest line. That only costs compression — a ring
// is a pool of predecessor CANDIDATES, never needed to decode.
export const RING_TOTAL = 512 << 20;
export const createRingBudget = (max = RING_TOTAL) => ({ max, total: 0, rings: [] });
const BROTLI = { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 };

export function createSealWriter({ fd, fs = nodeFs, frameBytes = FRAME_BYTES, chainMax = CHAIN_MAX, budget = null } = {}) {
  let pos = 0;
  const write = (buf) => { let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, pos + off); pos += buf.length; };
  write(headerBytes());

  const frames = [], records = [], streams = [], streamIdx = new Map();
  let parts = [], partLen = 0, deltas = 0, rawBytes = 0;
  const ring = [], me = { ring, bytes: 0 };
  if (budget) budget.rings.push(me);
  const drop = (r) => { const n = r.ring.shift().line.length; r.bytes -= n; if (budget) budget.total -= n; };

  const flush = () => {
    if (!partLen) return;
    const raw = parts.length === 1 ? parts[0] : Buffer.concat(parts, partLen);
    const out = zlib.brotliCompressSync(raw, { params: { ...BROTLI, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    frames.push([pos, out.length, raw.length]);
    write(out);
    parts = []; partLen = 0;
  };

  // line: the record's exact bytes INCLUDING its "\n" (if any). The writer keeps a reference for
  // predecessor matching, so callers MUST NOT reuse the buffer.
  function add(line, { id = null, stream, shard = 0, lineNo, unparseable = false }) {
    const idx = records.length;
    let kind = 0, back = -1, depth = 0, enc = line;
    const pred = pickPredecessor(ring, line, chainMax);
    if (pred) {
      const ops = encodeOps(pred.line, line);
      if (ops.length < 0.5 * line.length) { kind = 1; back = pred.idx; depth = pred.depth + 1; enc = ops; deltas++; }
    }
    // Cut only at record boundaries: a record never spans two frames, and one bigger than a whole
    // frame gets a frame of its own.
    if (partLen && (partLen >= frameBytes || enc.length >= frameBytes)) flush();
    const off = partLen;
    parts.push(enc); partLen += enc.length;
    let s = streamIdx.get(stream);
    if (s === undefined) { s = streams.length; streams.push(stream); streamIdx.set(stream, s); }
    const flags = (line.length && line[line.length - 1] === 0x0a ? FLAG_NL : 0) | (unparseable ? FLAG_UNPARSEABLE : 0);
    const sha = createHash('sha256').update(line).digest('base64');
    records.push([id == null ? null : String(id), s, frames.length, off, enc.length, line.length, kind, back, sha, flags, shard, lineNo]);
    rawBytes += line.length;
    if (partLen >= frameBytes) flush();
    ring.push({ idx, depth, line }); me.bytes += line.length; if (budget) budget.total += line.length;
    while (ring.length > CANDIDATES || (ring.length > 1 && me.bytes > RING_BYTES)) drop(me);
    while (budget && budget.total > budget.max) {
      let big = null;
      for (const r of budget.rings) if (r.ring.length > 1 && (!big || r.bytes > big.bytes)) big = r;
      if (!big) break;                    // every ring is down to its newest line
      drop(big);
    }
    return idx;
  }

  // shards: the source-shard table (4.2), known in full only after the whole source has been read.
  function finish(shards) {
    flush();
    const tail = indexTailBytes({ frames, shards, streams, records });
    const indexOffset = pos;
    write(tail);
    write(trailerBytes(indexOffset, tail.length));
    return { bytes: pos, records: records.length, frames: frames.length, deltas, rawBytes };
  }

  return { add, finish, get count() { return records.length; }, get ringBytes() { return me.bytes; } };
}
