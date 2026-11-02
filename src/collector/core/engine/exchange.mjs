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
import { endpointClass } from '../../../dissect/endpoints.mjs'
import { MAX_BODY_BYTES } from '../../../capture/request-body.mjs'

const defaultRunTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex')

const tokens = (pairs, name) => (pairs || []).filter(([k]) => k.toLowerCase() === name).flatMap(([, v]) => v.split(',').map((t) => t.trim().toLowerCase()))
// an absolute-form request target (plain http through a proxy, RFC 9112 §3.2.2) → its path and query, the value the same request has without a proxy:
// the endpoint and the retention rules read paths (4.1 §统一原始信封); the whole line stays in req_head_raw. Any other target as it is.
const pathOf = (target) => { const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(target || ''); if (!m) return target; const rest = target.slice(m[0].length); return rest.startsWith('/') ? rest : `/${rest}` }
const isWsUpgrade = (req, resp) => resp.head.status === 101 && tokens(req.head.headers, 'upgrade').includes('websocket') && tokens(resp.head.headers, 'upgrade').includes('websocket')
// a socket error as the ws recorder records it; 'end' / 'close' (no Error) are a clean end
const errOf = (e) => (e ? { type: e.code || e.type || 'error', message: String(e.message || e) } : null)

/** createExchangeTee({flow, recordStore, isRecording, maxBodyBytes, newId, wsTerminal, retention, onFailure})
 *   → {fromClient, fromUpstream, clientEnded(err?), upstreamEnded(err?), abort(error), wsSummary(), rowNotes(), stats}
 * rowNotes() = what flows/ must say about this connection (RFC 4.6 §记录, D38): {writeFailed} = envelopes the
 * store did not write (HTTP and WebSocket), {notFollowed} = the reply after which nothing more was framed
 * (a non-WebSocket 101, a CONNECT 2xx), {framerError: {side, message}} = framing failed, nothing after it is
 * recorded.
 * boundary() = where the connection stands for the drain gate (engine/drain.mjs, 1.6 §1.3): {idle, headPending, seq, blind}:
 * idle = no request in flight, no response in progress (a WebSocket: no call open); headPending = the oldest request
 * has had no byte of its response yet (so its head, once whole, can still carry a header line); seq = that request's
 * seq; blind = the tee cannot see response boundaries on this connection (framing stopped, a WebSocket with no terminal
 * message to wait for). markAdded(seq, what) = the gate put `what` into the bytes it forwarded for exchange `seq` ('connection-close'):
 * the envelope of that exchange says so (trocar_added) and rowNotes().trocarAdded does, recorded or not.
 * onTurnEnd() = a WebSocket call just closed on its terminal message (the ws recorder's option).
 * wsTerminal = FlowExtras.wsTerminal (harness data, Plan 3c §2); wsSummary() = the ws recorder's summary
 * for flows/ once the connection switched to WebSocket, else null. onFailure({code, reason, …}) takes the
 * capture failures (RFC 4.6 §记录, D38) — the engine's failure(), which writes them to flows/; the
 * WebSocket recorder gets the same sink. A framing error stops recording the rest of the connection.
 * retention(proc, host, method, path) → {class, level} (D40, RFC 4.6 §记录「保存级别」): the daemon's callback, asked once
 * per request when its head arrives — the same instant as isRecording() — and once per WebSocket call at its first frame.
 * At `log` the bodies are not buffered, only counted; either way the full wire length of each body is counted past the cap
 * (body_wire_bytes). No callback: every call is `full`, its class told by the endpoint alone. */
