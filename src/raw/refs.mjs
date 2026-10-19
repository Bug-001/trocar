// src/raw/refs.mjs — the 回源 pointer grammar: raw_ref / text_ref (RFC 4.2:37, 4.2:40).
//
// A pointer, not the bytes: the read side MINTS these and the source-truth resolver
// PARSES them back, so the grammar has exactly one home (D59③: no ETL step is left).
import { TEXT_REF_FIELD } from '../dissect/record-fields.mjs';

// ── 回源 pointers (raw_ref / text_ref) — the AC-1 technical payoff (RFC 4.2:37) ──────
// The projection stores NO fulltext (RFC 3.2 invariant): a block row keeps only a
// pointer that locates its VERBATIM bytes back in the source NDJSON. The adapter emits
// a record-relative BYTE SPAN [start,end) into req_body (cc.mjs mkBlock: text_ref =
// spanOf(node)); ETL mints raw_ref and composes the persisted text_ref = raw_ref + span.
//   raw_ref  = "<session_id>/<stream>#<record.id>"        → one source record
//   text_ref = "<raw_ref>::<start>-<end>"                 → a block's bytes in req_body
//            | "<raw_ref>::<field>::<start>-<end>"        → bytes of another field of the record (4.2:40
//              字段段, gate G1): a WebSocket call's stitched blocks live in an EARLIER record's
//              resp.messages[j] (D37 ②); R2 compares the reply (resp.raw); 3.1:37 shows req_extra_messages.
// TEXT_REF_FIELD / fieldTextOf (the field segment's grammar and text) live in src/dissect/record-fields.mjs,
// imported here (not re-exported): every reader imports them from that leaf.
export function mintRawRef(sessionId, streamBasename, recordId) {
  return `${sessionId ?? '_control'}/${streamBasename}#${recordId}`;
}
export function composeTextRef(rawRef, span, field = null) {
  if (field == null || field === 'req_body') return `${rawRef}::${span[0]}-${span[1]}`;
  if (!TEXT_REF_FIELD.test(field)) throw new Error(`composeTextRef: "${field}" is not a text_ref field (4.2:40)`);
  return `${rawRef}::${field}::${span[0]}-${span[1]}`;
}
export function parseTextRef(textRef) {
  const i = textRef.lastIndexOf('::');
  // No `::span` suffix is legitimate (a raw ref addresses the whole record). Guard it: with i === -1
  // the old `slice(0, i)` was `slice(0, -1)`, which silently CHOPPED THE LAST CHARACTER off the ref —
  // so `req_plain` looked up as `req_plai` and the resolver reported the record "absent" rather than
  // reporting a malformed ref. A silently wrong answer from the source-truth resolver is the worst
  // failure mode this module can have.
  if (i < 0) return { rawRef: textRef, field: null, start: null, end: null, recordId: textRef.slice(textRef.lastIndexOf('#') + 1) };
  const head = textRef.slice(0, i);
  const [start, end] = textRef.slice(i + 2).split('-').map(Number);
  // A field segment sits between the record id and the span. Record ids never contain "::" (the
  // /api/block grammar refuses them), so the first "::" after the last "#" starts it.
  const j = head.indexOf('::', head.lastIndexOf('#') + 1);
  const rawRef = j >= 0 ? head.slice(0, j) : head;
  return { rawRef, field: j >= 0 ? head.slice(j + 2) : null, start, end, recordId: rawRef.slice(rawRef.lastIndexOf('#') + 1) };
}
