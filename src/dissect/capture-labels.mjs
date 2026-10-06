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
import { requestEncodingOf } from './request-body.mjs';
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

// The response body's labels (RFC 4.1 落地细节 (10), 4.6 §记录 体不完整; D38): the old capture and the
// collector shape the response the same way, and a call whose body was not decoded, not JSON, empty, partly parsed or
// cut must not look like a normal call with an empty answer (invariant 4). An interrupted call: what arrived
// (`resp.partial`). → null when there is nothing to say; else the flags and one sentence.
export function respIncompleteOf(rec) {
  const resp = rec && rec.resp;
  if (!resp || typeof resp !== 'object' || rec.transport === 'ws') return null; // a WebSocket call: wsIncompleteOf
  const body = resp.kind === 'error' && resp.partial && typeof resp.partial === 'object' ? resp.partial : resp;
  const undecoded = !!body.encoding_error;
  const binary = !undecoded && body.kind === 'text' && body.raw_b64 != null;
  const notJson = !undecoded && !binary && body.kind === 'text';
  const empty = body.kind === 'empty';
  const unparsed = typeof body.unparsed_events === 'number' && body.unparsed_events > 0 ? body.unparsed_events : 0;
  const truncated = body.truncated === true;
  const n = body.body_bytes;
  const bodyBytes = truncated && typeof n === 'number' && Number.isFinite(n) ? n : null;
  const parts = [];
  if (undecoded) parts.push(`the body could not be decompressed (${String(body.encoding_error)}): its wire bytes are kept (raw_b64), its text is not`);
  if (binary) parts.push('the body is not UTF-8 text: its bytes are kept (raw_b64), nothing was read from it');
  if (notJson) parts.push('the body is not JSON (kept verbatim as text): no answer or usage was read from it');
  if (empty) parts.push('there was no body');
  if (unparsed) parts.push(`${unparsed} SSE event(s) whose data is not JSON were left out of the reconstruction: the answer shown may be incomplete`);
  if (truncated) parts.push(`the body was cut at the capture cap: ${bodyBytes != null ? `only the first ${bodyBytes} bytes are stored` : 'only a prefix is stored'}`);
  if (!parts.length) return null;
  return { undecoded, binary, notJson, empty, unparsed, truncated, bodyBytes, text: `response: ${parts.join('; ')}` };
}

// Gate G17 (default this read side is written against): a request
// body stored only in part (#21 labels above) is NOT the full context the model saw, so the call is
// context_state 'partial' — its cache facts are then NULL (3.2:124), and the labels still say why.
// 3.2:52 names missing predecessors / unrecoverable server-inherited parts only; this one function is the
// whole default, so a different answer from the user is a one-line change. → 'partial' | null.
export function contextStateOfRequest(rec) {
  return reqIncompleteOf(rec) || bodyUnparsedOf(rec) ? 'partial' : null;
}

// A request body that is stored as text and does not parse to an object (a legacy capture or a corrupt one: with no
// req_truncated / req_partial label, truncation and corruption cannot be told apart) has no context to read, so no
// message count either (3.4: no compaction verdict from an unobserved count). The same test as the board's own
// "unparsed" (assemble.mjs, analyze.mjs::isUnparsed) so the two sides cannot disagree. null / absent body: no body
// at all (a WebSocket call whose request was not stored, a v0 envelope), not this case.
export function bodyUnparsedOf(rec) {
  const b = rec && rec.req_body;
  if (typeof b !== 'string') return false;
  try { const v = JSON.parse(b); return !(v && typeof v === 'object'); } catch { return true; }
}

// The other incompleteness labels (4.6 §记录 「不完整的标注,各说一件事」), one per thing that happened, from
// envelope fields only. None of them changes context_state (3.1): they say which BYTES of this record are
// not all there, or not decoded; the request-body labels above stay with reqIncompleteOf, so nothing is
// shown twice. → [{ id, label, text }]
export function captureLabelsOf(rec) {
  const out = [];
  if (!rec) return out;
  const r = rec.resp || rec.response || {};
  if (r.truncated === true) out.push({ id: 'resp-truncated', label: '已截断 · reply cut at the cap',
    text: `the reply was cut at the capture cap: only its first ${Number(r.body_bytes) || 0} bytes are stored` });
  if (r.kind === 'error' && r.partial) out.push({ id: 'resp-partial', label: '不完整 · reply never finished',
    text: 'the response stopped before it finished; what arrived is kept under resp.partial' });
  if (r.encoding_error) out.push({ id: 'resp-undecoded', label: '回复未解码 · reply not decoded',
    text: `the reply could not be decoded (${r.encoding_error}); its bytes are kept as base64 in the record, so no reply text is shown` });
  if (rec.ws_truncated === true) out.push({ id: 'ws-truncated', label: '已截断 · call over the size cap',
    text: 'messages past the per-call cap are stored as {omitted_bytes}; their bytes are not in the record' });
  // 3.1 / 3.2:132: the reader decodes req_body_b64 first (request-body.mjs, at load); labelled only when no text is
  // left — the reader could not decode it either, or the collector said it did not and kept no bytes to try
  if (typeof rec.req_body !== 'string' && (rec.req_encoding_error || (typeof rec.req_body_b64 === 'string' && requestEncodingOf(rec)))) {
    out.push({ id: 'req-undecoded', label: '压缩请求体未解码 · compressed request not decoded',
      text: `the request body is stored compressed (${rec.req_content_encoding || 'unknown encoding'}) and could not be decoded: ${rec._reqBodyDecodeError || rec.req_encoding_error || 'the reader did not try'}` });
  }
  // 1.6 §1.3 / 4.6 §记录: asight put a line into the response head the client got (`off` landed before the head was forwarded): the call says
  // so in place (invariant 4) — the stored head and body are the upstream's own, the client's head had this one line more
  if (Array.isArray(rec.asight_added) && rec.asight_added.includes('connection-close')) out.push({ id: 'asight-added', label: 'asight 加的 · Connection: close',
    text: 'asight added the hop-by-hop header Connection: close to this response when capture was turned off; the response body is byte for byte what the upstream sent, and resp_head_raw is the upstream head' });
  return out;
}
