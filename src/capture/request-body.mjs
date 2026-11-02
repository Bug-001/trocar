// request-body.mjs — what a request body becomes in an envelope: ONE rule for every call, LLM or not (RFC 4.1
// §统一原始信封 `req_body`, D40; before D40 only an LLM call kept its body and every other call kept {raw_chars}).
// buildEnvelope (envelope.mjs) is the only caller, so the reverse proxy, the MITM and the collector cannot drift.
//
//   no body                              req_body ''
//   valid UTF-8, not compressed          req_body = the wire text, NOT parsed (the adapter slices byte spans out of it)
//   not UTF-8, not compressed            req_body null + req_body_b64 (the wire bytes), no req_content_encoding: that
//                                        field is what tells this apart from a compressed body
//   compressed (Content-Encoding)        req_body_b64 (the wire bytes) + req_content_encoding (the header as sent);
//                                        req_body = the decoded text when it decodes (gzip / deflate / br)
//   zstd, or a body that does not decode req_body null + req_encoding_error. zstd is never decoded at capture: the reader
//                                        does it, so a capture does not depend on the Node that recorded it
//   cut at the cap / never finished      NOT decoded, no req_encoding_error (that field means "the bytes are complete, only
//                                        not decoded"): the stored prefix is req_body when it is whole UTF-8 text, else
//                                        req_body null + req_body_b64; req_truncated / req_partial say why (invariant 4)
// Imports node built-ins and the reader's decode limits only.
import zlib from 'node:zlib'

// The two decode limits are the reader's (src/dissect/request-body.mjs owns them): a body that decompresses past
// MAX_DECODED_BYTES is not expanded (a decompression bomb, or an upload that is not text); a call that is not inference is
// decoded only up to NON_INFERENCE_MAX_DECODED_BYTES (D40: any host of any agent can send a compressed body; 204 KB of gzip once
// became a 200 MiB req_body and pushed the NDJSON line past V8's string limit). Over a limit the wire bytes are kept
// (req_body_b64) and the call says so (req_encoding_error), the way a body that does not decode does.
import { MAX_DECODED_BYTES, NON_INFERENCE_MAX_DECODED_BYTES } from '../dissect/request-body.mjs'
// The most of one body (either direction) an envelope stores — the collector's engine, its WebSocket frames and both old
// capture paths. What is past it is counted (body_wire_bytes) but not kept, and the envelope says so (req_truncated /
// resp.truncated).
export const MAX_BODY_BYTES = 64 << 20
// A RESPONSE is decoded under the same two-limit rule (review 2026-10-07: a 713 KB gzip reply that expands to 700 MiB left no envelope
// at all, and the wire cap alone bounds nothing: 64 MiB of gzip can be 64 GiB). A call that is not inference is decoded up to 1 MiB;
// inference up to MAX_BODY_BYTES, the cap on one stored body — "inference" is told by path, so any host can claim it. Over the limit
// the wire bytes are kept (raw_b64) and the reply says so (encoding_error).
export const responseDecodeLimit = (llm) => (llm ? MAX_BODY_BYTES : NON_INFERENCE_MAX_DECODED_BYTES)
/**
 * A JSON reply as an envelope stores it (RFC 4.1 保真边界 ⑤, D40 audit): `body` = the parsed value, which is what readers use, and `raw` = the
 * wire text whenever writing `body` back out would not give that text — whitespace, a trailing newline, the order of integer-like keys, a number
 * past 2^53 (12345678901234567890 parses to 12345678901234567000), a duplicated key (the last wins), \uXXXX escapes, a BOM. A reply that
 * re-serializes to itself stores no `raw`: nothing is lost and nothing is stored twice. `text` MUST already be valid UTF-8 (a BOM is not JSON:
 * it is skipped for the parse only). → {body, raw?} | null when it does not parse. Shared by both capture paths, so they cannot drift.
 */
