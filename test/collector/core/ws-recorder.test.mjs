// ws-recorder.test.mjs — RFC 4.6 §传输与帧级记录 (D37), the recorder half of W1 / W2 / W5 / W6 / W10 /
// W13–W17 and T2 on WebSocket: one envelope per logical call, cut by terminal patterns handed in as
// DATA (the Codex-like patterns below live only in this test), and the frame partition that rebuilds
// the whole connection verbatim. Socket-free: the engine wiring is 3c-4.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { asWritten } from '../../helpers/record-store.mjs'
import { createWsRecorder, compileTerminal, MAX_CALL_BYTES } from '../../../src/collector/core/ws/recorder.mjs'
import { rebuildWsWire } from '../../../src/collector/core/ws/raw.mjs'
import { encodeFrame } from '../../lab/ws-client.mjs'

const FLOW = { id: 'f1', host: 'api.openai.com', scheme: 'https', dst: { address: '10.0.0.1', port: 443, family: 4 }, proc: { pid: 7, exe: '/x/agent', agent: 'a' } }
const TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }]
const head = (s, extra) => ({ raw: Buffer.from(s, 'latin1'), startLine: s.split('\r\n')[0], ...extra })
function upgrade({ ext, offer, target = '/v1/responses' }) {
  const reqH = [['Host', 'api.openai.com'], ['Upgrade', 'websocket'], ['Session-Id', 's-1'], ...(offer ? [['Sec-WebSocket-Extensions', offer]] : [])]
  const respH = [['Upgrade', 'websocket'], ...(ext ? [['Sec-WebSocket-Extensions', ext]] : [])]
  const raw = (line, hs) => `${line}\r\n${hs.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`
  return {
    req: { head: head(raw(`GET ${target} HTTP/1.1`, reqH), { method: 'GET', target, headers: reqH }) },
    resp: { head: head(raw('HTTP/1.1 101 Switching Protocols', respH), { status: 101, headers: respH }) },
  }
}
function rig({ ext = null, offer, terminal = TERMINAL, target, write, maxCallBytes, split = Infinity, seqStart = 0, retention } = {}) {
  const out = [], failures = [], turns = { n: 0 }; let on = true; let n = 0
  const store = { envelope: (e) => asWritten(write ? write(e, out, store) : (out.push(e), true), out.length), lastError: null }
  const r = createWsRecorder({ flow: FLOW, upgrade: upgrade({ ext, offer, target }), seqStart, genId: () => `id${n++}`, isRecording: () => on, terminal, maxCallBytes, retention, recordStore: store, onFailure: (f) => failures.push(f), onTurnEnd: () => { turns.n++ } })
  const wire = { c: [], s: [] }
  const feed = (fn, b) => { for (let i = 0; i < b.length; i += split) fn(b.subarray(i, i + split)) }
  return { r, out, failures, wire, turns, c: (b) => { wire.c.push(b); feed(r.fromClient, b) }, s: (b) => { wire.s.push(b); feed(r.fromUpstream, b) }, set on(v) { on = v } }
}
const ev = (type, extra = {}) => JSON.stringify({ type, ...extra })
const srv = (op, payload, opts) => encodeFrame(op, payload, { mask: false, ...opts })
const cli = (op, payload, opts) => encodeFrame(op, payload, opts)

// Every frame of every envelope (rebuilt alone, W5) and of ws.tail_raw, by frame number: the connection.
function connection(t) {
  const frames = []
  const one = (env, e) => rebuildWsWire({ ...env, ws_raw: [e] }, e.d)[e.d]
  for (const env of t.out) for (const e of env.ws_raw) frames.push({ i: e.i, d: e.d, b: one(env, e) })
  for (const e of t.r.summary().tail_raw || []) frames.push({ i: e.i, d: e.d, b: one({}, e) })
  frames.sort((a, b) => a.i - b.i)
  const dir = (d) => Buffer.concat(frames.filter((f) => f.d === d).map((f) => f.b))
  return { ids: frames.map((f) => f.i), c: dir('c'), s: dir('s') }
}
function assertWholeWire(t, label = '') {
  const w = connection(t)
  assert.deepEqual(w.ids, [...Array(t.r.summary().frames).keys()], `${label} every frame lands exactly once`)
  assert.ok(w.c.equals(Buffer.concat(t.wire.c)) && w.s.equals(Buffer.concat(t.wire.s)), `${label} envelopes + tail_raw rebuild the wire`)
}

test('W10 / W13 / W2 / W3: a terminal message writes its call at once (a generate:false prewarm is a call of its own, verbatim); a client message during the open call is req_extra_messages; response.incomplete and response.failed end calls', () => {
  const t = rig()
  const create = ev('response.create', { generate: false, input: 'hi' })
  t.c(Buffer.concat([cli(1, create.slice(0, 10), { fin: false }), cli(9, 'ping!'), cli(0, create.slice(10))]))
  t.s(srv(10, 'ping!')); t.s(srv(1, ev('response.created')))
  assert.equal(t.out.length, 0, 'nothing before the terminal message')
  t.s(srv(1, ev('response.completed', { response: { id: 'r1' } })))
  assert.equal(t.out.length, 1, 'written synchronously when the terminal message arrives (W10)')
  t.c(cli(1, ev('response.create', { input: 'long' }))); t.s(srv(1, ev('response.output_text.delta')))
  t.c(cli(1, ev('response.interrupt'))); t.s(srv(1, ev('response.incomplete')))
  t.c(cli(1, ev('response.create', { input: 'x' }))); t.s(srv(1, ev('response.failed')))
  assert.equal(t.out.length, 3, 'the interrupt did not start a call of its own')
  const [a, b, c] = t.out
  assert.deepEqual([a.req_body, a.resp], [create, { kind: 'ws', messages: [ev('response.created'), ev('response.completed', { response: { id: 'r1' } })] }])
  assert.deepEqual(a.ws_raw.map((f) => [f.i, f.d, f.p ? 'p' : f.m ? 'm' : '-']), [[0, 'c', 'm'], [1, 'c', 'p'], [2, 'c', 'm'], [3, 's', 'p'], [4, 's', 'm'], [5, 's', 'm']])
  assert.deepEqual([a.ws_frames, a.ws_raw[2].m], [[0, 5], [0, 10]], 'the second fragment slices message 0 at its offset')
  assert.deepEqual([b.req_extra_messages, b.resp.messages.at(-1), b.ws_raw.find((f) => f.d === 'c' && f.i > b.ws_frames[0]).m], [[ev('response.interrupt')], ev('response.incomplete'), [1, 0]], 'client m-slices count req_body, then req_extra_messages')
  assert.equal(c.resp.messages[0], ev('response.failed'))
  assert.deepEqual(t.out.map((e) => [e.seq, e.transport, e.error, e.req_headers['session-id']]), [[0, 'ws', undefined, 's-1'], [1, 'ws', undefined, 's-1'], [2, 'ws', undefined, 's-1']])
  for (const e of t.out) assert.ok(rebuildWsWire(e), 'each envelope rebuilds alone (W5)')
  t.r.end(null); assertWholeWire(t)
})

