import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildTransparentEnvelope, buildWsEnvelope } from '../../../src/collector/core/record/envelope.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const FLOW = { id: 'f1', host: 'relay.test', scheme: 'https', dst: { address: '10.0.0.9', port: 443 }, proc: { pid: 9, exe: '/usr/bin/claude', agent: 'claude-code' } }
const head = (s) => ({ raw: Buffer.from(s, 'latin1'), startLine: s.split('\r\n')[0] })

test('envelope: D10 fields first, new fields after req_body, raw heads verbatim', () => {
  const reqRaw = 'POST /anthropic/v1/messages HTTP/1.1\r\nHost: relay.test\r\nX-Api-Key: k\r\nX-Dup: a\r\nx-dup: b\r\n\r\n'
  const env = buildTransparentEnvelope({
    id: 'r1', flow: FLOW, seq: 0, error: null,
    req: { head: { ...head(reqRaw), method: 'POST', target: '/anthropic/v1/messages', headers: [['Host', 'relay.test'], ['X-Api-Key', 'k'], ['X-Dup', 'a'], ['x-dup', 'b']] }, body: Buffer.from('{"model":"m"}'), truncated: false, tsStart: '2026-10-05T00:00:00.000Z' },
    resp: { head: { ...head('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'), status: 200, headers: [['Content-Type', 'application/json']] }, body: Buffer.from('{"ok":1}'), truncated: false, tsStart: '2026-10-05T00:00:01.000Z', tsEnd: '2026-10-05T00:00:02.000Z' },
  })
  const keys = Object.keys(env)
  assert.ok(keys.indexOf('req_headers') < keys.indexOf('req_body'))
  for (const k of ['host', 'scheme', 'dst', 'proc', 'flow_id', 'seq', 'req_head_raw', 'resp_head_raw']) assert.ok(keys.indexOf(k) > keys.indexOf('req_body'), k)
  assert.equal(env.req_body, '{"model":"m"}'); assert.equal(env.is_llm_call, true)
  assert.equal(env.req_headers['x-dup'], 'a, b'); assert.equal(env.req_head_raw, reqRaw)
  assert.equal(env.capture, 'transparent'); assert.deepEqual(env.resp.body, { ok: 1 })
  assert.equal('transport' in env, false, 'an HTTP envelope carries no transport (absent = http)')
  const line = JSON.stringify(env)
  assert.ok(line.indexOf('"req_headers":{') < line.indexOf('"req_body"'))
})

test('envelope: a response that never arrived is an error envelope', () => {
  const env = buildTransparentEnvelope({ id: 'r2', flow: FLOW, seq: 1, resp: null, error: { type: 'ECONNRESET', message: 'reset' },
    req: { head: { ...head('POST /v1/messages HTTP/1.1\r\n\r\n'), method: 'POST', target: '/v1/messages', headers: [] }, body: Buffer.alloc(0), truncated: false, tsStart: '2026-10-05T00:00:00.000Z' } })
  assert.equal(env.error, true); assert.equal(env.resp.kind, 'error'); assert.equal(env.resp.error.type, 'ECONNRESET')
})

test('envelope: a request body cut at the cap is labelled req_truncated + req_body_bytes; an uncut one carries neither (invariant 4)', () => {
  const mk = (target, body, truncated) => buildTransparentEnvelope({ id: 'r3', flow: FLOW, seq: 0, error: null,
    req: { head: { ...head(`POST ${target} HTTP/1.1\r\n\r\n`), method: 'POST', target, headers: [] }, body: Buffer.from(body), truncated, tsStart: '2026-10-05T00:00:00.000Z' },
    resp: { head: { ...head('HTTP/1.1 200 OK\r\n\r\n'), status: 200, headers: [] }, body: Buffer.alloc(0), truncated: false, tsStart: '2026-10-05T00:00:01.000Z', tsEnd: '2026-10-05T00:00:02.000Z' } })
  const cut = mk('/v1/messages', '{"model":"m","mess', true)
  assert.equal(cut.req_truncated, true); assert.equal(cut.req_body_bytes, 18)
  assert.equal(cut.req_body, '{"model":"m","mess')   // the captured prefix is still stored as-is
  const keys = Object.keys(cut)
  for (const k of ['req_truncated', 'req_body_bytes']) assert.ok(keys.indexOf(k) > keys.indexOf('req_body'), k)
  const nonLlm = mk('/api/event_logging/batch', 'abcd', true)   // D40: a non-LLM body is cut and labelled the same way
  assert.deepEqual([nonLlm.req_truncated, nonLlm.req_body_bytes, nonLlm.req_body], [true, 4, 'abcd'])
  const whole = mk('/v1/messages', '{"model":"m"}', false)
  for (const k of ['req_truncated', 'req_body_bytes', 'req_partial']) assert.equal(k in whole, false, k)
})

