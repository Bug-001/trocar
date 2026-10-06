// response-tee.mjs — the old capture's response side, shared by the MITM and the reverse proxy (RFC 4.1; D38 L-2,
// L-3, L-4): the upstream response goes to the client byte for byte, and `resp` is built on a side copy. Every way
// the copy can go wrong is said, never dropped:
//   - the upstream closes before the response is complete (L-2): the client's response is ended too (destroyed, so
//     it is not left hanging nor taken for complete), and the envelope is `error:true` with what arrived under
//     `resp.partial`, plus an `upstream-aborted` event;
//   - a compressed SSE stream that cannot be decompressed (L-3): `resp.encoding_error` + the wire bytes in `raw_b64`,
//     plus a `decode-failed` event (before, the envelope never came: the decoder's 'end' never fired);
//   - a body that is not JSON (a proxy's HTML error page) or cannot be decompressed (L-4): its bytes are kept —
//     `raw` (UTF-8 text) or `raw_b64` (+ `encoding_error`), as the collector does (core/record/body.mjs) — instead
//     of being replaced by a character count; one that cannot be decompressed is a `decode-failed` event too.
//   - D40 (RFC 4.1 §统一原始信封 `resp`): a non-LLM SSE response also keeps its decoded text in `raw` (the reconstructor is
//     Anthropic-shaped and rebuilds nothing from another stream); every body is stored up to `maxBodyBytes` (64 MiB, the
//     collector's cap) — past it only the prefix is kept, `truncated` + `body_bytes` say so, and the full wire length is
//     counted anyway (done()'s third argument, body_wire_bytes); at the `log` level no body is kept, only counted.
import zlib from 'node:zlib'
import { makeSseReconstructor } from './sse-reconstruct.mjs'
import { failureOf } from './events.mjs'
import { logResponse, MAX_BODY_BYTES } from './envelope.mjs'
import { utf8Strict } from './request-body.mjs'

export { MAX_BODY_BYTES }
const utf8 = (buf) => utf8Strict(buf)
// {buf} decoded per content-encoding, or {buf (the wire bytes), error}
export function decodeBodyChecked(buf, enc = '') {
  try {
    if (enc.includes('br')) return { buf: zlib.brotliDecompressSync(buf) }
    if (enc.includes('gzip')) return { buf: zlib.gunzipSync(buf) }
    if (enc.includes('deflate')) return { buf: zlib.inflateSync(buf) }
  } catch (e) { return { buf, error: String((e && e.message) || e), ...(e && typeof e.code === 'string' ? { code: e.code } : {}) } }
  return { buf }
}
// onDecodeError({error, code}) is told when the body cannot be decompressed (the caller writes the event line, L-4)
export function bodyResp(status, wire, enc, onDecodeError = null) {
  if (!wire.length) return { status, kind: 'empty' }
  const dec = decodeBodyChecked(wire, enc)
  if (dec.error) { if (onDecodeError) onDecodeError(dec); return { status, kind: 'text', encoding_error: dec.error, raw_b64: wire.toString('base64') } }
  try { return { status, kind: 'json', body: JSON.parse(dec.buf.toString('utf8')) } } catch { /* not JSON: keep its bytes */ }
  const t = utf8(dec.buf)
  return t !== null ? { status, kind: 'text', raw: t } : { status, kind: 'text', raw_b64: dec.buf.toString('base64') }
}

