// src/view/control-wire.mjs — a non-inference call as the board's detail panel needs it (RFC 2.6 §C 「请求与响应体」 + §保真边界 1, 4.1 D40).
//
// Since D40 a call that is not inference keeps its bodies like any other: the request body verbatim (text, or base64 for bytes that are not
// UTF-8), a non-LLM SSE reply as `resp.raw`, a WebSocket call's messages — up to 64 MiB each. The panel must show them, and must not stall on
// them, so /api/control sends each record with its bodies RESHAPED for display and the heavy fields left behind (they are intact in the source
// NDJSON; the record's `id` / `raw_ref` finds them):
//   ctl.req / ctl.resp   {kind, text?, hex?, bytes?, chars?, clipped?}  — kind: text · json · sse · ws · binary · undecoded · length-only · empty · none
//                        text is the body as stored, clipped to BODY_SHOW_CHARS; a clipped body says so (shown_chars < chars) and where the rest is.
//                        binary: bytes + the first HEX_SHOW_BYTES as a hex dump. length-only: the record kept only a size (a pre-D40 record,
//                        or the operator's 「只记日志」): never shown as an empty body.
//   ctl.labels           what to say in place (4.1 保真边界, via captureLabelsOf): 本条采于 D40 之前,只存了长度 · 只记日志 · 已截断 · 压缩请求体未解码 …
//   ctl.host / hostHeader / hostDiffers   the host the bytes went to (SNI …) and the request's own Host header — a mismatch is a behaviour signal
// A small JSON reply stays in `resp.body` (the feature-flag ledger reads it there); a body over the cap leaves `resp.body` and is in ctl.resp.text.
// Envelope fields only — no provider knowledge, no host or endpoint literal (invariant 3). Pure over the record.
import { captureLabelsOf, bodyRetentionOf } from '../dissect/capture-labels.mjs';
import { requestEncodingOf } from '../dissect/request-body.mjs';
import { trafficClassOf } from '../dissect/traffic.mjs';
import { headerOf } from '../dissect/harnesses.mjs';

