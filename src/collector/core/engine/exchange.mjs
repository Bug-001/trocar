// exchange.mjs — pair framed requests and responses on ONE connection into envelopes (RFC 4.6
// §引擎/§记录). It observes bytes only (fromClient/fromUpstream); the flow layer forwards the real
// bytes. Two passive framers feed a FIFO of exchanges: a request head opens one (sampling
// isRecording() at that instant) and queues its method; the oldest unanswered exchange pairs with
// the next final response. Interim (1xx) responses are skipped; an upgrade or an abort finalizes
// open exchanges. Recording never blocks forwarding — only the store write touches disk.
import { randomBytes } from 'node:crypto'
import { createFramer } from '../http1/framer.mjs'
import { buildTransparentEnvelope } from '../record/envelope.mjs'

const defaultRunTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex')

export function createExchangeTee({ flow, recordStore, isRecording = () => true, maxBodyBytes = 64 << 20, newId }) {
  const stats = { exchanges: 0, recorded: 0 }
  const run = defaultRunTag()
  let idSeq = 0
  const genId = newId || (() => `req_${run}-${String(++idSeq).padStart(5, '0')}`)

  const pending = []   // exchanges awaiting their final response (FIFO; responses are ordered)
  let curReq = null    // request body currently accumulating
  let curResp = null   // response body currently accumulating
  let stopped = false

  // Accumulate a body with a hard cap; past maxBodyBytes stop and mark truncated (invariant 4).
  function append(target, chunk) {
    if (target.truncated) return
    const room = maxBodyBytes - target.bytes
    if (chunk.length > room) {
      if (room > 0) { target.chunks.push(Buffer.from(chunk.subarray(0, room))); target.bytes += room }
      target.truncated = true
    } else {
      target.chunks.push(Buffer.from(chunk)); target.bytes += chunk.length
    }
  }

  const reqFramer = createFramer('request', {
    onHead(h) {
      const ex = {
        seq: stats.exchanges++,
        id: genId(),
        record: isRecording(),             // sampled at request start (RFC 4.6 §开关)
        req: { head: { raw: h.raw, startLine: h.startLine, headers: h.headers, method: h.method, target: h.target }, chunks: [], bytes: 0, truncated: false, tsStart: new Date().toISOString() },
        emitted: false,
      }
      curReq = ex.req
      respFramer.expect({ method: h.method })
      pending.push(ex)
    },
    onBody(b) { if (curReq) append(curReq, b) },
    onEnd() { curReq = null },
    onUpgrade() {},
    onError() { if (curReq) { curReq.partial = 'framer-error'; curReq = null } },  // body never completes
  })

  const respFramer = createFramer('response', {
    onHead(h) {
      curResp = { head: { raw: h.raw, status: h.status, headers: h.headers }, chunks: [], bytes: 0, truncated: false, tsStart: new Date().toISOString() }
    },
    onBody(b) { if (curResp) append(curResp, b) },
    onEnd(e) {
      if (!curResp) return
      if (e.interim) { curResp = null; return }   // 1xx: the final response for this request follows
      finalize(curResp, null); curResp = null
    },
    onUpgrade() { finalize(curResp, null); curResp = null; stopped = true }, // 101 / CONNECT 2xx: head only
    onError() {},
  })

  function respPartOf(resp, aborted) {
    if (!resp) return null
    return { head: resp.head, body: Buffer.concat(resp.chunks), truncated: resp.truncated, tsStart: resp.tsStart, tsEnd: new Date().toISOString(), ...(aborted ? { aborted: true } : {}) }
  }

  // `why` names what ended the exchange if its request body is still arriving (invariant 4: the
  // envelope then holds only a prefix, labelled req_partial). Later bytes of that body are dropped.
  function emit(ex, respPart, error, why) {
    if (ex.emitted) return
    ex.emitted = true
    const partial = ex.req.partial || (ex.req === curReq ? why : null)
    if (ex.req === curReq) curReq = null
    if (!ex.record) return
    recordStore.envelope(buildTransparentEnvelope({
      id: ex.id, flow, seq: ex.seq,
      req: { head: ex.req.head, body: Buffer.concat(ex.req.chunks), truncated: ex.req.truncated, partial, tsStart: ex.req.tsStart },
      resp: respPart,
      error: error || null,
    }))
    stats.recorded++
  }

  function finalize(resp, error) {
    const ex = pending.shift()
    if (!ex) return
    emit(ex, respPartOf(resp, false), error, 'early-response')
  }

  function abort(error) {
    if (stopped) return
    stopped = true
    const partial = curResp; curResp = null
    let first = true
    while (pending.length) {
      const ex = pending.shift()
      emit(ex, first && partial ? respPartOf(partial, true) : null, error, 'aborted')
      first = false
    }
  }

  return {
    fromClient(chunk) { if (!stopped) reqFramer.push(chunk) },
    fromUpstream(chunk) { if (!stopped) respFramer.push(chunk) },
    clientEnded() { if (!stopped) reqFramer.end() },
    upstreamEnded() { if (!stopped) respFramer.end() },
    abort,
    stats,
  }
}