test('W14: a server message with no call open is its own envelope (req_body null); frames between calls ride with the next envelope; trailing frames go to tail_raw; the upgrade is no envelope; any chunking', () => {
  for (const split of [Infinity, 1, 5]) {
  const t = rig({ split })
  t.s(srv(1, ev('rate_limits.updated')))
  assert.deepEqual(t.out.map((e) => [e.req_body, e.resp.messages]), [[null, [ev('rate_limits.updated')]]], 'written at once, alone')
  t.c(cli(9, 'hb')); t.s(srv(10, 'hb'))
  assert.equal(t.out.length, 1)
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))
  assert.deepEqual(t.out[1].ws_raw.map((f) => f.i), [1, 2, 3, 4], 'the ping / pong before the call ride with it')
  assert.deepEqual(t.out.map((e) => e.seq), [0, 1], 'the push takes a seq of its own')
  t.c(Buffer.concat([cli(1, 'unfinished', { fin: false }), cli(8, Buffer.from([3, 232]))])); t.s(srv(8, Buffer.from([3, 232])))
  t.r.end(null)
  assert.equal(t.out.length, 2, 'a message that never finished opens no call')
  assert.deepEqual(t.r.summary().tail_raw.map((f) => [f.i, f.d, !!f.p]), [[5, 'c', true], [6, 'c', true], [7, 's', true]])
  for (const e of t.out) { assert.match(e.req_head_raw, /^GET \/v1\/responses HTTP\/1.1\r\n/); assert.match(e.resp_head_raw, /^HTTP\/1.1 101 /) }
  assert.deepEqual(t.r.summary(), { frames: 8, calls: 2, recorded: 2, partial: 0, dropped_frames: 0, tail_raw: t.r.summary().tail_raw })
  assertWholeWire(t, `split ${split}`)
  }
})

test('no terminal pattern for this path: a call runs to the next client message, the last one to the end of the connection; a reset ends it as an error; W18 overlapping ws_frames', () => {
  const t = rig({ terminal: [{ pathSuffix: '/other', patterns: ['.'] }] })
  t.c(cli(1, 'a')); t.s(srv(1, 'A1')); t.s(srv(1, ev('response.completed')))
  assert.equal(t.out.length, 0, 'the fallback waits for the next client message')
  t.c(cli(1, 'b', { fin: false })); t.s(srv(1, 'A3')); t.s(srv(9, 'pg')); t.c(cli(0, 'b2'))
  assert.deepEqual(t.out.map((e) => [e.req_body, e.resp.messages, e.ws_raw.map((f) => f.i)]), [['a', ['A1', ev('response.completed'), 'A3'], [0, 1, 2, 4]]], 'A3 completed in this call: its frame goes with it, b\'s first frame waits for b')
  t.s(srv(1, 'B1')); t.r.end(null)
  assert.deepEqual(t.out.map((e) => [e.ws_frames, e.partial]), [[[0, 4], undefined], [[3, 7], undefined]], 'W18: all on, the ranges overlap (A3 is A\'s, b began at 3), the frame ids do not; no gap, nothing partial')
  assert.deepEqual(t.out.map((e) => [e.req_body, e.error]), [['a', undefined], ['bb2', undefined]], 'a clean close ends the last call normally')
  assert.deepEqual(t.out[1].ws_raw.map((f) => [f.i, f.m]), [[3, [0, 0]], [5, undefined], [6, [0, 1]], [7, [0, 0]]], 'the ping after b began is b\'s')
  assertWholeWire(t)
  const u = rig({ terminal: null }); u.c(cli(1, 'a')); u.s(srv(1, 'A1')); u.r.end({ type: 'ECONNRESET', message: 'reset' })
  assert.deepEqual([u.out[0].error, u.out[0].resp.partial.messages], [true, ['A1']])
})

test('compileTerminal: first entry whose pathSuffix matches (query stripped); headBytes; unusable patterns are skipped', () => {
  const m = compileTerminal([{ pathSuffix: '/x', patterns: ['^X'] }, { pathSuffix: '/responses', patterns: ['(', '^\\{"t":"done"'], headBytes: 12 }], '/v1/responses?model=m')
  assert.deepEqual([m(Buffer.from('{"t":"done"}')), m(Buffer.from('{"t":"other"}'))], [true, false])
  assert.equal(compileTerminal([{ patterns: ['^.{20}Z'], headBytes: 10 }], '/a')(Buffer.from(`${'a'.repeat(20)}Z`)), false, 'only the first headBytes bytes are tested')
  assert.equal(compileTerminal([{ pathSuffix: '/responses', patterns: ['('] }], '/responses'), null)
  assert.equal(compileTerminal(null, '/responses'), null)
})

test('W15 / T2: a call cut before its terminal message is error:true with resp.partial and keeps its frames; a binary opener is req_body null + req_body_b64; other non-text messages are {b64}', () => {
  const t = rig()
  t.c(cli(2, Buffer.from([0, 1, 2]))); t.s(srv(1, ev('response.output_text.delta'))); t.s(srv(2, Buffer.from([9, 9])))
  t.s(srv(1, Buffer.from([0xc3, 0x28]))); t.s(srv(1, 'cut mid-', { fin: false })); t.s(srv(8, Buffer.from([3, 233])))
  t.r.end({ type: 'ECONNRESET', message: 'reset' })
  const [e] = t.out
  assert.deepEqual([e.error, e.req_body, e.req_body_b64, e.resp.kind, e.resp.error], [true, null, 'AAEC', 'error', { type: 'ECONNRESET', message: 'reset' }])
  assert.deepEqual(e.resp.partial, { kind: 'ws', messages: [ev('response.output_text.delta'), { b64: 'CQk=' }, { b64: 'wyg=' }] }, 'invalid UTF-8 text is kept as bytes')
  assert.equal(t.r.summary().tail_raw, undefined, 'the cut call keeps its frames: the unfinished message and the close too')
  assert.ok(e.ws_raw[0].m && e.ws_raw[2].m, 'binary frames slice their stored bytes')
  assertWholeWire(t)
  const q = rig(); q.c(cli(1, ev('response.create'))); q.r.end(null)
  assert.deepEqual([q.out[0].error, q.out[0].resp.error.type], [true, 'ws_closed'], 'a clean close before the terminal message also interrupts the call')
})

