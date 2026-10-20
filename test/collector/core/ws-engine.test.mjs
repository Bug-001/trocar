// ws-engine.test.mjs — RFC 4.6 acceptance W (WebSocket, D37) through the real engine (createEngine) over
// TLS against the mock upstream's Responses WebSocket (test/lab/mock-upstream/ws.mjs), with the real 0600
// record store and the daemon's failure recorder: envelopes, connection rows and failure events (all in flows/) are
// read back from disk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startMockUpstream } from '../../lab/mock-upstream/server.mjs'
import { makeLabCa } from '../../lab/mock-upstream/lab-ca.mjs'
import { wsConnect, encodeFrame } from '../../lab/ws-client.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { rebuildWsWire } from '../../../src/collector/core/ws/raw.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'
import { createFailureRecorder, recentFailures } from '../../../src/collector/core/events.mjs'
import { request } from '../../lab/helpers.mjs'
import { closeWithin } from '../../helpers/bounded.mjs'

const T = { timeout: 20000 }
const TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }]
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const create = (fields) => JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, ...fields })
const b64 = (s) => Buffer.from(s, 'base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) { const v = fn(); if (v) return v } throw new Error(`${what}: not within ${ms}ms`) }
const trocarCa = createCa()
const labCaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-ws-labca-'))
const labCa = makeLabCa(labCaDir)
process.on('exit', () => fs.rmSync(labCaDir, { recursive: true, force: true }))

async function lab(t, { terminal = TERMINAL, recording, delays, describe } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-ws-engine-'))
  const mock = await startMockUpstream({ tls: { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }, delays })
  const envelopes = [], errors = []
  const store = createRecordStore({ root: path.join(dir, 'rec'), raw: path.join(dir, 'rec') }) // real 0600 files: W10 and flows/ read the disk
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 11, agent: 'codex', decrypt: true })
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: fs.readFileSync(labCa.caCert),
    store: { envelope: (e) => { envelopes.push(e); return store.envelope(e) }, flow: (f) => store.flow(f) }, onFailure: createFailureRecorder(path.join(dir, 'rec')).event, // as the daemon wires it
    isRecording: recording || (() => true), describe: describe || (() => ({ wsTerminal: terminal })), onError: (e) => errors.push(e) })
  const { port } = await engine.listen({})
  const clients = []
  // close our clients first: engine.close() waits for in-flight flows (RFC 4.6 §开关), it never kills them
  t.after(async () => {
    for (const c of clients) c.sock.destroy()
    try { await mock.close(); await closeWithin(engine) } // a hook has no test-level deadline: engine.close() is bounded, or one flow left open parks the file
    finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  const connect = async (opts = {}) => { const c = await wsConnect(port, { tls: { servername: 'api.openai.com', ca: trocarCa.certPem }, ...opts }); clients.push(c); return c }
  const read = (sub) => { const d = path.join(dir, 'rec', sub); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [] }
  return { mock, engine, envelopes, errors, connect, log: () => mock.state.log, port, onDisk: () => read(''), flows: () => read('flows').filter((r) => r.event == null), failures: () => read('flows').filter((r) => r.event === 'failure'), dir }
}

const VARIANTS = [
  ['no deflate', undefined, undefined],
  ['deflate, context takeover both ways (Codex offer)', 'permessage-deflate; client_max_window_bits', 'permessage-deflate'],
  ['deflate, client_no_context_takeover', 'permessage-deflate; client_no_context_takeover', 'permessage-deflate; client_no_context_takeover'],
  ['deflate, server_no_context_takeover', 'permessage-deflate; server_no_context_takeover', 'permessage-deflate; server_no_context_takeover'],
  ['deflate, the 101 answer differs from the first offer', 'permessage-deflate; server_no_context_takeover; server_max_window_bits=8, permessage-deflate', 'permessage-deflate'],
]

for (const [name, offer, answer] of VARIANTS) {
  test(`W1 ${name}: req_body / resp.messages verbatim, ws_raw rebuilds the wire, forwarding is byte-identical`, T, async (t) => {
    const L = await lab(t)
    const c = await L.connect({ extensions: offer })
    assert.equal(c.status, 101); assert.equal(c.headers['sec-websocket-extensions'], answer)
    const big = 'lorem ipsum dolor '.repeat(60)
    const sent = [create({ input: [user(`one ${big}`)] })]
    await c.sendText(sent[0]); const e1 = await c.events()
    sent.push(create({ input: [user(`two ${big}`)], previous_response_id: e1.at(-1).response.id }))
    await c.sendText(sent[1]); const e2 = await c.events()
    await until(() => L.envelopes.length === 2, 'two envelopes')
    const inMsgs = L.log().filter((e) => e.type === 'ws_message').map((e) => e.text)
    assert.deepEqual(L.envelopes.map((e) => e.req_body), inMsgs); assert.deepEqual(inMsgs, sent)
    assert.deepEqual(L.envelopes.map((e) => e.resp.messages.map((m) => JSON.parse(m))), [e1, e2])
    assert.ok(L.envelopes.every((e) => e.transport === 'ws' && e.ws_ext === (answer ?? null)))
    const frames = L.log().filter((e) => e.type === 'ws_frame')
    const rebuilt = L.envelopes.map((e) => rebuildWsWire(e))
    assert.ok(Buffer.concat(rebuilt.map((r) => r.c)).equals(Buffer.concat(frames.filter((f) => f.dir === 'in').map((f) => b64(f.raw_b64)))), 'client frames rebuilt')
    assert.ok(Buffer.concat(rebuilt.map((r) => r.s)).equals(Buffer.concat(frames.filter((f) => f.dir === 'out').map((f) => b64(f.raw_b64)))), 'server frames rebuilt')
    const hs = L.log().find((e) => e.type === 'request')
    assert.ok(Buffer.concat(c.state.received).equals(Buffer.concat([b64(hs.resp_raw_b64), ...frames.filter((f) => f.dir === 'out').map((f) => b64(f.raw_b64))])), 'client received exactly what the mock sent')
    assert.equal(b64(hs.req_raw_b64).toString('latin1'), c.wire)
  })
}

// The closeout question: a real WebSocket through createEngine leaves its calls in capture-*.ndjson and
// a transport:'ws' summary in flows/, on disk; envelopes + flows/ ws.tail_raw rebuild the connection.
test('W14 end to end on disk: envelopes in capture-*.ndjson, flows/ transport:ws + ws summary, the close frames in tail_raw; together they rebuild the wire', T, async (t) => {
  const L = await lab(t)
  const c = await L.connect({ extensions: 'permessage-deflate; client_max_window_bits' })
  await c.sendText(create({ input: [user('on disk')] })); await c.events()
  c.send(8, Buffer.from([0x03, 0xe8])) // Close 1000: the mock echoes it and ends TCP
  await until(() => c.state.closed, 'connection closed')
  const [f] = await until(() => L.flows().length && L.flows(), 'flows/ record')
  const [e] = L.onDisk()
  assert.equal(e.transport, 'ws'); assert.equal(e.flow_id, f.flow_id); assert.equal(e.seq, 0)
  assert.equal(f.decision, 'decrypt'); assert.equal(f.transport, 'ws')
  assert.deepEqual({ ...f.ws, tail_raw: f.ws.tail_raw.map((x) => x.d) }, { frames: f.ws.frames, calls: 1, recorded: 1, partial: 0, dropped_frames: 0, tail_raw: ['c', 's'] })
  const frames = L.log().filter((x) => x.type === 'ws_frame')
  assert.equal(f.ws.frames, frames.length)
  const wire = rebuildWsWire({ ws_raw: [...e.ws_raw, ...f.ws.tail_raw], resp: e.resp, req_body: e.req_body })
  for (const [d, dir] of [['c', 'in'], ['s', 'out']]) assert.ok(wire[d].equals(Buffer.concat(frames.filter((x) => x.dir === dir).map((x) => b64(x.raw_b64)))), `${d} direction rebuilt`)
  const mode = (p) => fs.statSync(p).mode & 0o777
  assert.equal(mode(path.join(L.dir, 'rec', 'flows', fs.readdirSync(path.join(L.dir, 'rec', 'flows'))[0])), 0o600)
})

test('W2 fragments with ping / pong between them, both directions: messages reassemble, control frames are recorded and never merged', T, async (t) => {
  const L = await lab(t, { delays: { wsFragmentBytes: 64 } })
  const c = await L.connect({ extensions: 'permessage-deflate; client_max_window_bits' })
  const msg = create({ input: [user('fragmented')] }); const third = Math.ceil(msg.length / 3)
  c.send(1, msg.slice(0, third), { fin: false }); c.send(9, 'are-you-there'); c.send(0, msg.slice(third, 2 * third), { fin: false }); c.send(0, msg.slice(2 * third))
  assert.equal((await c.next()).opcode, 10)
  const evs = await c.events()
  const [e] = await until(() => L.envelopes.length && L.envelopes, 'the envelope')
  assert.equal(e.req_body, msg)
  assert.deepEqual(e.resp.messages.map((m) => JSON.parse(m)), evs)
  const ops = (d) => e.ws_raw.filter((f) => f.d === d).map((f) => Buffer.from(f.h, 'base64')[0] & 0x0f)
  assert.deepEqual(ops('c'), [1, 9, 0, 0])
  const frames = L.log().filter((x) => x.type === 'ws_frame' && x.dir === 'out')
  const pings = frames.filter((f) => f.opcode === 9).length
  assert.ok(pings > 0, 'the mock fragmented at least one message')
  assert.equal(ops('s')[0], 10); assert.equal(ops('s').filter((o) => o === 9).length, pings, 'every server ping between fragments is in ws_raw')
  assert.ok(e.resp.messages.every((m) => !m.includes('mock-frag-ping') && !m.includes('are-you-there')))
  assert.ok(rebuildWsWire(e).s.equals(Buffer.concat(frames.map((f) => b64(f.raw_b64)))))
})

test('W10 the last reply of a turn is on disk within 1 s of its terminal message while the connection stays open; without a pattern it waits', T, async (t) => {
  const L = await lab(t)
  const c = await L.connect()
  await c.sendText(create({ input: [user('w10')] })); await c.events()
  const t0 = Date.now(); while (!L.onDisk().length && Date.now() - t0 < 1000) await sleep(5)
  assert.equal(L.onDisk().length, 1, 'on disk within 1 s of the terminal message'); assert.ok(!c.state.closed, 'connection still open')
  const N = await lab(t, { terminal: null })
  const d = await N.connect()
  await d.sendText(create({ input: [user('w10b')] })); await d.events(); await sleep(300)
  assert.equal(N.envelopes.length, 0, 'fallback: not before the next message or close')
  d.sock.destroy()
  await until(() => N.envelopes.length === 1, 'written at close')
})

test('W6 on→off→on mid-connection: zero client errors, nothing recorded while off, the call after is partial', T, async (t) => {
  let on = true
  const L = await lab(t, { recording: () => on })
  const c = await L.connect({ extensions: 'permessage-deflate; client_max_window_bits' })
  const big = 'lorem ipsum dolor '.repeat(60)
  for (const i of [1, 2, 3]) {
    if (i === 2) on = false
    if (i === 3) on = true
    await c.sendText(create({ input: [user(`turn ${i} ${big}`)] })); const evs = await c.events()
    assert.equal(evs.at(-1).type, 'response.completed')
  }
  await until(() => L.envelopes.length === 2, 'two envelopes')
  assert.equal(c.state.error, null)
  assert.deepEqual(L.envelopes.map((e) => JSON.parse(e.req_body).input[0].content[0].text.slice(0, 6)), ['turn 1', 'turn 3'])
  assert.deepEqual(L.envelopes.map((e) => e.partial_reasons ?? null), [null, ['off-window']])
  assert.deepEqual(L.envelopes.map((e) => e.seq), [0, 2], 'the call not recorded still takes its seq')
})

test('W3 a generate:false prewarm is recorded verbatim as its own call; the turn that names it is the next envelope', T, async (t) => {
  const L = await lab(t)
  const c = await L.connect({ extensions: 'permessage-deflate; client_max_window_bits' })
  const warm = create({ generate: false, input: [], instructions: 'be brief '.repeat(200), tools: [] })
  await c.sendText(warm); const w = await c.events()
  const turn = create({ input: [user('after warmup')], previous_response_id: w.at(-1).response.id })
  await c.sendText(turn); await c.events()
  await until(() => L.envelopes.length === 2, 'two envelopes')
  assert.deepEqual(L.envelopes.map((e) => e.req_body), [warm, turn])
  assert.deepEqual(L.envelopes[0].resp.messages.map((m) => JSON.parse(m).type), ['response.created', 'response.in_progress', 'response.completed'])
  assert.equal(L.log().find((e) => e.type === 'ws_message').source, 'warmup')
})

test('W4 an upgrade answered 426, then the HTTP SSE fallback: both are recorded as ordinary envelopes', T, async (t) => {
  const L = await lab(t)
  const v = await L.connect({ version: '8' })
  assert.equal(v.status, 426); v.sock.destroy()
  const r = await request(`https://127.0.0.1:${L.port}`, '/v1/responses', JSON.stringify({ model: 'gpt-test-1', stream: true, input: 'fallback' }), { ca: trocarCa.certPem, servername: 'api.openai.com' })
  assert.equal(r.status, 200)
  await until(() => L.envelopes.length === 2, 'two envelopes')
  assert.deepEqual(L.envelopes.map((e) => [e.method, e.resp.status, e.resp.kind, e.transport]), [['GET', 426, 'json', undefined], ['POST', 200, 'sse', undefined]])
})

test('mid-call upstream RST: the client gets only upstream bytes, the call is an error envelope with the messages it got (T2 on WebSocket)', T, async (t) => {
  const L = await lab(t)
  const c = await L.connect({ headers: { 'x-mock-scenario': 'mid-stream-reset' } })
  await c.sendText(create({ input: [user('reset me')] }))
  await until(() => c.state.closed, 'connection reset')
  const [e] = await until(() => L.envelopes.length && L.envelopes, 'the error envelope')
  assert.equal(e.error, true); assert.equal(e.resp.kind, 'error'); assert.equal(e.resp.error.type, 'ECONNRESET'); assert.ok(e.resp.partial.messages.length >= 2)
  const frames = L.log().filter((x) => x.type === 'ws_frame' && x.dir === 'out')
  const hs = L.log().find((x) => x.type === 'request')
  assert.ok(Buffer.concat(c.state.received).equals(Buffer.concat([b64(hs.resp_raw_b64), ...frames.map((f) => b64(f.raw_b64))])))
})

// D38: a capture failure is never silent. Through the engine, the ws recorder's failure
// lands in flows/ on disk as a failure event with the flow's id, the connection row's ws summary counts it, and
// `trocar collector status` (recentFailures, the reader it uses with or without a daemon) lists it.
test('D38 a WebSocket capture failure through the engine: a flows/ failure event names the flow and the reason; ws.failures counts it; status lists it', T, async (t) => {
  const L = await lab(t)
  const c = await L.connect() // no deflate agreed
  c.sock.write(encodeFrame(1, 'x', { rsv1: true })) // RSV1 without permessage-deflate: the mock fails the connection
  await until(() => c.state.closed, 'connection failed by the mock')
  const [f] = await until(() => L.flows().length && L.flows(), 'flows/ record')
  assert.equal(f.ws.failures, 1)
  assert.deepEqual(L.failures().map((x) => [x.flow_id, x.where, x.code, x.d]), [[f.flow_id, 'ws', 'decode-failed', 'c']])
  assert.ok(recentFailures(path.join(L.dir, 'rec')).some((x) => x.where === 'ws' && x.code === 'decode-failed' && x.flow_id === f.flow_id), 'status lists it')
  assert.equal(fs.existsSync(path.join(L.dir, 'rec', 'failures')), false, 'no second failure directory nobody reads')
})

// Plan 3c §2: describe(meta) must not throw; if it does, the flow goes on with no extras (fail-open) and
// the throw is not silent (D38): onError and a flows/ failure event.
test('describe throws: the connection is still decrypted and recorded with the fallback cut; the throw is a flows/ failure event and reaches onError', T, async (t) => {
  const L = await lab(t, { describe: () => { throw new Error('registry not ready') } })
  const c = await L.connect()
  await c.sendText(create({ input: [user('no extras')] })); await c.events()
  c.sock.destroy() // no terminal pattern reached the recorder: the call is written at close
  await until(() => L.envelopes.length === 1 && L.flows().length, 'envelope and flow')
  assert.equal(L.envelopes[0].transport, 'ws')
  assert.deepEqual(L.failures().map((x) => [x.code, x.pid, x.agent, x.reason]), [['describe-error', 11, 'codex', 'registry not ready']])
  assert.deepEqual(L.errors.map((e) => e.message), ['registry not ready'])
})
