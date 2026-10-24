// src/raw/delta.mjs — the D35 per-record byte delta (RFC 4.2 §原始层封存 「记录编码」).
//
// A delta record is a list of byte ops against an EARLIER record's line bytes in the same sealed
// file: COPY(offset, len) from the predecessor, INSERT(literal bytes). Nothing here parses JSON or
// knows a provider — the ops are pure byte splices, so decoding reproduces the line exactly
// (invariant 2: the sealed file is the source truth, not a re-serialisation of it).
//
// The encoder heuristic is a SHOULD, not format (any ops that decode correctly are valid). It is the
// one validated by the 2026-10-05 experiment (scratchpad rawlog-exp/delta.mjs, 2.74 / 2.28 / 5.26 %
// of raw): multi-hunk matching with a 32-byte rolling hash sampled every 16 bytes, matches ≥ 64 bytes,
// merged down to ≤ 8 hunks across the smallest copy gaps.
//
// Op encoding (varint = unsigned LEB128, numbers up to 2^53): head = len * 2 + tag.
//   tag 0 = COPY  → head, varint offset into the predecessor line
//   tag 1 = INSERT → head, then `len` literal bytes
// The ops run to the end of the record's span (the index gives its length), so they need no count.

import { readVarint } from './format.mjs';

export const WINDOW = 32;        // rolling-hash window
export const STRIDE = 16;        // predecessor positions indexed every STRIDE bytes
export const MIN_MATCH = 64;     // shortest accepted COPY in the middle region
export const MAX_HUNKS = 8;      // hunks (changed regions) per delta after merging
export const CHAIN_MAX = 16;     // steps from a record back to its keyframe (MUST, 4.2)
export const CANDIDATES = 32;    // predecessor search window (records)
const MAX_MIDDLE = 64 << 20;     // beyond this the middle is one hunk (bounded hash table)
const BASE = 0x01000193;
let POW = 1; for (let i = 0; i < WINDOW - 1; i++) POW = Math.imul(POW, BASE);

// Longest common prefix of a[ao..] and b[bo..], at most `max` bytes (native compare in big steps).
export function lcp(a, b, ao = 0, bo = 0, max = Infinity) {
  const n = Math.min(a.length - ao, b.length - bo, max);
  let i = 0;
  for (let step = 65536; step >= 16; step >>= 2) {
    while (i + step <= n && a.compare(b, bo + i, bo + i + step, ao + i, ao + i + step) === 0) i += step;
  }
  while (i < n && a[ao + i] === b[bo + i]) i++;
  return i;
}
// Longest common suffix of a[..aEnd) and b[..bEnd), not reaching below aMin / bMin.
function lcs(a, b, aEnd, bEnd, aMin, bMin) {
  const n = Math.min(aEnd - aMin, bEnd - bMin);
  let i = 0;
  for (let step = 65536; step >= 16; step >>= 2) {
    while (i + step <= n && a.compare(b, bEnd - i - step, bEnd - i, aEnd - i - step, aEnd - i) === 0) i += step;
  }
  while (i < n && a[aEnd - 1 - i] === b[bEnd - 1 - i]) i++;
  return i;
}

// Copy runs [{aS, bS, len}] of B against A, monotonic in both. Always starts with the common prefix
// and ends with the common suffix (either may be empty).
function copyRuns(A, B) {
  const P = lcp(A, B);
  const S = lcs(A, B, A.length, B.length, P, P);
  const aE = A.length - S, bE = B.length - S;
  const runs = [{ aS: 0, bS: 0, len: P }];
  if (aE - P >= MIN_MATCH && bE - P >= MIN_MATCH && aE - P <= MAX_MIDDLE) {
    const nIdx = Math.ceil((aE - P) / STRIDE);
    let bits = 12; while ((1 << bits) < nIdx * 2 && bits < 20) bits++;
    const WAYS = 8;
    const tbl = new Int32Array((1 << bits) * WAYS).fill(-1);
    const slot = (h) => (Math.imul(h, 0x9E3779B1) >>> (32 - bits)) * WAYS;
    if (aE - P >= WINDOW) {
      let h = 0;
      for (let j = 0; j < WINDOW; j++) h = (Math.imul(h, BASE) + A[P + j]) | 0;
      for (let i = P; ; i++) {
        if ((i - P) % STRIDE === 0) {
          const s = slot(h);
          for (let w = 0; w < WAYS; w++) if (tbl[s + w] < 0) { tbl[s + w] = i; break; }
        }
        if (i + WINDOW >= aE) break;
        h = (Math.imul((h - Math.imul(A[i], POW)) | 0, BASE) + A[i + WINDOW]) | 0;
      }
    }
    const rehash = (pos) => { let h = 0; for (let t = 0; t < WINDOW; t++) h = (Math.imul(h, BASE) + B[pos + t]) | 0; return h; };
    let aCur = P, bCur = P, j = P;
    let h = j + WINDOW <= bE ? rehash(j) : 0;
    while (j + WINDOW <= bE) {
      const s = slot(h);
      let best = -1;
      for (let w = 0; w < WAYS; w++) {
        const p = tbl[s + w];
        if (p < 0) break;
        if (p >= aCur && p + WINDOW <= aE && (best < 0 || p < best) && A.compare(B, j, j + WINDOW, p, p + WINDOW) === 0) best = p;
      }
      if (best >= 0) {
        const fwd = lcp(A, B, best, j, Math.min(aE - best, bE - j));
        let back = 0;
        while (best - back > aCur && j - back > bCur && A[best - back - 1] === B[j - back - 1]) back++;
        if (back + fwd >= MIN_MATCH) {
          runs.push({ aS: best - back, bS: j - back, len: back + fwd });
          aCur = best + fwd; bCur = j + fwd; j = bCur;
          if (j + WINDOW <= bE) h = rehash(j);
          continue;
        }
      }
      if (j + WINDOW >= bE) break;
      h = (Math.imul((h - Math.imul(B[j], POW)) | 0, BASE) + B[j + WINDOW]) | 0;
      j++;
    }
  }
  runs.push({ aS: aE, bS: bE, len: S });
  return runs;
}