export const BODY_SHOW_CHARS = 1 << 20; // the most of one body's text a record carries to the browser
export const HEX_SHOW_BYTES = 4096;     // the most of a binary body shown as hex

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const b64Bytes = (s) => { const n = s.length; return Math.max(0, Math.floor((n * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)); };

// 16 bytes a line: offset, hex, printable ASCII
export function hexDump(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.subarray(i, i + 16);
    out.push(`${i.toString(16).padStart(6, '0')}  ${[...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}`);
  }
  return out.join('\n');
}
const hexOfB64 = (b64) => { // only the head is decoded: a body can be 85 MiB of base64
  const head = b64.slice(0, Math.ceil((HEX_SHOW_BYTES * 4) / 3) + 4);
  return hexDump(Buffer.from(head, 'base64').subarray(0, HEX_SHOW_BYTES));
};
function textBody(kind, text, bytes) {
  const chars = text.length;
  let t = text.length > BODY_SHOW_CHARS ? text.slice(0, BODY_SHOW_CHARS) : text;
  if (t.length < chars && /[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1); // never cut a surrogate pair in two
  return { kind, text: t, chars, shown_chars: t.length, clipped: t.length < chars, ...(bytes != null ? { bytes } : {}) };
}

function reqView(rec) {
  const wire = finite(rec.body_wire_bytes && rec.body_wire_bytes.req);
  const b = rec.req_body;
  if (typeof b === 'string') {
    if (b === '') return { kind: 'empty', bytes: wire ?? 0 };
    const v = textBody('text', b, wire ?? (b.length > 64 * 1024 * 1024 ? null : Buffer.byteLength(b)));
    const enc = requestEncodingOf(rec);
    return enc ? { ...v, decoded_from: enc } : v; // a compressed request shown decoded says so (4.6 §记录)
  }
  if (b && typeof b === 'object' && b.verbatim === false) return { kind: 'length-only', bytes: finite(b.raw_chars) ?? wire };
  if (b == null && typeof rec.req_body_b64 === 'string') {
    const enc = requestEncodingOf(rec);
    const n = wire ?? b64Bytes(rec.req_body_b64);
    return enc ? { kind: 'undecoded', encoding: enc, bytes: n } : { kind: 'binary', bytes: n, hex: hexOfB64(rec.req_body_b64) };
  }
  if (b && typeof b === 'object') return textBody('json', JSON.stringify(b, null, 2), wire); // a demo v0 record: the parsed request
  return { kind: 'none', ...(wire != null ? { bytes: wire } : {}) };
}

const messageText = (m, i) => (typeof m === 'string' ? m : m && typeof m === 'object' && m.verbatim === false ? `[${i}] (length only: ${m.raw_chars} bytes, not stored)`
  : m && typeof m === 'object' && m.omitted_bytes != null ? `[${i}] (over the per-call cap: ${m.omitted_bytes} bytes not kept)` : m && typeof m === 'object' && typeof m.b64 === 'string' ? `[${i}] (binary, ${b64Bytes(m.b64)} bytes, kept as base64)` : JSON.stringify(m));

function respView(rec) {
  const r = rec.resp || rec.response || {};
  const wire = finite(rec.body_wire_bytes && rec.body_wire_bytes.resp);
  const base = wire != null ? { bytes: wire } : {};
  if (r.verbatim === false) return { kind: 'length-only', bytes: finite(r.raw_chars) ?? wire };
  const bodyOf = (part) => {
    if (part.kind === 'ws' && Array.isArray(part.messages)) return textBody('ws', part.messages.map(messageText).join('\n'), wire ?? undefined);
    if (typeof part.raw === 'string') return textBody(part.kind === 'sse' ? 'sse' : 'text', part.raw, wire ?? undefined);
    if (typeof part.raw_b64 === 'string') return part.encoding_error ? { kind: 'undecoded', encoding: part.encoding_error, bytes: wire ?? b64Bytes(part.raw_b64), ...base } : { kind: 'binary', bytes: wire ?? b64Bytes(part.raw_b64), hex: hexOfB64(part.raw_b64) };
    if (part.kind === 'json') {
      const text = JSON.stringify(part.body === undefined ? null : part.body, null, 2);
      return text.length <= BODY_SHOW_CHARS ? { kind: 'json', ...base } : textBody('json', text, wire ?? undefined); // small: the record's own resp.body is shown
    }
    if (part.kind === 'empty') return { kind: 'empty', ...base };
    return { kind: 'none', ...base };
  };
  if (r.kind === 'error') {
    const part = r.partial && typeof r.partial === 'object' ? bodyOf(r.partial) : { kind: 'none' };
    return { ...part, error: r.error || null, interrupted: !!r.partial };
  }
  return bodyOf(r);
}

/**
 * controlRecordWire(rec) → the record as /api/control ships it: the raw fields the list and the flag ledger read, the heavy ones left behind,
 * and `ctl`. Never throws: a record this cannot read is returned as it is with `ctl.error`, so one odd record cannot blank the panel.
 */
export function controlRecordWire(rec) {
  try {
    const hostHeader = headerOf(rec, 'host');
    const norm = (h) => (h ? String(h).toLowerCase().replace(/:\d+$/, '') : null);
    const ctl = {
      retention: bodyRetentionOf(rec), traffic_class: trafficClassOf(rec), labels: captureLabelsOf(rec),
      host: typeof rec.host === 'string' ? rec.host : null, hostHeader, hostDiffers: !!(typeof rec.host === 'string' && hostHeader && norm(rec.host) !== norm(hostHeader)),
      wire_bytes: rec.body_wire_bytes && typeof rec.body_wire_bytes === 'object' ? { req: finite(rec.body_wire_bytes.req), resp: finite(rec.body_wire_bytes.resp) } : null,
      req: reqView(rec), resp: respView(rec),
    };
    const { req_body, req_body_b64, ws_raw, ...rest } = rec;
    const r = rec.resp || rec.response;
    const out = { ...rest };
    if (ws_raw !== undefined) ctl.omitted = ['ws_raw'];
    if (r && typeof r === 'object') {
      const { raw, raw_b64, ...slim } = r;
      if (ctl.resp.text !== undefined || ctl.resp.hex !== undefined || ctl.resp.kind === 'ws') { delete slim.body; delete slim.messages; }
      if (slim.partial && typeof slim.partial === 'object') { const { raw: _a, raw_b64: _b, body: _c, messages: _d, ...p } = slim.partial; slim.partial = p; }
      out[rec.resp ? 'resp' : 'response'] = slim;
    }
    out.ctl = ctl;
    return out;
  } catch (e) {
    return { ...rec, ctl: { error: String((e && e.message) || e), labels: [] } };
  }
}
