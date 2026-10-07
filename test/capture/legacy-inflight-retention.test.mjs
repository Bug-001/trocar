// test/capture/legacy-inflight-retention.test.mjs — RFC 4.1 验收 #3e「在途的按旧值」 for the OLD capture (D40 audit finding 偷懒): the retention level of
// a call is sampled when its REQUEST starts, in the reverse proxy and in the MITM, and the call keeps that level to its end — a change of the
// setting between the request and the response reaches only the calls that start after it. The collector side was guarded by
// test/collector/core/exchange.test.mjs; on the old paths moving the sample to the response start in mitm.mjs or reverse-proxy.mjs left every
// test green (mutations M30 / M31). A call stored half at one level and half at the other — a full request with a log-line reply — is the
// failure this pins: neither level, and a body stored for a call the operator had already set to not keep.
import test from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_PATHS } from '../helpers/legacy-paths.mjs'

const T = { timeout: 30_000 }
const BODY = '{"events":[{"name":"tengu_start"}]}'
const REPLY = '{"accepted":1}'

// an upstream that holds each response until the test releases it, and says when a request has reached it
function slowUpstream() {
  const waiting = new Map(), reached = new Map()
  const gate = (key) => { if (!waiting.has(key)) { let r; waiting.set(key, { p: new Promise((ok) => { r = ok }), release: () => r() }) } return waiting.get(key) }
  const arrived = (key) => { if (!reached.has(key)) { let r; reached.set(key, { p: new Promise((ok) => { r = ok }), fire: () => r() }) } return reached.get(key) }
  const handler = (req, res) => {
    req.resume()
    req.on('end', () => {
      const key = new URL(req.url, 'http://x').searchParams.get('k')
      arrived(key).fire()
      gate(key).p.then(() => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(REPLY) }); res.end(REPLY) })
    })
  }
  return { handler, release: (k) => gate(k).release(), reachedUpstream: (k) => arrived(k).p }
}
const waitEnvelope = async (p, key) => { for (let i = 0; i < 300; i++) { const e = p.envelopes.find((x) => x.endpoint.includes(`k=${key}`)); if (e) return e; await new Promise((r) => setTimeout(r, 10)) } throw new Error(`no envelope for ${key}`) }

for (const start of LEGACY_PATHS) {
  const name = start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'
  test(`${name}: a call keeps the level it started with — a setting changed while its response is on the way reaches the next call, never half of this one (4.1 #3e)`, T, async () => {
    const up = slowUpstream()
    let level = 'full'
    const seen = []
    const p = await start(up.handler, { retention: (q) => { seen.push([q.endpoint, level]); return { class: 'telemetry', level } } })
    try {
      const post = (key) => p.send({ method: 'POST', path: `/api/event_logging/v2/batch?k=${key}`, headers: { 'content-type': 'application/json' }, body: BODY })
      // started at full, set to log while the upstream still holds the response
      const a = post('a'); await up.reachedUpstream('a'); level = 'log'; up.release('a')
      assert.equal((await a).body.toString(), REPLY, 'the client got the reply')
      const A = await waitEnvelope(p, 'a')
      assert.deepEqual([A.req_body, 'body_retention' in A, A.resp.kind, A.resp.body], [BODY, false, 'json', { accepted: 1 }], 'started at full: request AND reply are full, whatever the setting is now')
      // the next call starts after the change: log
      const b = post('b'); await up.reachedUpstream('b'); up.release('b'); await b
      const B = await waitEnvelope(p, 'b')
      assert.deepEqual([B.body_retention, B.req_body, B.resp.verbatim, 'body' in B.resp], ['log', { raw_chars: BODY.length, verbatim: false }, false, false])
      // and the other direction: started at log, set to full on the way — still a log line, no half-stored body
      const c = post('c'); await up.reachedUpstream('c'); level = 'full'; up.release('c'); await c
      const C = await waitEnvelope(p, 'c')
      assert.deepEqual([C.body_retention, C.req_body, C.resp.verbatim, 'body' in C.resp, 'raw' in C.resp], ['log', { raw_chars: BODY.length, verbatim: false }, false, false, false], 'started at log: still log at its end')
      assert.deepEqual(seen.map(([, l]) => l), ['full', 'log', 'log'], 'the callback was asked once per request, at its start (not again at the response)')
    } finally { p.stop() }
  })
}