// D40 FLIPPED THIS (it asserted that a non-LLM path keeps client messages as {raw_chars, verbatim:false} with no payload):
// what an agent sends over a WebSocket besides model calls is exactly what is worth reading, so the call is recorded like
// an LLM one — messages verbatim, frames keep their payload, ws_raw rebuilds the wire (4.6 W16).
test('W16: a non-LLM path is recorded verbatim in both directions, and ws_raw rebuilds the wire like any other call (D40)', () => {
  const t = rig({ target: '/realtime/control' })
  t.c(Buffer.concat([cli(1, 'secret', { fin: false }), cli(9, 'p'), cli(0, '-ish')])); t.s(srv(1, ev('response.completed')))
  t.r.end(null)
  const [e] = t.out
  assert.deepEqual([e.req_body, e.is_llm_call, e.resp.messages], ['secret-ish', false, [ev('response.completed')]])
  assert.deepEqual(e.ws_raw.map((f) => [f.d, 'p' in f, 'm' in f]), [['c', false, true], ['c', true, false], ['c', false, true], ['s', false, true]], 'text frames slice the stored message, the ping keeps its payload')
  assert.equal('body_retention' in e, false)
  assert.deepEqual([e.traffic_class, e.body_wire_bytes], ['other', { req: 'secret-ish'.length, resp: ev('response.completed').length }])
  assertWholeWire(t)
  assert.match(JSON.stringify(t.out), /secret-ish/)
})

test('W16 at the log level: both directions are {raw_chars, verbatim:false}, the frames keep a header and no payload, the envelope says so; a change reaches the next call only (D40 · K2)', () => {
  let level = 'log'
  const asked = []
  const t = rig({ target: '/realtime/control', terminal: [{ pathSuffix: '/control', patterns: TERMINAL[0].patterns }], retention: (method, target) => { asked.push([method, target]); return { class: 'telemetry', level } } })
  const first = ev('response.create', { input: 'secret input' })
  t.c(cli(1, first)); t.s(srv(1, ev('response.created')))
  level = 'full'                                                  // the operator edits the file while the call is open
  t.s(srv(1, ev('response.completed')))                           // the terminal message closes the call
  const [e] = t.out
  assert.deepEqual(e.req_body, { raw_chars: first.length, verbatim: false })
  assert.deepEqual(e.resp.messages, [{ raw_chars: ev('response.created').length, verbatim: false }, { raw_chars: ev('response.completed').length, verbatim: false }])
  assert.deepEqual([e.body_retention, e.traffic_class, e.body_wire_bytes], ['log', 'telemetry', { req: first.length, resp: ev('response.created').length + ev('response.completed').length }])
  assert.ok(e.ws_raw.every((f) => !('p' in f) && !('m' in f) && typeof f.h === 'string'), 'headers only')
  assert.equal(e.req_headers['session-id'], 's-1', 'the headers of the upgrade stay'); assert.match(e.req_head_raw, /^GET \/realtime\/control/)
  assert.doesNotMatch(JSON.stringify(e), /secret input/)
  // the call was cut at its terminal message all the same, and the NEXT call is sampled afresh: full now
  t.c(cli(1, ev('response.create', { input: 'second' }))); t.s(srv(1, ev('response.completed')))
  const second = t.out[1]
  assert.deepEqual([second.req_body, 'body_retention' in second, second.resp.messages], [ev('response.create', { input: 'second' }), false, [ev('response.completed')]])
  assert.ok(asked.length >= 2 && asked.every(([m, tgt]) => m === 'GET' && tgt === '/realtime/control'), 'asked with the upgrade request\'s method and target')
})

test('a retention callback that throws or is absent keeps the call in full, told by its endpoint (D40 · fail toward keeping)', () => {
  const t = rig({ retention: () => { throw new Error('boom') } })
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))
  assert.deepEqual([t.out[0].req_body, t.out[0].traffic_class, 'body_retention' in t.out[0]], [ev('response.create'), 'llm', false])
})

// A takeover sender keeps one streaming deflate context; a no-takeover sender compresses each message alone.
const strip = (b) => b.subarray(0, b.length - 4)
function deflater(takeover) {
  if (!takeover) return async (text) => strip(zlib.deflateRawSync(text, { finishFlush: zlib.constants.Z_SYNC_FLUSH }))
  const z = zlib.createDeflateRaw()
  return (text) => new Promise((res) => { const o = []; const f = (d) => o.push(d); z.on('data', f).write(text); z.flush(zlib.constants.Z_SYNC_FLUSH, () => setImmediate(() => { z.off('data', f); res(strip(Buffer.concat(o))) })) })
}

test('W1 (recorder): deflate off, takeover both ways, client_ / server_no_context_takeover; parameters from the 101, not the offer: messages verbatim, the wire rebuilds', async () => {
  const offer = 'permessage-deflate; client_no_context_takeover; server_no_context_takeover; client_max_window_bits'
  for (const ext of [null, 'permessage-deflate', 'permessage-deflate; client_no_context_takeover', 'permessage-deflate; server_no_context_takeover']) {
    const t = rig({ ext, offer, split: ext ? 7 : Infinity })
    const cz = deflater(!/client_no/.test(ext)), sz = deflater(!/server_no/.test(ext))
    const sent = { c: [], s: [] }
    for (let i = 0; i < 3; i++) {
      const q = ev('response.create', { input: `${'lorem ipsum dolor '.repeat(40)}${i}` }), a = ev('response.completed', { text: `${'lorem ipsum dolor '.repeat(40)}${i}` })
      sent.c.push(q); sent.s.push(a)
      t.c(ext ? cli(1, await cz(q), { rsv1: true }) : cli(1, q)); t.s(ext ? srv(1, await sz(a), { rsv1: true }) : srv(1, a))
    }
    t.r.end(null)
    assert.deepEqual(t.out.map((e) => [e.req_body, ...e.resp.messages]), sent.c.map((q, i) => [q, sent.s[i]]), String(ext))
    assert.ok(t.out.every((e) => e.ws_ext === ext && !e.partial && e.ws_raw.every((f) => (ext ? f.p : f.m))), `${ext}: compressed frames carry p, plain ones m`)
    assertWholeWire(t, String(ext))
  }
})

