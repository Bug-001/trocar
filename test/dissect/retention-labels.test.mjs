// test/dissect/retention-labels.test.mjs — what was kept of a call's bodies, told from the record alone (RFC 4.1 #9, 2.6 §保真边界 1,
// 3.2 §D40): `full` / `log` / `legacy-meta`, the label each non-full state carries, and the class a record from before D40 is given
// by the same table the capture used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyRetentionOf, retentionLabelOf, captureLabelsOf, isLogOnly } from '../../src/dissect/capture-labels.mjs'
import { trafficClassOf } from '../../src/dissect/traffic.mjs'
import { bodyOf } from '../../src/dissect/harnesses.mjs'
import { preD40, full, logged, inference } from '../fixtures/d40-records.mjs'

test('4.1 #9 — a pre-D40 {raw_chars} body is legacy-meta and is labelled; a D40 body is full and says nothing', () => {
  const old = preD40({ id: 'o' })
  assert.equal(bodyRetentionOf(old), 'legacy-meta')
  // a pre-D40 record also kept its JSON reply parsed and re-serialized (no body_wire_bytes, no resp.raw): that is said too (4.1 保真边界 ⑤)
  assert.deepEqual(captureLabelsOf(old).map((l) => l.id), ['retention-legacy-meta', 'resp-json-reserialized'])
  for (const rec of [full({ id: 'f' }), inference({ id: 'i' }), full({ id: 'b', reqBody: null, reqB64: 'AAEC' }), full({ id: 'e', reqBody: '' })]) {
    assert.equal(bodyRetentionOf(rec), 'full', rec.id)
    assert.equal(retentionLabelOf(rec), null, `${rec.id}: a complete body carries no 「非逐字」 label`)
    assert.deepEqual(captureLabelsOf(rec).filter((l) => l.id.startsWith('retention-')), [])
  }
})

test('the shape alone identifies a pre-D40 record, but only a NON-inference one: an inference body is never {raw_chars}, and a log record is told by body_retention first', () => {
  assert.equal(bodyRetentionOf({ is_llm_call: true, req_body: { raw_chars: 5, verbatim: false } }), 'full')
  assert.equal(bodyRetentionOf({ is_llm_call: false, req_body: { raw_chars: 5, verbatim: false }, body_retention: 'log' }), 'log')
  assert.equal(bodyRetentionOf({ is_llm_call: false, req_body: { raw_chars: 'x', verbatim: false } }), 'full', 'not a length: not this shape')
  assert.equal(bodyRetentionOf({ is_llm_call: false, body_retention: 'verbatim', req_body: '{}' }), 'full', 'the retired D37 value is tolerated, and means the body is there')
  assert.deepEqual([bodyRetentionOf(null), bodyRetentionOf({}), isLogOnly(undefined)], ['full', 'full', false])
})

test('a pre-D40 record that kept a length of 0 had no body: it is full, not legacy-meta, and says nothing (review L1)', () => {
  const get = preD40({ id: 'g', rawChars: 0 })
  assert.equal(bodyRetentionOf(get), 'full')
  assert.equal(retentionLabelOf(get), null)
  assert.deepEqual(captureLabelsOf(get).filter((l) => l.id.startsWith('retention-')), [])
  assert.equal(bodyRetentionOf(preD40({ id: 'o', rawChars: 1 })), 'legacy-meta', 'one byte kept as a length is still only a length')
  assert.equal(bodyRetentionOf({ ...logged({ id: 'l', wire: [0, 3] }) }), 'log', 'a log record is told by body_retention first')
})

test('a log record is labelled with the harness the level was looked up under and the class; an old-capture record is the cc row', () => {
  const l = retentionLabelOf(logged({ id: 'l', endpoint: '/v1/code/sessions/s/worker/events', cls: 'session-sync' }))
  assert.deepEqual([l.retention, l.harness, l.class], ['log', 'cc', 'session-sync'])
  const codex = retentionLabelOf(logged({ id: 'c', cls: 'telemetry', proc: { pid: 1, exe: '/x/codex', agent: 'codex' }, host: 'chatgpt.com' }))
  assert.deepEqual([codex.harness, codex.class], ['codex', 'telemetry'])
  const stranger = retentionLabelOf(logged({ id: 's', cls: 'other', proc: { pid: 1, exe: '/x/z', agent: 'mystery' } }))
  assert.deepEqual([stranger.harness, stranger.class], ['unknown', 'other'])
  const oldCapture = retentionLabelOf(logged({ id: 'm', proc: null }))
  assert.equal(oldCapture.harness, 'cc', 'the old reverse proxy / MITM apply the cc row (4.6 §记录)')
  assert.match(l.text, /not an empty body/, 'and it says the missing body is not an empty one')
})