export const noFailureSink = (r) => { throw Object.assign(new Error(`capture failure with nowhere to be recorded: ${r.code}: ${r.reason}`), { code: r.code }) } // a wiring fault: loud, never dropped
export function createExchangeTee({ flow, recordStore, isRecording = () => true, maxBodyBytes = MAX_BODY_BYTES, newId, wsTerminal = null, retention = null, onFailure = noFailureSink, onTurnEnd = () => {} }) {
  // the retention callback, sampled once per call: a throw or a nonsense answer is `full`, its class told by the
  // endpoint alone (never throws into the framer: a bad flow object is trocar's own bug, reported where the envelope
  // is built, not here). Class names are the operator's table's, so any non-empty name is taken as it is (D60③).
  const sample = (method, target) => {
    let host = null
    try { host = flow.host } catch { /* the envelope build reports it */ }
    const fallback = () => ({ class: endpointClass(target) || 'other', level: 'full' })
    if (typeof retention !== 'function') return fallback()
    try {
      const r = retention(flow.proc, host, method, target)
      return { class: r && typeof r.class === 'string' && r.class ? r.class : 'other', level: r && r.level === 'log' ? 'log' : 'full' }
    } catch { return fallback() }
  }
  const stats = { exchanges: 0, recorded: 0 }
  const run = defaultRunTag()
  let idSeq = 0
  const genId = newId || (() => `req_${run}-${String(++idSeq).padStart(5, '0')}`)

  const pending = []   // exchanges awaiting their final response (FIFO; responses are ordered)
  let curReq = null    // request body currently accumulating
  let curResp = null   // response body currently accumulating
  let stopped = false
  let ws = null        // after a WebSocket 101: the frame recorder that owns both directions
  let writeFailed = 0  // envelopes the store did not write (false or a throw): counted on the flows/ row
  let notFollowed = null
  let unpaired = false // one unpaired-response event per connection
  let framerError = null // {side, message}: framing stopped here, the rest of the connection is not recorded
  const added = []     // [{seq, what}]: what the drain gate put into the bytes it forwarded (1.6 §1.3), for the flows/ row
  let respSeen = false // a byte of the response to the oldest request has arrived (cleared when a response, interim or final, ends)
  let clientMid = false // client bytes arrived and no request head has been completed from them yet
  // the WebSocket recorder writes through this, so its lost envelopes are counted on the row too
  const counted = {
    envelope(env) { let r; try { r = recordStore.envelope(env) } catch (e) { writeFailed++; throw e } if (!r || !r.ok) writeFailed++; return r },
    get lastError() { return recordStore.lastError },
  }

  // Accumulate a body with a hard cap; past maxBodyBytes stop and mark truncated (invariant 4). `wire` counts every byte,
  // kept or not (body_wire_bytes); a body at the `log` level (keep:false) is only counted.
  function append(target, chunk) {
    target.wire += chunk.length
    if (!target.keep || target.truncated) return
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
      const target = pathOf(h.target)
      const rt = sample(h.method, target)
      const ex = {
        seq: stats.exchanges++,
        id: genId(),
        record: isRecording(),             // sampled at request start (RFC 4.6 §开关)
        rt,                                // so is the retention level and class (D40)
        req: { head: { raw: h.raw, startLine: h.startLine, headers: h.headers, method: h.method, target }, chunks: [], bytes: 0, wire: 0, keep: rt.level !== 'log', truncated: false, tsStart: new Date().toISOString() },
        emitted: false,
        upgradeReq: asksUpgrade(h.headers), // the request framer holds what follows it (release / takeRest)
      }
      curReq = ex.req
      clientMid = false
      respFramer.expect({ method: h.method })
      pending.push(ex)
    },
    onBody(b) { if (curReq) append(curReq, b) },
    onEnd() { curReq = null; clientMid = false },
    onUpgrade() {},
    onError(e) { // body never completes; no later request on this connection is framed
      if (curReq) { curReq.partial = 'framer-error'; curReq = null }
      if (!framerError) framerError = { side: 'request', message: e.message }
      onFailure({ code: 'framer-error', flow_id: flow.id, side: 'request', reason: e.message })
    },
  })

  const respFramer = createFramer('response', {
    onHead(h) {
      // the response belongs to the oldest unanswered request (responses are ordered): its level is that request's
      const owner = pending[0]
      curResp = { head: { raw: h.raw, status: h.status, headers: h.headers }, chunks: [], bytes: 0, wire: 0, keep: !owner || owner.rt.level !== 'log', truncated: false, tsStart: new Date().toISOString() }
    },
    onBody(b) { if (curResp) append(curResp, b) },
    onEnd(e) {
      respSeen = false
      if (!curResp) return
      if (e.interim) { curResp = null; return }   // 1xx: the final response for this request follows
      finalize(curResp, null); curResp = null
    },
    onUpgrade({ rest } = {}) {
      const ex = pending[0]
      const early = reqFramer.takeRest() // client bytes held behind the upgrade request: the new protocol's
      if (!(curResp && ex && isWsUpgrade(ex.req, curResp))) { // other 101 / CONNECT 2xx: head only, then nothing is framed
        notFollowed = curResp && curResp.head.status === 101 ? `101 ${tokens(curResp.head.headers, 'upgrade').join(',') || '-'}` : `CONNECT ${curResp ? curResp.head.status : '-'}`
        finalize(curResp, null); curResp = null; stopped = true; return
      }
      // RFC 4.6 §引擎 6: after a WebSocket 101 the raw bytes keep flowing; the side copy goes to ws/. The
      // upgrade is no envelope of its own: its seq is the first call's (RFC 4.6 §记录).
      pending.shift()
      ws = createWsRecorder({ flow, upgrade: { req: ex.req, resp: curResp }, seqStart: ex.seq, genId, recordStore: counted, isRecording, terminal: wsTerminal, retention: sample, onFailure, onTurnEnd })
      curResp = null
      if (early.length) ws.fromClient(early) // frames sent before the 101 arrived (RFC 6455 says wait; some don't)
      if (rest && rest.length) ws.fromUpstream(rest)
    },
    // no later response is framed: the open exchanges end here, labelled with the cause (invariant 4)
    onError(e) { if (!framerError) framerError = { side: 'response', message: e.message }; onFailure({ code: 'framer-error', flow_id: flow.id, side: 'response', reason: e.message }); abort({ type: 'framer_error', message: e.message }) },
  })

  function respPartOf(resp, aborted) {
    if (!resp) return null
    return { head: resp.head, body: Buffer.concat(resp.chunks), truncated: resp.truncated, wire: resp.wire, tsStart: resp.tsStart, tsEnd: new Date().toISOString(), ...(aborted ? { aborted: true } : {}) }
  }

  // `why` names what ended the exchange if its request body is still arriving (invariant 4: the
  // envelope then holds only a prefix, labelled req_partial). Later bytes of that body are dropped.
  function emit(ex, respPart, error, why) {
    if (ex.emitted) return
    ex.emitted = true
    const partial = ex.req.partial || (ex.req === curReq ? why : null)
    if (ex.req === curReq) curReq = null
    if (!ex.record) return
    // building the envelope runs inside the framer's push(): an exception here is trocar's own (engine-error),
    // not a framing error, and must not stop the framing of the rest of the connection (D38)
    let env
    try {
      env = buildTransparentEnvelope({
        id: ex.id, flow, seq: ex.seq,
        req: { head: ex.req.head, body: Buffer.concat(ex.req.chunks), truncated: ex.req.truncated, wire: ex.req.wire, partial, tsStart: ex.req.tsStart },
        resp: respPart,
        error: error || null,
        class: ex.rt.class, level: ex.rt.level,
      })
    } catch (e) { onFailure({ code: 'engine-error', flow_id: flow.id, seq: ex.seq, reason: `recording failed: ${String((e && e.message) || e)}` }); return }
    if (ex.added) env.trocar_added = [...ex.added] // after every other key: what trocar put into the bytes the client got (4.6 §记录, invariant 4)
    let ok = true
    try { ok = recordStore.envelope(env).ok === true } catch { ok = false } // the store counts and reports its own failures
    if (!ok) { writeFailed++; return }
    stats.recorded++
  }

  function finalize(resp, error) {
    const ex = pending.shift()
    if (!ex) { // a response no request of ours asked for (e.g. after the request framer failed): not silent (D38)
      if (!unpaired) { unpaired = true; onFailure({ code: 'unpaired-response', flow_id: flow.id, status: resp && resp.head ? resp.head.status : null, reason: `a ${resp && resp.head ? resp.head.status : '?'} response arrived with no request to pair with; it is not recorded` }) }
      return
    }
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
    fromClient(chunk) { if (ws) ws.fromClient(chunk); else if (!stopped) { if (chunk.length) clientMid = true; reqFramer.push(chunk) } },
    fromUpstream(chunk) { if (ws) ws.fromUpstream(chunk); else if (!stopped) { if (chunk.length) respSeen = true; respFramer.push(chunk) } },
    clientEnded(err) { if (ws) ws.end(errOf(err)); else if (!stopped) reqFramer.end() },
    upstreamEnded(err) { if (ws) ws.end(errOf(err)); else if (!stopped) respFramer.end() },
    abort,
    wsSummary: () => (ws ? ws.summary() : null),
    rowNotes: () => ({ ...(writeFailed ? { writeFailed } : {}), ...(notFollowed ? { notFollowed } : {}), ...(framerError ? { framerError } : {}), ...(added.length ? { trocarAdded: added.map((a) => ({ ...a })) } : {}) }),
    boundary() {
      if (ws) { const st = ws.state(); return { idle: st === 'idle', headPending: false, seq: null, blind: st === 'blind' } }
      return { idle: !pending.length && !curReq && !curResp && !clientMid, headPending: pending.length > 0 && !respSeen, seq: pending.length ? pending[0].seq : null, blind: stopped || !!framerError }
    },
    markAdded(seq, what) {
      added.push({ seq, what })
      const ex = pending.find((e) => e.seq === seq)
      if (ex) (ex.added || (ex.added = [])).push(what)
    },
    stats,
  }
}
