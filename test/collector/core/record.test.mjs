import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildTransparentEnvelope } from '../../../src/collector/core/record/envelope.mjs'
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
  assert.equal('req_truncated' in whole, false); assert.equal('req_body_bytes' in whole, false)
})

test('store: 0600 files, 0700 dirs, streams split by kind, write errors never throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-store-'))
  const s = createRecordStore({ root })
  s.envelope({ ts: '2026-10-05T01:00:00.000Z', id: 'a' }); s.flow({ ts: '2026-10-05T01:00:00.000Z', flow_id: 'f' })
  s.audit({ ts: '2026-10-05T01:00:00.000Z' }); s.replay({ ts: '2026-10-05T01:00:00.000Z', id: 'b' })
  assert.equal(fs.statSync(path.join(root, 'capture-2026-10-05.ndjson')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(root, 'flows')).mode & 0o777, 0o700)
  for (const d of ['flows', 'audit', 'replays']) assert.ok(fs.existsSync(path.join(root, d, '2026-10-05.ndjson')))
  s.close()
  const broken = createRecordStore({ root: '/dev/null/nope' })
  assert.doesNotThrow(() => broken.envelope({ ts: '2026-10-05T01:00:00.000Z' }))
  assert.equal(broken.errors, 1)
})
