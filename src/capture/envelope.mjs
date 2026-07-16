// envelope.mjs — THE single authority for the D10 unified envelope shape (RFC 4.1). All three
// capture sources (reverse-proxy / mitm / relay-tee) emit this via buildEnvelope, so the adapter
// seam does not leak at the capture end (invariant 3). Field names are canonical (req_headers /
// req_body / resp + observ-meta) — the demo's request_headers/request/response names are renamed.
import fs from 'node:fs'
import { safeHeaders, detectAuthMode } from './redact.mjs'

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
export function isLlmCall(endpoint) {
  const e = String(endpoint || '').split('?')[0]
  if (e.includes('count_tokens')) return false
  if (e.startsWith('/v1/messages')) return true      // Anthropic Messages
  if (/(^|\/)responses$/.test(e)) return true         // OpenAI Responses (Codex) — /responses, /v1/responses, /codex/responses
  if (/(^|\/)chat\/completions$/.test(e)) return true // OpenAI / DeepSeek Chat Completions
  return false
}

// Build the canonical D10 envelope. reqBody is the raw request Buffer as captured off the wire.
// For llm calls we store the WHOLE parsed body verbatim (system/tools/messages intact) — no
// summary counts; those are derived in the 3.1 adapter (RFC 4.1 out-of-scope). Non-llm bodies
// are stored as {raw_chars} metadata, labeled non-verbatim in place (invariant 4).
export function buildEnvelope({
  id, tsRequest, tsRespStart = null, tsRespEnd = null, durationMs = null,
  method, endpoint, reqBody, reqHeaders, resp, capture, error = false,
}) {
  const llm = isLlmCall(endpoint)
  let req_body
  if (!llm) {
    // Non-LLM / control traffic: metadata only, labeled non-verbatim (RFC 4.1:92 + invariant 4).
    req_body = { raw_chars: reqBody ? reqBody.length : 0, verbatim: false }
  } else {
    // LLM call: req_body MUST be the VERBATIM captured UTF-8 STRING, NOT a JSON.parse'd object.
    // The 3.1 adapter (parseBlocks) slices per-block byte spans out of this string for the D19
    // content_hash and AC-1 rebuild; parsing here would discard the exact wire bytes (whitespace/
    // key-order/number formatting) the cache-break forensics depend on. Structure is derived
    // downstream in the adapter (RFC 4.1 out-of-scope), not at capture.
    req_body = reqBody ? reqBody.toString('utf8') : ''
  }
  return {
    // core
    ts: tsRequest, endpoint, method,
    req_headers: safeHeaders(reqHeaders),
    req_body, resp,
    // observ-meta
    id, ts_request: tsRequest, ts_response_start: tsRespStart,
    ts_response_end: tsRespEnd == null ? isoStamp() : tsRespEnd,
    duration_ms: durationMs, is_llm_call: llm, capture,
    auth_mode: detectAuthMode(reqHeaders),
    ...(error ? { error: true } : {}),
  }
}

// Append-only writer for ONE flat envelope stream — no per-session split (D20; per-session
// grouping/lineage is 4.2 ETL). SYNCHRONOUS durable append: each envelope is fsync-visible on
// disk the instant write() returns (an open fd + writeSync, not a buffered WriteStream), so a
// crash never loses a captured turn (invariant 2: raw NDJSON is the source of truth). Frequency
// is one write per completed LLM call, so the blocking cost is negligible.
export function createEnvelopeWriter(filePath) {
  const fd = fs.openSync(filePath, 'a')
  let open = true
  return {
    write(env) { fs.writeSync(fd, JSON.stringify(env) + '\n') },
    close() { if (open) { open = false; fs.closeSync(fd) } },
  }
}