export function parseJsonReply(text) {
  let body
  try { body = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) } catch { return null }
  return JSON.stringify(body) === text ? { body } : { body, raw: text }
}
/** True when decodeContent stopped because the output passed its maxBytes (zlib's ERR_BUFFER_TOO_LARGE), not because the bytes are bad. */
export const decodedOverLimit = (dec) => !!dec && !dec.decoded && (dec.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|output length/i.test(dec.error || ''))

const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) // a BOM stays: bytes, not text
/** The text of `buf` when it is valid UTF-8, else null. Never a lossy decode. */
export function utf8Strict(buf) { try { return STRICT.decode(buf) } catch { return null } }

/** Decode Content-Encoding (comma-separated codings applied right to left). → {buf, decoded, error?}. */
export function decodeContent(buf, encoding, { maxBytes } = {}) {
  const codings = String(encoding || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const o = maxBytes ? { maxOutputLength: maxBytes } : undefined
  let cur = buf
  for (let i = codings.length - 1; i >= 0; i--) {
    const c = codings[i]
    try {
      if (c === 'br') cur = zlib.brotliDecompressSync(cur, o)
      else if (c === 'gzip' || c === 'x-gzip') cur = zlib.gunzipSync(cur, o)
      else if (c === 'deflate') cur = zlib.inflateSync(cur, o)
      else if (c === 'zstd') {
        if (typeof zlib.zstdDecompressSync === 'function') cur = zlib.zstdDecompressSync(cur, o)
        else return { buf, decoded: false, error: 'zstd unsupported' }
      } else if (c === 'identity') { /* no-op */ } else return { buf, decoded: false, error: `unknown encoding: ${c}` }
    } catch (e) {
      return { buf, decoded: false, error: String((e && e.message) || e), ...(e && typeof e.code === 'string' ? { code: e.code } : {}) }
    }
  }
  return { buf: cur, decoded: true }
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (headers[name] !== undefined) return headers[name]
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k]
  return undefined
}

/**
 * shapeRequestBody({headers, body, incomplete, llm}) → {req_body, extra}
 *   headers    the request headers as an object (any case)
 *   llm        the call is inference (default): a compressed body is decoded up to MAX_DECODED_BYTES, else up to NON_INFERENCE_MAX_DECODED_BYTES
 *   body       the captured Buffer: the whole body, or — when `incomplete` — the prefix that was kept
 *   incomplete the body was cut at the cap or never finished
 * `extra` holds the fields that follow req_body, in their order: req_body_b64, req_content_encoding, req_encoding_error.
 */
export function shapeRequestBody({ headers, body, incomplete = false, llm = true }) {
  if (!body || !body.length) return { req_body: '', extra: {} }
  const enc = headerOf(headers, 'content-encoding')
  const codings = String(enc == null ? '' : Array.isArray(enc) ? enc.join(',') : enc).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
  if (codings.every((c) => c === 'identity')) {
    const text = utf8Strict(body)
    return text !== null ? { req_body: text, extra: {} } : { req_body: null, extra: { req_body_b64: body.toString('base64') } }
  }
  const wire = { req_body_b64: body.toString('base64'), req_content_encoding: Array.isArray(enc) ? enc.join(', ') : enc }
  if (incomplete) return { req_body: null, extra: wire }
  if (codings.includes('zstd')) return { req_body: null, extra: { ...wire, req_encoding_error: 'zstd request body not decoded at capture; decode req_body_b64' } }
  const maxBytes = llm ? MAX_DECODED_BYTES : NON_INFERENCE_MAX_DECODED_BYTES
  const dec = decodeContent(body, wire.req_content_encoding, { maxBytes })
  if (!dec.decoded) {
    const over = decodedOverLimit(dec)
    return { req_body: null, extra: { ...wire, req_encoding_error: over ? `decoded body over the ${maxBytes}-byte capture limit${llm ? '' : ' for a call that is not inference'}; the wire bytes are in req_body_b64` : dec.error } }
  }
  const text = utf8Strict(dec.buf)
  if (text === null) return { req_body: null, extra: { ...wire, req_encoding_error: 'decoded body is not UTF-8' } }
  return { req_body: text, extra: wire }
}
