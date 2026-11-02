// test/dissect/labels-english.test.mjs — 2.6 (D58): every capture label the board receives is plain English. Each envelope flag the
// label producers read is one axis; every axis alone and all of them together go through the producers AND through the two board
// paths (the replay's sessionView, the request detail's controlRecordWire), and no `label` / `text` that comes out holds CJK.
// The wording itself is not a contract (the board keys on ids), so only the script is asserted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureLabelsOf, reqIncompleteOf, wsIncompleteOf, respIncompleteOf, retentionLabelOf } from '../../src/dissect/capture-labels.mjs'
import { HARNESSES } from '../../src/dissect/harnesses.mjs'
import { sessionView } from '../helpers/session-view.mjs'
import { controlRecordWire } from '../../src/view/control-wire.mjs'

const CJK = /[　-〿㐀-鿿＀-￯]/
const stream = (r) => Object.defineProperty(r, '_stream', { value: 'capture-2026-10-21.ndjson', enumerable: false })

const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-x","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
const http = (o = {}) => ({ id: 'h', ts_request: '2026-10-21T00:00:00Z', method: 'POST', endpoint: '/v1/messages', is_llm_call: true, capture: 'transparent',
  host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1.0' },
  req_body: '{"model":"claude-x","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}', body_wire_bytes: { req: 80, resp: 120 },
  resp: { status: 200, kind: 'sse', raw: SSE }, ...o })
const ws = (o = {}) => ({ id: 'w', ts_request: '2026-10-21T00:00:00Z', is_llm_call: true, endpoint: '/v1/responses', transport: 'ws', flow_id: 'F', seq: 1,
  ws_ext: '', capture: 'transparent', host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: { 'session-id': 'S' },
  req_body: '{"type":"response.create","model":"m","input":[]}',
  resp: { kind: 'ws', messages: ['{"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}'] }, ...o })

// one axis per envelope flag (or closed value) a label producer reads
const HTTP_AXES = {
  respTruncated: { resp: { status: 200, kind: 'sse', raw: SSE, truncated: true, body_bytes: 10 } },
  respPartial: { resp: { kind: 'error', status: null, error: { type: 'ECONNRESET' }, partial: { kind: 'sse', raw: SSE } } },
  respUndecoded: { resp: { status: 200, kind: 'text', raw_b64: 'AAEC', encoding_error: 'bad gzip' } },
  respBinary: { resp: { status: 200, kind: 'sse', raw_b64: 'AAEC' } },
  respNotJson: { resp: { status: 200, kind: 'text', raw: 'oops' } },
  respEmpty: { resp: { status: 200, kind: 'empty' } },
  respUnparsed: { resp: { status: 200, kind: 'sse', raw: SSE, unparsed_events: 2 } },
  respReserialized: { body_wire_bytes: undefined, resp: { status: 200, kind: 'json', body: { content: [], usage: {} } } },
  reqUndecoded: { req_body: null, req_body_b64: 'AAEC', req_content_encoding: 'zstd', req_encoding_error: 'bad zstd' },
  proxy: { capture: 'proxy' },
  trocarAdded: { trocar_added: ['connection-close'] },
  reqTruncated: { req_truncated: true, req_body_bytes: 40 },
  reqTruncatedNoSize: { req_truncated: true },
  ...Object.fromEntries(['early-response', 'aborted', 'framer-error', 'something-new'].map((p) => [`reqPartial:${p}`, { req_partial: p }])),
  log: { is_llm_call: false, body_retention: 'log', traffic_class: 'telemetry', req_body: { raw_chars: 9, verbatim: false } },
  legacyMeta: { is_llm_call: false, capture: 'mitm', proc: undefined, req_body: { raw_chars: 9, verbatim: false } },
}
const WS_AXES = {
  partial: { partial: true, partial_reasons: ['earlier-dropped'] },
  partialNoReason: { partial: true },
  wsTruncated: { ws_truncated: true },
  omitted: { resp: { kind: 'ws', messages: [{ omitted_bytes: 70000000 }] } },
  undecodedMsg: { resp: { kind: 'ws', messages: [{ b64: 'AAEC', decode_error: 'inflate' }, '{"type":"response.created"}'] } },
  openerUndecoded: { req_body: null, partial_reasons: ['decode-failed'], ws_raw: [{ d: 'c', h: 'gQ==' }] },
  nonVerbatimLegacy: { is_llm_call: false, req_body: { raw_chars: 9, verbatim: false } },
  nonVerbatimLog: { is_llm_call: false, body_retention: 'log', req_body: { raw_chars: 9, verbatim: false } },
  replyUnread: { resp: { kind: 'ws', messages: ['{"type":"response.created"}', { b64: 'AAEC' }, 'not json'] } },
}
const variants = (make, axes) => [
  ...Object.entries(axes).map(([k, o]) => [k, make(o)]),
  ['all', make(Object.values(axes).reduce((a, o) => ({ ...a, ...o }), {}))],
]

const said = []
const collect = (where, x) => { if (typeof x === 'string') said.push([where, x]) }
const fromLabels = (where, labels) => { for (const l of labels || []) { collect(`${where} ${l.id} label`, l.label); collect(`${where} ${l.id} text`, l.text) } }
const fromStep = (where, s) => {
  if (!s) return
  fromLabels(where, s.wire && s.wire.labels)
  for (const e of (s.wire && s.wire.observerEffect) || []) { collect(`${where} effect`, e.what); collect(`${where} effect`, e.cause) }
}

test('2.6 / D58 — no capture label, label text or observer effect the board receives holds CJK', () => {
  for (const [name, rec] of [...variants(http, HTTP_AXES), ...variants(ws, WS_AXES)]) {
    const where = `${rec.transport || 'http'}:${name}`
    fromLabels(`${where} captureLabelsOf`, captureLabelsOf(rec))
    for (const [fn, f] of [['reqIncompleteOf', reqIncompleteOf], ['wsIncompleteOf', wsIncompleteOf], ['respIncompleteOf', respIncompleteOf], ['retentionLabelOf', retentionLabelOf]]) {
      const out = f(rec)
      if (out) { collect(`${where} ${fn} label`, out.label); collect(`${where} ${fn} text`, out.text) }
    }
    const ctl = controlRecordWire(stream({ ...rec }))
    fromLabels(`${where} controlRecordWire`, ctl && ctl.ctl && ctl.ctl.labels)
    const view = sessionView([stream({ ...rec })], 'S')
    for (const s of (view && view.analyzed && view.analyzed.steps) || []) fromStep(`${where} sessionView`, s)
  }
  for (const h of HARNESSES) for (const e of h.observerEffects || []) { collect(`${h.id} effect`, e.what); collect(`${h.id} effect`, e.cause) }
  // the table reaches every producer: a label from each id the board can receive
  const ids = new Set(said.map(([w]) => w.split(' ')[2]).filter(Boolean))
  for (const id of ['resp-truncated', 'resp-partial', 'resp-undecoded', 'ws-truncated', 'req-undecoded', 'capture-routing', 'trocar-added',
    'retention-log', 'retention-legacy-meta', 'resp-json-reserialized', 'req-incomplete', 'reply-unread']) assert.ok(ids.has(id), `no variant reached ${id}`)
  const cjk = said.filter(([, s]) => CJK.test(s))
  assert.deepEqual(cjk, [], 'labels with CJK')
})
