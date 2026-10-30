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
//   ctl.labels           what to say in place (4.1 保真边界, via captureLabelsOf): stored as length only · logged only · cut at the cap · not decoded …
//   ctl.host / hostHeader / hostDiffers   the host the bytes went to (SNI …) and the request's own Host header — a mismatch is a behaviour signal
//                        (not for a reverse-proxy record: there `host` is the upstream and the Host header is the client's address to the proxy, always different)
//   ctl.req / ctl.resp .truncated / .incomplete / .stored_bytes   a body cut at the capture cap, or a request that never finished: the stored bytes are only part of it
// A small JSON reply stays in `resp.body` (the feature-flag ledger reads it there); a body over the cap leaves `resp.body` and is in ctl.resp.text.
// BOUNDED (review 2026-10-07): the page lists the newest CONTROL_DETAIL_RECORDS of a class and opens only those, so only those travel with their
// bodies. Every older record goes SLIM (`detail:false`): the same raw fields minus every body (req_body, req_body_b64, ws_raw, req_extra_messages,
// resp.raw / raw_b64 / messages, a resp.body over BODY_SHOW_CHARS), `ctl` without req / resp, and `ctl.omitted` naming what was left behind (it is
// intact in the source record). A small `resp.body` stays: the feature-flag ledger reads it over all of a class. 20,000 records of 3 KB bodies were
// a 91 MiB answer for one class; at ~100k V8's string limit made it a 500 and the page an empty view.
// Envelope fields only — no provider knowledge, no host or endpoint literal (invariant 3). Pure over the record.
import { captureLabelsOf, bodyRetentionOf, reqIncompleteOf, isLogOnly } from '../dissect/capture-labels.mjs';
import { requestEncodingOf } from '../dissect/request-body.mjs';
import { trafficClassOf } from '../dissect/traffic.mjs';
import { headerOf } from '../dissect/harnesses.mjs';
import { isSecretHeader } from '../capture/redact.mjs';