test('W6 / C14: on→off→on, deflate takeover both ways: a call begun on is recorded whole across off, one begun off is not, inflate state survives, off frames are nowhere, the next call is partial', async () => {
  const t = rig({ ext: 'permessage-deflate' })
  const cz = deflater(true), sz = deflater(true), big = 'lorem ipsum dolor '.repeat(50)
  const turn = async (i, extra = () => {}) => { t.c(cli(1, await cz(ev('response.create', { input: `${big}${i}` })), { rsv1: true })); await extra(); t.s(srv(1, await sz(ev('response.completed', { text: `${big}${i}` })), { rsv1: true })) }
  await turn(1)
  await turn(2, () => { t.on = false; t.s(srv(9, 'hb')) })        // begun on, ends off: recorded whole
  t.c(cli(9, 'hb')); await turn(3)                                 // begun off: not recorded, nor the ping before it
  t.on = true; await turn(4); t.on = false; t.c(cli(9, 'bye')); t.c(cli(1, 'SECRET', { fin: false })); t.r.end(null) // arrive off at the end
  assert.deepEqual(t.out.map((e) => [e.seq, JSON.parse(e.req_body).input.slice(-1), JSON.parse(e.resp.messages.at(-1)).text.slice(-1)]), [[0, '1', '1'], [1, '2', '2'], [3, '4', '4']])
  assert.deepEqual(t.out.map((e) => e.partial_reasons), [undefined, undefined, ['off-window']], 'only after the gap (W5: no partial without one)')
  assert.deepEqual(t.out[1].ws_raw.map((f) => [f.i, f.d]), [[2, 'c'], [3, 's'], [4, 's']], 'the ping inside the on-begun call stays with it')
  assert.deepEqual(connection(t).ids, [0, 1, 2, 3, 4, 8, 9], 'frames 5–7 arrived off: in no envelope and not in tail_raw')
  const { tail_raw, ...sum } = t.r.summary()
  assert.deepEqual([sum, tail_raw], [{ frames: 12, calls: 4, recorded: 3, partial: 1, dropped_frames: 5 }, undefined])
  // no pattern: b begins off while the on call a is open (its frame waits); the call b opens is not recorded
  const f = rig({ terminal: null })
  f.c(cli(1, 'a')); f.s(srv(1, 'A1')); f.on = false; f.c(cli(1, 'b')); f.on = true; f.s(srv(1, 'B1')); f.c(cli(1, 'c')); f.s(srv(1, 'C1')); f.r.end(null)
  assert.deepEqual(f.out.map((e) => [e.req_body, e.resp.messages, e.partial_reasons]), [['a', ['A1'], undefined], ['c', ['C1'], ['off-window']]])
  assert.deepEqual(connection(f).ids, [0, 1, 4, 5], 'B1 arrived on, but belongs to the call begun off')
})

// the drain gate's view of the connection (1.6 §1.3, engine/drain.mjs): idle = nothing to wait for, open = a call whose terminal message is awaited,
// blind = no terminal message can be seen here, so `off` does not close it
test('state(): idle with no call, open while a call (or a message of it) is in flight, idle again at its terminal message — which fires onTurnEnd once, and a call cut by the end of the connection does not', () => {
  const t = rig()
  assert.deepEqual([t.r.state(), t.turns.n], ['idle', 0])
  t.c(cli(1, ev('response.create').slice(0, 8), { fin: false })) // a client message begun, not finished
  assert.equal(t.r.state(), 'open', 'a message in flight is not idle')
  t.c(cli(0, ev('response.create').slice(8)))
  assert.equal(t.r.state(), 'open', 'the call is open')
  t.s(srv(1, ev('response.created')))
  assert.deepEqual([t.r.state(), t.turns.n], ['open', 0])
  t.s(srv(1, ev('response.completed')))
  assert.deepEqual([t.r.state(), t.turns.n], ['idle', 1], 'the terminal message closes the call and the turn is announced once')
  t.s(srv(1, ev('rate_limits.updated'))) // a server message with no call open is a call of its own, written at once: not a turn that ended
  assert.deepEqual([t.r.state(), t.turns.n, t.out.length], ['idle', 1, 2], 'written alone, and no turn end is announced for it')
  t.c(cli(1, ev('response.create'))); assert.equal(t.r.state(), 'open')
  t.r.end(null)
  assert.deepEqual([t.r.state(), t.turns.n], ['idle', 1], 'a call the connection closed under is no turn end; the connection is over')
})

test('state(): blind when the harness declared no terminal message, when either direction is no longer followed (a reserved opcode), or when the open call may have lost its terminal message (an undecodable or omitted server message)', () => {
  const none = rig({ terminal: null }); none.c(cli(1, 'a'))
  assert.equal(none.r.state(), 'blind', 'no terminal pattern for this path: nothing says where a turn ends')
  const idleNone = rig({ terminal: null })
  assert.equal(idleNone.r.state(), 'blind', 'even with no call open: it cannot be told that none will start')

  const c = rig(); c.c(cli(1, ev('response.create'))); assert.equal(c.r.state(), 'open')
  c.c(Buffer.from([0x83, 0x80, 0, 0, 0, 0])) // a masked client frame with a reserved opcode: the client direction stops
  assert.deepEqual([c.r.summary().broken, c.r.state()], [{ c: 'reserved opcode 3' }, 'blind'], 'a client direction that is not followed')

  const s = rig(); s.c(cli(1, ev('response.create'))); s.s(Buffer.from([0x83, 0x00]))
  assert.deepEqual([s.r.summary().broken, s.r.state()], [{ s: 'reserved opcode 3' }, 'blind'], 'a server direction that is not followed')
  const idleBroken = rig(); idleBroken.s(Buffer.from([0x83, 0x00]))
  assert.equal(idleBroken.r.state(), 'blind', 'also with no call open: it cannot be seen that none starts')

  const d = rig({ ext: 'permessage-deflate' }); d.c(cli(1, ev('response.create')))
  d.s(srv(1, Buffer.from([0xff, 0xff, 0xff]), { rsv1: true })) // does not inflate: this might have been the terminal message
  assert.deepEqual([d.failures.map((f) => f.code), d.r.state(), d.turns.n], [['decode-failed'], 'blind', 0], 'an undecodable message of the open call')

  const o = rig({ maxCallBytes: 100 }); o.c(cli(1, ev('response.create')))
  o.s(srv(1, 'x'.repeat(150))) // one message past the cap: omitted, so its text is not seen
  assert.deepEqual([o.r.state(), o.turns.n], ['blind', 0], 'an omitted message of the open call')
})

