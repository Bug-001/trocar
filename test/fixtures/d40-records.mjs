// test/fixtures/d40-records.mjs — hand-built envelopes for the D40 read side (RFC 3.2 §D40, 4.1 #3b / #9, 2.6 #5 / #7, 4.4 #15).
// New fixtures only: test/fixtures/*.ndjson are captured bytes and are never edited. Shapes follow the writers:
//   preD40()      a non-LLM record as the old capture wrote it before D40 — req_body {raw_chars, verbatim:false}, no host /
//                 traffic_class / body_wire_bytes / body_retention (the key set was measured on a live capture, shapes only)
//   full()        what buildEnvelope writes now (src/capture/envelope.mjs): the body verbatim, host, traffic_class, body_wire_bytes
//   logged()      the same call at the `log` level: {raw_chars, verbatim:false} bodies + body_retention:'log', headers kept
// `at` is the call's time; `id` its record id. Everything else is a plain override.

export const HOST = 'api.anthropic.com'
const UA = { 'user-agent': 'claude-cli/2.1.0 (external, cli)', host: HOST }
const T = (s) => `2026-10-06T10:00:${String(s).padStart(2, '0')}.000Z`

// a transparent-collector record carries proc; the old capture paths do not
export const PROC = { pid: 4242, exe: '/usr/local/bin/claude', agent: 'claude-code' }

export function preD40({ id, at = 1, endpoint = '/api/event_logging/v2/batch', rawChars = 4321, headers = UA, resp = { status: 200, kind: 'json', body: { accepted_count: 3 } } } = {}) {
  return { id, ts: T(at), ts_request: T(at), ts_response_start: T(at), ts_response_end: T(at), duration_ms: 120, method: 'POST', endpoint,
    is_llm_call: false, capture: 'mitm', auth_mode: 'oauth', error: false, req_headers: headers, req_body: { raw_chars: rawChars, verbatim: false }, resp }
}

// a D40 record. `reqBody` is the wire text (or null with `reqB64`), wire = [req, resp] byte counts.
export function full({ id, at = 1, endpoint = '/api/event_logging/v2/batch', host = HOST, cls = 'telemetry', reqBody = '{"events":[{"name":"tengu_start"}]}', reqB64 = null,
  wire = [reqBody == null ? 0 : Buffer.byteLength(reqBody), 12], resp = { status: 200, kind: 'json', body: { accepted_count: 1 } }, headers = UA, proc = PROC, llm = false, extra = {} } = {}) {
  return { id, ts: T(at), ts_request: T(at), ts_response_start: T(at), ts_response_end: T(at), duration_ms: 80, method: 'POST', endpoint,
    is_llm_call: llm, capture: 'transparent', auth_mode: 'oauth', error: false, req_headers: headers, req_body: reqBody,
    ...(reqB64 != null ? { req_body_b64: reqB64 } : {}),
    ...(proc ? { proc } : {}), host, traffic_class: cls, body_wire_bytes: { req: wire[0], resp: wire[1] }, resp: { ...resp, request_id: null }, ...extra }
}

export function logged({ id, at = 1, endpoint = '/api/event_logging/v2/batch', host = HOST, cls = 'telemetry', wire = [900, 12], llm = false, headers = UA, proc = PROC, status = 200 } = {}) {
  return { id, ts: T(at), ts_request: T(at), ts_response_start: T(at), ts_response_end: T(at), duration_ms: 80, method: 'POST', endpoint,
    is_llm_call: llm, capture: 'transparent', auth_mode: 'oauth', error: false, req_headers: headers, req_body: { raw_chars: wire[0], verbatim: false },
    ...(proc ? { proc } : {}), host, traffic_class: cls, body_wire_bytes: { req: wire[0], resp: wire[1] }, body_retention: 'log',
    resp: { status, kind: 'json', headers: { 'content-type': 'application/json' }, request_id: null, raw_chars: wire[1], verbatim: false } }
}

// a session-keyed inference call (Anthropic wire) — `sid` is the Claude Code session header
export const inference = ({ id, at = 1, sid = 'S-d40', text = 'hello', wire = null, retention = null, headers = {} } = {}) => {
  const req = JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const h = { ...UA, 'x-claude-code-session-id': sid, ...headers }
  if (retention === 'log') return logged({ id, at, endpoint: '/v1/messages', cls: 'llm', llm: true, headers: h, wire: wire || [req.length, 300] })
  return full({ id, at, endpoint: '/v1/messages', cls: 'llm', llm: true, headers: h, reqBody: req, wire: wire || [Buffer.byteLength(req), 300],
    resp: { status: 200, kind: 'sse', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } })
}

// one NDJSON line of a record, the way the writers append it
export const line = (rec) => JSON.stringify(rec) + '\n'
