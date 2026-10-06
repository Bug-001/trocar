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
//     of being replaced by a character count.
import zlib from 'node:zlib'
import { makeSseReconstructor } from './sse-reconstruct.mjs'
import { failureOf } from './events.mjs'

const utf8 = (buf) => { const s = buf.toString('utf8'); return Buffer.from(s, 'utf8').equals(buf) ? s : null }
// {buf} decoded per content-encoding, or {buf (the wire bytes), error}
export function decodeBodyChecked(buf, enc = '') {
  try {
    if (enc.includes('br')) return { buf: zlib.brotliDecompressSync(buf) }
    if (enc.includes('gzip')) return { buf: zlib.gunzipSync(buf) }
    if (enc.includes('deflate')) return { buf: zlib.inflateSync(buf) }
  } catch (e) { return { buf, error: String((e && e.message) || e) } }
  return { buf }
}
export function bodyResp(status, wire, enc) {
  if (!wire.length) return { status, kind: 'empty' }
  const dec = decodeBodyChecked(wire, enc)
  if (dec.error) return { status, kind: 'text', encoding_error: dec.error, raw_b64: wire.toString('base64') }
  try { return { status, kind: 'json', body: JSON.parse(dec.buf.toString('utf8')) } } catch { /* not JSON: keep its bytes */ }
  const t = utf8(dec.buf)
  return t !== null ? { status, kind: 'text', raw: t } : { status, kind: 'text', raw_b64: dec.buf.toString('base64') }
}

// done(resp, aborted) is called exactly once; onEvent(rec) gets the failure records.
export function teeResponse(up, res, { keepRawSse = false, where, onEvent = () => {} }, done) {
  res.writeHead(up.statusCode || 502, up.headers)
  const isSse = String(up.headers['content-type'] || '').includes('text/event-stream')
  const enc = String(up.headers['content-encoding'] || '').toLowerCase()
  const recon = isSse ? makeSseReconstructor(keepRawSse) : null
  const wire = [] // non-SSE: the body; compressed SSE: the wire bytes, for an encoding_error
  let decoder = null, decodeError = null, finished = false
  if (isSse && enc) {
    if (enc.includes('br')) decoder = zlib.createBrotliDecompress()
    else if (enc.includes('gzip')) decoder = zlib.createGunzip()
    else if (enc.includes('deflate')) decoder = zlib.createInflate()
    if (decoder) {
      decoder.on('data', (d) => recon.push(d))
      decoder.on('error', (e) => { decodeError = e; onEvent(failureOf(where, e, 'decode-failed', { reason: `the SSE response (content-encoding ${enc}) could not be decompressed: ${e.message}; its wire bytes are kept (raw_b64)` })) })
    }
  }
  const finish = (aborted) => {
    if (finished) return
    finished = true
    let resp
    if (isSse) {
      resp = { status: up.statusCode, kind: 'sse', ...recon.finish() }
      if (decodeError) { resp.encoding_error = String(decodeError.message); resp.raw_b64 = Buffer.concat(wire).toString('base64') }
    } else resp = bodyResp(up.statusCode, Buffer.concat(wire), enc)
    resp.request_id = up.headers['request-id'] || up.headers['x-request-id'] || null
    if (!aborted) return done(resp, false)
    done({ status: up.statusCode, kind: 'error', error: { type: 'upstream_aborted', message: 'the upstream closed the response before it was complete' }, partial: resp }, true)
  }
  up.on('data', (chunk) => {
    res.write(chunk)
    if (!isSse) wire.push(chunk)
    else if (decoder) { wire.push(chunk); if (!decodeError) decoder.write(chunk) } else recon.push(chunk)
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