test('W-2: an exception in the recorder itself is recorder-error, not broken; that direction stops being followed and the relay never sees it', () => {
  const failures = []
  const r = createWsRecorder({ flow: FLOW, upgrade: upgrade({}), genId: () => 'id', isRecording: () => { throw new Error('switch sampler threw') }, terminal: TERMINAL, recordStore: { envelope: () => true }, onFailure: (f) => failures.push(f) })
  assert.doesNotThrow(() => { r.fromUpstream(srv(1, ev('response.created'))); r.fromUpstream(srv(1, ev('response.completed'))); r.end(null) })
  assert.deepEqual(failures.map((f) => [f.where, f.code, f.d, f.reason]), [['ws', 'recorder-error', 's', 'switch sampler threw']], 'once: the direction is not followed after it')
  assert.deepEqual(r.summary().broken, { s: 'switch sampler threw' })
})

test('C8: after a failed write every later call is partial (write-failed); an undecodable message is {b64, decode_error} and marks its call and later ones; a broken direction too; a throwing store never reaches the relay', () => {
  let n = 0
  const t = rig({ ext: 'permessage-deflate', write: (e, out) => { out.push(e); return n++ !== 0 } })
  const junk = Buffer.from([0xff, 0xff, 0xff])
  t.c(cli(1, 'one')); t.s(srv(1, ev('response.completed')))                          // the store says: not written
  t.c(cli(1, 'two')); t.s(srv(1, ev('response.completed')))
  t.c(cli(1, 'three')); t.s(srv(1, junk, { rsv1: true })); t.s(srv(1, ev('response.completed')))
  t.s(Buffer.from([0x83, 0x00])); t.c(cli(1, 'four')); t.r.end(null)               // reserved opcode: the server direction stops
  assert.deepEqual(t.out.map((e) => e.partial_reasons), [undefined, ['write-failed'], ['write-failed', 'decode-failed'], ['write-failed', 'decode-failed']])
  const bad = t.out[2].resp.messages[0]
  assert.deepEqual([bad.b64, typeof bad.decode_error], [junk.toString('base64'), 'string'])
  assert.equal(t.out[2].ws_raw[1].p, junk.toString('base64'), 'its frame keeps the wire payload')
  assert.deepEqual([t.r.summary().recorded, t.r.summary().partial, t.r.summary().broken], [3, 3, { s: 'reserved opcode 3' }])
  const x = rig({ write: () => { throw new Error('disk gone') } })
  assert.doesNotThrow(() => { x.c(cli(1, 'a')); x.s(srv(1, ev('response.completed'))); x.r.end(null) })
  assert.equal(x.r.summary().recorded, 0)
})

test('W17 / C13: past the per-call cap later messages are {omitted_bytes} with no frame payload (ws_truncated); one message past the cap is omitted and the next recorded; a takeover direction then fails to inflate, a no-takeover one does not', async () => {
  const t = rig({ maxCallBytes: 100 })
  const done = ev('response.completed')
  t.c(cli(1, ev('response.create'))); t.s(srv(1, 'x'.repeat(60))); t.s(srv(1, 'y'.repeat(60))); t.s(srv(1, done))
  assert.deepEqual([t.out[0].resp.messages, t.out[0].ws_truncated], [['x'.repeat(60), { omitted_bytes: 60 }, { omitted_bytes: done.length }], true], 'the terminal message still ends the call')
  assert.deepEqual(t.out[0].ws_raw.map((f) => 'p' in f || 'm' in f), [true, true, false, false])
  t.c(cli(1, ev('response.create'))); t.s(Buffer.concat([srv(1, 'a'.repeat(80), { fin: false }), srv(9, 'p'), srv(0, 'b'.repeat(70))])); t.s(srv(1, 'ok')); t.s(srv(1, done))
  const b = t.out[1]
  assert.deepEqual([b.resp.messages, b.ws_truncated, b.partial], [[{ omitted_bytes: 150 }, 'ok', done], true, undefined], 'a fresh budget per call')
  assert.deepEqual(b.ws_raw.map((f) => 'p' in f || 'm' in f), [true, false, true, false, true, true], 'the fragment before the cap loses its payload too')
  t.r.end(null); assert.ok(rebuildWsWire(b, 'c'))
  const f = rig({ maxCallBytes: 100 })
  f.c(cli(1, ev('response.create'))); f.s(srv(1, 'x'.repeat(60))); f.s(srv(1, 'y'.repeat(60))); f.s(srv(1, 'z'.repeat(30), { fin: false })); f.r.end({ type: 'ECONNRESET', message: 'reset' })
  assert.deepEqual([f.out[0].error, f.out[0].ws_truncated, f.out[0].ws_raw.map((e) => 'p' in e || 'm' in e)], [true, true, [true, true, false, false]], 'past the cap, an unfinished message keeps no payload either')
  // the omitted message sits between history and a message that refers into it: never wrong text
  const big = `${randomBytes(2500).toString('hex')}${'C'.repeat(1500)}`, next = `${'C'.repeat(1500)}tail`
  for (const [ext, want] of [['permessage-deflate', 'decode-failed'], ['permessage-deflate; server_no_context_takeover', next]]) {
    const u = rig({ ext, maxCallBytes: 2000 }), sz = deflater(!/server_no/.test(ext))
    u.c(cli(1, ev('response.create')))
    for (const m of ['A'.repeat(1500), big, next, done]) u.s(srv(1, await sz(m), { rsv1: true }))
    const [, m0, m1] = u.out[0].resp.messages
    assert.equal(typeof m0.omitted_bytes, 'number')
    assert.deepEqual([m1.decode_error ? 'decode-failed' : m1, u.out[0].partial_reasons], [want, want === 'decode-failed' ? ['decode-failed'] : undefined], ext)
  }
})

