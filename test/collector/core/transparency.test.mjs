// transparency.test.mjs — end-to-end byte-transparency regression (RFC 4.6 acceptance T1/T2/T4).
// Drives the mock upstream (test/lab/mock-upstream/, from branch test/mock-upstream-tls) through
// the real engine with decrypt:true and asserts, per scenario, that the engine neither changed the
// request bytes the upstream saw nor the response bytes the client received, emitted exactly one
// envelope, flagged transport faults as errors, and reconstructed split multibyte text.
//
// NOTE: depends on the mock upstream branch (test/mock-upstream-tls) landing first; the mock files under
// test/lab/mock-upstream/ are an untracked helper here (see .git/info/exclude), not committed.
import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startMockUpstream } from '../../lab/mock-upstream/server.mjs'
import { makeLabCa } from '../../lab/mock-upstream/lab-ca.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const HOST = 'api.anthropic.com'
const SCENARIOS = ['ok', 'long-stream', 'unicode-split', 'gzip', 'content-length', 'conn-close', 'http-429', 'http-502-html', 'mid-stream-reset', 'mid-stream-fin']
const FAULTS = new Set(['mid-stream-reset', 'mid-stream-fin']) // only these truncate the response → error envelope
const b64 = (s) => Buffer.from(s, 'base64').toString('latin1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every wait here is bounded (test/helpers/bounded.mjs): the client's close, the engine's close, and the test itself, so a
// failure is a failure and not a file that never finishes under --test-force-exit.
test('byte transparency across mock scenarios', { timeout: 60_000 }, async (t) => {
  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-ca-'))
  const lab = makeLabCa(caDir)
  const mock = await startMockUpstream({ tls: { key: fs.readFileSync(lab.key), cert: fs.readFileSync(lab.cert) }, delays: { stallMs: 200, dripMs: 5 } })
  const trocarCa = createCa()
  const envelopes = []
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 1, agent: 'claude-code', decrypt: true })
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: fs.readFileSync(lab.caCert), store: { envelope: (e) => envelopes.push(e), flow() {} } })
  const { port } = await engine.listen({})
  // The mock goes first: its sockets go, so every flow still open ends (engine.close() waits for them, never destroys one).
  t.after(async () => {
    try { await mock.close(); await closeWithin(engine) }
    finally { fs.rmSync(caDir, { recursive: true, force: true }) }
  })

  for (const name of SCENARIOS) {
    envelopes.length = 0
    const body = JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: `hi [[mock:${name}]]` }] })
    const reqRaw = `POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nAnthropic-Version: 2023-06-01\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    let c
    const got = await within(new Promise((resolve) => {
      c = tls.connect({ port, host: '127.0.0.1', servername: HOST, ca: trocarCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(reqRaw))
      let b = Buffer.alloc(0); c.on('data', (d) => { b = Buffer.concat([b, d]) })
      c.on('close', () => resolve(b)); c.on('error', () => {})
    }), 15_000, `${name}: the client never saw its connection close`, () => c.destroy())
    // wait for the envelope (faults emit it on teardown, just after the client's close)
    for (let i = 0; i < 100 && envelopes.length === 0; i++) await sleep(5)
    const entry = mock.state.log.filter((e) => e.type === 'request' && e.scenario === name).at(-1)
    assert.ok(entry, `${name}: mock logged the request`)
    // T1: the upstream saw exactly the bytes the client wrote, and the client received exactly the
    // bytes the upstream wrote (byte-for-byte, no re-chunk / re-case / re-encode).
    assert.equal(b64(entry.req_raw_b64), reqRaw, `${name}: request bytes verbatim`)
    assert.equal(got.toString('latin1'), b64(entry.resp_raw_b64), `${name}: response bytes verbatim`)
    // one envelope per request; T2: a truncated response is flagged error, nothing else is
    assert.equal(envelopes.length, 1, `${name}: exactly one envelope`)
    assert.equal(!!envelopes[0].error, FAULTS.has(name), `${name}: error flag matches fault`)
    // T4: a multibyte character split across chunks/records is reconstructed intact
    if (name === 'unicode-split') assert.ok(envelopes[0].resp.text.includes('你好🙂'), 'unicode-split reconstructed')
  }
})
