// envelope.mjs — THE single authority for the D10 unified envelope shape (RFC 4.1). All three
// capture sources (reverse-proxy / mitm / relay-tee) emit this via buildEnvelope, so the adapter
// seam does not leak at the capture end (invariant 3). Field names are canonical (req_headers /
// req_body / resp + observ-meta) — the demo's request_headers/request/response names are renamed.
import fs from 'node:fs'
import { detectAuthMode } from './redact.mjs'
import { shapeRequestBody } from './request-body.mjs'

export function isoStamp(d = new Date()) { return d.toISOString() }

// Hop-by-hop headers a relay must manage; content-length is recomputed by the outbound client.
export const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
])

// is_llm_call = the derived "是否真推理" tag (RFC 4.1:34) — provider-agnostic: whether this endpoint
// is a real model-inference call (→ req_body stored VERBATIM), not control-plane / token-count traffic.
// Recognizes the v1 harnesses' inference endpoints: Anthropic Messages, OpenAI Responses (Codex, e.g.
// /codex/responses through the capture tee), OpenAI/DeepSeek Chat Completions. Capture stays a thin tee
// — this is endpoint recognition, NOT provider parsing (that lives in the 3.1 adapter / D25 dissector).
// Suffix-based so relay/中转站 prefixes count too (RFC 4.6 §记录: `/anthropic/v1/messages` is still
// an inference request). The endpoints are DATA — path regex sources matched on the path without its query, from the
// path's start — because the class table (src/classes/table.mjs, D60③) ships them as its `llm` / `token-count` rules
// and the two must not drift (一个外部事实只写一处). The v1 harnesses' inference endpoints: Anthropic Messages
// (count_tokens excluded by the token-count list), OpenAI Responses (Codex), OpenAI/DeepSeek Chat Completions, and
// Gemini's :generateContent / :streamGenerateContent.
export const TOKEN_COUNT_ENDPOINT_PATHS = Object.freeze(['.*count_tokens.*'])
export const LLM_ENDPOINT_PATHS = Object.freeze([
  '.*/v1/messages$',          // Anthropic Messages (incl. relay prefixes)
  '.*/responses$',            // OpenAI Responses (Codex)
  '.*/chat/completions$',     // OpenAI / DeepSeek Chat Completions
  '.*:streamGenerateContent.*', '.*:generateContent.*', // Gemini
])
const pathMatchers = (sources) => sources.map((s) => new RegExp(`^(?:${s})`))
const TOKEN_COUNT_RE = pathMatchers(TOKEN_COUNT_ENDPOINT_PATHS), LLM_RE = pathMatchers(LLM_ENDPOINT_PATHS)
export function isLlmCall(endpoint) {
  const e = String(endpoint || '').split('?')[0]
  if (TOKEN_COUNT_RE.some((re) => re.test(e))) return false
  return LLM_RE.some((re) => re.test(e))
}

// The seven traffic classes (RFC 4.6 §记录「保存级别」, D40) and the two retention levels. `llm` and `token-count` are
// told by the ENDPOINT alone (here); the rest by the read-side harness table (src/dissect/traffic.mjs), which the
// wiring injects — capture code names no harness and holds no host pattern (D20, 0.1 §5).
export const TRAFFIC_CLASSES = Object.freeze(['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other'])
export const RETENTION_LEVELS = Object.freeze(['full', 'log'])
// The most of one body (either direction) an envelope stores — the collector's engine and both old capture paths. What is
// past it is counted (body_wire_bytes) but not kept, and the envelope says so (req_truncated / resp.truncated).
export const MAX_BODY_BYTES = 64 << 20
/** 'llm' | 'token-count' | null — what the endpoint says by itself. */
export function endpointClass(endpoint) {
  if (isLlmCall(endpoint)) return 'llm'
  return TOKEN_COUNT_RE.some((re) => re.test(String(endpoint || '').split('?')[0])) ? 'token-count' : null
}

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
    // VERBATIM (2026-07-20). This used to be `safeHeaders(reqHeaders)`, which rewrote
    // Authorization / x-api-key / Cookie / Proxy-Authorization to `<redacted>`. trocar exists to show
    // what really went over the wire, and that rewrite made the capture non-verbatim at exactly the
    // layer whose thesis is byte-fidelity. The risk did not disappear, it MOVED: the file now holds
    // live credentials, so it is created 0600 and `trocar doctor` hard-fails if it is readable by
    // anyone else (src/capture/selftest.mjs::qFilePerms). See spec 4.1 §采集安全.
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

// Append-only writer for ONE flat envelope stream — no per-session split (D20; per-session
// grouping/lineage is 4.2 ETL). SYNCHRONOUS durable append: each envelope is fsync-visible on
// disk the instant write() returns (an open fd + writeSync, not a buffered WriteStream), so a
// crash never loses a captured turn (invariant 2: raw NDJSON is the source of truth). Frequency
// is one write per completed LLM call, so the blocking cost is negligible.
export function createEnvelopeWriter(filePath) {
  // 0600 — OWNER ONLY. Since 2026-07-20 the envelope stores request headers VERBATIM, so these bytes
  // contain live API credentials. The mode argument only applies when open() CREATES the file, so an
  // existing capture is chmod'd too: the real ~/.trocar files were 0644 when this landed, i.e. every
  // account on the machine could read them. `trocar doctor` ④b hard-fails on anything looser.
  const fd = fs.openSync(filePath, 'a', 0o600)
  try { fs.fchmodSync(fd, 0o600) } catch { /* best effort: some filesystems refuse chmod */ }
  let open = true
  return {
    write(env) { fs.writeSync(fd, JSON.stringify(env) + '\n') },
    close() { if (open) { open = false; fs.closeSync(fd) } },
  }
}
