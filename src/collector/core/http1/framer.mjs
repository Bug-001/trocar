// framer.mjs — a passive, incremental HTTP/1.1 message framer (RFC 9112 §6), one per direction.
// It only finds message boundaries in a COPY of the bytes; it never re-serializes and the caller
// keeps forwarding the original bytes untouched (RFC 4.6 §引擎 6). It never throws out of push():
// a framing violation routes to onError and the framer stops, leaving the relay to carry on.
//
// createFramer(side, h) → { push(chunk), end(), expect({method}), release(), takeRest() }
//   side: 'request' | 'response'. The response framer needs each request's method, in order; the
//   exchange layer calls expect({method}) once per request head (FIFO; supports pipelining).
//   h: { onHead, onBody, onEnd, onUpgrade, onError } — see RFC 4.6 and the plan for the shapes.
//   Protocol switch: the response framer calls onUpgrade({rest}) after a 101 / CONNECT 2xx head, rest =
//   the bytes that followed the head in the same push. After a request that asks to upgrade (Upgrade +
//   Connection: upgrade) the request framer holds what follows: release() frames it as HTTP again (the
//   upgrade was refused, e.g. 426), takeRest() returns it and stops (the upgrade happened).
import { parseHead } from '../engine/sniff.mjs'

const tokensOf = (headers, name) => headers.filter(([k]) => k.toLowerCase() === name).flatMap(([, v]) => v.split(',').map((t) => t.trim().toLowerCase()))
/** A request that asks to switch protocols (RFC 9110 §7.8): an Upgrade header and Connection: upgrade. */
export const asksUpgrade = (headers) => tokensOf(headers || [], 'upgrade').some(Boolean) && tokensOf(headers || [], 'connection').includes('upgrade')

