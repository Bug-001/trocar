// src/dissect/capture-labels.mjs — read the collector's incompleteness labels (RFC 4.6 §记录). This
// module: the request-body labels from PR #21. Each label says ONE thing (4.6 「不完整的标注,各说一件事」):
//   req_truncated + req_body_bytes — the body was cut at the capture cap. It finished uploading and was
//     forwarded whole; only its first req_body_bytes bytes (the STORED prefix, not the wire length) are on disk.
//   req_partial — the collector did not receive the whole body: it never finished uploading
//     ('early-response' | 'aborted'), or the collector lost the request's HTTP framing and stopped storing
//     it ('framer-error'; the framer is passive, so the relay may still have forwarded the rest). What is
//     on disk is what arrived before that.
// These are NOT the top-level `partial` (a connection's earlier messages are missing — context, not bytes).
// Envelope fields only, no wire knowledge, so the board and the ETL can both use it. Leaf module.
const PARTIAL = {
  'early-response': 'never finished uploading: the upstream answered (e.g. 413 / 401) before it was fully sent',
  aborted: 'never finished uploading: the connection was aborted mid-body',
  'framer-error': "not captured whole: the collector lost the request's HTTP framing and stopped storing it there (whether the rest reached the upstream is unknown)",
};

// → null for a complete request, else { truncated, storedBytes, partial, text }.
export function reqIncompleteOf(rec) {
  if (!rec || (!rec.req_truncated && !rec.req_partial)) return null;
  const truncated = !!rec.req_truncated;
  const n = rec.req_body_bytes;
  const storedBytes = truncated && typeof n === 'number' && Number.isFinite(n) ? n : null;
  const partial = rec.req_partial ? String(rec.req_partial) : null;
  const parts = [];
  if (truncated) {
    parts.push(storedBytes != null
      ? `cut at the capture cap: only the first ${storedBytes} bytes are stored (the request sent was longer)`
      : 'cut at the capture cap: only a prefix is stored (its size was not recorded)');
  }
  // An unknown value is shown verbatim, never dropped: a newer collector may add a reason.
  if (partial) parts.push(PARTIAL[partial] || `not received whole (req_partial: ${partial})`);
  return { truncated, storedBytes, partial, text: `request body ${parts.join('; ')} — the stored bytes are only part of the request` };
}

// WebSocket envelopes (RFC 4.6 §传输与帧级记录, D37; D38): their labels, each saying one thing (4.6 「各说一件事」):
//   partial + partial_reasons     earlier messages on this connection are missing — context, not this call's bytes
//   ws_truncated / {omitted_bytes} messages past the capture cap kept only their size — this call's bytes are not all here
//   {b64, decode_error}           a message that could not be decompressed: its raw bytes are kept, its text is not
//   {raw_chars, verbatim:false}   a non-LLM endpoint's client message: only its size (non-verbatim)
//   the call's own first client message could not be decompressed (4.6 §传输与帧级记录 信封): `req_body:null` with no
//     `req_body_b64`, told from "no client message" by this call's client data frames in `ws_raw` plus `decode-failed`
//     in `partial_reasons` — counted as undecoded, and this call's own bytes are then not said to be whole
// → null for an HTTP envelope or a complete, verbatim WebSocket call; else the counts and one sentence.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// the opcode of a ws_raw frame from its base64 header `h` (first byte, low 4 bits); -1 when unreadable
const opcodeOf = (h) => { const a = B64.indexOf(String(h || '')[0]), b = B64.indexOf(String(h || '')[1]); return a < 0 || b < 0 ? -1 : (((a << 2) | (b >> 4)) & 0x0f); };
const hasClientData = (wsRaw) => Array.isArray(wsRaw) && wsRaw.some((f) => f && f.d === 'c' && [0, 1, 2].includes(opcodeOf(f.h)));
export function wsIncompleteOf(rec) {
  if (!rec || rec.transport !== 'ws') return null;
  const resp = rec.resp || {};
  const msgs = [rec.req_body, ...(Array.isArray(rec.req_extra_messages) ? rec.req_extra_messages : []),
    ...((resp.messages || (resp.partial && resp.partial.messages)) || [])];
  let omitted = 0, undecoded = 0, nonVerbatim = 0;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.omitted_bytes != null) omitted++;
    if (m.decode_error) undecoded++;
    if (m.verbatim === false) nonVerbatim++;
  }
  const partial = rec.partial === true;
  const partialReasons = Array.isArray(rec.partial_reasons) ? rec.partial_reasons.map(String) : [];
  const openerUndecoded = rec.req_body == null && rec.req_body_b64 == null && partialReasons.includes('decode-failed') && hasClientData(rec.ws_raw);
  if (openerUndecoded) undecoded++;
  const truncated = rec.ws_truncated === true || omitted > 0;
  if (!partial && !truncated && !undecoded && !nonVerbatim) return null;
  const parts = [];
  if (partial) parts.push(`earlier messages on this connection are missing (${partialReasons.join(', ') || 'reason not recorded'}): the context this call relied on is incomplete${openerUndecoded ? '' : ', its own bytes are whole'}`);
  if (truncated) parts.push(`${omitted || 'some'} message(s) past the capture cap kept only their size: this call's bytes are not all stored`);
  if (undecoded) parts.push(`${undecoded} message(s) could not be decompressed${openerUndecoded ? ', the request message among them' : ''}: their raw bytes are kept, their text is not`);
  if (nonVerbatim) parts.push(`${nonVerbatim} client message(s) of a non-LLM endpoint stored as their size only (non-verbatim)`);
  return { partial, partialReasons, truncated, omitted, undecoded, nonVerbatim, ...(openerUndecoded ? { requestUndecoded: true } : {}), text: `WebSocket call: ${parts.join('; ')}` };
}
