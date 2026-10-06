// body.mjs — turn a response's decoded bytes into a recordable shape (RFC 4.6 §记录). SSE is kept
// VERBATIM (the full decoded text in `raw`, so event: / id: / comment lines survive — invariant 2)
// alongside the Anthropic reconstruction; JSON is parsed; other text is UTF-8 or raw_b64. Decoding
// failures and truncation are labeled in place (invariant 4), never silently dropped.
import { makeSseReconstructor } from '../../../capture/sse-reconstruct.mjs'
import { decodeContent, utf8Strict } from '../../../capture/request-body.mjs'

// decodeContent moved to src/capture/request-body.mjs when the request-body rule became one rule for every call (D40);
// re-exported here because the response side below still uses it.
export { decodeContent }

// The text of `buf` when it is valid UTF-8, else null — a BOM stays (ignoreBOM: it is bytes, not text) and an invalid byte is never
// replaced with U+FFFD: either would make `raw` something other than the wire (invariant 2). The old capture reads the same way.
const tryUtf8 = utf8Strict

/**
 * shapeResponse({status, headers:[[k,v]], body:Buffer, truncated}) → resp with a lowercased header
 * object, a `kind` of sse|json|text|empty, and the shaped payload. `truncated` adds truncated:true +
 * body_bytes; a decoding failure adds encoding_error and keeps the raw bytes in raw_b64.
 */
export function shapeResponse({ status, headers = [], body, truncated = false }) {
  const hobj = {}
  for (const [k, v] of headers) hobj[k.toLowerCase()] = v
  const resp = { status, headers: hobj }
  const ctype = String(hobj['content-type'] || '').toLowerCase()
  const cenc = hobj['content-encoding'] || ''

  if (!body || body.length === 0) {
    resp.kind = 'empty'
  } else {
    const dec = decodeContent(body, cenc)
    if (!dec.decoded) {
      resp.kind = ctype.includes('text/event-stream') ? 'sse' : ctype.includes('json') ? 'json' : 'text'
      resp.encoding_error = dec.error
      resp.raw_b64 = body.toString('base64')
    } else if (ctype.includes('text/event-stream')) {
      resp.kind = 'sse'
      const recon = makeSseReconstructor(true)
      recon.push(Buffer.from(dec.buf))
      Object.assign(resp, recon.finish())   // text, raw_sse, usage, content_blocks, tool_calls, …
      // the exact decoded SSE text, verbatim; a stream that is not valid UTF-8 keeps its bytes (raw_b64), never a lossy text
      const t = tryUtf8(dec.buf)
      if (t !== null) resp.raw = t; else resp.raw_b64 = dec.buf.toString('base64')
    } else {
      const utf = tryUtf8(dec.buf)
      if (ctype.includes('json') && utf !== null) {
        // JSON is read only from valid UTF-8: bytes that are not would parse with U+FFFD in place of them (a lossy body)
        // (a leading BOM is not JSON: it is skipped for the parse only — a JSON reply is stored parsed, never as its wire bytes, 4.1 保真边界 ⑤)
        try { resp.body = JSON.parse(utf.charCodeAt(0) === 0xfeff ? utf.slice(1) : utf); resp.kind = 'json' }
        catch { resp.kind = 'text'; resp.raw = utf }
      } else if (utf !== null) {
        resp.kind = 'text'; resp.raw = utf
      } else {
        resp.kind = 'text'; resp.raw_b64 = dec.buf.toString('base64')
      }
    }
  }
  if (truncated) { resp.truncated = true; resp.body_bytes = body ? body.length : 0 }
  return resp
}