test('envelope: a request body that never finished carries req_partial:<reason> after req_body (invariant 4)', () => {
  const env = buildTransparentEnvelope({ id: 'r4', flow: FLOW, seq: 0, resp: null, error: { type: 'ECONNRESET', message: 'reset' },
    req: { head: { ...head('POST /v1/messages HTTP/1.1\r\n\r\n'), method: 'POST', target: '/v1/messages', headers: [] }, body: Buffer.from('{"mo'), truncated: false, partial: 'aborted', tsStart: '2026-10-05T00:00:00.000Z' } })
  assert.equal(env.req_partial, 'aborted'); assert.equal(env.req_body, '{"mo'); assert.equal('req_truncated' in env, false)
  const keys = Object.keys(env); assert.ok(keys.indexOf('req_partial') > keys.indexOf('req_body'))
})

test('store: 0600 files, 0700 dirs, streams split by kind, write errors never throw', () => {
  const root = tmpDir('asight-store-')
  const s = createRecordStore({ root, now: () => new Date('2026-10-05T01:00:00.000Z') })
  s.envelope({ ts: '2026-10-05T01:00:00.000Z', id: 'a' }); s.flow({ ts: '2026-10-05T01:00:00.000Z', flow_id: 'f' })
  s.audit({ ts: '2026-10-05T01:00:00.000Z' }); s.replay({ ts: '2026-10-05T01:00:00.000Z', id: 'b' })
  assert.equal(fs.statSync(path.join(root, 'capture-2026-10-05.ndjson')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(root, 'flows')).mode & 0o777, 0o700)
  for (const d of ['flows', 'audit', 'replays']) assert.ok(fs.existsSync(path.join(root, d, '2026-10-05.ndjson')), d)
  assert.equal(typeof s.failure, 'undefined', 'no failures/ stream (D38): failures are flows/ event lines, written by core/events.mjs')
  s.close()
  const broken = createRecordStore({ root: '/dev/null/nope' })
  assert.equal(broken.envelope({ ts: '2026-10-05T01:00:00.000Z' }), false, 'a failed write says so, never throws')
  assert.equal(broken.errors, 1)
  assert.match(String(broken.lastError), /ENOTDIR|ENOENT/, 'the reason is kept for the caller (D38)')
  const ok = createRecordStore({ root })
  assert.equal(ok.envelope({ ts: '2026-10-05T01:00:00.000Z', id: 'c' }), true, 'a written line says so')
  ok.close()
})

// RFC 4.6 §传输与帧级记录 (D37): one envelope per logical WebSocket call, the upgrade's heads on each.
const WS_UP = {
  req: { head: { ...head('GET /v1/responses HTTP/1.1\r\nSession-Id: s-1\r\n\r\n'), method: 'GET', target: '/v1/responses', headers: [['Session-Id', 's-1']] } },
  resp: { head: { ...head('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n'), status: 101, headers: [['Sec-WebSocket-Extensions', 'permessage-deflate']] } },
}
const wsCall = (x) => ({ client: [], server: [], tsStart: '2026-10-05T00:00:00.000Z', tsRespStart: '2026-10-05T00:00:01.000Z', tsEnd: '2026-10-05T00:00:03.000Z', partial: [], truncated: false, ...x })
const RAW = [{ i: 4, d: 'c', h: 'gYI=', p: 'aGk=' }, { i: 9, d: 's', h: 'gQI=', p: 'b2s=' }]

