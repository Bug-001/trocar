// body.mjs — turn a response's decoded bytes into a recordable shape (RFC 4.6 §记录). SSE is kept
// VERBATIM (the full decoded text in `raw`, so event: / id: / comment lines survive — invariant 2)
// alongside the Anthropic reconstruction; JSON is parsed; other text is UTF-8 or raw_b64. Decoding
// failures and truncation are labeled in place (invariant 4), never silently dropped.
import zlib from 'node:zlib'
import { makeSseReconstructor } from '../../../capture/sse-reconstruct.mjs'

/** Decode Content-Encoding (comma-separated codings applied right to left). {buf, decoded, error?}. */
export function decodeContent(buf, encoding) {
  const codings = String(encoding || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  let cur = buf
  for (let i = codings.length - 1; i >= 0; i--) {
    const c = codings[i]
    try {
      if (c === 'br') cur = zlib.brotliDecompressSync(cur)
      else if (c === 'gzip' || c === 'x-gzip') cur = zlib.gunzipSync(cur)
      else if (c === 'deflate') cur = zlib.inflateSync(cur)
      else if (c === 'zstd') {
        if (typeof zlib.zstdDecompressSync === 'function') cur = zlib.zstdDecompressSync(cur)
        else return { buf, decoded: false, error: 'zstd unsupported' }
      } else if (c === 'identity') { /* no-op */ } else return { buf, decoded: false, error: `unknown encoding: ${c}` }
    } catch (e) {
      return { buf, decoded: false, error: String((e && e.message) || e) }
    }
  }
  return { buf: cur, decoded: true }
}

function tryUtf8(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return null }
}

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
      resp.raw = dec.buf.toString('utf8')    // the exact decoded SSE text, verbatim
    } else {
      const utf = tryUtf8(dec.buf)
      if (ctype.includes('json')) {
        try { resp.body = JSON.parse(utf !== null ? utf : dec.buf.toString('utf8')); resp.kind = 'json' }
        catch { resp.kind = 'text'; if (utf !== null) resp.raw = utf; else resp.raw_b64 = dec.buf.toString('base64') }
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
