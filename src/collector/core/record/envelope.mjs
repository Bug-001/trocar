// envelope.mjs (collector) — build a transparent-capture D10 envelope on top of the single
// authority src/capture/envelope.mjs::buildEnvelope (never duplicate it). RFC 4.6 §记录: the new
// fields (host/scheme/dst/proc/flow_id/seq/req_head_raw/resp_head_raw, and req_truncated/
// req_body_bytes only when the request body hit the cap) are appended AFTER req_body,
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
 *   req  = {head:{raw,startLine,headers,method,target}, body, truncated, tsStart}
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
    // A request body cut at the engine's cap is labelled in place (invariant 4), mirroring
    // resp.truncated / resp.body_bytes; req_body is a string here, so the label sits at top level.
    ...(req.truncated ? { req_truncated: true, req_body_bytes: req.body ? req.body.length : 0 } : {}),
  }
}