test('W6 / C14 across a cut: a message in flight goes with its own call — off content never lands in a recorded envelope, an on call never loses its own frames', () => {
  const secret = (t) => !/U0VDUkVU|SECRET/.test(JSON.stringify(t.out)) // 'SECRET' in base64 or as text
  // a client message begun off while an on call is open, still in flight at that call's terminal message
  const a = rig()
  a.c(cli(1, ev('response.create'))); a.on = false; a.c(cli(1, 'SECRET', { fin: false })); a.s(srv(1, ev('response.completed')))
  a.c(cli(0, '-tail')); a.s(srv(1, ev('response.completed'))); a.r.end(null)
  assert.deepEqual([a.out.map((e) => e.ws_raw.map((f) => f.i)), secret(a), a.r.summary().tail_raw], [[[0, 2]], true, undefined])
  // a server push begun off completes after an on call opened: it does not join that call
  const b = rig()
  b.on = false; b.s(srv(1, 'SECRET', { fin: false })); b.on = true
  b.c(cli(1, ev('response.create'))); b.s(srv(0, '-push')); b.s(srv(1, ev('response.completed'))); b.r.end(null)
  assert.deepEqual([b.out.map((e) => [e.resp.messages, e.partial_reasons]), secret(b)], [[[[ev('response.completed')], ['off-window']]], true])
  // an opener begun on, in flight when the call begun off reaches its terminal message: recorded whole
  const c = rig()
  c.on = false; c.c(cli(1, ev('response.create', { input: 'off' }))); c.on = true
  c.c(cli(1, '{"type":"response.create",', { fin: false })); c.s(srv(1, ev('response.completed')))
  c.c(cli(0, '"input":"on"}')); c.s(srv(1, ev('response.completed'))); c.r.end(null)
  const [B] = c.out
  assert.deepEqual([c.out.length, B.req_body, B.ws_raw.map((f) => f.i), B.partial_reasons], [1, '{"type":"response.create","input":"on"}', [1, 3, 4], ['off-window']])
  assert.ok(rebuildWsWire(B, 'c').c.equals(Buffer.concat(c.wire.c.slice(1))), 'its own bytes are whole')
  // no pattern: a server message begun on in call A completes after the next client message (begun off) started
  const d = rig({ terminal: null })
  d.c(cli(1, 'a')); d.s(srv(1, 'S1-', { fin: false })); d.on = false; d.c(cli(1, 'b', { fin: false })); d.s(srv(0, 'S2')); d.c(cli(0, 'b2')); d.r.end(null)
  assert.deepEqual(d.out.map((e) => [e.resp.messages, e.ws_raw.map((f) => f.i), e.partial]), [[['S1-S2'], [0, 1, 3], undefined]])
  assert.ok(rebuildWsWire(d.out[0], 's').s.equals(Buffer.concat(d.wire.s)))
})

test('a call whose server messages no longer decode (takeover window lost, or the direction stopped) cannot see its terminal message: it ends at the next client message instead of swallowing later turns', async () => {
  const t = rig({ ext: 'permessage-deflate', maxCallBytes: 4000 }), sz = deflater(true)
  for (const i of [1, 2, 3]) {
    t.c(cli(1, ev('response.create', { input: i })))
    if (i === 1) t.s(srv(1, await sz(ev('response.output_text.delta', { delta: randomBytes(8000).toString('hex') })), { rsv1: true }))
    for (const m of [ev('response.output_text.delta', { delta: `d${i}` }), ev('response.completed', { i })]) t.s(srv(1, await sz(m), { rsv1: true }))
  }
  assert.equal(t.out.length, 2, 'each turn is written when the next one starts')
  t.r.end(null)
  assert.deepEqual(t.out.map((e) => [JSON.parse(e.req_body).input, e.req_extra_messages, e.error, e.partial_reasons, e.resp.messages.every((m) => m.decode_error || m.omitted_bytes)]),
    [1, 2, 3].map((i) => [i, undefined, undefined, ['decode-failed'], true]))
  assert.deepEqual(t.out.flatMap((e) => e.ws_raw.map((f) => f.i)), [...Array(t.r.summary().frames).keys()], 'every frame once (the omitted one without payload)')
  const o = rig({ maxCallBytes: 4000 }) // the terminal message itself past the cap: omitted, so it cannot be recognised
  o.c(cli(1, ev('response.create', { input: 1 }))); o.s(srv(1, ev('response.completed', { output: 'x'.repeat(5000) })))
  o.c(cli(1, ev('response.create', { input: 2 }))); assert.equal(o.out.length, 1, 'turn 1 is written when turn 2 starts')
  o.s(srv(1, ev('response.completed'))); o.r.end(null)
  assert.deepEqual(o.out.map((e) => [JSON.parse(e.req_body).input, e.req_extra_messages, e.ws_truncated]), [[1, undefined, true], [2, undefined, undefined]])
  const u = rig()
  u.c(cli(1, ev('response.create', { input: 1 }))); u.s(srv(1, ev('response.output_text.delta'))); u.s(Buffer.from([0x83, 0]))
  u.c(cli(1, ev('response.create', { input: 2 }))); u.c(cli(1, ev('response.create', { input: 3 }))); u.r.end(null)
  assert.deepEqual(u.out.map((e) => [JSON.parse(e.req_body).input, e.req_extra_messages, e.error]), [[1, undefined, undefined], [2, undefined, undefined], [3, undefined, undefined]])
})

