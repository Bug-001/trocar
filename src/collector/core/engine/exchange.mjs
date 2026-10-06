// exchange.mjs — pair framed requests and responses on ONE connection into envelopes (RFC 4.6
// §引擎/§记录). It observes bytes only (fromClient/fromUpstream); the flow layer forwards the real
// bytes. Two passive framers feed a FIFO of exchanges: a request head opens one (sampling
// isRecording() at that instant) and queues its method; the oldest unanswered exchange pairs with
// the next final response. Interim (1xx) responses are skipped; an abort finalizes open exchanges;
// a WebSocket 101 hands both directions to ws/recorder.mjs (one envelope per logical call, RFC 4.6
// §传输与帧级记录): the upgrade is no envelope of its own and its seq goes to the first call; a refused
// upgrade (e.g. 426) is an ordinary exchange. Recording never blocks forwarding — only the store
// write touches disk.
import { randomBytes } from 'node:crypto'
import { createFramer, asksUpgrade } from '../http1/framer.mjs'
import { buildTransparentEnvelope } from '../record/envelope.mjs'
import { createWsRecorder } from '../ws/recorder.mjs'

const defaultRunTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex')

const tokens = (pairs, name) => (pairs || []).filter(([k]) => k.toLowerCase() === name).flatMap(([, v]) => v.split(',').map((t) => t.trim().toLowerCase()))
const isWsUpgrade = (req, resp) => resp.head.status === 101 && tokens(req.head.headers, 'upgrade').includes('websocket') && tokens(resp.head.headers, 'upgrade').includes('websocket')
// a socket error as the ws recorder records it; 'end' / 'close' (no Error) are a clean end
const errOf = (e) => (e ? { type: e.code || e.type || 'error', message: String(e.message || e) } : null)

/** createExchangeTee({flow, recordStore, isRecording, maxBodyBytes, newId, wsTerminal, onFailure})
 *   → {fromClient, fromUpstream, clientEnded(err?), upstreamEnded(err?), abort(error), wsSummary(), stats}
 * wsTerminal = FlowExtras.wsTerminal (harness data, Plan 3c §2); wsSummary() = the ws recorder's summary
 * for flows/ once the connection switched to WebSocket, else null. onFailure({code, reason, …}) takes the
 * capture failures (RFC 4.6 §记录, D38) — the engine's failure(), which writes them to flows/; the
 * WebSocket recorder gets the same sink. A framing error stops recording the rest of the connection. */
export const noFailureSink = (r) => { throw Object.assign(new Error(`capture failure with nowhere to be recorded: ${r.code}: ${r.reason}`), { code: r.code }) } // a wiring fault: loud, never dropped
export function createExchangeTee({ flow, recordStore, isRecording = () => true, maxBodyBytes = 64 << 20, newId, wsTerminal = null, onFailure = noFailureSink }) {
  const stats = { exchanges: 0, recorded: 0 }
  const run = defaultRunTag()
  let idSeq = 0
  const genId = newId || (() => `req_${run}-${String(++idSeq).padStart(5, '0')}`)

  const pending = []   // exchanges awaiting their final response (FIFO; responses are ordered)
  let curReq = null    // request body currently accumulating
  let curResp = null   // response body currently accumulating
  let stopped = false
  let ws = null        // after a WebSocket 101: the frame recorder that owns both directions

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
        upgradeReq: asksUpgrade(h.headers), // the request framer holds what follows it (release / takeRest)
      }
      curReq = ex.req
      respFramer.expect({ method: h.method })
      pending.push(ex)
    },
    onBody(b) { if (curReq) append(curReq, b) },
    onEnd() { curReq = null },
    onUpgrade() {},
    onError(e) { // body never completes; no later request on this connection is framed
      if (curReq) { curReq.partial = 'framer-error'; curReq = null }
      onFailure({ code: 'framer-error', flow_id: flow.id, side: 'request', reason: e.message })
    },
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
    onUpgrade({ rest } = {}) {
      const ex = pending[0]
      const early = reqFramer.takeRest() // client bytes held behind the upgrade request: the new protocol's
      if (!(curResp && ex && isWsUpgrade(ex.req, curResp))) { finalize(curResp, null); curResp = null; stopped = true; return } // other 101 / CONNECT 2xx: head only
      // RFC 4.6 §引擎 6: after a WebSocket 101 the raw bytes keep flowing; the side copy goes to ws/. The
      // upgrade is no envelope of its own: its seq is the first call's (RFC 4.6 §记录).
      pending.shift()
      ws = createWsRecorder({ flow, upgrade: { req: ex.req, resp: curResp }, seqStart: ex.seq, genId, recordStore, isRecording, terminal: wsTerminal, onFailure })
      curResp = null
      if (early.length) ws.fromClient(early) // frames sent before the 101 arrived (RFC 6455 says wait; some don't)
      if (rest && rest.length) ws.fromUpstream(rest)
    },
    // no later response is framed: the open exchanges end here, labelled with the cause (invariant 4)
    onError(e) { onFailure({ code: 'framer-error', flow_id: flow.id, side: 'response', reason: e.message }); abort({ type: 'framer_error', message: e.message }) },
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
    if (ex.upgradeReq) reqFramer.release() // upgrade refused (e.g. 426): what followed is HTTP again
  }

  function abort(error) {
    if (ws) return ws.end(error)
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
    fromClient(chunk) { if (ws) ws.fromClient(chunk); else if (!stopped) reqFramer.push(chunk) },
    fromUpstream(chunk) { if (ws) ws.fromUpstream(chunk); else if (!stopped) respFramer.push(chunk) },
    clientEnded(err) { if (ws) ws.end(errOf(err)); else if (!stopped) reqFramer.end() },
    upstreamEnded(err) { if (ws) ws.end(errOf(err)); else if (!stopped) respFramer.end() },
    abort,
    wsSummary: () => (ws ? ws.summary() : null),
    stats,
  }
}