export function createFramer(side, h) {
  const isReq = side === 'request'
  let buf = Buffer.alloc(0)
  let state = 'head'          // head | length | chunk-size | chunk-data | chunk-crlf | trailers | close | upgrade-wait | failed
  let ctx = null             // per-message framing context
  let failed = false
  let upgraded = false
  const methodQueue = []     // response side: request methods awaiting their response (FIFO)
  let awaitUpgrade = false   // request side: the message being framed asked to switch protocols

  function fail(msg) { if (!failed) { failed = true; state = 'failed'; h.onError(new Error(msg)) } }

  function headerValues(headers, name) {
    const lower = name.toLowerCase()
    const out = []
    for (const [k, v] of headers) if (k.toLowerCase() === lower) out.push(v)
    return out
  }
  function teIsChunked(vals) {
    const codings = []
    for (const v of vals) for (const part of v.split(',')) codings.push(part.trim().toLowerCase())
    return codings.length > 0 && codings[codings.length - 1] === 'chunked'
  }
  function contentLength(vals) {
    const flat = []
    for (const v of vals) for (const part of v.split(',')) flat.push(part.trim())
    const uniq = new Set(flat)
    if (uniq.size !== 1) return null                 // conflicting Content-Length → framing error
    const n = Number([...uniq][0])
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  function endMessage(framing, interim) {
    h.onEnd(interim ? { framing, interim: true } : { framing })
    ctx = null
    // After an Upgrade request the next bytes are either the next HTTP request (upgrade refused) or
    // the new protocol (101): hold them until the exchange layer says which (release / takeRest).
    state = awaitUpgrade ? 'upgrade-wait' : 'head'
    awaitUpgrade = false
  }
  // The bytes after the 101 / CONNECT 2xx head belong to the new protocol: hand them over.
  function doUpgrade() { upgraded = true; const rest = buf; buf = Buffer.alloc(0); h.onUpgrade({ rest }) }

  function onHeadReq(parsed, raw) {
    const [method, target, version] = parsed.startLine.split(' ')
    h.onHead({ raw, startLine: parsed.startLine, headers: parsed.headers, method, target, version })
    awaitUpgrade = asksUpgrade(parsed.headers)
    const te = headerValues(parsed.headers, 'transfer-encoding')
    const cl = headerValues(parsed.headers, 'content-length')
    if (teIsChunked(te)) { ctx = {}; state = 'chunk-size' }
    else if (cl.length) {
      const n = contentLength(cl); if (n === null) return fail('bad content-length')
      ctx = { remaining: n }; state = 'length'
    } else endMessage('none')
  }

  function onHeadResp(parsed, raw) {
    const parts = parsed.startLine.split(' ')
    const version = parts[0]; const status = parseInt(parts[1], 10)
    h.onHead({ raw, startLine: parsed.startLine, headers: parsed.headers, status, version })
    if (status >= 100 && status < 200) {
      if (status === 101) { methodQueue.shift(); return doUpgrade() } // protocol switch ends the exchange
      return endMessage('none', true)                                 // other 1xx: interim, method stays queued
    }
    const method = methodQueue.length ? methodQueue.shift() : 'GET'
    if (method === 'CONNECT' && status >= 200 && status < 300) return doUpgrade()
    if (method === 'HEAD' || status === 204 || status === 304) return endMessage('none')
    const te = headerValues(parsed.headers, 'transfer-encoding')
    const cl = headerValues(parsed.headers, 'content-length')
    if (teIsChunked(te)) { ctx = {}; state = 'chunk-size' }
    else if (cl.length) {
      const n = contentLength(cl); if (n === null) return fail('bad content-length')
      ctx = { remaining: n }; state = 'length'
    } else state = 'close'                                            // close-delimited (ends at end())
  }

  function process() {
    while (!failed && !upgraded) {
      if (state === 'head') {
        const parsed = parseHead(buf)
        if (!parsed) return
        const raw = buf.subarray(0, parsed.headLength)
        buf = buf.subarray(parsed.headLength)
        if (isReq) onHeadReq(parsed, raw); else onHeadResp(parsed, raw)
      } else if (state === 'length') {
        if (ctx.remaining > 0) {
          if (buf.length === 0) return
          const take = Math.min(ctx.remaining, buf.length)
          h.onBody(buf.subarray(0, take)); buf = buf.subarray(take); ctx.remaining -= take
          if (ctx.remaining > 0) return
        }
        endMessage('length')
      } else if (state === 'chunk-size') {
        const i = buf.indexOf('\r\n')
        if (i === -1) return
        const line = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 2)
        const sizePart = line.split(';')[0].trim()
        if (!/^[0-9a-fA-F]+$/.test(sizePart)) return fail('bad chunk size')
        const size = parseInt(sizePart, 16)
        if (size === 0) state = 'trailers'
        else { ctx.chunkRemaining = size; state = 'chunk-data' }
      } else if (state === 'chunk-data') {
        if (buf.length === 0) return
        const take = Math.min(ctx.chunkRemaining, buf.length)
        h.onBody(buf.subarray(0, take)); buf = buf.subarray(take); ctx.chunkRemaining -= take
        if (ctx.chunkRemaining > 0) return
        state = 'chunk-crlf'
      } else if (state === 'chunk-crlf') {
        if (buf.length < 2) return
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) return fail('bad chunk terminator')
        buf = buf.subarray(2); state = 'chunk-size'
      } else if (state === 'trailers') {
        const i = buf.indexOf('\r\n')
        if (i === -1) return
        const line = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 2)
        if (line === '') endMessage('chunked')              // empty line ends the trailer section
      } else if (state === 'close') {
        if (buf.length) { h.onBody(buf); buf = Buffer.alloc(0) }
        return                                              // body continues until end()
      } else return
    }
  }

  return {
    push(chunk) {
      if (failed || upgraded) return
      try { buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk); process() }
      catch (e) { fail(e.message) }
    },
    end() {
      if (failed || upgraded) return
      try { if (state === 'close') { if (buf.length) { h.onBody(buf); buf = Buffer.alloc(0) } endMessage('close') } }
      catch (e) { fail(e.message) }
    },
    expect({ method }) { methodQueue.push(method) },
    // request side, upgrade-wait: the upgrade was refused → frame what followed as HTTP again
    release() { if (state === 'upgrade-wait' && !failed && !upgraded) { state = 'head'; try { process() } catch (e) { fail(e.message) } } },
    // request side, upgrade-wait: the upgrade happened → the held bytes belong to the new protocol
    takeRest() { upgraded = true; const rest = buf; buf = Buffer.alloc(0); return rest },
  }
}
