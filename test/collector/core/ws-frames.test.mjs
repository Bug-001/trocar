// ws-frames.test.mjs — RFC 4.6 §传输与帧级记录 (D37), unit halves of W1 / W2 / W5: passive RFC 6455
// framing of one direction, message reassembly with control frames in between, permessage-deflate,
// and the ws_raw encoding that rebuilds the wire bytes verbatim.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { createFrameParser, createMessageAssembler, OP } from '../../../src/collector/core/ws/frames.mjs'
import { parseExtensions, createInflater } from '../../../src/collector/core/ws/deflate.mjs'
import { rebuildWsWire, messageBytes, messagesOf } from '../../../src/collector/core/ws/raw.mjs'
import { encodeFrame } from '../../lab/ws-client.mjs'

const SYNC = { finishFlush: zlib.constants.Z_SYNC_FLUSH }
const strip = (z) => z.subarray(0, z.length - 4) // RFC 7692: drop the 00 00 ff ff tail

function parseAll(bytes, split) {
  const p = createFrameParser(); const frames = []
  for (let i = 0; i < bytes.length; i += split) { const r = p.push(bytes.subarray(i, i + split)); frames.push(...r.frames); assert.equal(r.error, null) }
  return frames
}

test('frames: masked and unmasked, 7/16/64-bit lengths, split anywhere; header keeps the mask key, payload unmasked', () => {
  const sizes = [0, 125, 126, 65535, 65536]
  const wire = Buffer.concat(sizes.flatMap((n) => [encodeFrame(OP.TEXT, 'x'.repeat(n)), encodeFrame(OP.BINARY, Buffer.alloc(n, 7), { mask: false })]))
  const before = Buffer.from(wire)
  for (const split of [1, 7, 4096, wire.length]) {
    const frames = parseAll(wire, split)
    assert.deepEqual(frames.map((f) => f.payload.length), sizes.flatMap((n) => [n, n]))
    assert.ok(frames.filter((_, i) => i % 2 === 0).every((f) => f.masked && f.payload.every((b) => b === 0x78)))
    const remask = (f) => (f.masked ? Buffer.from(f.payload.map((b, i) => b ^ f.header[f.header.length - 4 + (i & 3)])) : f.payload)
    assert.ok(Buffer.concat(frames.flatMap((f) => [f.header, remask(f)])).equals(wire), 'header + re-masked payload == the wire')
  }
  assert.ok(wire.equals(before), 'the parser reads a copy: the forwarded bytes are never changed')
  const [f] = parseAll(encodeFrame(OP.TEXT, 'hi'), 1)
  assert.equal(f.header.length, 6) // 2 + 4-byte mask key
})

test('frames: a reserved opcode or an oversized control frame stops the direction with an error, never a throw', () => {
  const p = createFrameParser()
  assert.match(p.push(Buffer.from([0x83, 0x00])).error, /reserved opcode 3/)
  assert.deepEqual(p.push(encodeFrame(OP.TEXT, 'ok')), { frames: [], error: 'reserved opcode 3' }, 'the direction stays stopped')
  assert.match(createFrameParser().push(Buffer.from([0x09, 0x00])).error, /control frame/) // ping without FIN
  assert.match(createFrameParser().push(encodeFrame(OP.PING, 'x'.repeat(126))).error, /control frame/)
  assert.match(createFrameParser().push(Buffer.from([0x82, 0x7f, 0x40, 0, 0, 0, 0, 0, 0, 0])).error, /not representable/) // 2^62
})

test('frames: a 32 MiB frame in 2 KiB chunks is buffered, not re-copied per chunk (the relay shares this event loop)', () => {
  const wire = encodeFrame(OP.BINARY, Buffer.alloc(32 << 20, 1), { mask: false })
  const p = createFrameParser(); const frames = []; const t0 = Date.now()
  for (let i = 0; i < wire.length; i += 2048) frames.push(...p.push(wire.subarray(i, i + 2048)).frames)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].payload.length, 32 << 20)
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
})

