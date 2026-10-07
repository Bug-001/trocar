// envelope.mjs (collector) — build a transparent-capture D10 envelope on top of the single
// authority src/capture/envelope.mjs::buildEnvelope (never duplicate it). RFC 4.6 §记录: the new
// fields (host/scheme/dst/proc/flow_id/seq/req_head_raw/resp_head_raw, plus req_truncated/
// req_body_bytes/req_partial only when the request body is incomplete) are appended AFTER req_body,
// and raw request/response heads are preserved latin1-verbatim for byte-exact resend (invariant 2).
import { buildEnvelope, logResponse, isLlmCall } from '../../../capture/envelope.mjs'
import { shapeResponse } from './body.mjs'

// Lowercase header names and join repeats with ', ' — the same shape Node's http gives.
function lowerHeaders(pairs) {
  const o = {}
  for (const [k, v] of pairs || []) {
    const lk = k.toLowerCase()
    o[lk] = o[lk] === undefined ? v : o[lk] + ', ' + v
  }
  return o
}

/**
 * buildTransparentEnvelope({id, flow, seq, req, resp, error}) → envelope.
 *   flow = {id, host, scheme, dst, proc}
 *   req  = {head:{raw,startLine,headers,method,target}, body, truncated, partial?, tsStart, wire?}
 *          partial = 'early-response' | 'aborted' | 'framer-error' when the body never finished
 *          wire = the body's full wire length (the exchange counts past the cap); default body.length
 *   resp = null | {head:{raw,status,headers}, body, truncated, tsStart, tsEnd, aborted?, wire?}
 *   error= null | {type, message}
 *   class / level = the call's traffic class and retention level, sampled when the request started (D40). At the `log`
 *          level the bodies were not buffered (the exchange only counted them): req_body and resp keep sizes, not bytes.
 * A null or aborted response yields error:true with resp.kind:'error' (partial body under resp.partial).
 * The request body follows the one rule of src/capture/request-body.mjs, for every call (D40).
 */
export function buildTransparentEnvelope({ id, flow, seq, req, resp, error = null, class: trafficClass = null, level = 'full' }) {
  const reqHeaders = lowerHeaders(req.head.headers)
  const haveResp = !!resp && !resp.aborted && !error
  const durationMs = resp && resp.tsStart && resp.tsEnd ? Date.parse(resp.tsEnd) - Date.parse(resp.tsStart) : null
  const logged = level === 'log'
  const shape = (r) => (logged
    ? logResponse({ status: r.head.status, headers: lowerHeaders(r.head.headers), wireBytes: r.wire ?? (r.body ? r.body.length : 0) })
    : shapeResponse({ status: r.head.status, headers: r.head.headers, body: r.body, truncated: r.truncated, llm: isLlmCall(req.head.target) }))

  let shaped
  if (haveResp) {
    shaped = shape(resp)
  } else {
    shaped = { status: resp && resp.head ? (resp.head.status ?? null) : null, kind: 'error' }
    if (error) shaped.error = { type: error.type, message: error.message }
    if (resp && resp.head) shaped.partial = shape(resp)
  }

  const env = buildEnvelope({
    id,
    tsRequest: req.tsStart,
    tsRespStart: resp ? resp.tsStart : null,
    tsRespEnd: resp ? resp.tsEnd : null,
    durationMs,
    method: req.head.method,
    endpoint: req.head.target,
    reqBody: logged ? null : req.body,
    reqHeaders,
    resp: shaped,
    // 4.8 §5.6: how the call reached the engine — flow.capture is the meta's capture (proxy on Windows), the default is transparent (Linux and the other per-process captures)
    capture: flow.capture || 'transparent',
    error: !haveResp,
    host: flow.host, trafficClass, retention: level,
    reqWireBytes: req.wire ?? (req.body ? req.body.length : 0),
    respWireBytes: resp ? (resp.wire ?? (resp.body ? resp.body.length : 0)) : null,
    reqTruncated: !!req.truncated, reqPartial: req.partial || null,
  })

  // Append the transparent-capture fields AFTER everything buildEnvelope produced (key order matters:
  // the sharder scans the first "req_headers":{ … to "req_body").
  return {
    ...env,
    scheme: flow.scheme,
    dst: flow.dst,
    proc: flow.proc,
    flow_id: flow.id,
    seq,
    req_head_raw: req.head.raw.toString('latin1'),
    resp_head_raw: resp && resp.head && resp.head.raw ? resp.head.raw.toString('latin1') : null,
  }
}

