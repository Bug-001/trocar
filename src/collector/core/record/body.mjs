// body.mjs — turn a response's decoded bytes into a recordable shape (RFC 4.6 §记录). SSE is kept
// VERBATIM (the full decoded text in `raw`, so event: / id: / comment lines survive — invariant 2)
// alongside the Anthropic reconstruction; JSON is parsed (and keeps its wire text in `raw` when re-serializing would change it);
// other text is UTF-8 or raw_b64. Decoding
// failures and truncation are labeled in place (invariant 4), never silently dropped.
import { makeSseReconstructor } from '../../../capture/sse-reconstruct.mjs'
import { decodeContent, utf8Strict, responseDecodeLimit, decodedOverLimit, parseJsonReply } from '../../../capture/request-body.mjs'

// decodeContent moved to src/capture/request-body.mjs when the request-body rule became one rule for every call (D40);
// re-exported here because the response side below still uses it.
export { decodeContent }

// The text of `buf` when it is valid UTF-8, else null — a BOM stays (ignoreBOM: it is bytes, not text) and an invalid byte is never
// replaced with U+FFFD: either would make `raw` something other than the wire (invariant 2). The old capture reads the same way.
const tryUtf8 = utf8Strict

/**
 * shapeResponse({status, headers:[[k,v]], body:Buffer, truncated}) → resp with a lowercased header
 * object, a `kind` of sse|json|text|empty, and the shaped payload. `truncated` adds truncated:true +
 * body_bytes; a decoding failure adds encoding_error and keeps the raw bytes in raw_b64. A body that decodes past the limit
 * (responseDecodeLimit: 1 MiB when the call is not inference, 64 MiB when it is) is not expanded: it is a decoding failure of
 * the same shape, with the reason said (a compression bomb must not cost the daemon its memory and its event loop).
 */
export function shapeResponse({ status, headers = [], body, truncated = false, llm = true }) {
  const hobj = {}
  for (const [k, v] of headers) hobj[k.toLowerCase()] = v
  const resp = { status, headers: hobj }
  const ctype = String(hobj['content-type'] || '').toLowerCase()
  const cenc = hobj['content-encoding'] || ''

  if (!body || body.length === 0) {
    resp.kind = 'empty'
  } else {
    const maxBytes = responseDecodeLimit(llm)
    const dec = decodeContent(body, cenc, { maxBytes })
    if (!dec.decoded) {
      resp.kind = ctype.includes('text/event-stream') ? 'sse' : ctype.includes('json') ? 'json' : 'text'
      resp.encoding_error = decodedOverLimit(dec) ? `decoded size over ${maxBytes} bytes${llm ? '' : ' for a call that is not inference'}; the wire bytes are in raw_b64` : dec.error
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
        // JSON is read only from valid UTF-8: bytes that are not would parse with U+FFFD in place of them (a lossy body). The parsed
        // value is what readers use; the wire text is also kept whenever it is not what the value re-serializes to (parseJsonReply,
        // 4.1 保真边界 ⑤: a big integer, a duplicated key, key order and whitespace must not change silently)
        const j = parseJsonReply(utf)
        if (j) { resp.body = j.body; resp.kind = 'json'; if (j.raw !== undefined) resp.raw = j.raw }
        else { resp.kind = 'text'; resp.raw = utf }
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
