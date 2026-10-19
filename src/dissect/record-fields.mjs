// src/dissect/record-fields.mjs — the addressable FIELDS of a captured record (RFC 4.2:40 text_ref 字段段,
// gate G1): which envelope fields a text_ref may name, and the verbatim text each one holds. Envelope
// fields only (D10 resp.raw · 4.6 resp.messages / req_extra_messages), no wire knowledge. One definition for
// every reader — the resolver (src/query/source.mjs), /api/block, the board's locators and the ETL adapters —
// kept in this leaf so the adapters can use it without importing the read side's exporters (0.1 §2).
// Leaf module.
// req_body is the default and never written out, so every ref minted before the segment is unchanged.
export const TEXT_REF_FIELD = /^(resp\.raw|resp\.messages\.\d+|req_extra_messages\.\d+)$/;
// The text a field segment addresses in a record (one definition: the resolver and the board's locators
// both read it). resp.raw = the decoded reply text the collector stored (SSE or text); resp.messages.<j> = a
// WebSocket envelope's j-th server message; req_extra_messages.<k> = a later client message of the same call.
// An error envelope keeps what arrived under resp.partial, with the same numbering (ws_raw's m slices count it
// the same way). → { text } | { missing: why } — a non-text value is never stringified into "bytes".
const STORED_AS = (v) => (v && typeof v === 'object'
  ? (typeof v.b64 === 'string' ? `base64 bytes ({b64}${v.decode_error ? ', not decodable' : ''})`
    : v.omitted_bytes != null ? `{omitted_bytes: ${v.omitted_bytes}} — over the per-call cap, bytes not kept`
      : v.verbatim === false ? 'its length only ({raw_chars}) — not verbatim' : 'a non-text value')
  : `${v === undefined ? 'nothing' : typeof v}`);
export function fieldTextOf(rec, field) {
  const m = TEXT_REF_FIELD.exec(String(field || ''));
  if (!m) return { missing: `has no text_ref field "${field}"` };
  const resp = (rec && (rec.resp || rec.response)) || {};
  const part = resp.kind === 'error' && resp.partial && typeof resp.partial === 'object' ? resp.partial : resp;
  let v;
  if (field === 'resp.raw') v = part.raw;
  else {
    const [, list, j] = /^(resp\.messages|req_extra_messages)\.(\d+)$/.exec(field);
    const arr = list === 'resp.messages' ? (part.kind === 'ws' ? part.messages : null) : rec && rec.req_extra_messages;
    if (!Array.isArray(arr) || Number(j) >= arr.length) return { missing: `has no ${field}` };
    v = arr[Number(j)];
  }
  if (typeof v === 'string') return { text: v };
  return { missing: v === undefined ? `has no ${field}` : `stores ${field} as ${STORED_AS(v)}, not as text` };
}
