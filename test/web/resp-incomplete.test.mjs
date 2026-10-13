// test/web/resp-incomplete.test.mjs — a response body that was not decoded, is not JSON, is empty or was partly
// parsed reaches the board as a label, never as a normal call with an empty answer (D38; RFC 4.1 落地细节
// (10), invariant 4). The records are the OLD capture's envelopes, frozen in test/fixtures/old-capture-resp-shapes.ndjson
// (captures on disk keep this shape after the old capture's code is gone, invariant 2): `asight serve` (createServer)
// answers /api/session from them, and index.html renders that JSON. Both assemblers: Anthropic-shaped calls
// (src/view/analyze.mjs) and an OpenAI Responses call (src/view/assemble.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { respIncompleteOf } from '../../src/dissect/capture-labels.mjs'
import { createServer } from '../../src/server.mjs'
import { loadIndex } from '../helpers/frontend.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const listen = async (srv) => { srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); return srv.address().port }
const CC_SID = '7a1b7c2d-0000-4000-8000-0000000000d4'
const OA_SID = 'oa-resp-session-1'
// one envelope per upstream answer, in this order: five /v1/messages calls, then one /v1/responses call
const FIXTURE = fs.readFileSync(new URL('../fixtures/old-capture-resp-shapes.ndjson', import.meta.url), 'utf8')
const envelopes = FIXTURE.trim().split('\n').map((l) => JSON.parse(l))
const E = Object.fromEntries(['complete', 'undecoded', 'notJson', 'empty', 'unparsed', 'oaNotJson'].map((k, i) => [k, envelopes[i]]))

const root = tmpDir('asight-respinc-')
fs.writeFileSync(path.join(root, 'capture.ndjson'), FIXTURE, { mode: 0o600 })
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

test('respIncompleteOf: one label per response shape the old capture writes; a complete one is null', () => {
  assert.equal(envelopes.length, 6, 'precondition: the fixture holds one envelope per answer')
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
