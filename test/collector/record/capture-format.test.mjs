// capture-format.test.mjs — the record is one format whichever way the call reached the engine (the data format is the same on every platform;
// RFC 4.8 §5.6; acceptance W14 here and W18: the reader takes both `capture` values, transparent and proxy (D43).
// The same exchange (a JSON call and an SSE call on one TLS connection, to one origin) goes through the transparent door (what Linux
// uses) and through the proxy ingress (what the Windows proxy mode uses). The envelopes must be equal except for the
// fields that are about the route: time, ids, `capture`, `dst`, `proc.pid`, `proc.exe`. The connection rows of a direct upstream must be
// equal except for what the ingress adds (`ingress`, `pid_source`, `pid_ms`, `upstream`).
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { buildTransparentEnvelope } from '../../../src/collector/core/record/envelope.mjs'
import { runEtl } from '../../../src/etl/orchestrator.mjs'
import { freshConn } from '../../etl/helpers.mjs'
import { harnessOf, observerEffectsOf } from '../../../src/dissect/harnesses.mjs'
import { captureLabelsOf } from '../../../src/dissect/capture-labels.mjs'
import { CAPTURE_KINDS } from '../../../src/health/codes.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const T = { timeout: 30_000 }
const TOKEN = 'abcdef0123456789abcdef0123456789'
const asightCa = createCa(), originCa = createCa({ commonName: 'W14 origin CA' })
const originIssuer = createLeafIssuer(loadCa(originCa))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))

