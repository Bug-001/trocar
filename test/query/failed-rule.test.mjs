// test/query/failed-rule.test.mjs — one failed rule for the index row and the call row (RFC 3.5 §访问模式; 1.6 C.5 `calls.failed`;
// 3.1 `failed(norm, rec)`): an HTTP model call whose status is absent or ≥ 400 failed; a WebSocket logical call has no HTTP status
// and is not counted failed by the index row; a 200 is not failed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from './raw-home.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { runQuery } from '../../src/query/named/index.mjs'

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
