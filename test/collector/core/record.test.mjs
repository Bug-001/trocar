import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildTransparentEnvelope, buildWsEnvelope } from '../../../src/collector/core/record/envelope.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'

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
  assert.equal(mk('/api/event_logging/batch', 'abcd', true).req_truncated, true)   // non-LLM {raw_chars} too
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-store-'))
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-store-'))
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-store-'))
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
