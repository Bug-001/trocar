// capture-format.test.mjs — the record is one format whichever way the call reached the engine (the data format is the same on every platform;
// RFC 4.8 §5.6; acceptance W14 here, W18 — the reader accepts all three `capture` values — with Task 2(b)).
// The same exchange (a JSON call and an SSE call on one TLS connection, to one origin) goes through the transparent door (what Linux
// uses) and through the proxy ingress (what the Windows `vpn-block` and `own-forwarder` use). The envelopes must be equal except for the
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
const call = (stream) => { const b = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, stream, messages: [{ role: 'user', content: stream ? 'stream me' : 'hello' }] }); return `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nx-api-key: sk-ant-FAKE\r\nContent-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}` }
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

async function run(t, door, capture) {
  const port = await origin(t)
  const envelopes = [], flows = [], failures = []
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port, family: 4 }, pid: 4242, agent: 'claude-code', decrypt: true })
  const meta = { pid: 4242, agent: 'claude-code', decrypt: true, capture, form: 'claude-code.cli', pid_source: 'socket-table', pid_ms: 4, negKey: '4242', upstream: { kind: 'direct' } }
  redirector.setIngress('vb.claude-code.cli', meta)
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: originCa.certPem, ingressToken: TOKEN,
    store: { envelope: (e) => { envelopes.push(structuredClone(e)); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: (f) => failures.push(f),
  })
  const { port: enginePort, ingressPort } = await engine.listen({ ingress: door === 'ingress' ? { port: 0 } : null })
  t.after(() => closeWithin(engine))
  let socket
  if (door === 'ingress') {
    socket = net.connect(ingressPort, '127.0.0.1'); socket.on('error', () => {})
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: Basic ${Buffer.from(`vb.claude-code.cli:${TOKEN}`).toString('base64')}\r\n\r\n`)
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
  // One run through the ingress, not one per `capture` value: nothing reads meta.capture yet (the todo below), and `strip` removes the field, so a second run
  // with another value would be the same run again and say nothing.
  {
    const capture = 'vpn-block', via = await run(t, 'ingress', capture)
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
    assert.deepEqual([row.ingress, row.pid_source, row.pid_ms, row.upstream], [{ route: 'vb', group: 'claude-code.cli' }, 'socket-table', 4, { kind: 'direct' }])
    assert.equal('prelude' in row, false)
    assert.deepEqual(Object.keys(baseRow).filter((k) => ['ingress', 'pid_source', 'pid_ms', 'upstream'].includes(k)), [], 'the transparent row has none of them: Linux rows are unchanged')
  }
})

// What the envelope says about how the call reached the engine (4.8 §5.6, invariant 4). The ingress's meta carries `capture`, and nothing reads it yet: the envelope
// builder writes the literal 'transparent' (collector/core/record/envelope.mjs, two places) and the `flow` that startTee hands the exchange recorder (flow.mjs) has no
// `capture`. So today a Windows call is labelled `transparent`: the wrong label, and no other test sees it (`strip` above removes the field). Task 2(b) is those two
// literals plus `capture: meta.capture` in that `flow`. A todo, not a skip: it runs, fails today, and goes green by itself when 2(b) is in. HARD DEPENDENCY OF TASK 8:
// the daemon wiring that puts Windows data on disk must not land while this still carries `todo`.
test('W14 (Task 2(b)) an envelope that came through the ingress carries the capture value its meta says: vpn-block, own-forwarder', { ...T, todo: 'Task 2(b): the envelope builder writes the literal transparent and startTee passes no meta.capture; a hard dependency of Task 8' }, async (t) => {
  for (const capture of ['vpn-block', 'own-forwarder']) {
    const via = await run(t, 'ingress', capture)
    assert.deepEqual(via.envelopes.map((e) => e.capture), [capture, capture], `${capture}: the envelope says how the call reached the engine`)
  }
  assert.deepEqual((await run(t, 'transparent', 'transparent')).envelopes.map((e) => e.capture), ['transparent', 'transparent'], 'and a transparent call still says so')
})
