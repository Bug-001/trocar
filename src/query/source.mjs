// src/query/source.mjs — two small rules the read side shares about the bytes of a capture file.
//
// classifyFidelity(): whether the request body a reader hands back is the wire's own bytes, their decoded
// text, or a re-serialization (invariant 4: say so where it is not verbatim). Read by the block query
// (src/query/named/block.mjs).
//
// fpRanges() / readRangeSync(): the identity rule of an append-only capture file, used by the segment
// index (src/query/index-build.mjs) to decide whether a file it indexed may be read on from where it
// stopped.
import { readSync } from 'node:fs';
import { requestEncodingOf } from '../dissect/request-body.mjs';

// ── fidelity of the bytes we hand back (invariant 4 保真边界写明) ──────────
// NOT every record a reader hands back is byte-faithful. `normalizeRecord` (src/raw/ingest.mjs)
// has two branches:
//   · D10 — `req_body` is the VERBATIM captured request string → the bytes that went on the wire.
//   · demo v0 — the capture stored the request as PARSED JSON, so the body is rebuilt with
//     JSON.stringify. Whitespace, key order, duplicate keys, number formatting and unicode
//     escaping can all differ from the wire. It is a RE-SERIALIZATION, not the wire bytes.
// Both used to come back as bare strings, so the "回源 verbatim bytes" panel labelled the
// re-serialized ones verbatim too — presenting a reconstruction as the source truth, which is
// exactly the promise this tool exists to keep. So classify, and let every consumer label it.
// This is a CLASSIFIER only: it mirrors normalizeRecord's branches, it never rewrites anything.
export function classifyFidelity(raw) {
  // D10: the captured wire string — or, when the wire carried it compressed, its exact decompressed text (4.6 §记录)
  if (typeof raw.req_body === 'string') return requestEncodingOf(raw) ? 'decoded' : 'verbatim';
  if (raw.request === undefined) return null;                // not an llm record — no body at all
  if (raw.request === null) return 'reserialized';           // '' stand-in, synthesized not captured
  if (typeof raw.request === 'string') return 'verbatim';    // v0 stored raw text → passed through
  return 'reserialized';                                     // v0 parsed JSON → JSON.stringify(…)
}

// WHICH FILE an index mark describes, beyond its inode. A refresh treats a same-inode file that grew as an append and
// reads on from `end`. But an inode is no identity: Linux ext4 hands a deleted file's inode straight to the next file,
// and a truncating rewrite (O_TRUNC) keeps it — the new file was then read at the old file's offsets. In an
// append-only file the bytes before `end` never change, so the first and the last FP bytes before `end` are kept with
// the mark (plus mtime / ctime, to catch a same-size rewrite) and compared before any resume.
const FP = 4096;
// Exported: the segment index (src/query/index-build.mjs) invalidates its own files by the SAME rule —
// an append-only file is resumed only when the bytes before the last indexed line are still the ones indexed.
export const fpRanges = (end) => [[0, Math.min(FP, end)], [Math.max(0, end - FP), end]];
export function readRangeSync(fd, a, b) { const out = Buffer.alloc(b - a); let n = 0; while (n < out.length) { const r = readSync(fd, out, n, out.length - n, a + n); if (!r) break; n += r; } return out.subarray(0, n); }