/**
 * buildWsEnvelope({id, flow, seq, upgrade, call, wsRaw, error}) → the envelope of ONE logical WebSocket
 * call (RFC 4.6 §传输与帧级记录, D37). The upgrade is not an envelope of its own: every call carries the
 * upgrade request's headers (req_headers / req_head_raw: the sharder reads a session key there)
 * and the upstream's 101 head (resp_head_raw).
 *   upgrade = {req:{head}, resp:{head}}   the heads as the exchange tee holds them
 *   call    = {client:[v], server:[v], tsStart, tsRespStart, tsEnd, partial:[reason], truncated, class, level, wire:{req,resp}}
 *     v = a message as stored: its text, {b64}, {b64, decode_error}, {omitted_bytes}, or — at the `log` level (D40) and in
 *     records written before it — {raw_chars, verbatim:false}. client[0] opened the call; none = a server message that
 *     arrived with no call open. class / level = the call's traffic class and retention level, sampled at its first frame;
 *     wire = every payload byte the call carried in each direction, kept or not (body_wire_bytes).
 *   wsRaw   = the call's ws_raw entries in frame order (core/ws/raw.mjs)
 *   error   = null | {type, message}: the connection ended the call before its terminal message; the
 *             server messages then sit under resp.partial, the shape of an interrupted HTTP response
 * Only the opener's TEXT is req_body; a non-text opener is req_body:null + req_body_b64 (its decoded
 * bytes, no req_content_encoding); one past the cap or not decodable is req_body:null, labelled by
 * ws_truncated / partial_reasons and by its frames in ws_raw.
 */
export function buildWsEnvelope({ id, flow, seq, upgrade, call, wsRaw, error = null }) {
  const [opener = null, ...extra] = call.client
  const messages = { kind: 'ws', messages: call.server }
  const env = buildEnvelope({
    id, tsRequest: call.tsStart, tsRespStart: call.tsRespStart, tsRespEnd: call.tsEnd,
    durationMs: call.tsRespStart ? Date.parse(call.tsEnd) - Date.parse(call.tsRespStart) : null,
    method: upgrade.req.head.method, endpoint: upgrade.req.head.target, reqBody: null,
    reqHeaders: lowerHeaders(upgrade.req.head.headers),
    host: flow.host, trafficClass: call.class || null, retention: call.level || 'full',
    reqWireBytes: call.wire ? call.wire.req : 0, respWireBytes: call.wire ? call.wire.resp : 0,
    resp: error ? { status: null, kind: 'error', error: { type: error.type, message: error.message }, partial: messages } : messages,
    capture: flow.capture || 'transparent', error: !!error, // 4.8 §5.6, as above
  })
  env.req_body = typeof opener === 'string' || (opener && opener.verbatim === false) ? opener : null // keeps its key position
  const ext = (upgrade.resp.head.headers || []).filter(([k]) => k.toLowerCase() === 'sec-websocket-extensions').map(([, v]) => v)
  return {
    ...env,
    scheme: flow.scheme, dst: flow.dst, proc: flow.proc, flow_id: flow.id, seq,
    req_head_raw: upgrade.req.head.raw.toString('latin1'),
    resp_head_raw: upgrade.resp.head.raw.toString('latin1'),
    ...(opener && typeof opener.b64 === 'string' && !opener.decode_error ? { req_body_b64: opener.b64 } : {}),
    transport: 'ws',
    ws_frames: wsRaw.length ? [wsRaw[0].i, wsRaw[wsRaw.length - 1].i] : null,
    ws_ext: ext.length ? ext.join(', ') : null,
    ws_raw: wsRaw,
    ...(extra.length ? { req_extra_messages: extra } : {}),
    ...(call.partial.length ? { partial: true, partial_reasons: call.partial } : {}),
    ...(call.truncated ? { ws_truncated: true } : {}),
  }
}
