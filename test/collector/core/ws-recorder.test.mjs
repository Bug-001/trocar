// ws-recorder.test.mjs — RFC 4.6 §传输与帧级记录 (D37), the recorder half of W1 / W2 / W5 / W6 / W10 /
// W13–W17 and T2 on WebSocket: one envelope per logical call, cut by terminal patterns handed in as
// DATA (the Codex-like patterns below live only in this test), and the frame partition that rebuilds
// the whole connection verbatim. Socket-free: the engine wiring is 3c-4.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { createWsRecorder, compileTerminal } from '../../../src/collector/core/ws/recorder.mjs'
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
function rig({ ext = null, offer, terminal = TERMINAL, target, write, maxCallBytes } = {}) {
  const out = []; let on = true; let n = 0
  const r = createWsRecorder({ flow: FLOW, upgrade: upgrade({ ext, offer, target }), seqStart: 0, genId: () => `id${n++}`, isRecording: () => on, terminal, maxCallBytes,
    recordStore: { envelope: (e) => (write ? write(e, out) : (out.push(e), true)) } })
  const wire = { c: [], s: [] }
  return { r, out, wire, c: (b) => { wire.c.push(b); r.fromClient(b) }, s: (b) => { wire.s.push(b); r.fromUpstream(b) }, set on(v) { on = v } }
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

test('W14: a server message with no call open is its own envelope (req_body null); frames between calls ride with the next envelope; trailing frames go to tail_raw; the upgrade is no envelope', () => {
  const t = rig()
  t.s(srv(1, ev('rate_limits.updated')))
  assert.deepEqual(t.out.map((e) => [e.req_body, e.resp.messages]), [[null, [ev('rate_limits.updated')]]], 'written at once, alone')
  t.c(cli(9, 'hb')); t.s(srv(10, 'hb'))
  assert.equal(t.out.length, 1)
  t.c(cli(1, ev('response.create'))); t.s(srv(1, ev('response.completed')))
  assert.deepEqual(t.out[1].ws_raw.map((f) => f.i), [1, 2, 3, 4], 'the ping / pong before the call ride with it')
  t.c(Buffer.concat([cli(1, 'unfinished', { fin: false }), cli(8, Buffer.from([3, 232]))])); t.s(srv(8, Buffer.from([3, 232])))
  t.r.end(null)
  assert.equal(t.out.length, 2, 'a message that never finished opens no call')
  assert.deepEqual(t.r.summary().tail_raw.map((f) => [f.i, f.d, !!f.p]), [[5, 'c', true], [6, 'c', true], [7, 's', true]])
  for (const e of t.out) { assert.match(e.req_head_raw, /^GET \/v1\/responses HTTP\/1.1\r\n/); assert.match(e.resp_head_raw, /^HTTP\/1.1 101 /) }
  assert.deepEqual(t.r.summary(), { frames: 8, calls: 2, recorded: 2, partial: 0, dropped_frames: 0, tail_raw: t.r.summary().tail_raw })
  assertWholeWire(t)
})

test('no terminal pattern for this path: a call runs to the next client message, the last one to the end of the connection; a reset ends it as an error', () => {
  const t = rig({ terminal: [{ pathSuffix: '/other', patterns: ['.'] }] })
  t.c(cli(1, 'a')); t.s(srv(1, 'A1')); t.s(srv(1, ev('response.completed')))
  assert.equal(t.out.length, 0, 'the fallback waits for the next client message')
  t.c(cli(1, 'b', { fin: false })); t.s(srv(1, 'A3')); t.c(cli(0, 'b2'))
  assert.deepEqual(t.out.map((e) => [e.req_body, e.resp.messages, e.ws_frames]), [['a', ['A1', ev('response.completed'), 'A3'], [0, 2]]], 'cut at the next client message\'s first frame')
  t.s(srv(1, 'B1')); t.r.end(null)
  assert.deepEqual(t.out.map((e) => [e.req_body, e.error]), [['a', undefined], ['bb2', undefined]], 'a clean close ends the last call normally')
  assert.equal(t.out[1].ws_raw.find((f) => f.i === 4).p !== undefined, true, 'A3 rides here, its message is in the previous envelope')
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
  t.s(srv(1, Buffer.from([0xc3, 0x28]))); t.s(srv(8, Buffer.from([3, 233])))
  t.r.end({ type: 'ECONNRESET', message: 'reset' })
  const [e] = t.out
  assert.deepEqual([e.error, e.req_body, e.req_body_b64, e.resp.kind, e.resp.error], [true, null, 'AAEC', 'error', { type: 'ECONNRESET', message: 'reset' }])
  assert.deepEqual(e.resp.partial, { kind: 'ws', messages: [ev('response.output_text.delta'), { b64: 'CQk=' }, { b64: 'wyg=' }] }, 'invalid UTF-8 text is kept as bytes')
  assert.equal(t.r.summary().tail_raw, undefined, 'the cut call keeps its frames, close included')
  assert.ok(e.ws_raw[0].m && e.ws_raw[2].m, 'binary frames slice their stored bytes')
  assertWholeWire(t)
  const q = rig(); q.c(cli(1, ev('response.create'))); q.r.end(null)
  assert.deepEqual([q.out[0].error, q.out[0].resp.error.type], [true, 'ws_closed'], 'a clean close before the terminal message also interrupts the call')
})

test('W16: a non-LLM path keeps client messages as {raw_chars, verbatim:false} and no client data payload; the server direction still rebuilds', () => {
  const t = rig({ target: '/realtime/control' })
  t.c(Buffer.concat([cli(1, 'secret', { fin: false }), cli(9, 'p'), cli(0, '-ish')])); t.s(srv(1, ev('response.completed')))
  t.r.end(null)
  const [e] = t.out
  assert.deepEqual([e.req_body, e.is_llm_call, e.resp.messages], [{ raw_chars: 10, verbatim: false }, false, [ev('response.completed')]])
  assert.deepEqual(e.ws_raw.map((f) => [f.d, 'p' in f, 'm' in f]), [['c', false, false], ['c', true, false], ['c', false, false], ['s', false, true]])
  assert.ok(rebuildWsWire(e, 's').s.equals(Buffer.concat(t.wire.s)))
  assert.doesNotMatch(JSON.stringify(t.out), /secret|c2VjcmV0/)
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
    const t = rig({ ext, offer })
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
  t.on = true; await turn(4); t.on = false; t.c(cli(9, 'bye')); t.r.end(null)       // a frame that arrives off at the end
  assert.deepEqual(t.out.map((e) => [e.seq, JSON.parse(e.req_body).input.slice(-1), JSON.parse(e.resp.messages.at(-1)).text.slice(-1)]), [[0, '1', '1'], [1, '2', '2'], [3, '4', '4']])
  assert.deepEqual(t.out.map((e) => e.partial_reasons), [undefined, undefined, ['off-window']], 'only after the gap (W5: no partial without one)')
  assert.deepEqual(t.out[1].ws_raw.map((f) => [f.i, f.d]), [[2, 'c'], [3, 's'], [4, 's']], 'the ping inside the on-begun call stays with it')
  assert.deepEqual(connection(t).ids, [0, 1, 2, 3, 4, 8, 9], 'frames 5–7 arrived off: in no envelope and not in tail_raw')
  const { tail_raw, ...sum } = t.r.summary()
  assert.deepEqual([sum, tail_raw], [{ frames: 11, calls: 4, recorded: 3, partial: 1, dropped_frames: 4 }, undefined])
  // no pattern: b begins off while the on call a is open (its frame waits); the call b opens is not recorded
  const f = rig({ terminal: null })
  f.c(cli(1, 'a')); f.s(srv(1, 'A1')); f.on = false; f.c(cli(1, 'b')); f.on = true; f.s(srv(1, 'B1')); f.c(cli(1, 'c')); f.s(srv(1, 'C1')); f.r.end(null)
  assert.deepEqual(f.out.map((e) => [e.req_body, e.resp.messages, e.partial_reasons]), [['a', ['A1'], undefined], ['c', ['C1'], ['off-window']]])
  assert.deepEqual(connection(f).ids, [0, 1, 4, 5], 'B1 arrived on, but belongs to the call begun off')
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