test('assembler: fragments reassemble; ping / pong / close in between stay control frames', () => {
  const a = createMessageAssembler()
  const seq = [
    { opcode: OP.TEXT, fin: false, rsv1: false, payload: Buffer.from('he') },
    { opcode: OP.PING, fin: true, rsv1: false, payload: Buffer.from('p') },
    { opcode: OP.CONT, fin: false, rsv1: false, payload: Buffer.from('ll') },
    { opcode: OP.PONG, fin: true, rsv1: false, payload: Buffer.alloc(0) },
    { opcode: OP.CONT, fin: true, rsv1: false, payload: Buffer.from('o') },
    { opcode: OP.CLOSE, fin: true, rsv1: false, payload: Buffer.from([3, 232]) },
  ]
  const ev = seq.map((f) => a.push(f))
  assert.deepEqual(ev.map((e) => e.type), ['data', 'control', 'data', 'control', 'data', 'control'])
  assert.deepEqual(ev.filter((e) => e.type === 'data').map((e) => [e.start, e.done, e.offset]), [[true, false, 0], [false, false, 2], [false, true, 4]])
  assert.equal(ev[4].message.toString(), 'hello')
  assert.equal(ev[4].opcode, OP.TEXT) // message-level fields come from the first frame
  assert.equal(a.push({ opcode: OP.CONT, fin: true, payload: Buffer.alloc(0) }).type, 'error')
  const c = createMessageAssembler()
  assert.equal(c.push({ opcode: OP.BINARY, fin: false, rsv1: true, payload: Buffer.alloc(1) }).compressed, true)
  assert.equal(c.push({ opcode: OP.TEXT, fin: true, payload: Buffer.alloc(0) }).type, 'error') // new message inside a fragmented one
  assert.deepEqual((({ done, opcode, compressed }) => [done, opcode, compressed])(c.push({ opcode: OP.CONT, fin: true, rsv1: false, payload: Buffer.alloc(1) })), [true, OP.BINARY, true]) // RSV1 only on the first frame
})

test('frames: a message past maxPayload keeps frame sync: payload skipped unbuffered, reported omitted, later frames parse', () => {
  const big = encodeFrame(OP.TEXT, 'x'.repeat(40)), ok = encodeFrame(OP.TEXT, 'ok')
  const frag = [encodeFrame(OP.BINARY, 'a'.repeat(10), { fin: false }), encodeFrame(OP.PING, 'p'), encodeFrame(OP.CONT, 'b'.repeat(10), { fin: false }), encodeFrame(OP.CONT, 'c')]
  const all = [big, ok, ...frag, ok], wire = Buffer.concat(all)
  for (const split of [1, 5, wire.length]) {
    const p = createFrameParser({ maxPayload: 16 }), a = createMessageAssembler(), frames = [], done = []
    for (let i = 0; i < wire.length; i += split) { const r = p.push(wire.subarray(i, i + split)); assert.equal(r.error, null); frames.push(...r.frames) }
    for (const f of frames) { const e = a.push(f); if (e.done) done.push(e.message ? e.message.toString() : { omitted_bytes: e.omitted_bytes }) }
    assert.deepEqual(frames.map((f) => f.omitted ?? (f.payload && f.payload.length)), [40, 2, 10, 1, 10, 1, 2])
    assert.deepEqual(frames.map((f) => f.header), all.map((b) => b.subarray(0, 6)), 'every header kept, mask key included')
    assert.deepEqual(done, [{ omitted_bytes: 40 }, 'ok', { omitted_bytes: 21 }, 'ok']) // the fragment before the cap is dropped too
  }
  const [huge] = createFrameParser().push(Buffer.from([0x82, 0x7f, 0, 0, 1, 0, 0, 0, 0, 0])).frames // 1 TiB declared
  assert.deepEqual([huge.omitted, huge.payload], [2 ** 40, null], 'reported at its header, not after buffering')
})