test('an opener past the cap on its own, or one that does not inflate, is req_body:null, labelled, with its client data frames in ws_raw (past the cap: headers only; undecodable: p kept)', () => {
  const big = rig({ maxCallBytes: 100 })
  big.c(Buffer.concat([cli(1, 'x'.repeat(80), { fin: false }), cli(0, 'y'.repeat(40))])); big.s(srv(1, ev('response.completed')))
  const [a] = big.out
  assert.deepEqual([a.req_body, 'req_body_b64' in a, a.ws_truncated, a.partial], [null, false, true, undefined])
  assert.deepEqual(a.ws_raw.map((f) => [f.d, 'p' in f || 'm' in f]), [['c', false], ['c', false], ['s', true]], 'its frames are there, headers only')
  const junk = Buffer.from([0xff, 0xff, 0xff]), bad = rig({ ext: 'permessage-deflate' })
  bad.c(cli(1, junk, { rsv1: true })); bad.s(srv(1, ev('response.completed')))
  const [b] = bad.out
  assert.deepEqual([b.req_body, 'req_body_b64' in b, b.ws_truncated, b.partial_reasons], [null, false, undefined, ['decode-failed']], 'its compressed bytes are not passed off as decoded')
  assert.deepEqual(b.ws_raw.map((f) => [f.d, f.p]), [['c', junk.toString('base64')], ['s', undefined]], 'the compressed frame keeps its wire payload')
})

test('a server message is judged when complete: a push begun before the opener and completed after it joins that call', () => {
  const t = rig(), push = ev('rate_limits.updated', { n: 1 })
  t.s(srv(1, push.slice(0, 8), { fin: false })); t.c(cli(1, ev('response.create')))
  t.s(srv(0, push.slice(8))); assert.equal(t.out.length, 0, 'not an envelope of its own')
  t.s(srv(1, ev('response.completed'))); t.r.end(null)
  assert.deepEqual(t.out.map((e) => [e.req_body, e.resp.messages, e.ws_raw.map((f) => f.i)]), [[ev('response.create'), [push, ev('response.completed')], [0, 1, 2, 3]]])
  assertWholeWire(t)
})

test('a control frame lost while off does not make later calls partial (only a lost data message does)', () => {
  const t = rig()
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))
  t.on = false; t.c(cli(9, 'hb')); t.s(srv(10, 'hb')); t.on = true
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed'))); t.r.end(null)
  assert.deepEqual([t.out.map((e) => e.partial_reasons), t.r.summary().dropped_frames], [[undefined, undefined], 2])
})

test('clean close, judged per call: the last call is ws_closed unless it itself cannot see its terminal message', () => {
  const t = rig({ ext: 'permessage-deflate; server_no_context_takeover' })
  t.c(cli(1, ev('response.create', { input: 1 }))); t.s(srv(1, Buffer.from([0xff, 0xff, 0xff]), { rsv1: true })) // call 1 cannot see its terminal
  t.c(cli(1, ev('response.create', { input: 2 }))); t.s(srv(1, ev('response.output_text.delta')))               // call 2 can
  t.r.end(null)
  assert.deepEqual(t.out.map((e) => [JSON.parse(e.req_body).input, e.error, e.resp.error && e.resp.error.type]), [[1, undefined, undefined], [2, true, 'ws_closed']])
})

test('seq: the first call takes seqStart (the upgrade request\'s number), later calls count on, recorded or not', () => {
  const t = rig({ seqStart: 7 })
  for (const [m, on] of [['a', true], ['b', false], ['c', true]]) { t.on = on; t.c(cli(1, m)); t.s(srv(1, ev('response.completed'))) }
  assert.deepEqual(t.out.map((e) => [e.req_body, e.seq]), [['a', 7], ['c', 9]])
})

test('no silent failure (proposed D38) — a failed write, an undecodable message and a stopped direction each leave a record with its reason at once; a stopped direction truncates the call it cuts', () => {
  const t = rig({ ext: 'permessage-deflate', write: (e, out, store) => { out.push(e); if (out.length > 1) return true; store.lastError = new Error('ENOSPC: no space left'); return false } })
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))                                       // the store does not write it
  t.c(cli(1, ev('response.create'))); t.s(srv(1, Buffer.from([0xff, 0xff]), { rsv1: true })); t.s(srv(1, ev('response.completed')))
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.output_text.delta'))); t.s(Buffer.from([0x83, 0]))
  assert.deepEqual(t.failures.map((f) => [f.code, f.flow_id, f.where, f.d, f.i, f.seq]), [['write-failed', 'f1', 'ws', undefined, undefined, 0], ['decode-failed', 'f1', 'ws', 's', 3, undefined], ['broken', 'f1', 'ws', 's', undefined, undefined]], 'written when they happen')
  assert.deepEqual([t.failures[0].reason, typeof t.failures[1].reason, t.failures[2].reason], ['ENOSPC: no space left', 'string', 'reserved opcode 3'])
  t.c(cli(1, ev('response.create'))); t.r.end(null)                                                                // a call opened after the stop
  assert.deepEqual(t.out.map((e) => e.ws_truncated), [undefined, undefined, true, true], 'the stopped direction lost bytes of the open call and of every later one')
  assert.deepEqual([t.out.at(-1).partial_reasons, t.r.summary().failures, t.failures[0].id, t.failures.every((f) => f.event === 'failure')], [['write-failed', 'decode-failed'], 3, t.out[0].id, true])
  const n = rig()                                                                                                       // RSV1 with no deflate agreed
  n.c(cli(1, ev('response.create'))); n.s(srv(1, 'abc', { rsv1: true }))
  assert.deepEqual(n.failures.map((f) => [f.code, f.d, f.i]), [['decode-failed', 's', 1]])
  const o = rig({ ext: 'permessage-deflate' }); o.on = false                                                              // off: no envelope, but the failure is recorded (it breaks the window)
  o.c(cli(1, ev('response.create'))); o.s(srv(1, Buffer.from([0xff, 0xff]), { rsv1: true })); o.r.end(null)
  assert.deepEqual([o.out.length, o.failures.map((f) => f.code)], [0, ['decode-failed']])
  const x = rig({ write: () => { throw new Error('EIO: disk gone') } })
  x.c(cli(1, 'a')); x.s(srv(1, ev('response.completed')))
  assert.deepEqual(x.failures.map((f) => [f.code, f.reason]), [['write-failed', 'EIO: disk gone']])
  const lostAtEnd = [], y = createWsRecorder({ flow: FLOW, upgrade: upgrade({}), terminal: TERMINAL, genId: () => { throw new Error('id source gone') }, recordStore: { envelope: () => true }, onFailure: (f) => lostAtEnd.push(f) })
  y.fromClient(cli(1, 'a')); assert.doesNotThrow(() => y.end(null))
  assert.deepEqual(lostAtEnd.map((f) => [f.code, f.reason]), [['recorder-error', 'id source gone']], 'an internal error at the end is recorded too')
})

