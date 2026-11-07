// test/query/failed-rule.test.mjs — one failed rule for the index row and the call row (RFC 3.5 §访问模式; 1.6 C.5 `calls.failed`;
// 3.1 `failed(norm, rec)`): an HTTP model call whose status is absent or ≥ 400 failed; a WebSocket logical call has no HTTP status
// and is not counted failed by the index row; a 200 is not failed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from './raw-home.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { buildTransparentEnvelope, buildWsEnvelope } from '../../src/collector/core/record/envelope.mjs'
import { threadSession } from '../helpers/cc-threads.mjs'
import { sessionDoc } from '../helpers/session-doc.mjs'

const SEG = '20261018T100000Z'
const at = (s) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + s * 1000).toISOString()
const base = { method: 'POST', is_llm_call: true, capture: 'transparent', traffic_class: 'llm', body_wire_bytes: { req: 10, resp: 20 } }
const http = (s, resp) => JSON.stringify({ ...base, ts: at(s), ts_request: at(s), id: `a${s}`, endpoint: '/v1/messages', host: 'api.anthropic.com',
  proc: { pid: 7, exe: '/x/claude', agent: 'claude-code' }, req_headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'S' },
  req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `q${s}` }] }), ...(resp ? { resp } : {}) })
const done = JSON.stringify({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })
const ws = (s) => JSON.stringify({ ...base, ts: at(s), ts_request: at(s), id: `w${s}`, endpoint: '/v1/responses', transport: 'ws', flow_id: 'F', seq: 1, ws_ext: '',
  host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: { 'session-id': 'CX' },
  req_body: '{"type":"response.create","model":"m","input":[]}', resp: { kind: 'ws', messages: ['{"type":"response.created"}', done] } })

const RESP = (status) => ({ status, kind: 'json', body: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 1, output_tokens: 1 } } })

test('3.5 failed rules: status-less and 404 HTTP calls failed; a 200 and a WebSocket logical call not (overview and session rows)', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [http(1, null), http(2, RESP(404)), http(3, RESP(200)), ws(4)])
  await segmentIndex({ home, segment: SEG, owner: true })

  const ov = await runQuery('overview', {}, { home })
  assert.equal(ov.calls.failed, 2)

  const rowsOf = async (id) => (await runQuery('session', { id }, { home })).calls
  const errorOf = (rows) => Object.fromEntries(rows.map((r) => [r.rid.split(':').pop(), !!r.error]))
  const cc = errorOf(await rowsOf('S'))
  assert.deepEqual([cc[1], cc[2], cc[3]], [true, true, false])
  const cx = errorOf(await rowsOf('CX'))
  assert.deepEqual(Object.values(cx), [false])
})

// ── 3.5 ② the reply's own terminal: a cut after a named success is not failed, a named failure is ──────────────────────────────────
// Records as the collector writes them (buildTransparentEnvelope / buildWsEnvelope): a stream cut before the server ended the exchange
// is an error envelope with what arrived under resp.partial. Axes: wire × how the stream ended × whether the client cut it after that.
const flowOf = (agent) => ({ id: 'F', host: 'h', scheme: 'https', dst: {}, proc: { pid: 7, exe: `/x/${agent}`, agent } })
const head = (o) => ({ raw: Buffer.from(''), ...o })
const sse = (events) => events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)).join('')
const CUT = { type: 'ECONNRESET', message: 'the client closed the connection' }
const httpEnv = (s, wire, events, cut) => buildTransparentEnvelope({ id: `h${s}`, flow: flowOf(wire.agent), seq: s,
  req: { head: head({ method: 'POST', target: wire.path, headers: [['content-type', 'application/json'], [wire.session, wire.id]] }), body: Buffer.from(wire.body), truncated: false, tsStart: at(s) },
  resp: { head: head({ status: 200, headers: [['content-type', 'text/event-stream']] }), body: Buffer.from(sse(events)), truncated: false, tsStart: at(s), tsEnd: at(s), ...(cut ? { aborted: true } : {}) },
  error: cut ? CUT : null })
const U = { input_tokens: 7, output_tokens: 3 }
const WIRES = {
  // the DeepSeek harness on the Anthropic wire, Codex on Responses, OpenCode on Chat Completions
  anthropic: { agent: 'dsh', path: '/anthropic/v1/messages', session: 'x-deepseek-harness-session-id', id: 'DS',
    body: JSON.stringify({ model: 'deepseek-x', stream: true, messages: [{ role: 'user', content: 'q' }] }),
    head: [{ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'deepseek-x', content: [], usage: U } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }],
    ends: { success: [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }],
      failure: [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }] } },
  responses: { agent: 'codex', path: '/v1/responses', session: 'session-id', id: 'CX2', body: JSON.stringify({ model: 'gpt-x', stream: true, input: [] }),
    head: [{ type: 'response.created', response: { id: 'r1', status: 'in_progress' } }, { type: 'response.output_text.delta', delta: 'a' }],
    ends: { success: [{ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [], usage: U } }],
      incomplete: [{ type: 'response.incomplete', response: { id: 'r1', status: 'incomplete', output: [], usage: U } }],
      failure: [{ type: 'response.failed', response: { id: 'r1', status: 'failed', output: [], error: { code: 'server_error' } } }] } },
  chat: { agent: 'opencode', path: '/v1/chat/completions', session: 'x-opencode-session-id', id: 'OC', body: JSON.stringify({ model: 'gpt-x', stream: true, messages: [{ role: 'user', content: 'q' }] }),
    head: [{ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'a' } }] }],
    ends: { success: [{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { id: 'c1', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }, 'data: [DONE]\n\n'],
      failure: [{ error: { message: 'upstream failed', type: 'server_error' } }],
      // finish reasons outside the named list: no named terminal, so the record's error alone decides
      unnamedError: [{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }],
      unnamedResource: [{ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'insufficient_system_resource' }] }] } },
}
const SUCCESS = new Set(['success', 'incomplete'])
const FAILURE = new Set(['failure'])