// The origin answers with fixed bytes (no Date header, no ids): a JSON reply, and an SSE reply in two chunks.
const JSON_BODY = JSON.stringify({ id: 'msg_fixed', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } })
const SSE = ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n']
const chunked = (s) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`
function origin(t) {
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, originIssuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => {
    let buf = Buffer.alloc(0); s.on('error', () => {})
    s.on('data', async (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return
        const head = buf.subarray(0, i).toString('latin1'), n = Number(/content-length: *(\d+)/i.exec(head)?.[1] || 0)
        if (buf.length < i + 4 + n) return
        const body = buf.subarray(i + 4, i + 4 + n).toString(); buf = buf.subarray(i + 4 + n)
        if (JSON.parse(body).stream) {
          s.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ntransfer-encoding: chunked\r\n\r\n')
          for (const ev of SSE) { s.write(chunked(ev)); await sleep(5) }
          s.write('0\r\n\r\n')
        } else s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(JSON_BODY)}\r\n\r\n${JSON_BODY}`)
      }
    })
  })
  return listen(srv).then(() => { t.after(() => srv.close()); return srv.address().port })
}
const callBody = (stream) => JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, stream, messages: [{ role: 'user', content: stream ? 'stream me' : 'hello' }] })
const call = (stream) => { const b = callBody(stream); return `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nx-api-key: sk-ant-FAKE\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}` }
// the agent: two calls on one TLS connection, read to the end of each response
function agent(socket) {
  return within(new Promise((resolve, reject) => {
    const c = tls.connect({ socket, servername: 'api.anthropic.com', ca: asightCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(call(false)))
    let got = '', phase = 0
    c.on('data', (d) => {
      got += d.toString('latin1')
      if (phase === 0 && got.endsWith(JSON_BODY)) { phase = 1; got = ''; c.write(call(true)) }
      else if (phase === 1 && got.endsWith('0\r\n\r\n')) { phase = 2; c.end() }
    })
    c.on('error', reject); c.on('close', () => resolve(phase))
  }), 10_000, 'the agent\'s two calls', () => socket.destroy())
}

// the volatile and route-bound fields: time (ts*, duration_ms), ids, and what the route decides (capture, dst, proc.pid, proc.exe)
const strip = (env) => {
  const e = structuredClone(env)
  for (const k of Object.keys(e)) if (k.startsWith('ts')) delete e[k]
  for (const k of ['id', 'flow_id', 'seq', 'capture', 'dst', 'duration_ms']) delete e[k]
  if (e.proc) { delete e.proc.pid; delete e.proc.exe }
  return e
}
const stripRow = (row, extra = []) => { const r = structuredClone(row); for (const k of ['ts', 'flow_id', 'duration_ms', 'dst', 'pid', ...extra]) delete r[k]; return r }

async function run(t, door, capture, retention = null) {
  const port = await origin(t)
  const envelopes = [], flows = [], failures = []
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port, family: 4 }, pid: 4242, agent: 'claude-code', decrypt: true })
  const meta = { pid: 4242, agent: 'claude-code', decrypt: true, capture, form: 'claude-code.cli', pid_source: 'socket-table', pid_ms: 4, negKey: '4242', upstream: { kind: 'direct' } }
  redirector.setIngress('of.claude-code.cli', meta)
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: originCa.certPem, ingressToken: TOKEN,
    store: { envelope: (e) => { envelopes.push(structuredClone(e)); return { ok: true, id: `20261007T000000Z:${envelopes.length}` } }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: (f) => failures.push(f), retention,
  })
  const { port: enginePort, ingressPort } = await engine.listen({ ingress: door === 'ingress' ? { port: 0 } : null })
  t.after(() => closeWithin(engine))
  let socket
  if (door === 'ingress') {
    socket = net.connect(ingressPort, '127.0.0.1'); socket.on('error', () => {})
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: Basic ${Buffer.from(`of.claude-code.cli:${TOKEN}`).toString('base64')}\r\n\r\n`)
    await within(new Promise((res) => { let b = ''; const on = (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { socket.removeListener('data', on); assert.match(b, /^HTTP\/1\.1 200 /); res() } }; socket.on('data', on) }), 4000, 'the 200')
  } else { socket = net.connect(enginePort, '127.0.0.1'); socket.on('error', () => {}) }
  assert.equal(await agent(socket), 2, 'both calls were answered')
  for (let i = 0; i < 400 && (flows.length < 1 || envelopes.length < 2); i++) await sleep(10)
  assert.deepEqual(failures, [])
  return { envelopes, flows, port }
}

test('W14 the same calls through the transparent door and through the ingress: the envelopes are equal bar the route\'s own fields', T, async (t) => {
  const base = await run(t, 'transparent', 'transparent')
  assert.equal(base.envelopes.length, 2); assert.deepEqual(base.envelopes.map((e) => [e.seq, e.is_llm_call, e.method, e.endpoint]), [[0, true, 'POST', '/v1/messages'], [1, true, 'POST', '/v1/messages']])
  assert.equal(base.envelopes[1].resp.kind, 'sse', 'the SSE call is a real stream, parsed as one'); assert.ok(base.envelopes[0].req_head_raw.startsWith('POST /v1/messages HTTP/1.1\r\n'), 'verbatim heads')
  // One run through the ingress, not one per `capture` value: `strip` removes the field (this test is about everything else),
  // and the value itself is asserted by the test below — a second run with another value would be the same run again.
  {
    const capture = 'proxy', via = await run(t, 'ingress', capture)
    assert.deepEqual(via.envelopes.map(strip), base.envelopes.map(strip), 'the envelopes, minus ts*, ids, capture, dst, proc.pid, proc.exe')
    assert.deepEqual(via.envelopes.map((e) => e.proc.agent), ['claude-code', 'claude-code'])
    assert.deepEqual(via.envelopes[0].dst, { address: '127.0.0.1', port: via.port, family: 4 }, 'dst is the target the proxy client asked for (a route field: not part of the comparison)')
    // the connection row of a direct upstream: the same, bar what the ingress adds. The agent's own wire bytes are the same too: the CONNECT and asight's
    // answers are not counted (4.8 §5.6).
    const [row] = via.flows, [baseRow] = base.flows
    assert.deepEqual(stripRow(row, ['ingress', 'pid_source', 'pid_ms', 'upstream', 'bytes_down']), stripRow(baseRow, ['bytes_down']), 'the connection row, minus ingress, pid_source, pid_ms, upstream')
    // bytes_down carries the leaf's ECDSA signature, whose DER length varies by a byte or two from handshake to handshake; the 39-byte \`200 Connection established\`
    // the ingress said is far outside that, so a count that included it would show here
    assert.ok(Math.abs(row.bytes_down - baseRow.bytes_down) <= 4, `bytes_down ${row.bytes_down} vs ${baseRow.bytes_down}: the agent's own bytes, not the ingress's answer`)
    assert.deepEqual([row.ingress, row.pid_source, row.pid_ms, row.upstream], [{ route: 'of', group: 'claude-code.cli' }, 'socket-table', 4, { kind: 'direct' }])
    assert.equal('prelude' in row, false)
    assert.deepEqual(Object.keys(baseRow).filter((k) => ['ingress', 'pid_source', 'pid_ms', 'upstream'].includes(k)), [], 'the transparent row has none of them: Linux rows are unchanged')
  }
})

// What the envelope says about how the call reached the engine (4.8 §5.6, invariant 4). The ingress's meta carries `capture`, `flow.mjs`'s startTee hands it to the
// exchange recorder inside the flow, and the envelope builder takes it from there (the literal 'transparent' stood before Task 2(b)): a Windows call says `proxy`.
// HARD DEPENDENCY OF TASK 8: the daemon wiring that puts Windows data on disk must not land while an ingress call is still labelled transparent (plan Task 8,
// a known seam) — the daemon-path test goes green only through this one.
test('W14 (Task 2(b)) an envelope that came through the ingress carries the capture value its meta says: proxy', T, async (t) => {
  assert.deepEqual(CAPTURE_KINDS, ['transparent', 'proxy'], 'the closed set the envelope draws its capture value from (4.1 信封表; codes.test.mjs holds it too)')
  for (const capture of ['proxy']) {
    const via = await run(t, 'ingress', capture)
    assert.deepEqual(via.envelopes.map((e) => e.capture), [capture, capture], `${capture}: the envelope says how the call reached the engine`)
  }
  assert.deepEqual((await run(t, 'transparent', 'transparent')).envelopes.map((e) => e.capture), ['transparent', 'transparent'], 'and a transparent call still says so (a meta with no capture keeps the default)')
})

// W18 (4.8 §5.6 读取侧): the read side of BOTH capture values. The envelopes are built directly (buildTransparentEnvelope,
// the same builder the engine's tee calls): the engine path is W14 above, this is the reader's half — a proxy envelope with
// `proc.pid:null` (the no-pid meta of 4.8 §5.2) is one calls row in DuckDB, the observer-effect table applies to proxy as to
// transparent, and the board labels the routing in place. Nothing in the reader may treat a pid of null or a proxy capture as
// an error or a missing record (3.4 never splits or joins a session by pid).
const W18_BODY = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'w18' }] })
const W18_REPLY = JSON.stringify({ id: 'msg_w18', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, output_tokens: 1 } })
function envelopeOf(capture, pid) {
  const rh = [['Host', 'api.anthropic.com'], ['x-claude-code-session-id', 'sess-w18'], ['user-agent', 'claude-cli/1.0'], ['x-api-key', 'sk-ant-FAKE'], ['Content-Type', 'application/json'], ['Content-Length', String(Buffer.byteLength(W18_BODY))]]
  const sh = [['content-type', 'application/json'], ['content-length', String(Buffer.byteLength(W18_REPLY))]]
  return buildTransparentEnvelope({
    id: `env-${capture}-${pid ?? 'nopid'}`, seq: 0,
    flow: { id: `flow-${capture}-${pid ?? 'nopid'}`, host: 'api.anthropic.com', scheme: 'https', dst: { address: '93.184.216.34', port: 443, family: 4 }, proc: { pid: pid ?? null, exe: pid != null ? 'C:\\Users\\u\\app\\node.exe' : null, agent: 'claude-code' }, capture },
    req: { head: { raw: Buffer.from(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(W18_BODY)}\r\n\r\n`, 'latin1'), startLine: 'POST /v1/messages HTTP/1.1', headers: rh, method: 'POST', target: '/v1/messages' },
      body: Buffer.from(W18_BODY), truncated: false, tsStart: '2026-10-08T00:00:00.000Z' },
    resp: { head: { raw: Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(W18_REPLY)}\r\n\r\n`, 'latin1'), status: 200, headers: sh },
      body: Buffer.from(W18_REPLY), truncated: false, tsStart: '2026-10-08T00:00:01.000Z', tsEnd: '2026-10-08T00:00:02.000Z' },
  })
}
test('W18 the read side of both capture kinds: a pid-null proxy envelope ETLs to one calls row, the effect table and the routing label cover both', T, async () => {
  for (const [capture, pid] of [['proxy', null], ['transparent', 4242]]) {
    const env = envelopeOf(capture, pid)
    assert.equal(env.capture, capture, 'the builder writes the meta\'s capture value')
    assert.equal(harnessOf(env).id, 'cc', 'the read-side harness table names the harness from proc.agent alone — a pid of null is no exception')
    const conn = await freshConn()
    const stats = await runEtl([env], conn)
    assert.equal(stats.quarantined, 0, `${capture}: the reader claims the envelope`)
    const n = Number((await conn.runAndReadAll('SELECT count(*) AS n FROM calls')).getRowObjects()[0].n)
    assert.equal(n, 1, `${capture}: one calls row in DuckDB (proc.pid ${pid})`)
  }
  // the observer-effect table applies to both kinds (4.8 §5.6); a legacy capture stays the control group
  const cc = (capture) => ({ proc: { pid: 4242, exe: '/x/node', agent: 'claude-code' }, capture })
  assert.deepEqual(observerEffectsOf(cc('proxy')), observerEffectsOf(cc('transparent')), 'the same effects for a proxy call')
  assert.deepEqual((observerEffectsOf(cc('proxy')) || []).map((e) => e.id), ['cc-gzip-off'], 'a proxy call carries its effect')
  assert.equal(observerEffectsOf({ ...cc('proxy'), capture: 'mitm' }), null, 'a legacy capture never does')
  // the board labels the routing in place (captureLabelsOf): a proxy call says how it reached the engine, the default does not
  const routing = (rec) => captureLabelsOf(rec).find((l) => l.id === 'capture-routing') || null
  const label = routing(envelopeOf('proxy', null))
  assert.ok(label, 'a proxy call carries the routing label')
  assert.ok(/门/.test(label.label) && /door/.test(label.text), 'the label names the entity the call came through: asight\'s door (D47), not only the name')
  assert.ok(!/内核|kernel/.test(label.label + label.text), 'macOS and Windows have no kernel since D47')
  assert.equal(routing(envelopeOf('transparent', 4242)), null, 'the transparent default carries no routing label')
})

// D60③ (1.6 §4.2, 4.6 §记录「保存级别」): what the class table's verdict does to the record — the one thing the format has to say about it.
// `traffic_class` is the class NAME, whatever the operator called it (the names are their table's, not a closed set), and a class
// kept at `log` carries `body_retention:'log'` in the shape a log-level call has: headers and sizes, no body, in neither direction.
test('W14 the class the table gives a call is its traffic_class, and a class kept at `log` carries body_retention:\'log\' with sizes and headers only', T, async (t) => {
  const asked = []
  const r = await run(t, 'transparent', 'transparent', (proc, host, method, p) => { asked.push([host, method, p]); return { class: 'catalog', level: 'log' } })
  assert.deepEqual(asked, [['api.anthropic.com', 'POST', '/v1/messages'], ['api.anthropic.com', 'POST', '/v1/messages']], 'sampled once per call, at its start')
  const [e, sse] = r.envelopes
  assert.deepEqual([e.traffic_class, e.body_retention], ['catalog', 'log'], 'a class the operator added: the name is recorded as it is')
  assert.deepEqual(e.req_body, { raw_chars: Buffer.byteLength(callBody(false)), verbatim: false })
  assert.deepEqual([e.body_wire_bytes.req, e.req_headers['x-api-key']], [Buffer.byteLength(callBody(false)), 'sk-ant-FAKE'], 'the size and the headers stay')
  assert.ok(e.req_head_raw.startsWith('POST /v1/messages HTTP/1.1\r\n'), 'the verbatim head is metadata, not the body')
  assert.equal(e.resp.verbatim, false); assert.equal('body' in e.resp || 'raw' in e.resp, false, 'no response body either')
  assert.deepEqual([sse.body_retention, sse.resp.verbatim], ['log', false], 'the streamed call too')
  // the same two calls with no table in the way: the endpoint alone says `llm`, and everything is kept
  const full = await run(t, 'transparent', 'transparent')
  assert.deepEqual(full.envelopes.map((x) => [x.traffic_class, 'body_retention' in x]), [['llm', false], ['llm', false]])
})