test('ws envelope: upgrade heads verbatim, opener text in req_body, new fields after req_body, transport ws', () => {
  const env = buildWsEnvelope({ id: 'w1', flow: FLOW, seq: 3, upgrade: WS_UP, wsRaw: RAW, call: wsCall({ client: ['{"type":"response.create"}', 'more'], server: ['a', { b64: 'AAE=' }] }) })
  const keys = Object.keys(env)
  for (const k of ['host', 'flow_id', 'seq', 'req_head_raw', 'resp_head_raw', 'transport', 'ws_frames', 'ws_ext', 'ws_raw', 'req_extra_messages']) assert.ok(keys.indexOf(k) > keys.indexOf('req_body'), k)
  assert.equal(env.req_body, '{"type":"response.create"}'); assert.deepEqual(env.req_extra_messages, ['more']); assert.equal(env.is_llm_call, true)
  assert.deepEqual(env.resp, { kind: 'ws', messages: ['a', { b64: 'AAE=' }] }); assert.equal(env.error, undefined)
  assert.deepEqual([env.transport, env.ws_frames, env.ws_ext, env.seq, env.flow_id, env.method], ['ws', [4, 9], 'permessage-deflate', 3, 'f1', 'GET'])
  assert.equal(env.req_headers['session-id'], 's-1'); assert.equal(env.req_head_raw, WS_UP.req.head.raw.toString('latin1')); assert.match(env.resp_head_raw, /^HTTP\/1.1 101/)
  assert.equal(env.duration_ms, 2000); assert.equal(env.ts, '2026-10-05T00:00:00.000Z')
  for (const k of ['partial', 'partial_reasons', 'ws_truncated', 'req_body_b64']) assert.equal(k in env, false, k)
})

test('ws envelope: no opener → req_body null; a binary opener → req_body null + req_body_b64; non-LLM opener is metadata; cut → error with resp.partial; labels', () => {
  const push = buildWsEnvelope({ id: 'w2', flow: FLOW, seq: 0, upgrade: WS_UP, wsRaw: RAW, call: wsCall({ server: ['hello'] }) })
  assert.equal(push.req_body, null); assert.equal('req_extra_messages' in push, false)
  const bin = buildWsEnvelope({ id: 'w3', flow: FLOW, seq: 0, upgrade: WS_UP, wsRaw: [], call: wsCall({ client: [{ b64: 'AAE=' }, { b64: 'Ag==' }], tsRespStart: null }) })
  assert.deepEqual([bin.req_body, bin.req_body_b64, bin.req_extra_messages, bin.ws_frames, bin.duration_ms], [null, 'AAE=', [{ b64: 'Ag==' }], null, null])
  assert.equal('req_content_encoding' in bin, false)
  const lost = buildWsEnvelope({ id: 'w4', flow: FLOW, seq: 0, upgrade: WS_UP, wsRaw: RAW, call: wsCall({ client: [{ omitted_bytes: 9 }], truncated: true, partial: ['off-window', 'decode-failed'] }) })
  assert.deepEqual([lost.req_body, 'req_body_b64' in lost, lost.ws_truncated, lost.partial, lost.partial_reasons], [null, false, true, true, ['off-window', 'decode-failed']])
  const ctl = { ...WS_UP, req: { head: { ...WS_UP.req.head, target: '/realtime/control' } } }
  const meta = buildWsEnvelope({ id: 'w5', flow: FLOW, seq: 0, upgrade: ctl, wsRaw: RAW, call: wsCall({ client: [{ raw_chars: 2, verbatim: false }] }) })
  assert.deepEqual([meta.req_body, meta.is_llm_call], [{ raw_chars: 2, verbatim: false }, false])
  const cut = buildWsEnvelope({ id: 'w6', flow: FLOW, seq: 0, upgrade: WS_UP, wsRaw: RAW, call: wsCall({ client: ['go'], server: ['part'] }), error: { type: 'ECONNRESET', message: 'reset' } })
  assert.equal(cut.error, true)
  assert.deepEqual(cut.resp, { status: null, kind: 'error', error: { type: 'ECONNRESET', message: 'reset' }, partial: { kind: 'ws', messages: ['part'] } })
  const none = buildWsEnvelope({ id: 'w7', flow: FLOW, seq: 0, upgrade: { ...WS_UP, resp: { head: { ...head('HTTP/1.1 101 x\r\n\r\n'), status: 101, headers: [] } } }, wsRaw: RAW, call: wsCall({ client: ['x'] }) })
  assert.equal(none.ws_ext, null)
})