test('3.5 ② the reply\'s own terminal: a cut after a named success reads whole; a named failure fails; anything else keeps the record\'s error', async () => {
  const home = rawHome(), lines = [], want = {}
  let s = 10
  for (const [w, wire] of Object.entries(WIRES)) for (const end of ['none', ...Object.keys(wire.ends)]) for (const cut of [true, false]) {
    if (end === 'none' && !cut) continue
    const n = s++
    lines.push(JSON.stringify(httpEnv(n, wire, [...wire.head, ...(wire.ends[end] || [])], cut)))
    want[n] = { at: `${w} ${end} cut=${cut}`, sid: wire.id, failed: FAILURE.has(end) || (cut && !SUCCESS.has(end)), closed: cut && SUCCESS.has(end), partial: cut && !SUCCESS.has(end) }
  }
  // WebSocket: a connection that ended with an error, a harness that declares no terminal (the collector closes the call on the error)
  const created = JSON.stringify({ type: 'response.created', response: { id: 'w1' } })
  const wsEnds = { success: [created, JSON.stringify({ type: 'response.completed', response: { id: 'w1', status: 'completed', output: [], usage: U } })],
    failure: [created, JSON.stringify({ type: 'response.failed', response: { id: 'w1', status: 'failed', output: [] } })], none: [created] }
  for (const [end, server] of Object.entries(wsEnds)) {
    const n = s++
    lines.push(JSON.stringify(buildWsEnvelope({ id: `w${n}`, seq: n, wsRaw: [], flow: flowOf('pi'), error: CUT,
      upgrade: { req: { head: head({ method: 'GET', target: '/v1/responses', headers: [['session-id', 'PI']] }) }, resp: { head: head({ headers: [] }) } },
      call: { client: ['{"type":"response.create","model":"gpt-x","input":[]}'], server, tsStart: at(n), tsRespStart: at(n), tsEnd: at(n), partial: [], truncated: false } })))
    want[n] = { at: `ws ${end}`, sid: 'PI', failed: end !== 'success', closed: end === 'success', partial: end !== 'success' }
  }
  writeSegment(home, SEG, lines)
  await segmentIndex({ home, segment: SEG, owner: true })

  const ov = await runQuery('overview', {}, { home })
  assert.equal(ov.calls.failed, 0, 'rule ①: every HTTP status is 200')
  const got = {}
  for (const sid of new Set(Object.values(want).map((x) => x.sid))) for (const r of (await runQuery('session', { id: sid }, { home })).calls) got[Number(r.rid.split(':').pop()) + 9] = r
  const bad = []
  for (const [n, x] of Object.entries(want)) {
    const r = got[n], ids = ((r.wire && r.wire.labels) || []).map((l) => l.id)
    if (!!r.error !== x.failed) bad.push(`${x.at}: failed ${!!r.error}`)
    if (x.closed && (r.usage && r.usage.out) !== 3) bad.push(`${x.at}: usage ${JSON.stringify(r.usage)}`)
    if (ids.includes('resp-closed-early') !== x.closed || ids.includes('resp-partial') !== x.partial) bad.push(`${x.at}: labels ${ids}`)
    if (x.failed && /^anthropic failure/.test(x.at) && r.errMsg !== 'Overloaded') bad.push(`${x.at}: errMsg ${r.errMsg}`) // the event's own message says why
  }
  assert.deepEqual(bad, [])
  // the overview's usage rows count failed by the call row's verdict
  const failedRows = ov.usage.rows.reduce((a, r) => a + r.failed, 0)
  assert.equal(failedRows, Object.values(want).filter((x) => x.failed).length)
})

test('3.5 ② a thread call the agent closed after its reply\'s last event hands its successor a whole context and is its cache base', async () => {
  // Claude Code on Message Threads: M0 → M1 → M2, M1's reply whole but the connection closed by the agent before the server ended it
  const s = threadSession()
  const M1 = { ...s.M1, error: true, resp: { kind: 'error', status: 200, error: CUT, partial: s.M1.resp } }
  const [, m1, m2] = (await sessionDoc([s.M0, M1, s.M2], 'sess-threads')).calls
  assert.equal(m1.error, false)
  assert.equal(m2.wire.contextState, 'reconstructed', 'no gap at M2')
  assert.equal(m2.cacheBreak.refRid, m1.rid, 'M2\'s cache base is M1')
  assert.equal(m2.cacheBreak.cause, 'append', 'no cache break at M2')
})
