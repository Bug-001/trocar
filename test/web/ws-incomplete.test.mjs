// test/web/ws-incomplete.test.mjs — a WebSocket call's incompleteness labels reach the board (D38; RFC 4.6
// §传输与帧级记录 「不完整的标注,各说一件事」, F5, invariant 4). Product path: the collector's own WebSocket recorder and
// record store write a capture directory, `asight serve` (createServer) answers /api/session from it, and index.html
// renders that JSON. No envelope below is written by hand: partial (a message that could not be decompressed earlier
// on the connection), ws_truncated / {omitted_bytes} (past the cap), {b64, decode_error}, and a non-LLM endpoint's
// {raw_chars, verbatim:false}. None of them renders as complete.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createWsRecorder } from '../../src/collector/core/ws/recorder.mjs'
import { createRecordStore } from '../../src/collector/core/record/store.mjs'
import { wsIncompleteOf } from '../../src/dissect/capture-labels.mjs'
import { createServer } from '../../src/server.mjs'
import { encodeFrame } from '../lab/ws-client.mjs'
import { loadIndex } from '../helpers/frontend.mjs'

const TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }]
const ev = (type, extra = {}) => JSON.stringify({ type, ...extra })
const cli = (op, p, o) => encodeFrame(op, p, o)
const srv = (op, p, o) => encodeFrame(op, p, { mask: false, ...o })
function upgrade(target, session = [['Session-Id', 'ws-session-1']]) {
  const reqH = [['Host', 'api.example.test'], ['Upgrade', 'websocket'], ...session]
  const raw = (line, hs) => `${line}\r\n${hs.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`
  const head = (s, extra) => ({ raw: Buffer.from(s, 'latin1'), startLine: s.split('\r\n')[0], ...extra })
  return { req: { head: head(raw(`GET ${target} HTTP/1.1`, reqH), { method: 'GET', target, headers: reqH }) }, resp: { head: head(raw('HTTP/1.1 101 Switching Protocols', [['Upgrade', 'websocket']]), { status: 101, headers: [['Upgrade', 'websocket']] }) } }
}
// One connection through the real recorder into the real store; returns the envelopes it wrote.
function connection(store, { target = '/v1/responses', maxCallBytes, flow = 'f1', session }, drive) {
  const out = []
  let n = 0
  const r = createWsRecorder({ flow: { id: flow, host: 'api.example.test', scheme: 'https', dst: { address: '10.0.0.1', port: 443, family: 4 }, proc: { pid: 7, exe: '/x/agent', agent: 'agent-x' } },
    upgrade: upgrade(target, session), seqStart: 0, genId: () => `${flow}-${n++}`, isRecording: () => true, terminal: TERMINAL, maxCallBytes,
    recordStore: { envelope: (e) => { out.push(e); return store.envelope(e) }, lastError: null }, onFailure: () => {} })
  drive(r)
  r.end()
  return out
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-wsinc-'))
const store = createRecordStore({ root, onError: (e) => { throw e } })
const E = {}
E.complete = connection(store, {}, (r) => { r.fromClient(cli(1, ev('response.create', { input: 'hi' }))); r.fromUpstream(srv(1, ev('response.completed'))) })[0]
;[E.undecoded, E.partial] = connection(store, { flow: 'f2' }, (r) => {
  r.fromClient(cli(1, ev('response.create', { input: 'a' })))
  r.fromUpstream(srv(1, 'not deflated', { rsv1: true })) // RSV1 with no permessage-deflate agreed: cannot be decoded
  r.fromUpstream(srv(1, ev('response.completed')))
  r.fromClient(cli(1, ev('response.create', { input: 'b' }))); r.fromUpstream(srv(1, ev('response.completed')))
})
E.truncated = connection(store, { flow: 'f3', maxCallBytes: 64 }, (r) => {
  r.fromClient(cli(1, ev('response.create', { input: 'x'.repeat(10) })))
  r.fromUpstream(srv(1, ev('response.output_text.delta', { delta: 'y'.repeat(200) })))
  r.fromUpstream(srv(1, ev('response.completed')))
})[0]
E.meta = connection(store, { flow: 'f4', target: '/v1/realtime-status' }, (r) => { r.fromClient(cli(1, ev('status.get'))); r.fromClient(cli(1, ev('status.get'))) })
// an Anthropic-shaped body on a WebSocket: the board assembles it on the other path (src/view/analyze.mjs)
const CC = JSON.stringify({ model: 'claude-x', max_tokens: 8, system: [{ type: 'text', text: 's' }], tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }] })
E.ccPartial = connection(store, { flow: 'f5', target: '/v1/messages', session: [['X-Claude-Code-Session-Id', 'ws-cc-1']] }, (r) => {
  r.fromClient(cli(1, CC)); r.fromUpstream(srv(1, 'x', { rsv1: true })); r.fromUpstream(srv(1, ev('error')))
  r.fromClient(cli(1, CC)); r.fromUpstream(srv(1, ev('error')))
})[1]
store.close()