export const BODY_SHOW_CHARS = 1 << 20; // the most of one body's text a record carries to the browser
const HEX_SHOW_BYTES = 4096;     // the most of a binary body shown as hex
export const CONTROL_DETAIL_RECORDS = 80; // how many of a class's newest records /api/control sends with their bodies (the page lists and opens 80)

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const b64Bytes = (s) => { const n = s.length; return Math.max(0, Math.floor((n * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0)); };

// 16 bytes a line: offset, hex, printable ASCII
function hexDump(buf) {
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

// the bytes of the request body that are in the record (a stored prefix when the call was cut or never finished)
const storedReqBytes = (rec) => (typeof rec.req_body === 'string' ? Buffer.byteLength(rec.req_body) : typeof rec.req_body_b64 === 'string' ? b64Bytes(rec.req_body_b64) : null);
function reqView(rec) {
  const v = reqBodyView(rec);
  const inc = reqIncompleteOf(rec); // req_truncated (cut at the cap) / req_partial (never finished): what is stored is not the request (invariant 4)
  return inc ? { ...v, incomplete: true, truncated: inc.truncated, ...(inc.partial ? { partial: inc.partial } : {}), stored_bytes: inc.storedBytes ?? storedReqBytes(rec) } : v;
}
function reqBodyView(rec) {
  const wire = finite(rec.body_wire_bytes && rec.body_wire_bytes.req);
  const b = rec.req_body;
  if (typeof b === 'string') {
    if (b === '') return { kind: 'empty', bytes: wire ?? 0 };
    const v = textBody('text', b, wire ?? (b.length > 64 * 1024 * 1024 ? null : Buffer.byteLength(b)));
    const enc = requestEncodingOf(rec);
    return enc ? { ...v, decoded_from: enc } : v; // a compressed request shown decoded says so (4.6 §记录)
  }
  if (b && typeof b === 'object' && b.verbatim === false) {
    const n = finite(b.raw_chars) ?? wire;
    if (n === 0 && !isLogOnly(rec)) return { kind: 'empty', bytes: 0 }; // a pre-D40 GET kept `raw_chars: 0`: there was no body, nothing was lost
    return { kind: 'length-only', bytes: n };
  }
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
  // a body cut at the capture cap (resp.truncated + body_bytes): `bytes` is the whole reply on the wire, the text only its stored prefix
  const cut = (part, v) => (part.truncated === true ? { ...v, truncated: true, stored_bytes: finite(part.body_bytes) } : v);
  const bodyOf = (part) => {
    if (part.kind === 'ws' && Array.isArray(part.messages)) return textBody('ws', part.messages.map(messageText).join('\n'), wire ?? undefined);
    if (typeof part.raw === 'string') return cut(part, textBody(part.kind === 'sse' ? 'sse' : 'text', part.raw, wire ?? undefined));
    if (typeof part.raw_b64 === 'string') return part.encoding_error ? { kind: 'undecoded', encoding: part.encoding_error, bytes: wire ?? b64Bytes(part.raw_b64), ...base } : cut(part, { kind: 'binary', bytes: wire ?? b64Bytes(part.raw_b64), hex: hexOfB64(part.raw_b64) });
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

const jsonLen = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
// a response with the bodies left behind: raw / raw_b64 always (they are in ctl.resp when shown), body / messages when shown or too big or slim
function slimResp(r, { detail, shown, omitted, prefix }) {
  const { raw, raw_b64, ...out } = r;
  if (!detail) { if (raw !== undefined) omitted.push(`${prefix}raw`); if (raw_b64 !== undefined) omitted.push(`${prefix}raw_b64`); }
  if (shown) { delete out.body; delete out.messages; } // shown in ctl.resp instead
  else if (!detail) {
    if (out.messages !== undefined) { delete out.messages; omitted.push(`${prefix}messages`); }
    if (out.body !== undefined && jsonLen(out.body) > BODY_SHOW_CHARS) { delete out.body; omitted.push(`${prefix}body`); }
  }
  return out;
}

// A credential-class header's value (isSecretHeader, the one server rule) never leaves in a query document (2.6 §保真边界 2, 4.1 §凭据处置):
// blanked in the header objects and the raw heads, the names in ctl.masked; `reveal` (one lowercased name) keeps that one. The stored bytes stay
// verbatim. The old capture placeholder '<redacted>' is no credential and stays as stored. Never throws: every field is type-checked.
// A raw head line keeps its name, the whitespace around the colon and its line ending; an obs-fold continuation (leading SP/HTAB)
// of a blanked header keeps only its leading whitespace and line ending, so it never becomes the empty line that ends the head.
const HEAD_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)([ \t]*):([ \t]*)([^\r\n]*)(\r?\n?)$/;
const FOLD_LINE = /^([ \t]+)[^\r\n]*?(\r?\n?)$/;
function maskCredentials(rec, reveal) {
  const masked = new Set();
  const hit = (k) => { const n = String(k).trim().toLowerCase(); return isSecretHeader(n) && n !== reveal ? n : null; };
  const headers = (h) => {
    if (!h || typeof h !== 'object' || Array.isArray(h)) return h;
    let out = h;
    for (const [k, v] of Object.entries(h)) {
      const n = hit(k);
      if (!n || v === '<redacted>') continue;
      if (out === h) out = { ...h };
      out[k] = Array.isArray(v) ? v.map(() => '') : '';
      masked.add(n);
    }
    return out;
  };
  const rawHead = (s) => {
    if (typeof s !== 'string') return s;
    let folding = false;
    return s.split(/(?<=\n)/).map((line) => {
      const f = folding && FOLD_LINE.exec(line);
      if (f) return f[1] + f[2];
      const m = HEAD_LINE.exec(line), n = m && hit(m[1]);
      folding = !!n;
      if (!n) return line;
      masked.add(n);
      return `${m[1]}${m[2]}:${m[3]}${m[5]}`;
    }).join('');
  };
  const resp = (r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r, headers: headers(r.headers) };
    if (r.headers === undefined) delete out.headers;
    if (r.partial && typeof r.partial === 'object' && r.partial.headers !== undefined) out.partial = { ...r.partial, headers: headers(r.partial.headers) };
    return out;
  };
  if (!rec || typeof rec !== 'object') return { rec, masked: [] };
  const out = { ...rec };
  for (const k of ['req_headers', 'request_headers']) if (out[k] !== undefined) out[k] = headers(out[k]);
  for (const k of ['resp', 'response']) if (out[k] !== undefined) out[k] = resp(out[k]);
  for (const k of ['req_head_raw', 'resp_head_raw']) if (out[k] !== undefined) out[k] = rawHead(out[k]);
  return { rec: out, masked: [...masked].sort() };
}

/**
 * controlRecordWire(rec, {detail}) → the record as /api/control ships it: the raw fields the list and the flag ledger read, the heavy ones left behind,
 * and `ctl`. `detail:false` is the slim form (see the header). Never throws: a record this cannot read is returned as it is with `ctl.error`, so one
 * odd record cannot blank the panel. Credential-class header values are blanked first (maskCredentials), in both branches; `reveal`
 * names the one to keep, and `ctl.masked` lists the names blanked.
 */
export function controlRecordWire(input, { detail = true, reveal = null } = {}) {
  const { rec, masked } = maskCredentials(input, typeof reveal === 'string' ? reveal.trim().toLowerCase() : null);
  const mask = masked.length ? { masked } : {};
  try {
    const hostHeader = headerOf(rec, 'host');
    const norm = (h) => (h ? String(h).toLowerCase().replace(/:\d+$/, '') : null);
    const labels = captureLabelsOf(rec);
    const inc = reqIncompleteOf(rec); // the request-body labels live in reqIncompleteOf (capture-labels.mjs), not in captureLabelsOf
    if (inc) labels.push({ id: 'req-incomplete', label: inc.truncated ? 'Request cut at the capture cap' : 'Request never finished', text: inc.text });
    const ctl = {
      retention: bodyRetentionOf(rec), traffic_class: trafficClassOf(rec), labels,
      host: typeof rec.host === 'string' ? rec.host : null, hostHeader,
      // a reverse-proxy record's `host` is the upstream and its Host header the client's address to the proxy: they differ by construction (4.1), not as a signal
      hostDiffers: !!(rec.capture !== 'reverse-proxy' && typeof rec.host === 'string' && hostHeader && norm(rec.host) !== norm(hostHeader)),
      wire_bytes: rec.body_wire_bytes && typeof rec.body_wire_bytes === 'object' ? { req: finite(rec.body_wire_bytes.req), resp: finite(rec.body_wire_bytes.resp) } : null,
      ...(detail ? { req: reqView(rec), resp: respView(rec) } : { detail: false }),
    };
    const { req_body, req_body_b64, ws_raw, req_extra_messages, ...rest } = rec;
    const omitted = [];
    if (!detail) { if (req_body !== undefined) omitted.push('req_body'); if (req_body_b64 !== undefined) omitted.push('req_body_b64'); }
    if (ws_raw !== undefined) omitted.push('ws_raw');
    if (req_extra_messages !== undefined) omitted.push('req_extra_messages'); // a WebSocket call's later client messages: bodies too
    const r = rec.resp || rec.response;
    const out = { ...rest };
    if (r && typeof r === 'object') {
      const shown = detail && (ctl.resp.text !== undefined || ctl.resp.hex !== undefined || ctl.resp.kind === 'ws');
      const slim = slimResp(r, { detail, shown, omitted, prefix: 'resp.' });
      if (slim.partial && typeof slim.partial === 'object') slim.partial = (({ raw: _a, raw_b64: _b, body: _c, messages: _d, ...p }) => p)(slim.partial);
      out[rec.resp ? 'resp' : 'response'] = slim;
    }
    if (omitted.length) ctl.omitted = omitted;
    Object.assign(ctl, mask);
    out.ctl = ctl;
    return out;
  } catch (e) {
    return { ...rec, ctl: { error: String((e && e.message) || e), labels: [], ...mask } };
  }
}