test('more pinned details: decoded bytes in req_body_b64; a server message begun in the previous call joins the next one; a terminal past the call total keeps the window; the default cap', async () => {
  const ctx = rig({ ext: 'permessage-deflate; client_no_context_takeover' }), raw = Buffer.from([0, 1, 2, 255, 254])
  ctx.c(cli(2, strip(zlib.deflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH })), { rsv1: true })); ctx.s(srv(1, ev('response.completed')))
  assert.equal(ctx.out[0].req_body_b64, raw.toString('base64'), 'the decompressed bytes, not the wire bytes')
  const f = rig({ terminal: null })
  f.c(cli(1, 'a')); f.s(srv(1, 'S-', { fin: false })); f.c(cli(1, 'b')); f.s(srv(0, 'end')); f.r.end(null)
  assert.deepEqual(f.out.map((e) => [e.req_body, e.resp.messages]), [['a', []], ['b', ['S-end']]], 'judged when complete, also in the fallback cut')
  const sz = deflater(true), delta = () => ev('response.output_text.delta', { d: randomBytes(100).toString('hex') })
  const w1 = await sz(delta()), w2 = await sz(delta()), w3 = await sz(ev('response.completed', { r: 'done' })), w4 = await sz(ev('response.completed', { r: 'next' }))
  const t = rig({ ext: 'permessage-deflate', maxCallBytes: 26 + w1.length + 1 })
  t.c(cli(1, ev('response.create'))); for (const w of [w1, w2, w3]) t.s(srv(1, w, { rsv1: true }))
  assert.deepEqual([t.out.length, t.out[0].resp.messages.slice(1), t.out[0].ws_truncated], [1, [{ omitted_bytes: w2.length }, { omitted_bytes: w3.length }], true], 'the call total ran out at w2; w3 is still recognised as the terminal (W10)')
  t.c(cli(1, ev('response.create'))); t.s(srv(1, w4, { rsv1: true }))
  assert.deepEqual([t.out[1].resp.messages, t.out[1].partial], [[ev('response.completed', { r: 'next' })], undefined], 'it was still inflated: the window holds')
  assert.equal(MAX_CALL_BYTES, 64 << 20)
  const d = rig(), two = 'x'.repeat(2 << 20)
  d.c(cli(1, ev('response.create'))); d.s(srv(1, two)); d.s(srv(1, ev('response.completed')))
  assert.equal(d.out[0].resp.messages[0].length, two.length, 'the default cap is the large one')
})

test('C14 on a fragmented opener: begun on and finished off it is recorded with every fragment; begun off and finished on it is not', () => {
  const t = rig()
  t.c(cli(1, '{"type":"response.create",', { fin: false })); t.on = false; t.c(cli(0, '"x":1}')); t.s(srv(1, ev('response.completed')))
  assert.deepEqual([t.out.map((e) => e.ws_raw.map((f) => f.i)), t.out[0].req_body], [[[0, 1, 2]], '{"type":"response.create","x":1}'])
  assert.ok(rebuildWsWire(t.out[0], 'c').c.equals(Buffer.concat(t.wire.c)))
  t.c(cli(1, '{"type":"response.create",', { fin: false })); t.on = true; t.c(cli(0, '"x":2}')); t.s(srv(1, ev('response.completed')))
  assert.deepEqual([t.out.length, t.r.summary().calls], [1, 2])
})

test('switch details at call boundaries: frames between calls go with an off-begun next call; a push begun on follows an off-begun call; a drop marks the call open at that moment', () => {
  const a = rig()
  a.c(cli(1, ev('response.create'))); a.s(srv(1, ev('response.completed'))); a.c(cli(9, 'hb'))           // 0, 1, then a ping between calls (on)
  a.on = false; a.c(cli(1, ev('response.create'))); a.s(srv(1, ev('response.completed')))               // 3, 4: begun off
  a.on = true; a.c(cli(1, ev('response.create'))); a.s(srv(1, ev('response.completed'))); a.r.end(null) // 5, 6
  assert.deepEqual(connection(a).ids, [0, 1, 5, 6], 'the ping rode with the off-begun call and was dropped with it')
  const b = rig(), push = ev('rate_limits.updated')
  b.s(srv(1, push.slice(0, 5), { fin: false })); b.on = false; b.c(cli(1, ev('response.create')))      // push begun on; then a call begun off
  b.s(srv(0, push.slice(5))); b.s(srv(1, ev('response.completed')))                                    // the push completes inside it: dropped with it
  b.on = true; b.c(cli(1, ev('response.create'))); b.s(srv(1, ev('response.completed'))); b.r.end(null)
  assert.deepEqual(b.out.map((e) => [e.resp.messages, e.partial_reasons]), [[[ev('response.completed')], ['off-window']]])
  const c = rig({ terminal: null })
  c.c(cli(1, 'a')); c.on = false; c.s(srv(1, 'S-', { fin: false })); c.on = true                       // S begins off inside A
  c.c(cli(1, 'b')); c.s(srv(0, 'end')); c.s(srv(1, 'B1')); c.c(cli(1, 'c')); c.r.end(null)            // S completes in B: dropped, B marked
  assert.deepEqual(c.out.map((e) => [e.req_body, e.resp.messages, e.partial_reasons]), [['a', [], undefined], ['b', ['B1'], ['off-window']], ['c', [], ['off-window']]])
})

// D38: a terminal pattern from the daemon that does not compile is skipped — and recorded, once, on the
// connection it would have cut (RFC 4.6 §记录 pattern-invalid); the usable patterns still cut.
test('an invalid terminal pattern is a pattern-invalid failure record; the usable one still cuts the call', () => {
  const t = rig({ terminal: [{ pathSuffix: '/responses', patterns: ['(', '^\\{"type":"response\\.completed"'] }] })
  assert.deepEqual(t.failures.map((f) => [f.code, f.flow_id, f.where, f.pattern, typeof f.reason]), [['pattern-invalid', 'f1', 'ws', '(', 'string']])
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))
  assert.equal(t.out.length, 1, 'cut at the terminal message by the usable pattern')
  assert.equal(t.r.summary().failures, 1)
  const none = rig({ terminal: [{ patterns: ['['] }] })
  assert.deepEqual(none.failures.map((f) => f.code), ['pattern-invalid'])
})