// done(resp, aborted, wireBytes) is called exactly once; onEvent(rec) gets the failure records.
//   level      'full' | 'log' — the retention level of this call (log: nothing is buffered, the bytes are only counted)
//   rawSse     keep the decoded SSE text in `resp.raw` (set for a non-LLM stream: the reconstructor would rebuild nothing)
//   maxBodyBytes  the storage cap per body; what is past it is counted, not kept
export function teeResponse(up, res, { keepRawSse = false, rawSse = false, level = 'full', maxBodyBytes = MAX_BODY_BYTES, where, onEvent = () => {} }, done) {
  res.writeHead(up.statusCode || 502, up.headers)
  const logged = level === 'log'
  const isSse = String(up.headers['content-type'] || '').includes('text/event-stream')
  const enc = String(up.headers['content-encoding'] || '').toLowerCase()
  const recon = isSse && !logged ? makeSseReconstructor(keepRawSse) : null
  const wire = [] // non-SSE: the body; compressed SSE: the wire bytes, for an encoding_error — both only up to the cap
  const rawParts = [] // a non-LLM SSE stream's decoded text, up to the cap
  let wireBytes = 0, kept = 0, rawBytes = 0, decoder = null, decodeError = null, finished = false
  const cut = { wire: false, raw: false } // which stored copy hit the cap
  const keep = (list, chunk, held, which) => { // append up to the cap; the first byte past it marks that copy cut
    const room = maxBodyBytes - held
    if (room <= 0) { cut[which] = true; return held }
    if (chunk.length > room) { list.push(chunk.subarray(0, room)); cut[which] = true; return held + room }
    list.push(chunk); return held + chunk.length
  }
  const feedSse = (d) => { recon.push(d); if (rawSse) rawBytes = keep(rawParts, d, rawBytes, 'raw') }
  if (isSse && enc && !logged) {
    if (enc.includes('br')) decoder = zlib.createBrotliDecompress()
    else if (enc.includes('gzip')) decoder = zlib.createGunzip()
    else if (enc.includes('deflate')) decoder = zlib.createInflate()
    if (decoder) {
      decoder.on('data', feedSse)
      decoder.on('error', (e) => { decodeError = e; onEvent(failureOf(where, e, 'decode-failed', { reason: `the SSE response (content-encoding ${enc}) could not be decompressed: ${e.message}; its wire bytes are kept (raw_b64)` })) })
    }
  }
  const finish = (aborted) => {
    if (finished) return
    finished = true
    const requestId = up.headers['request-id'] || up.headers['x-request-id'] || null
    let resp
    if (logged) {
      resp = logResponse({ status: up.statusCode, headers: up.headers, wireBytes, requestId })
    } else if (isSse) {
      resp = { status: up.statusCode, kind: 'sse', ...recon.finish() }
      if (rawSse && !decodeError) { const b = Buffer.concat(rawParts); const t = utf8(b); if (t !== null) resp.raw = t; else resp.raw_b64 = b.toString('base64') }
      if (decodeError) { resp.encoding_error = String(decodeError.message); resp.raw_b64 = Buffer.concat(wire).toString('base64') }
    } else {
      // a body that cannot be decompressed is a decode-failed line too, like the SSE one (4.1: 响应解压失败 MUST 各留一行);
      // a body cut at the cap cannot be decompressed because it was cut: labelled truncated, not a decode failure
      resp = bodyResp(up.statusCode, Buffer.concat(wire), enc, cut.wire ? null : (dec) => onEvent(failureOf(where, { code: dec.code, message: dec.error }, 'decode-failed', { reason: `the response body (content-encoding ${enc}) could not be decompressed: ${dec.error}; its wire bytes are kept (raw_b64)` })))
    }
    if (!logged) {
      resp.request_id = requestId
      if (isSse ? rawSse && cut.raw : cut.wire) { resp.truncated = true; resp.body_bytes = isSse ? rawBytes : kept }
    }
    if (!aborted) return done(resp, false, wireBytes)
    done({ status: up.statusCode, kind: 'error', error: { type: 'upstream_aborted', message: 'the upstream closed the response before it was complete' }, partial: resp }, true, wireBytes)
  }
  up.on('data', (chunk) => {
    res.write(chunk)
    wireBytes += chunk.length
    if (logged) return
    if (!isSse) kept = keep(wire, chunk, kept, 'wire')
    else if (decoder) { kept = keep(wire, chunk, kept, 'wire'); if (!decodeError) decoder.write(chunk) } else feedSse(chunk)
  })
  up.on('end', () => {
    res.end()
    if (decoder && !decodeError) { decoder.once('end', () => finish(false)); decoder.once('error', () => finish(false)); decoder.end() } else finish(false)
  })
  up.on('close', () => {
    if (up.complete || finished) return
    onEvent({ event: 'failure', where, code: 'upstream-aborted', reason: `the upstream closed the response (status ${up.statusCode}) before it was complete; the client's response was ended too and an error:true envelope keeps what arrived` })
    res.destroy()
    finish(true)
  })
}
