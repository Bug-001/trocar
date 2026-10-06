// test/dissect/retention-labels.test.mjs — what was kept of a call's bodies, told from the record alone (RFC 4.1 #9, 2.6 §保真边界 1,
// 3.2 §D40): `full` / `log` / `legacy-meta`, the label each non-full state carries, and the class a record from before D40 is given
// by the same table the capture used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyRetentionOf, retentionLabelOf, captureLabelsOf, isLogOnly, LEGACY_META_TEXT } from '../../src/dissect/capture-labels.mjs'
import { trafficClassOf } from '../../src/dissect/traffic.mjs'
import { bodyOf } from '../../src/dissect/harnesses.mjs'
import { preD40, full, logged, inference } from '../fixtures/d40-records.mjs'

test('4.1 #9 — a pre-D40 {raw_chars} body is legacy-meta and says 「本条采于 D40 之前,只存了长度」; a D40 body is full and says nothing', () => {
  const old = preD40({ id: 'o' })
  assert.equal(bodyRetentionOf(old), 'legacy-meta')
  assert.equal(retentionLabelOf(old).label, '本条采于 D40 之前,只存了长度')
  assert.equal(LEGACY_META_TEXT, '本条采于 D40 之前,只存了长度')
  assert.deepEqual(captureLabelsOf(old).map((l) => l.id), ['retention-legacy-meta'])
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

test('a log record says 「只记日志 · 用户设置 <harness> · <类别>」 with the harness the level was looked up under; an old-capture record is the cc row', () => {
  const l = retentionLabelOf(logged({ id: 'l', endpoint: '/v1/code/sessions/s/worker/events', cls: 'session-sync' }))
  assert.deepEqual([l.retention, l.harness, l.class, l.label], ['log', 'cc', 'session-sync', '只记日志 · 用户设置 cc · session-sync'])
  const codex = retentionLabelOf(logged({ id: 'c', cls: 'telemetry', proc: { pid: 1, exe: '/x/codex', agent: 'codex' }, host: 'chatgpt.com' }))
  assert.equal(codex.label, '只记日志 · 用户设置 codex · telemetry')
  const stranger = retentionLabelOf(logged({ id: 's', cls: 'other', proc: { pid: 1, exe: '/x/z', agent: 'mystery' } }))
  assert.equal(stranger.label, '只记日志 · 用户设置 unknown · other')
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

test('a non-inference body over 1 MiB is not parsed for identity (D40: it may be a 64 MiB upload); an inference body of any size is', () => {
  const big = JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) })
  assert.equal(bodyOf({ is_llm_call: false, req_body: big }), null)
  assert.ok(bodyOf({ is_llm_call: true, req_body: big }))
  assert.deepEqual(bodyOf({ is_llm_call: false, req_body: '{"a":1}' }), { a: 1 })
})