// An independent sender: ONE streaming deflateRaw context across messages (what a takeover peer runs).
function streamingDeflater() {
  const z = zlib.createDeflateRaw()
  return (text) => new Promise((resolve) => {
    const out = []; const take = (d) => out.push(d)
    z.on('data', take).write(text)
    z.flush(zlib.constants.Z_SYNC_FLUSH, () => setImmediate(() => { z.off('data', take); resolve(strip(Buffer.concat(out))) }))
  })
}

// What the recorder (3c-3) does per direction: parse → assemble → inflate, or skip an omitted message.
function decodeAll(wire, maxPayload, noContextTakeover) {
  const p = createFrameParser({ maxPayload }), a = createMessageAssembler(), inf = createInflater({ noContextTakeover }), out = []
  for (const e of p.push(wire).frames.map((f) => a.push(f)).filter((x) => x.done)) {
    if (e.omitted_bytes != null) { if (e.compressed) inf.skip(); out.push('omitted'); continue }
    try { out.push(inf.inflate(e.message).toString()) } catch { out.push('decode-failed') }
  }
  return out
}

test('deflate: an omitted message breaks a takeover window (the next is decode-failed, never wrong text); without takeover the next inflates', async () => {
  const texts = ['A'.repeat(1500), `${randomBytes(800).toString('hex')}${'C'.repeat(1500)}`, `${'C'.repeat(1500)}tail`]
  const send = streamingDeflater(); const take = []; for (const t of texts) take.push(await send(t))
  const wire = (zs) => Buffer.concat(zs.map((z) => encodeFrame(OP.TEXT, z, { rsv1: true })))
  assert.deepEqual(decodeAll(wire(take), 500, false), [texts[0], 'omitted', 'decode-failed'])
  assert.deepEqual(decodeAll(wire(texts.map((t) => strip(zlib.deflateRawSync(t, SYNC)))), 500, true), [texts[0], 'omitted', texts[2]])
})

test('deflate: parseExtensions reads the agreed parameters; context takeover (past 32 KiB) and no_context_takeover both inflate', async () => {
  assert.deepEqual(parseExtensions('permessage-deflate; server_no_context_takeover; client_max_window_bits=10').deflate,
    { serverNoContextTakeover: true, clientNoContextTakeover: false, serverMaxWindowBits: 15, clientMaxWindowBits: 10 })
  assert.deepEqual(parseExtensions('permessage-deflate;client_no_context_takeover; server_max_window_bits="12"').deflate,
    { serverNoContextTakeover: false, clientNoContextTakeover: true, serverMaxWindowBits: 12, clientMaxWindowBits: 15 })
  assert.equal(parseExtensions('').deflate, null)
  assert.deepEqual(parseExtensions('x-foo, permessage-deflate').other, ['x-foo'])
  const big = randomBytes(24 << 10).toString('hex') // 48 KiB of history: the window is its LAST 32 KiB
  const texts = ['lorem ipsum dolor '.repeat(40), `again ${'lorem ipsum dolor '.repeat(41)}`, big, 'short', `${big.slice(-3000)} end`]
  const send = streamingDeflater()
  const parts = []; for (const t of texts) parts.push(await send(t))
  const inf = createInflater()
  assert.deepEqual(parts.map((p) => inf.inflate(p).toString()), texts)
  // the second message back-references the first: without the first's window it cannot be read
  assert.throws(() => { if (createInflater().inflate(parts[1]).toString() !== texts[1]) throw new Error('wrong text') })
  const fresh = createInflater({ noContextTakeover: true })
  assert.deepEqual(texts.map((t) => fresh.inflate(strip(zlib.deflateRawSync(t, SYNC))).toString()), texts)
  assert.throws(() => createInflater({ maxOutput: 100 }).inflate(strip(zlib.deflateRawSync('x'.repeat(1000), SYNC))))
  // a message that failed (here: past maxOutput) leaves no stale window: the next one that refers into it throws, never wrong text
  const send2 = streamingDeflater(), lossy = createInflater({ maxOutput: 2000 }), q = [];  for (const t of ['A'.repeat(1500), 'C'.repeat(3000), `${'C'.repeat(1500)}tail`]) q.push(await send2(t))
  assert.equal(lossy.inflate(q[0]).toString(), 'A'.repeat(1500)); assert.throws(() => lossy.inflate(q[1])); assert.throws(() => lossy.inflate(q[2]))
})

