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
// Leaf module: node built-ins only.
import zlib from 'node:zlib'

// A body that decompresses past this is not expanded: it is kept as wire bytes and labelled (a decompression bomb, or an
// upload that is not text). The reader has the same limit (dissect/request-body.mjs).
export const MAX_DECODED_BYTES = 256 * 1024 * 1024

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
      return { buf, decoded: false, error: String((e && e.message) || e) }
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
 * shapeRequestBody({headers, body, incomplete}) → {req_body, extra}
 *   headers    the request headers as an object (any case)
 *   body       the captured Buffer: the whole body, or — when `incomplete` — the prefix that was kept
 *   incomplete the body was cut at the cap or never finished
 * `extra` holds the fields that follow req_body, in their order: req_body_b64, req_content_encoding, req_encoding_error.
 */
export function shapeRequestBody({ headers, body, incomplete = false }) {
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
  const dec = decodeContent(body, wire.req_content_encoding, { maxBytes: MAX_DECODED_BYTES })
  if (!dec.decoded) return { req_body: null, extra: { ...wire, req_encoding_error: dec.error } }
  const text = utf8Strict(dec.buf)
  if (text === null) return { req_body: null, extra: { ...wire, req_encoding_error: 'decoded body is not UTF-8' } }
  return { req_body: text, extra: wire }
}
