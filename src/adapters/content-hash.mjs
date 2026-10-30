// src/adapters/content-hash.mjs — D19: content_hash = full sha-256 over a block's
// VERBATIM serialized bytes (the bytes exactly as captured in req_body), NOT a
// JSON.parse -> JSON.stringify re-serialization.
//
// WHY byte-exact (the moat): content_hash is BOTH the dedup PK (3.2) AND the
// cache-break divergence signal (3.3/D17①). Re-serializing would normalize
// whitespace, key order, number formatting, and unicode escaping — masking the
// exact wire-byte changes (json-key-reorder, tool-array-reorder, formatting
// drift) that D17① must DETECT. So we hash the raw substring of req_body that a
// block occupies. Key-order canonicalization is used ONLY for divergence_cause
// CLASSIFICATION (3.3), never for this hash.
import { createHash } from 'node:crypto';

// sha-256 hex of the UTF-8 bytes of a string.
export function contentHash(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Hash the verbatim serialization of a scanned node (slice of the source text).
export function hashSpan(text, node) {
  return contentHash(text.slice(node.start, node.end));
}

// [start, end) offsets of a scanned node (for text_ref / byte-offset回源).
export function spanOf(node) {
  return [node.start, node.end];
}