test('ws_raw: an m-slice rebuilds from the stored message, p from itself; masks are re-applied from the header', () => {
  const f1 = encodeFrame(1, 'hel', { fin: false }), f2 = encodeFrame(9, 'p'), f3 = encodeFrame(0, 'lo')
  const h = (f, n) => f.subarray(0, n).toString('base64')
  const env = { req_body: 'hello', resp: { kind: 'ws', messages: [] }, ws_raw: [
    { i: 0, d: 'c', h: h(f1, 6), m: [0, 0] }, { i: 1, d: 'c', h: h(f2, 6), p: Buffer.from('p').toString('base64') }, { i: 2, d: 'c', h: h(f3, 6), m: [0, 3] }] }
  assert.ok(rebuildWsWire(env).c.equals(Buffer.concat([f1, f2, f3])))
  assert.deepEqual([messageBytes({ b64: 'AAE=' }), messageBytes({ b64: 'AAE=', decode_error: 'x' })], [Buffer.from([0, 1]), null]) // that b64 is still compressed
  assert.throws(() => rebuildWsWire({ ...env, ws_raw: [{ i: 0, d: 'c', h: h(f1, 6) }] }), /not retained/)
  assert.deepEqual(messagesOf({ req_body: null, req_body_b64: 'AAE=', req_extra_messages: ['x'] }, 'c'), [{ b64: 'AAE=' }, 'x'])
})

test('ws_raw: both directions, 16/64-bit lengths, a compressed frame as p: one envelope rebuilds alone (W5), never a wrong length', () => {
  const big = 'y'.repeat(70000), z = strip(zlib.deflateRawSync('zz', SYNC))
  const c = [encodeFrame(OP.TEXT, 'first'), encodeFrame(OP.TEXT, big)] // req_body, req_extra_messages[0]
  const s = [encodeFrame(OP.TEXT, 'x'.repeat(200), { mask: false }), encodeFrame(OP.TEXT, z, { mask: false, rsv1: true })]
  const [c0, c1] = createFrameParser().push(Buffer.concat(c)).frames, [s0, s1] = createFrameParser().push(Buffer.concat(s)).frames
  const ws_raw = [['c', c0, { m: [0, 0] }], ['s', s0, { m: [0, 0] }], ['c', c1, { m: [1, 0] }], ['s', s1, { p: s1.payload.toString('base64') }]]
    .map(([d, f, x], i) => ({ i, d, h: f.header.toString('base64'), ...x }))
  // an envelope cut by the connection keeps its server messages under resp.partial
  const env = { req_body: 'first', req_extra_messages: [big], resp: { status: null, kind: 'error', partial: { kind: 'ws', messages: ['x'.repeat(200), 'zz'] } }, ws_raw }
  const wire = rebuildWsWire(env)
  assert.ok(wire.c.equals(Buffer.concat(c)) && wire.s.equals(Buffer.concat(s)))
  assert.throws(() => rebuildWsWire({ ...env, req_extra_messages: ['short'] }), /header says 70000/)
  // a direction without payloads (non-LLM client messages) does not hide the other one (W5, W16)
  const nonLlm = { ...env, req_body: { raw_chars: 5, verbatim: false }, ws_raw: ws_raw.map(({ m, ...e }) => (e.d === 'c' ? e : { ...e, m })) }
  assert.throws(() => rebuildWsWire(nonLlm), /not retained/); assert.ok(rebuildWsWire(nonLlm, 's').s.equals(Buffer.concat(s)))
  assert.throws(() => rebuildWsWire({ ...env, ws_raw: [{ ...ws_raw[0], h: ws_raw[0].h.slice(0, 4) }] }), /header is 3 bytes/) // mask key cut off
})