// At most MAX_HUNKS changed regions: after coalescing runs that touch in both A and B, every gap
// between two runs is one hunk, so keep the prefix, the suffix and the MAX_HUNKS - 1 longest interior
// runs. Dropping a run turns it into inserted bytes (merging its two neighbouring hunks across the
// smallest copy gaps), which is always still correct — only less compact.
function mergeRuns(runs) {
  const c = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const p = c[c.length - 1], q = runs[i];
    if (q.aS === p.aS + p.len && q.bS === p.bS + p.len) p.len += q.len; else c.push(q);
  }
  if (c.length - 1 <= MAX_HUNKS) return c;
  const keep = c.slice(1, -1).map((r, i) => [r.len, i + 1]).sort((x, y) => y[0] - x[0])
    .slice(0, MAX_HUNKS - 1).map((x) => x[1]).sort((x, y) => x - y);
  return [c[0], ...keep.map((i) => c[i]), c[c.length - 1]];
}

class Out {
  constructor(n) { this.buf = Buffer.allocUnsafe(Math.max(64, n)); this.n = 0; }
  need(k) { if (this.n + k > this.buf.length) { const b = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.n + k)); this.buf.copy(b, 0, 0, this.n); this.buf = b; } }
  varint(x) { this.need(10); while (x >= 128) { this.buf[this.n++] = (x % 128) | 128; x = Math.floor(x / 128); } this.buf[this.n++] = x; }
  bytes(b) { this.need(b.length); b.copy(this.buf, this.n); this.n += b.length; }
  done() { return this.buf.subarray(0, this.n); }
}

export function encodeOps(A, B) {
  const runs = mergeRuns(copyRuns(A, B));
  const out = new Out(256);
  let bPos = 0;
  for (const r of runs) {
    if (r.bS > bPos) { out.varint((r.bS - bPos) * 2 + 1); out.bytes(B.subarray(bPos, r.bS)); }
    if (r.len > 0) { out.varint(r.len * 2); out.varint(r.aS); }
    bPos = r.bS + r.len;
  }
  if (bPos < B.length) { out.varint((B.length - bPos) * 2 + 1); out.bytes(B.subarray(bPos)); }
  return Buffer.from(out.done());
}

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

// Number of COPY ops (a hunk sits between two copies, so hunks ≤ copies + 1 and copies ≤ hunks + 1).
export function countCopies(ops) {
  let n = 0, pos = 0;
  while (pos < ops.length) {
    let head; [head, pos] = readVarint(ops, pos);
    if (head % 2) pos += Math.floor(head / 2); else { n++; [, pos] = readVarint(ops, pos); }
  }
  return n;
}

// Where the request body starts. Every envelope line opens with `ts`, which differs on every record,
// so a whole-line common prefix is always ~20 bytes and says nothing; the experiment measured the
// prefix from the body, which is where the conversation grows. A byte search for the envelope key —
// the same one the header scan is bounded with — not a JSON parse.
const BODY_KEY = Buffer.from('"req_body":');
const anchorOf = (line) => { const i = line.indexOf(BODY_KEY); return i < 0 ? 0 : i + BODY_KEY.length; };

// Encoder heuristic (SHOULD, 4.2): among the last CANDIDATES records, the one whose bytes share the
// longest common prefix with this one (measured from the body), never one already CHAIN_MAX deep.
// Ring entries: { idx, depth, line }. Ties go to the newest. Returns null when nothing is eligible.
export function pickPredecessor(ring, line, chainMax = CHAIN_MAX) {
  const anchor = anchorOf(line);
  let best = null, bestLen = -1;
  for (let r = ring.length - 1; r >= 0 && r >= ring.length - CANDIDATES; r--) {
    const c = ring[r];
    if (c.depth >= chainMax) continue;
    if (c.anchor === undefined) c.anchor = anchorOf(c.line);
    const ca = anchor && c.anchor ? c.anchor : 0, la = anchor && c.anchor ? anchor : 0;
    if (bestLen > 0) {                                  // cheap reject: must match the best prefix first
      const n = bestLen;
      if (c.line.length - ca < n || line.length - la < n || c.line.compare(line, la, la + n, ca, ca + n) !== 0) continue;
    }
    const L = lcp(c.line, line, ca, la);
    if (L > bestLen) { bestLen = L; best = c; }
  }
  return best;
}
