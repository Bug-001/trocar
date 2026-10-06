// test/web/resp-incomplete.test.mjs — a response body that was not decoded, is not JSON, is empty or was partly
// parsed reaches the board as a label, never as a normal call with an empty answer (D38; RFC 4.1 落地细节
// (10), invariant 4). Product path: the old reverse proxy's own envelopes (src/capture/reverse-proxy.mjs) are written
// to a capture directory, `asight serve` (createServer) answers /api/session from it, and index.html renders that JSON.
// Both assemblers: Anthropic-shaped calls (src/view/analyze.mjs) and an OpenAI Responses call (src/view/assemble.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'
import { respIncompleteOf } from '../../src/dissect/capture-labels.mjs'
import { createServer } from '../../src/server.mjs'
import { loadIndex } from '../helpers/frontend.mjs'

const listen = async (srv) => { srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); return srv.address().port }
const CC_SID = '7a1b7c2d-0000-4000-8000-0000000000d4'
const OA_SID = 'oa-resp-session-1'
const CC_BODY = JSON.stringify({ model: 'claude-x', max_tokens: 8, system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'q' }] })
const OA_BODY = JSON.stringify({ model: 'gpt-x', instructions: 'i', input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }], stream: true })
// what the upstream answers, per request path suffix
const ANSWERS = {
  undecoded: (res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(Buffer.from('this is not gzip')) },
  notJson: (res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html><body>502 Bad Gateway (from a proxy)</body></html>') },
  empty: (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end() },
  unparsed: (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {not json\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n') },
  complete: (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}') },
}
const up = http.createServer((req, res) => { req.resume(); req.on('end', () => ANSWERS[new URL(req.url, 'http://x').searchParams.get('case')](res)) })
const upPort = await listen(up)
const envelopes = []
const px = createReverseProxy({ target: `http://127.0.0.1:${upPort}`, onEnvelope: (e) => envelopes.push(e), onEvent: () => {} })
const pxPort = await listen(px)
const send = (p, body, headers) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: pxPort, method: 'POST', path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve) })
  r.on('error', resolve); r.end(body)
})
const E = {}
for (const k of ['complete', 'undecoded', 'notJson', 'empty', 'unparsed']) {
  await send(`/v1/messages?case=${k}`, CC_BODY, { 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': CC_SID })
  for (let i = 0; i < 100 && envelopes.length < Object.keys(E).length + 1; i++) await new Promise((r) => setTimeout(r, 10))
  E[k] = envelopes.at(-1)
}
await send('/v1/responses?case=notJson', OA_BODY, { 'session-id': OA_SID })
for (let i = 0; i < 100 && envelopes.length < 6; i++) await new Promise((r) => setTimeout(r, 10))
E.oaNotJson = envelopes.at(-1)
px.close(); up.close()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-respinc-'))
fs.writeFileSync(path.join(root, 'capture.ndjson'), envelopes.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 })
const get = (port, p) => new Promise((resolve, reject) => {
  http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject).end()
})
const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: root })
const port = await listen(server)
const projects = await get(port, '/api/projects')
const sessionOf = async (sid) => { const s = projects.projects.flatMap((p) => p.sessions).find((x) => x.session_id === sid); return s ? get(port, `/api/session?project=${encodeURIComponent(s.project_slug)}&id=${encodeURIComponent(sid)}&cursor=0&limit=60`) : null }
const CC_SESSION = await sessionOf(CC_SID)
const OA_SESSION = await sessionOf(OA_SID)
server.close()
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('respIncompleteOf: one label per response shape the old capture writes; a complete one is null', () => {
  assert.equal(envelopes.length, 6, 'precondition: every request left one envelope')
  assert.equal(respIncompleteOf(E.complete), null)
  assert.deepEqual([respIncompleteOf(E.undecoded).undecoded, E.undecoded.resp.kind], [true, 'sse'], 'a gzip SSE stream that would not decode')
  assert.match(respIncompleteOf(E.undecoded).text, /could not be decompressed .*wire bytes are kept/)
  assert.equal(respIncompleteOf(E.notJson).notJson, true)
  assert.equal(respIncompleteOf(E.empty).empty, true)
  assert.equal(respIncompleteOf(E.unparsed).unparsed, 1)
  assert.deepEqual(respIncompleteOf({ resp: { status: 200, kind: 'json', body: {}, truncated: true, body_bytes: 64 } }), { undecoded: false, binary: false, notJson: false, empty: false, unparsed: 0, truncated: true, bodyBytes: 64, text: 'response: the body was cut at the capture cap: only the first 64 bytes are stored' })
  assert.equal(respIncompleteOf({ transport: 'ws', resp: { kind: 'ws', messages: [] } }), null, 'a WebSocket call is wsIncompleteOf\'s')
})

test('the board: /api/session carries respIncomplete and where the call is shown it says so — both assemblers', async () => {
  assert.ok(CC_SESSION && CC_SESSION.analyzed && OA_SESSION && OA_SESSION.analyzed, 'precondition: the server assembled both sessions')
  const cases = [[CC_SESSION, 'undecoded', /响应未解码/], [CC_SESSION, 'notJson', /响应不是 JSON/], [CC_SESSION, 'empty', /响应为空/], [CC_SESSION, 'unparsed', /响应不完整/], [OA_SESSION, 'oaNotJson', /响应不是 JSON/]]
  for (const [S, k, re] of cases) {
    const step = S.analyzed.steps.find((s) => s.id === E[k].id)
    assert.ok(step && step.respIncomplete, `${k}: the step carries respIncomplete over HTTP`)
    const t = await loadIndex(S, ['poll', 'setPlayhead', 'anchor'])
    await t.M.poll()
    t.M.setPlayhead(S.analyzed.steps.indexOf(step), true)
    assert.match(t.getEl('rawpanel').innerHTML + t.getEl('ctxwin').innerHTML, re, `${k}: labelled where the call is shown`)
  }
  const complete = CC_SESSION.analyzed.steps.find((s) => s.id === E.complete.id)
  assert.equal(complete.respIncomplete, null, 'a complete call carries no label')
})
