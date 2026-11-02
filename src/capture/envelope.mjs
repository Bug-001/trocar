// envelope.mjs — THE single authority for the D10 unified envelope shape (RFC 4.1). All three
// capture sources (reverse-proxy / mitm / relay-tee) emit this via buildEnvelope, so the adapter
// seam does not leak at the capture end (invariant 3). Field names are canonical (req_headers /
// req_body / resp + observ-meta) — the demo's request_headers/request/response names are renamed.
import { detectAuthMode } from './redact.mjs'
import { shapeRequestBody } from './request-body.mjs'
import { isLlmCall, endpointClass } from '../dissect/endpoints.mjs'

function isoStamp(d = new Date()) { return d.toISOString() }

// is_llm_call and the endpoint-told class (`llm` / `token-count`) come from ONE table, src/dissect/endpoints.mjs (RFC 4.1:34),
// which the class table and the read side read too. Every other class comes from the class table (src/classes/table.mjs) —
// capture code names no harness and holds no host pattern (D20, 0.1 §5).
// The two retention levels (RFC 4.6 §记录「保存级别」, D40).
export const RETENTION_LEVELS = Object.freeze(['full', 'log'])

// What a response keeps at the `log` level (RFC 4.1 D40 行): the metadata and the headers, never the body. `kind` is told
// from the content type (the body is not read), raw_chars is the wire byte count (de-chunked, before content decoding).
export function logResponse({ status, headers = {}, wireBytes = 0, requestId = null }) {
  const h = {}
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v
  const ctype = String(h['content-type'] || '').toLowerCase()
  const kind = !wireBytes ? 'empty' : ctype.includes('text/event-stream') ? 'sse' : ctype.includes('json') ? 'json' : 'text'
  return { status, kind, headers: h, request_id: requestId ?? h['request-id'] ?? h['x-request-id'] ?? null, raw_chars: wireBytes, verbatim: false }
}

// Build the canonical D10 envelope. reqBody is the raw request Buffer as captured off the wire.
// D40: EVERY call's request body follows one rule (request-body.mjs) — valid UTF-8 → the wire text, not parsed;
// not UTF-8 → null + req_body_b64; compressed → req_body_b64 + req_content_encoding (+ the decoded text when it
// decodes). For llm calls req_body MUST be the VERBATIM captured UTF-8 STRING, NOT a JSON.parse'd object: the 3.1
// adapter (parseBlocks) slices per-block byte spans out of it for the D19 content_hash and the AC-1 rebuild, and
// parsing here would discard the exact wire bytes (whitespace / key-order / number formatting) the cache-break
// forensics depend on. Structure is derived downstream in the adapter (RFC 4.1 out-of-scope), not at capture.
//   retention 'log' (the operator set this harness × class to 「只记日志」): req_body = {raw_chars, verbatim:false} and
//   body_retention:'log'; the caller builds `resp` with logResponse(). Headers and metadata stay.
//   reqWireBytes / respWireBytes: the bodies' full wire length (de-chunked, before content decoding) — counted past
//   the storage cap, so body_wire_bytes is exact where the stored body is a prefix; null resp = no response.
//   reqTruncated / reqPartial: the body is a prefix (cap) or never finished — labelled in place (invariant 4).
// D40 fields all follow the observation meta: the sharder scans from the first "req_headers":{ to "req_body".
export function buildEnvelope({
  id, tsRequest, tsRespStart = null, tsRespEnd = null, durationMs = null,
  method, endpoint, reqBody, reqHeaders, resp, capture, error = false,
  host = null, trafficClass = null, retention = 'full', reqWireBytes = null, respWireBytes = null, reqTruncated = false, reqPartial = null,
}) {
  const llm = isLlmCall(endpoint)
  const logged = retention === 'log'
  const wireReq = reqWireBytes != null ? reqWireBytes : reqBody ? reqBody.length : 0
  let req_body, extra = {}
  if (logged) req_body = { raw_chars: wireReq, verbatim: false }
  else ({ req_body, extra } = shapeRequestBody({ headers: reqHeaders, body: reqBody, incomplete: !!(reqTruncated || reqPartial), llm }))
  return {
    // core
    ts: tsRequest, endpoint, method,
    // VERBATIM, credential headers included (Authorization / x-api-key / Cookie / Proxy-Authorization are kept as sent):
    // trocar shows what really went over the wire. The record file therefore holds live credentials, so it is owner-only
    // and `trocar doctor` hard-fails if anyone else can read it (src/capture/selftest.mjs::qFilePerms). See spec 4.1 §采集安全.
    req_headers: { ...reqHeaders },
    req_body, resp,
    // observ-meta
    id, ts_request: tsRequest, ts_response_start: tsRespStart,
    ts_response_end: tsRespEnd == null ? isoStamp() : tsRespEnd,
    duration_ms: durationMs, is_llm_call: llm, capture,
    auth_mode: detectAuthMode(reqHeaders),
    ...(error ? { error: true } : {}),
    // after req_body, in this order (RFC 4.1 §统一原始信封)
    ...extra,
    ...(host != null ? { host } : {}),
    traffic_class: trafficClass || endpointClass(endpoint) || 'other',
    body_wire_bytes: { req: wireReq, resp: respWireBytes },
    ...(logged ? { body_retention: 'log' } : {}),
    ...(reqTruncated ? { req_truncated: true, req_body_bytes: reqBody ? reqBody.length : 0 } : {}),
    ...(reqPartial ? { req_partial: reqPartial } : {}),
  }
}
