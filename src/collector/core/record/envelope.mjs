// envelope.mjs (collector) — build a transparent-capture D10 envelope on top of the single
// authority src/capture/envelope.mjs::buildEnvelope (never duplicate it). RFC 4.6 §记录: the new
// fields (host/scheme/dst/proc/flow_id/seq/req_head_raw/resp_head_raw, plus req_truncated/
// req_body_bytes/req_partial only when the request body is incomplete) are appended AFTER req_body,
// and raw request/response heads are preserved latin1-verbatim for byte-exact resend (invariant 2).
import { buildEnvelope } from '../../../capture/envelope.mjs'
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
 *   req  = {head:{raw,startLine,headers,method,target}, body, truncated, partial?, tsStart}
 *          partial = 'early-response' | 'aborted' | 'framer-error' when the body never finished
 *   resp = null | {head:{raw,status,headers}, body, truncated, tsStart, tsEnd, aborted?}
 *   error= null | {type, message}
 * A null or aborted response yields error:true with resp.kind:'error' (partial body under resp.partial).
 */
export function buildTransparentEnvelope({ id, flow, seq, req, resp, error = null }) {
  const reqHeaders = lowerHeaders(req.head.headers)
  const haveResp = !!resp && !resp.aborted && !error
  const durationMs = resp && resp.tsStart && resp.tsEnd ? Date.parse(resp.tsEnd) - Date.parse(resp.tsStart) : null

  let shaped
  if (haveResp) {
    shaped = shapeResponse({ status: resp.head.status, headers: resp.head.headers, body: resp.body, truncated: resp.truncated })
  } else {
    shaped = { status: resp && resp.head ? (resp.head.status ?? null) : null, kind: 'error' }
    if (error) shaped.error = { type: error.type, message: error.message }
    if (resp && resp.head) {
      shaped.partial = shapeResponse({ status: resp.head.status, headers: resp.head.headers, body: resp.body, truncated: resp.truncated })
    }
  }

  const env = buildEnvelope({
    id,
    tsRequest: req.tsStart,
    tsRespStart: resp ? resp.tsStart : null,
    tsRespEnd: resp ? resp.tsEnd : null,
    durationMs,
    method: req.head.method,
    endpoint: req.head.target,
    reqBody: req.body,
    reqHeaders,
    resp: shaped,
    capture: 'transparent',
    error: !haveResp,
  })

  // Append the transparent-capture fields AFTER everything buildEnvelope produced (key order matters:
  // the sharder scans the first "req_headers":{ … to "req_body").
  return {
    ...env,
    host: flow.host,
    scheme: flow.scheme,
    dst: flow.dst,
    proc: flow.proc,
    flow_id: flow.id,
    seq,
    req_head_raw: req.head.raw.toString('latin1'),
    resp_head_raw: resp && resp.head && resp.head.raw ? resp.head.raw.toString('latin1') : null,
    // An incomplete request body is labelled in place (invariant 4), mirroring resp.truncated /
    // resp.body_bytes (cap; bytes = stored prefix) and resp.partial (never finished). req_body is a
    // string here, so the labels sit at top level.
    ...(req.truncated ? { req_truncated: true, req_body_bytes: req.body ? req.body.length : 0 } : {}),
    ...(req.partial ? { req_partial: req.partial } : {}),
  }
}

/**
 * buildWsEnvelope({id, flow, seq, upgrade, call, wsRaw, error}) → the envelope of ONE logical WebSocket
 * call (RFC 4.6 §传输与帧级记录, D37). The upgrade is not an envelope of its own: every call carries the
 * upgrade request's headers (req_headers / req_head_raw: the sharder reads a session key there)
 * and the upstream's 101 head (resp_head_raw).
 *   upgrade = {req:{head}, resp:{head}}   the heads as the exchange tee holds them
 *   call    = {client:[v], server:[v], tsStart, tsRespStart, tsEnd, partial:[reason], truncated}
 *     v = a message as stored: its text, {b64}, {b64, decode_error}, {omitted_bytes}, or, for a non-LLM
 *     endpoint's client message, {raw_chars, verbatim:false}. client[0] opened the call; none = a server
 *     message that arrived with no call open.
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
    resp: error ? { status: null, kind: 'error', error: { type: error.type, message: error.message }, partial: messages } : messages,
    capture: 'transparent', error: !!error,
  })
  env.req_body = typeof opener === 'string' || (opener && opener.verbatim === false) ? opener : null // keeps its key position
  const ext = (upgrade.resp.head.headers || []).filter(([k]) => k.toLowerCase() === 'sec-websocket-extensions').map(([, v]) => v)
  return {
    ...env,
    host: flow.host, scheme: flow.scheme, dst: flow.dst, proc: flow.proc, flow_id: flow.id, seq,
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