test('a record from before D40 is given the class the capture would give it: the same table, UA-inferred harness, the Host header', () => {
  const cases = [
    [preD40({ id: '1', endpoint: '/api/event_logging/v2/batch' }), 'telemetry'],
    [preD40({ id: '2', endpoint: '/v1/code/sessions/cse_1/worker/events' }), 'session-sync'],
    [preD40({ id: '3', endpoint: '/api/oauth/file_upload' }), 'files'],
    [preD40({ id: '4', endpoint: '/api/web/domain_info?domain=x.test' }), 'account'],
    [preD40({ id: '5', endpoint: '/v1/messages/count_tokens' }), 'token-count'],
    [preD40({ id: '6', endpoint: '/something/new' }), 'other'],
    [{ ...preD40({ id: '7' }), is_llm_call: true, endpoint: '/v1/messages' }, 'llm'],
    [{ endpoint: '/x', req_headers: { host: 'o1.ingest.sentry.io', 'user-agent': 'x' } }, 'telemetry'],
  ]
  for (const [rec, want] of cases) assert.equal(trafficClassOf(rec), want, `${rec.id || rec.endpoint}`)
  assert.equal(trafficClassOf({ endpoint: '/x', traffic_class: 'files' }), 'files', 'an envelope\'s own class wins')
  assert.equal(trafficClassOf({ endpoint: '/x', traffic_class: 'nonsense' }), 'other', 'a value outside the closed set is not taken')
  assert.equal(trafficClassOf(null), 'other')
})

test('a non-inference body is never parsed for identity or hints (D40: it may be a 64 MiB upload, and before D40 it gave no key); an inference body of any size is', () => {
  const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) })
  assert.equal(bodyOf({ is_llm_call: false, req_body: big }), null)
  assert.ok(bodyOf({ is_llm_call: true, req_body: big }))
  assert.equal(bodyOf({ is_llm_call: false, req_body: '{"a":1}' }), null, 'not even a small one: the rule is the call\'s kind, not its size')
  assert.deepEqual(bodyOf({ is_llm_call: true, req_body: '{"a":1}' }), { a: 1 })
})

// review (F9): `NON_INFERENCE_PARSE_CAP` let a small non-inference body be parsed, so a hermes telemetry body {"session_id":"abc-123"} gave a session
// key — one the pre-D40 shape (`{raw_chars}`) never gave. The class and session of the same call then differed across the D40 boundary, and
// the header-only sharder (3.4:21) and the ETL disagreed.
test('F9 — a session key in the body of a call that is not inference is not a session key: kimi / hermes body keys are read from inference calls only, so the sharder and the ETL agree and nothing moves across the D40 boundary', async () => {
  const { sessionKeyOf } = await import('../../src/dissect/harnesses.mjs')
  const hermes = { pid: 3, exe: '/x/hermes', agent: 'hermes' }, kimi = { pid: 4, exe: '/x/kimi', agent: 'kimi-code' }
  const body = (o) => JSON.stringify(o)
  for (const [proc, key, endpoint] of [[hermes, 'session_id', '/telemetry/x'], [hermes, 'prompt_cache_key', '/telemetry/x'], [kimi, 'prompt_cache_key', '/upload']]) {
    const nonLlm = full({ id: 'n', proc, host: 'x.example.test', endpoint, cls: 'other', reqBody: body({ [key]: 'abc-123' }), headers: { 'user-agent': 'x' } })
    assert.equal(sessionKeyOf(nonLlm).key, null, `${proc.agent}.${key}: no key from a non-inference body`)
    assert.equal(sessionKeyOf(nonLlm).key, sessionKeyOf(nonLlm, { headersOnly: true }).key, 'the header-only sharder and the full reader agree')
    // the pre-D40 shape of the same call gave no key either: nothing changes across the boundary
    assert.equal(sessionKeyOf({ ...nonLlm, req_body: { raw_chars: 20, verbatim: false } }).key, null)
    // an inference call keeps reading its body key
    assert.equal(sessionKeyOf({ ...nonLlm, is_llm_call: true, endpoint: '/v1/chat/completions', traffic_class: 'llm' }).key, 'abc-123', `${proc.agent}.${key}: inference is as before`)
  }
})