// RFC 4.6 §记录 / 4.2:49: the daily file is chosen when the line is WRITTEN. A call that starts before
// midnight and ends after it must not be appended to the previous day's file once the new day's file
// exists — the ETL's per-session watermark would skip it.
test('store: an envelope whose request started before midnight but is written after it lands in the new day file', () => {
  const root = tmpDir('asight-store-')
  let clock = '2026-10-05T23:59:01.000Z'
  const s = createRecordStore({ root, now: () => new Date(clock) })
  s.envelope({ ts: '2026-10-05T23:59:00.000Z', id: 'a1' })
  clock = '2026-10-06T00:00:20.000Z'
  s.envelope({ ts: '2026-10-05T23:59:50.000Z', id: 'a2' }) // started 10 s before midnight
  s.close()
  const ids = (f) => fs.readFileSync(path.join(root, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(ids('capture-2026-10-05.ndjson').map((r) => r.id), ['a1'])
  assert.deepEqual(ids('capture-2026-10-06.ndjson'), [{ ts: '2026-10-05T23:59:50.000Z', id: 'a2' }], 'rec.ts is kept as captured')
})

test('store: crossing midnight closes the previous day\'s files, so a long-running daemon does not leak one fd set per day', () => {
  const root = tmpDir('asight-store-')
  let clock = '2026-10-05T23:59:01.000Z'
  const s = createRecordStore({ root, now: () => new Date(clock) })
  s.envelope({ id: 'a1' }); s.flow({ flow_id: 'f1' }); s.audit({ event: 'on' })
  assert.equal(s.openFiles, 3)
  clock = '2026-10-06T00:00:01.000Z'
  s.envelope({ id: 'a2' })
  assert.equal(s.openFiles, 1, 'only the new day\'s capture file is open')
  s.flow({ flow_id: 'f2' })
  s.close()
  assert.equal(s.openFiles, 0)
  assert.equal(s.errors, 0)
  const lines = (f) => fs.readFileSync(path.join(root, f), 'utf8').trim().split('\n').length
  assert.deepEqual([lines('capture-2026-10-05.ndjson'), lines('capture-2026-10-06.ndjson'), lines('flows/2026-10-05.ndjson'), lines('flows/2026-10-06.ndjson')], [1, 1, 1, 1])
  fs.rmSync(root, { recursive: true, force: true })
})

// D38 (RFC 4.6 §记录 / §日志体积预算「已关闭」, D35): at rollover the previous day's files only this store writes are
// fsync'd, closed and marked closed — the sealer then takes them; flows/ has a second writer and is not marked.
test('store: at rollover the previous day\'s capture / audit / replays files get the close marker, flows/ does not; the sealer accepts them', async () => {
  const { closedState } = await import('../../../src/raw/closed.mjs')
  const { sealShard } = await import('../../../src/raw/seal.mjs')
  const root = tmpDir('asight-store-')
  try {
    let clock = '2026-10-05T23:59:01.000Z'
    const s = createRecordStore({ root, now: () => new Date(clock), onError: (e) => { throw e } })
    s.envelope({ id: 'a1' }); s.flow({ flow_id: 'f1' }); s.audit({ event: 'on' }); s.replay({ id: 'r1' })
    assert.equal(closedState(path.join(root, 'capture-2026-10-05.ndjson')).closed, false, 'the current day is never marked')
    clock = '2026-10-06T00:00:01.000Z'
    s.envelope({ id: 'a2' })
    for (const f of ['capture-2026-10-05.ndjson', 'audit/2026-10-05.ndjson', 'replays/2026-10-05.ndjson']) assert.equal(closedState(path.join(root, f)).closed, true, f)
    assert.equal(fs.existsSync(path.join(root, 'flows', '2026-10-05.ndjson.closed')), false, 'flows/ also has the event writer: not this store\'s to close')
    assert.equal(closedState(path.join(root, 'capture-2026-10-06.ndjson')).closed, false)
    const r = await sealShard(path.join(root, 'capture-2026-10-05.ndjson'), { sessionsRoot: path.join(root, 'sessions'), journal: null })
    assert.equal(r.records, 1, 'the marked day is sealable')
    s.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 4.6 §记录: a daemon that stopped on day D and starts on D+1 never rolls over in-process; the store marks
// D's files closed when it is created, so they can be sealed — flows/ and today's files are never marked.
test('store: created on a later day, it marks the earlier days\' capture / audit / replays files closed (4.6 §记录)', async () => {
  const { closedState } = await import('../../../src/raw/closed.mjs')
  const root = tmpDir('asight-store-')
  try {
    const a = createRecordStore({ root, now: () => new Date('2026-10-05T22:00:00.000Z'), onError: (e) => { throw e } })
    a.envelope({ id: 'd1' }); a.flow({ flow_id: 'f1' }); a.audit({ event: 'on' }); a.replay({ id: 'r1' })
    a.close() // the daemon stops on day D: no rollover, no marker
    assert.equal(closedState(path.join(root, 'capture-2026-10-05.ndjson')).closed, false, 'precondition: not marked by stop')
    fs.writeFileSync(path.join(root, 'capture-2026-10-06.ndjson'), '') // a file of the new day already there
    const b = createRecordStore({ root, now: () => new Date('2026-10-06T08:00:00.000Z'), onError: (e) => { throw e } })
    for (const f of ['capture-2026-10-05.ndjson', 'audit/2026-10-05.ndjson', 'replays/2026-10-05.ndjson']) assert.equal(closedState(path.join(root, f)).closed, true, f)
    assert.equal(fs.existsSync(path.join(root, 'flows', '2026-10-05.ndjson.closed')), false, 'flows/ is not this store\'s to close')
    assert.equal(fs.existsSync(path.join(root, 'capture-2026-10-06.ndjson.closed')), false, 'today is never marked')
    createRecordStore({ root, now: () => new Date('2026-10-06T09:00:00.000Z'), onError: (e) => { throw e } }).close() // idempotent
    b.envelope({ id: 'd2' }); b.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('store: a clock set back keeps writing the latest day\'s file, never appends to an earlier (maybe sealed) one (F3(i))', () => {
  const root = tmpDir('asight-store-')
  try {
    let clock = '2026-10-06T00:00:30.000Z'
    const s = createRecordStore({ root, now: () => new Date(clock), onError: (e) => { throw e } })
    s.envelope({ id: 'b1' })
    clock = '2026-10-05T23:00:00.000Z' // an hour back
    s.envelope({ id: 'b2' }); s.flow({ flow_id: 'f' })
    s.close()
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.ndjson')), ['capture-2026-10-06.ndjson'])
    assert.equal(fs.readFileSync(path.join(root, 'capture-2026-10-06.ndjson'), 'utf8').trim().split('\n').length, 2)
    assert.deepEqual(fs.readdirSync(path.join(root, 'flows')), ['2026-10-06.ndjson'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// D38 a file renamed or deleted while open is reopened before the next write and reported (file-replaced) — no
// line goes into an orphan inode.
test('store: a capture file renamed or deleted while open is reopened, and that is a file-replaced failure', () => {
  const root = tmpDir('asight-store-')
  try {
    const errs = []
    const s = createRecordStore({ root, now: () => new Date('2026-10-06T01:00:00.000Z'), onError: (e) => errs.push(e) })
    const f = path.join(root, 'capture-2026-10-06.ndjson')
    s.envelope({ id: 'c1' })
    fs.renameSync(f, path.join(root, 'moved.ndjson'))
    assert.equal(s.envelope({ id: 'c2' }), true, 'written, to the path')
    assert.deepEqual(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['c2'])
    assert.deepEqual(fs.readFileSync(path.join(root, 'moved.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['c1'], 'nothing more into the moved file')
    fs.rmSync(f)
    s.envelope({ id: 'c3' })
    assert.deepEqual(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['c3'])
    assert.deepEqual(errs.map((e) => [e.code, e.file]), [['file-replaced', f], ['file-replaced', f]])
    s.envelope({ id: 'c4' })
    assert.equal(errs.length, 2, 'an unchanged file is not reported')
    s.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// RFC 4.6 §传输与帧级记录「请求体压缩」/ §记录 · acceptance T16 (D38 T-14): a compressed request body used to be
// read as UTF-8 and stored as U+FFFD noise that looked verbatim.
test('compressed request bodies: wire bytes verbatim in req_body_b64; gzip decoded; zstd never decoded at capture; a non-LLM endpoint is the same (D40)', async () => {
  const zlib = (await import('node:zlib')).default
  const json = '{"model":"m","messages":[{"role":"user","content":"压缩 ok"}]}'
  const mk = (target, enc, body) => buildTransparentEnvelope({ id: 'c', flow: FLOW, seq: 0, resp: null, error: null,
    req: { head: { ...head(`POST ${target} HTTP/1.1\r\n\r\n`), method: 'POST', target, headers: enc ? [['Content-Encoding', enc]] : [] }, body, truncated: false, tsStart: '2026-10-05T00:00:00.000Z' } })
  const gz = zlib.gzipSync(json)
  const g = mk('/v1/messages', 'gzip', gz)
  assert.equal(g.req_body, json); assert.equal(g.req_body_b64, gz.toString('base64')); assert.equal(g.req_content_encoding, 'gzip'); assert.equal(g.req_encoding_error, undefined)
  const keys = Object.keys(g); assert.ok(keys.indexOf('req_body_b64') > keys.indexOf('req_body') && keys.indexOf('req_body') > keys.indexOf('req_headers'))
  // zstd: stored, never decoded here — even on a Node that could (the decoder is spied on)
  const real = zlib.zstdDecompressSync; let calls = 0
  zlib.zstdDecompressSync = (...a) => { calls++; return real ? real(...a) : Buffer.alloc(0) }
  try {
    const zb = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync(json) : Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])
    const z = mk('/backend-api/codex/responses', 'zstd', zb)
    assert.equal(z.req_body, null); assert.equal(z.req_body_b64, zb.toString('base64')); assert.equal(z.req_content_encoding, 'zstd'); assert.match(z.req_encoding_error, /zstd/)
    assert.equal(mk('/v1/messages', 'gzip, zstd', zb).req_body, null)
    assert.equal(calls, 0, 'no zstd decoder was called at capture')
  } finally { zlib.zstdDecompressSync = real }
  const bad = mk('/v1/messages', 'gzip', Buffer.from('not gzip'))
  assert.equal(bad.req_body, null); assert.ok(bad.req_encoding_error); assert.equal(bad.req_body_b64, Buffer.from('not gzip').toString('base64'))
  // D40 flipped this: a non-LLM endpoint's compressed body used to be {raw_chars}; now it takes the LLM shape (4.6 T16)
  const nonLlm = mk('/api/event_logging/batch', 'gzip', gz)
  assert.deepEqual([nonLlm.req_body, nonLlm.req_body_b64, nonLlm.req_content_encoding], [json, gz.toString('base64'), 'gzip'])
  assert.equal(nonLlm.is_llm_call, false); assert.deepEqual(nonLlm.body_wire_bytes, { req: gz.length, resp: null })
  const plain = mk('/v1/messages', 'identity', Buffer.from(json))
  assert.equal(plain.req_body, json); assert.equal(plain.req_body_b64, undefined)
  assert.equal(mk('/v1/messages', null, Buffer.from(json)).req_body_b64, undefined, 'an uncompressed body has no wire fields')
  assert.equal('transport' in g, false, 'still an HTTP envelope (T16)')
})

// review D: req_encoding_error = "the bytes are complete, only not decoded" (§记录); an incomplete compressed body
// is labelled by req_truncated / req_partial alone; a decoded body that is not UTF-8 is not stored as lossy text
test('compressed request bodies: cut or unfinished bodies are not decoded; non-UTF-8 decoded bytes stay undecoded; deflate / br decoded; empty gzip body', async () => {
  const zlib = (await import('node:zlib')).default
  const json = '{"model":"m","messages":[{"role":"user","content":"ok"}]}'
  const mk = (enc, body, extra = {}) => buildTransparentEnvelope({ id: 'c', flow: FLOW, seq: 0, resp: null, error: null,
    req: { head: { ...head('POST /v1/messages HTTP/1.1\r\n\r\n'), method: 'POST', target: '/v1/messages', headers: enc ? [['Content-Encoding', enc]] : [] }, body, truncated: false, tsStart: '2026-10-05T00:00:00.000Z', ...extra } })
  const gz = zlib.gzipSync(json), cut = gz.subarray(0, 20)
  const t = mk('gzip', cut, { truncated: true })
  assert.deepEqual([t.req_body, t.req_body_b64, t.req_content_encoding, 'req_encoding_error' in t, t.req_truncated, t.req_body_bytes], [null, cut.toString('base64'), 'gzip', false, true, 20])
  const p = mk('gzip', gz, { partial: 'aborted' }) // even a body that would decode: it never finished
  assert.deepEqual([p.req_body, p.req_body_b64, 'req_encoding_error' in p, p.req_partial], [null, gz.toString('base64'), false, 'aborted'])
  const notUtf8 = mk('gzip', zlib.gzipSync(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])))
  assert.deepEqual([notUtf8.req_body, notUtf8.req_encoding_error], [null, 'decoded body is not UTF-8'])
  assert.equal(mk('deflate', zlib.deflateSync(json)).req_body, json)
  assert.equal(mk('br', zlib.brotliCompressSync(json)).req_body, json)
  const empty = mk('gzip', Buffer.alloc(0))
  assert.deepEqual([empty.req_body, 'req_body_b64' in empty, 'req_encoding_error' in empty], ['', false, false])
})
