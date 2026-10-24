// src/raw/delta.mjs — decoding the format-v1 per-record byte delta (RFC 4.2 §封存格式 「记录编码(版本 1,只读)」).
//
// A v1 delta record is a list of byte ops against an EARLIER record's line bytes in the same sealed file:
// COPY(offset, len) from the predecessor, INSERT(literal bytes). The ops are pure byte splices, so decoding reproduces
// the line exactly (invariant 2). The sealer no longer writes v1; readers read it for ever (4.2), so only the decoder
// and the bounds the v1 reader checks remain.
//
// Op encoding (varint = unsigned LEB128, numbers up to 2^53): head = len * 2 + tag.
//   tag 0 = COPY  → head, varint offset into the predecessor line
//   tag 1 = INSERT → head, then `len` literal bytes
// The ops run to the end of the record's span (the index gives its length), so they need no count.
import { readVarint } from './format.mjs';

export const CHAIN_MAX = 16;     // steps from a record back to its keyframe (MUST, 4.2)
export const CANDIDATES = 32;    // the v1 encoder's predecessor window (records): how far back a sequential read keeps lines

// Decode: run the ops over the predecessor line. Every bound is checked — a sealed file is read as
// source truth, so damaged ops MUST throw rather than yield plausible wrong bytes (invariant 4).
export function applyOps(A, ops) {
  const parts = [];
  let total = 0, pos = 0;
  while (pos < ops.length) {
    let head, off;
    [head, pos] = readVarint(ops, pos);
    const len = Math.floor(head / 2);
    if (head % 2) {
      if (pos + len > ops.length) throw new Error('delta ops corrupt: INSERT past the end of the record');
      parts.push(ops.subarray(pos, pos + len)); pos += len;
    } else {
      [off, pos] = readVarint(ops, pos);
      if (off + len > A.length) throw new Error(`delta ops corrupt: COPY ${off}+${len} out of range of a ${A.length}-byte predecessor`);
      parts.push(A.subarray(off, off + len));
    }
    total += len;
  }
  return Buffer.concat(parts, total);
}