const get = (port, p) => new Promise((resolve, reject) => {
  http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))) }).on('error', reject).end()
})
const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: root })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const { port } = server.address()
const projects = await get(port, '/api/projects')
const sess = projects.projects.flatMap((p) => p.sessions).find((s) => s.session_id === 'ws-session-1')
const SESSION = sess ? await get(port, `/api/session?project=${encodeURIComponent(sess.project_slug)}&id=ws-session-1&cursor=0&limit=60`) : null
const ccSess = projects.projects.flatMap((p) => p.sessions).find((s) => s.session_id === 'ws-cc-1')
const CC_SESSION = ccSess ? await get(port, `/api/session?project=${encodeURIComponent(ccSess.project_slug)}&id=ws-cc-1&cursor=0&limit=60`) : null
server.close()
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('wsIncompleteOf: each label the recorder writes, one thing each; complete and HTTP calls are null', () => {
  assert.equal(wsIncompleteOf(E.complete), null)
  assert.equal(wsIncompleteOf({ resp: { partial: { messages: [{ omitted_bytes: 9 }] } } }), null, 'an HTTP envelope is not this label\'s business')
  const u = wsIncompleteOf(E.undecoded)
  assert.deepEqual([u.undecoded, u.partial, u.truncated], [1, true, false], 'the call holding the undecodable message is marked partial too (4.6 §传输: decode-failed)')
  assert.match(u.text, /could not be decompressed: their raw bytes are kept/)
  const p = wsIncompleteOf(E.partial)
  assert.deepEqual([p.partial, p.partialReasons, p.undecoded], [true, ['decode-failed'], 0])
  assert.match(p.text, /context this call relied on is incomplete, its own bytes are whole/)
  const t = wsIncompleteOf(E.truncated)
  assert.deepEqual([t.truncated, t.omitted >= 1, t.partial], [true, true, false])
  const m = wsIncompleteOf(E.meta[0])
  assert.ok(m && m.nonVerbatim >= 1, 'a non-LLM endpoint: non-verbatim')
  assert.match(m.text, /non-LLM endpoint stored as their size only/)
})

test('the board: /api/session carries the labels and where the call is shown it says 不完整 / 已截断 / 未解码 — none renders as complete; both assemblers (F5)', async () => {
  assert.ok(SESSION && SESSION.analyzed, 'precondition: the server assembled the WebSocket session')
  const byId = new Map(SESSION.analyzed.steps.map((s) => [s.id, s]))
  for (const [k, re] of [['undecoded', /未解码/], ['partial', /不完整/], ['truncated', /已截断/]]) {
    const step = byId.get(E[k].id)
    assert.ok(step && step.wsIncomplete, `${k}: the step carries wsIncomplete over HTTP`)
    const t = await loadIndex(SESSION, ['poll', 'setPlayhead', 'anchor'])
    await t.M.poll()
    const i = SESSION.analyzed.steps.indexOf(step)
    t.M.setPlayhead(i, true)
    const shown = t.getEl('rawpanel').innerHTML + t.getEl('ctxwin').innerHTML
    assert.match(shown, re, `${k}: labelled where the call is shown`)
  }
  const complete = byId.get(E.complete.id)
  assert.equal(complete.wsIncomplete, null, 'a complete call carries no label')
  assert.ok(CC_SESSION && CC_SESSION.analyzed, 'precondition: the Anthropic-shaped WebSocket session')
  const cc = CC_SESSION.analyzed.steps.find((x) => x.id === E.ccPartial.id)
  assert.deepEqual(cc && cc.wsIncomplete && cc.wsIncomplete.partialReasons, ['decode-failed'], 'the other assembler carries it too')
})
