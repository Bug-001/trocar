// test/view/control-wire.test.mjs — a non-inference call as the detail panel gets it (RFC 2.6 §C + 验收 #5, §保真边界 1; 4.1 #9; 3.2 K7 board half):
// the request body as stored (text verbatim, binary as size + hex, compressed-but-undecoded said so), a non-LLM SSE reply as its raw text, a
// record from before D40 labelled 「本条采于 D40 之前,只存了长度」 and never read as an empty body, 「只记日志」 labelled with its setting, and a
// 64 MiB body that cannot stall the panel. Over the real /api/control route at the end.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { controlRecordWire, BODY_SHOW_CHARS, HEX_SHOW_BYTES, CONTROL_DETAIL_RECORDS, hexDump } from '../../src/view/control-wire.mjs'
import { controlView, sessionView, projectsView, projectsViewFromMetas } from '../../src/view/board.mjs'
import { emptyMeta, foldRecord } from '../../src/etl/session-meta.mjs'
import { createServer } from '../../src/server.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { preD40, full, logged, inference, line } from '../fixtures/d40-records.mjs'

const label = (w, id) => w.ctl.labels.find((l) => l.id === id)

test('2.6 #5 — a complete non-LLM request body is shown as it was stored: the text, its wire size, no 「非逐字」 label and no 「not decoded」', () => {
  const body = '{"events":[{"name":"tengu_start","data":"héllo · 你好"}]}'
  const w = controlRecordWire(full({ id: 't', reqBody: body, wire: [Buffer.byteLength(body), 12] }))
  assert.deepEqual([w.ctl.req.kind, w.ctl.req.text, w.ctl.req.bytes, w.ctl.req.clipped], ['text', body, Buffer.byteLength(body), false])
  assert.deepEqual(w.ctl.labels, [], 'nothing is missing: nothing to disclaim')
  assert.equal(w.ctl.retention, 'full')
  assert.equal(w.req_body, undefined, 'the body is not sent twice')
  assert.equal(w.ctl.resp.kind, 'json', 'a small JSON reply stays in resp.body for the flag ledger')
  assert.deepEqual(w.resp.body, { accepted_count: 1 })
})

test('2.6 #5 — a binary body is its size and its first bytes as hex, never the whole of it; a compressed one nobody could decode says so', () => {
  const bytes = Buffer.alloc(30 * 1024 * 1024, 0)
  bytes.set(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x41, 0x42]), 0)
  const rec = full({ id: 'b', reqBody: null, reqB64: bytes.toString('base64'), wire: [bytes.length, 3], endpoint: '/api/oauth/file_upload', cls: 'files' })
  const t0 = Date.now()
  const w = controlRecordWire(rec)
  assert.ok(Date.now() - t0 < 1500, 'a 30 MiB body is not decoded or dumped in full')
  assert.deepEqual([w.ctl.req.kind, w.ctl.req.bytes], ['binary', bytes.length])
  assert.match(w.ctl.req.hex, /^000000  50 4b 03 04 ff fe 41 42 00 00/)
  assert.equal(w.ctl.req.hex.split('\n').length, HEX_SHOW_BYTES / 16, 'a bounded dump')
  assert.equal(w.req_body_b64, undefined, 'the base64 stays in the source')
  assert.ok(JSON.stringify(w).length < 64 * 1024, 'what goes to the browser is small')
  const zst = controlRecordWire(full({ id: 'z', reqBody: null, reqB64: Buffer.from('xx').toString('base64'), extra: { req_content_encoding: 'zstd', req_encoding_error: 'zstd not decoded at capture' }, wire: [2, 1] }))
  assert.deepEqual([zst.ctl.req.kind, zst.ctl.req.encoding], ['undecoded', 'zstd'])
  assert.ok(label(zst, 'req-undecoded'), '压缩请求体未解码, said in place')
  const gz = controlRecordWire({ ...full({ id: 'g', reqBody: '{"a":1}', wire: [40, 1] }), req_content_encoding: 'gzip', req_body_b64: 'H4sIAAAAAAAAA6tWSkxPLVayqq4FAGMX9nQLAAAA' })
  assert.equal(gz.ctl.req.decoded_from, 'gzip', 'a request sent compressed and shown decoded says so')
  assert.equal(hexDump(Buffer.from('AB')).trim(), '000000  41 42' + ' '.repeat(47 - 5 + 2) + 'AB')
})

test('a 64 MiB-class text body is cut for display at the cap and says so: how much is shown, how much there is; the wire record stays small', () => {
  const big = 'a'.repeat(BODY_SHOW_CHARS * 3 + 17)
  const w = controlRecordWire(full({ id: 'big', reqBody: big, wire: [big.length, 0] }))
  assert.deepEqual([w.ctl.req.clipped, w.ctl.req.shown_chars, w.ctl.req.chars, w.ctl.req.bytes], [true, BODY_SHOW_CHARS, big.length, big.length])
  assert.ok(JSON.stringify(w).length < BODY_SHOW_CHARS + 8192)
  const emoji = '😀'.repeat(BODY_SHOW_CHARS) // a cut never splits a surrogate pair
  const e = controlRecordWire(full({ id: 'e', reqBody: emoji, wire: [emoji.length * 2, 0] }))
  assert.ok(e.ctl.req.clipped && !/[\ud800-\udbff]$/.test(e.ctl.req.text))
  const bigJson = { x: 'y'.repeat(BODY_SHOW_CHARS + 10) }
  const j = controlRecordWire(full({ id: 'j', resp: { status: 200, kind: 'json', body: bigJson }, wire: [1, BODY_SHOW_CHARS + 30] }))
  assert.equal(j.ctl.resp.kind, 'json'); assert.ok(j.ctl.resp.clipped && j.ctl.resp.text); assert.equal(j.resp.body, undefined, 'a reply over the cap is in ctl.resp, not twice')
})

test('2.6 #5 — a non-LLM SSE reply is its raw text (not the empty answer the Anthropic reconstructor made of it); text and binary bodies too', () => {
  const sse = 'event: ping\ndata: {"t":1}\n\nevent: x\ndata: {"t":2}\n\n'
  const w = controlRecordWire(full({ id: 's', endpoint: '/v1/code/sessions/s/worker/events', cls: 'session-sync', resp: { status: 200, kind: 'sse', raw: sse, text: '', tool_calls: [] }, wire: [5, sse.length] }))
  assert.deepEqual([w.ctl.resp.kind, w.ctl.resp.text, w.ctl.resp.bytes], ['sse', sse, sse.length])
  assert.equal(w.resp.raw, undefined)
  const t = controlRecordWire(full({ id: 't', resp: { status: 502, kind: 'text', raw: '<html>bad gateway</html>' }, wire: [1, 24] }))
  assert.deepEqual([t.ctl.resp.kind, t.ctl.resp.text], ['text', '<html>bad gateway</html>'])
  const bin = controlRecordWire(full({ id: 'bin', resp: { status: 200, kind: 'text', raw_b64: Buffer.from([1, 2, 3, 250]).toString('base64') }, wire: [1, 4] }))
  assert.deepEqual([bin.ctl.resp.kind, bin.ctl.resp.bytes], ['binary', 4]); assert.match(bin.ctl.resp.hex, /01 02 03 fa/)
  const empty = controlRecordWire(full({ id: 'em', reqBody: '', resp: { status: 204, kind: 'empty' }, wire: [0, 0] }))
  assert.deepEqual([empty.ctl.req.kind, empty.ctl.resp.kind], ['empty', 'empty'])
})

test('4.1 #9 / 2.6 #5 — a pre-D40 {raw_chars} record says 「本条采于 D40 之前,只存了长度」, shows the length it kept, and is NOT an empty body', () => {
  const w = controlRecordWire(preD40({ id: 'o', rawChars: 4321 }))
  assert.equal(w.ctl.retention, 'legacy-meta')
  assert.equal(label(w, 'retention-legacy-meta').label, '本条采于 D40 之前,只存了长度')
  assert.deepEqual([w.ctl.req.kind, w.ctl.req.bytes], ['length-only', 4321])
  assert.equal(w.ctl.resp.kind, 'json', 'the reply of such a record was kept')
  assert.equal(w.ctl.traffic_class, 'telemetry', 'its class is told by the same table the capture uses')
})

test('「只记日志」 — a log record says 「只记日志 · 用户设置 <harness> · <类别>」 and shows the sizes the envelope counted; neither side reads as empty', () => {
  const w = controlRecordWire(logged({ id: 'l', wire: [9000, 21] }))
  assert.equal(label(w, 'retention-log').label, '只记日志 · 用户设置 cc · telemetry')
  assert.deepEqual([w.ctl.req.kind, w.ctl.req.bytes, w.ctl.resp.kind, w.ctl.resp.bytes, w.ctl.retention], ['length-only', 9000, 'length-only', 21, 'log'])
  assert.deepEqual(w.ctl.wire_bytes, { req: 9000, resp: 21 })
})

test('2.6 — host (the SNI) and the request\'s own Host header are both shown, and a mismatch is flagged (it is a behaviour signal)', () => {
  const same = controlRecordWire(full({ id: 'a', host: 'API.anthropic.com', headers: { host: 'api.anthropic.com:443' } }))
  assert.deepEqual([same.ctl.host, same.ctl.hostHeader, same.ctl.hostDiffers], ['API.anthropic.com', 'api.anthropic.com:443', false])
  const diff = controlRecordWire(full({ id: 'b', host: 'collector.example.test', headers: { host: 'api.anthropic.com' } }))
  assert.deepEqual([diff.ctl.host, diff.ctl.hostHeader, diff.ctl.hostDiffers], ['collector.example.test', 'api.anthropic.com', true])
  const none = controlRecordWire(preD40({ id: 'c' }))
  assert.deepEqual([none.ctl.host, none.ctl.hostHeader, none.ctl.hostDiffers], [null, 'api.anthropic.com', false], 'an old record has only the header')
})

test('a non-LLM WebSocket call: its messages as stored (and the ones that are only a size, said so); ws_raw stays in the source and the record says it was left out', () => {
  const rec = { ...full({ id: 'w', reqBody: '{"type":"ping"}', wire: [15, 40] }), transport: 'ws', ws_raw: [{ d: 'c', h: 'gQ==', p: 'AAAA' }], resp: { status: 101, kind: 'ws', messages: ['{"type":"pong"}', { raw_chars: 99, verbatim: false }, { omitted_bytes: 70000000 }, { b64: 'AQID' }] } }
  const w = controlRecordWire(rec)
  assert.equal(w.ctl.resp.kind, 'ws')
  assert.match(w.ctl.resp.text, /^\{"type":"pong"\}\n\[1\] \(length only: 99 bytes, not stored\)\n\[2\] \(over the per-call cap: 70000000 bytes not kept\)\n\[3\] \(binary, 3 bytes, kept as base64\)$/)
  assert.equal(w.ws_raw, undefined); assert.deepEqual(w.ctl.omitted, ['ws_raw'])
  assert.deepEqual(w.resp.messages, undefined)
})

// ── review: what the panel says about a body that is only part of the call, an empty one, and a mismatching Host ──────────
test('H4 — a request cut at the capture cap, or one that never finished, is labelled in place and carries how much of it is stored: never shown as the whole body (invariant 4)', () => {
  // the collector's record of a 100 MB upload cut at the cap: 20 chars stored, 100,000,000 on the wire
  const cut = controlRecordWire(full({ id: 'c', endpoint: '/api/oauth/file_upload', cls: 'files', reqBody: 'x'.repeat(20), wire: [100000000, 5], extra: { req_truncated: true, req_body_bytes: 20 } }))
  assert.equal(label(cut, 'req-incomplete').label, '已截断 · request cut at the cap')
  assert.match(label(cut, 'req-incomplete').text, /cut at the capture cap: only the first 20 bytes are stored/)
  assert.deepEqual([cut.ctl.req.truncated, cut.ctl.req.incomplete, cut.ctl.req.stored_bytes, cut.ctl.req.bytes, cut.ctl.req.chars], [true, true, 20, 100000000, 20])
  // a 413 that came back before the upload finished: req_partial, no req_body_bytes — the stored bytes are what arrived
  const part = controlRecordWire(full({ id: 'p', reqBody: '{"half":', wire: [8, 5], extra: { req_partial: 'early-response' } }))
  assert.equal(label(part, 'req-incomplete').label, '不完整 · request never finished')
  assert.match(label(part, 'req-incomplete').text, /never finished uploading/)
  assert.deepEqual([part.ctl.req.partial, part.ctl.req.truncated, part.ctl.req.stored_bytes], ['early-response', false, 8])
  // binary prefix: the same
  const bin = controlRecordWire(full({ id: 'b', reqBody: null, reqB64: Buffer.alloc(64, 1).toString('base64'), wire: [5000, 5], extra: { req_truncated: true, req_body_bytes: 64 } }))
  assert.deepEqual([bin.ctl.req.kind, bin.ctl.req.truncated, bin.ctl.req.stored_bytes, bin.ctl.req.bytes], ['binary', true, 64, 5000])
  // a response cut at the cap says it on its side too
  const rcut = controlRecordWire(full({ id: 'r', resp: { status: 200, kind: 'text', raw: 'y'.repeat(10), truncated: true, body_bytes: 10 }, wire: [5, 99999] }))
  assert.deepEqual([rcut.ctl.resp.truncated, rcut.ctl.resp.stored_bytes, rcut.ctl.resp.bytes], [true, 10, 99999])
  assert.ok(label(rcut, 'resp-truncated'))
  // a complete request carries neither
  const ok = controlRecordWire(full({ id: 'ok', reqBody: '{"a":1}' }))
  assert.deepEqual([label(ok, 'req-incomplete'), ok.ctl.req.truncated, ok.ctl.req.incomplete], [undefined, undefined, undefined])
})

test('L1 — a pre-D40 record whose kept length is 0 had no body (a GET): it is an empty body, not 「只存了长度」 and not 「this is not an empty body」', () => {
  const get = controlRecordWire({ ...preD40({ id: 'g', rawChars: 0 }), method: 'GET', endpoint: '/api/web/domain_info?domain=x.test' })
  assert.deepEqual([get.ctl.retention, get.ctl.req.kind, get.ctl.req.bytes, get.ctl.labels.map((l) => l.id)], ['full', 'empty', 0, []])
  // one that kept a length is still 「只存了长度」, and a log record of 0 bytes stays a log record
  assert.equal(controlRecordWire(preD40({ id: 'o', rawChars: 12 })).ctl.req.kind, 'length-only')
  const log0 = controlRecordWire(logged({ id: 'l0', wire: [0, 5] }))
  assert.deepEqual([log0.ctl.retention, log0.ctl.req.kind], ['log', 'length-only'])
})

test('F7 — a reverse-proxy record\'s host (the upstream) always differs from the Host header (the client\'s address to the proxy): that is not a behaviour signal; the same pair from any other capture is', () => {
  const rp = { ...full({ id: 'rp', host: 'api.anthropic.com', proc: null, headers: { 'user-agent': 'x', host: '127.0.0.1:9800' } }), capture: 'reverse-proxy' }
  assert.deepEqual([controlRecordWire(rp).ctl.host, controlRecordWire(rp).ctl.hostHeader, controlRecordWire(rp).ctl.hostDiffers], ['api.anthropic.com', '127.0.0.1:9800', false])
  for (const capture of ['mitm', 'transparent']) assert.equal(controlRecordWire({ ...rp, capture }).ctl.hostDiffers, true, capture)
})

test('a record this cannot read is returned with the reason, never thrown at the panel', () => {
  for (const r of [{}, { req_body: 5, resp: 7 }, { req_body: {}, resp: { kind: 'json' } }, null === 1 ? 0 : { resp: { kind: 'error', partial: 1 } }]) {
    const w = controlRecordWire(r)
    assert.ok(w.ctl, JSON.stringify(r))
  }
})

test('controlView hands each record out reshaped, grouped as before; a session-keyed non-LLM call stays in its session', () => {
  const recs = [full({ id: 'a', endpoint: '/api/event_logging/v2/batch', headers: { 'user-agent': 'claude-cli/2', host: 'api.anthropic.com' } }), preD40({ id: 'b' })]
  const v = controlView(recs, 'telemetry')
  assert.deepEqual(v.records.map((r) => [r.id, r.ctl.retention]), [['a', 'full'], ['b', 'legacy-meta']])
  assert.deepEqual(controlView(recs).classes.map((c) => c.class), ['telemetry'])
})

// ── review (F1 / H3): /api/control?class= is bounded ───────────────────────────────────────────────────────────────────────
// It used to ship EVERY session-less record with its body (up to 1 MiB each): 20,000 records of 3 KB bodies measured 91 MiB for one class, and
// ~100k made JSON.stringify throw (a 500, the page's empty view). The page lists and opens only the newest 80 per class.
const iso = (i) => new Date(Date.UTC(2026, 9, 6, 10, 0, 0) + i * 1000).toISOString()
test('F1 — only the newest 80 records of a class carry their bodies; every older one is slim, says what it left behind, and the answer stays bounded', () => {
  const N = 5000, BODY = 3000
  const recs = Array.from({ length: N }, (_, i) => full({ id: `t${i}`, at: iso(i), reqBody: `${i}:` + 'b'.repeat(BODY), wire: [BODY + 8, 12] }))
  const v = controlView(recs, 'telemetry')
  assert.deepEqual([v.records.length, v.total, v.detail_limit, CONTROL_DETAIL_RECORDS], [N, N, 80, 80], 'every record is still listed (the page counts them); the page lists 80')
  const withBody = v.records.filter((r) => r.ctl.req && r.ctl.req.text)
  assert.deepEqual(withBody.map((r) => r.id), recs.slice(-80).map((r) => r.id), 'the newest 80, in order')
  const old = v.records[0]
  assert.deepEqual([old.ctl.detail, old.ctl.req, old.ctl.resp, old.req_body, old.req_body_b64, old.ctl.omitted], [false, undefined, undefined, undefined, undefined, ['req_body']])
  assert.deepEqual([old.ctl.retention, old.ctl.traffic_class, old.ctl.wire_bytes, old.ctl.host], ['full', 'telemetry', { req: BODY + 8, resp: 12 }, 'api.anthropic.com'], 'what the list and the labels read is still there')
  assert.deepEqual(old.resp.body, { accepted_count: 1 }, 'a small reply body stays: the feature-flag ledger reads it over the whole class')
  const size = JSON.stringify(v).length
  assert.ok(size < 80 * (BODY + 6000) + N * 2500, `bounded (${size} bytes for ${N} records of ${BODY}-byte bodies)`)
  assert.ok(size < (N * BODY) / 2, 'and far under what shipping every body would be')
  // the labels survive the slimming: a pre-D40 / log / cut record says so even when it is old
  const mix = [preD40({ id: 'o1', at: iso(0) }), logged({ id: 'l1', at: iso(1) }), ...Array.from({ length: 100 }, (_, i) => full({ id: `n${i}`, at: iso(2 + i) }))]
  const m = controlView(mix, 'telemetry').records
  assert.deepEqual([m[0].id, m[0].ctl.detail, m[0].ctl.labels.map((l) => l.id)], ['o1', false, ['retention-legacy-meta']])
  assert.deepEqual([m[1].id, m[1].ctl.labels.map((l) => l.id)], ['l1', ['retention-log']])
})

test('F1 — a slim record leaves every body behind, whatever its shape: WebSocket client messages and frames, an SSE / binary / big JSON reply, an interrupted reply', () => {
  const ws = { ...full({ id: 'w', reqBody: '{"type":"a"}', wire: [12, 40] }), transport: 'ws', ws_raw: [{ d: 'c', h: 'gQ==', p: 'AAAA' }], req_extra_messages: ['{"type":"b"}'], resp: { status: 101, kind: 'ws', messages: ['x'.repeat(5000)] } }
  const sse = full({ id: 's', resp: { status: 200, kind: 'sse', raw: 'data: 1\n\n'.repeat(500), text: '', tool_calls: [] } })
  const bin = full({ id: 'bn', resp: { status: 200, kind: 'text', raw_b64: Buffer.alloc(3000, 1).toString('base64') } })
  const bigJson = full({ id: 'bj', resp: { status: 200, kind: 'json', body: { x: 'y'.repeat(BODY_SHOW_CHARS + 10) } } })
  const interrupted = full({ id: 'it', resp: { status: 200, kind: 'error', error: { type: 'upstream_aborted' }, partial: { status: 200, kind: 'sse', raw: 'data: partial\n\n', body: { k: 'v' }, messages: ['m'] } } })
  const got = Object.fromEntries([ws, sse, bin, bigJson, interrupted].map((r) => [r.id, controlRecordWire(r, { detail: false })]))
  assert.deepEqual(got.w.ctl.omitted, ['req_body', 'ws_raw', 'req_extra_messages', 'resp.messages'])
  assert.deepEqual([got.w.ws_raw, got.w.req_extra_messages, got.w.resp.messages], [undefined, undefined, undefined])
  assert.deepEqual(got.s.ctl.omitted, ['req_body', 'resp.raw']); assert.equal(got.s.resp.raw, undefined)
  assert.deepEqual(got.bn.ctl.omitted, ['req_body', 'resp.raw_b64'])
  assert.deepEqual(got.bj.ctl.omitted, ['req_body', 'resp.body'], 'a reply body over the display cap is not shipped twice')
  assert.deepEqual(got.it.resp.partial, { status: 200, kind: 'sse' }, 'an interrupted reply keeps no bodies either')
  for (const r of Object.values(got)) assert.ok(JSON.stringify(r).length < 16 * 1024, r.id)
})

test('F1 — a detail record names the WebSocket client messages it does not ship; the page can say so', () => {
  const ws = { ...full({ id: 'w', reqBody: '{"type":"a"}', wire: [12, 40] }), transport: 'ws', req_extra_messages: ['{"type":"b"}'], resp: { status: 101, kind: 'ws', messages: ['{"type":"p"}'] } }
  const w = controlRecordWire(ws)
  assert.equal(w.req_extra_messages, undefined)
  assert.deepEqual(w.ctl.omitted, ['req_extra_messages'])
  assert.equal(w.ctl.req.text, '{"type":"a"}', 'the first message is shown')
})

// ── K7, board half: an inference call at the log level ─────────────────────────────────────────────────────────────────
test('K7 — a session with calls kept as a log line only: counted and labelled, not drawn, not "no calls"; the calls beside it render as before', () => {
  const recs = [inference({ id: 'a1', at: 1 }), inference({ id: 'a2', at: 2, retention: 'log' }), inference({ id: 'a3', at: 3, text: 'three' })]
  const v = sessionView(recs, 'S-d40')
  assert.deepEqual([v.logged.count, v.logged.labels, v.logged.items.map((i) => [i.id, i.status, i.endpoint, i.request_bytes, i.response_bytes])],
    [1, ['只记日志 · 用户设置 cc · llm'], [['a2', 200, '/v1/messages', recs[1].body_wire_bytes.req, 300]]])
  assert.equal(v.analyzed.stats.calls, 2, 'the two calls with bodies are drawn')
  assert.equal(v.meta.logged, 1); assert.equal(v.meta.calls, 2)
  const only = sessionView([recs[1]], 'S-d40')
  assert.deepEqual([only.analyzed.stats.calls, only.logged.count], [0, 1], 'a session of only log calls says so instead of showing nothing')
  assert.equal(sessionView([recs[0]], 'S-d40').logged, null, 'nothing to say when nothing was logged')
})

// review (F5): 2.6 §C used to say session-attached non-inference calls (probe / other) "follow the same body rules via openDetail". They do not:
// the probe lane draws the measurement and a note, `other` is only counted. Pinned, so the spec's now-narrower sentence stays true, and so the
// probe's `retention` (what the note says about its body) is carried through the session payload.
test('F5 — a session-attached count_tokens probe and a session-attached other call keep their bodies in the capture record only: the session payload carries the measurement and the retention, never the body', () => {
  const sid = { 'user-agent': 'claude-cli/2', host: 'api.anthropic.com', 'x-claude-code-session-id': 'S-d40' }
  const probe = (id, at, extra = {}) => full({ id, at, endpoint: '/v1/messages/count_tokens', cls: 'token-count', headers: sid, reqBody: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'PROBE-BODY-MARKER-' + id }] }), resp: { status: 200, kind: 'json', body: { input_tokens: 1234 } }, ...extra })
  const other = full({ id: 'ot', at: 5, endpoint: '/api/something/else', cls: 'other', headers: sid, reqBody: '{"note":"OTHER-BODY-MARKER"}' })
  const recs = [inference({ id: 'a1', at: 1 }), probe('p1', 2), { ...logged({ id: 'p2', at: 3, endpoint: '/v1/messages/count_tokens', cls: 'token-count', headers: sid }), resp: { status: 200, kind: 'json', body: { input_tokens: 77 }, headers: {}, request_id: null } },
    { ...preD40({ id: 'p3', at: 4, endpoint: '/v1/messages/count_tokens', headers: sid, resp: { status: 200, kind: 'json', body: { input_tokens: 55 } } }) }, other]
  const v = sessionView(recs, 'S-d40')
  const wire = JSON.stringify(v)
  assert.doesNotMatch(wire, /PROBE-BODY-MARKER|OTHER-BODY-MARKER/, 'no request body of a probe or an `other` call goes down with the session')
  assert.deepEqual(v.probes.series.map((p) => [p.tokens, p.retention]), [[1234, 'full'], [77, 'log'], [55, 'legacy-meta']], 'each probe says what became of its body (the lane note reads it)')
  assert.deepEqual([v.meta.probes, v.meta.other], [3, 1], 'the other call is counted, and only counted')
})

test('K7 — the session list counts them (and the archive layer\'s meta agrees with the board)', () => {
  const recs = [inference({ id: 'a1', at: 1 }), inference({ id: 'a2', at: 2, retention: 'log' })]
  const p = projectsView(recs).projects[0].sessions[0]
  assert.deepEqual([p.calls, p.logged], [1, 1])
  let m = emptyMeta('S-d40'); for (const r of recs) m = foldRecord(m, r)
  assert.deepEqual(projectsViewFromMetas([m]).projects[0].sessions[0], p, 'the fold and the board derive the same list entry')
})

// ── the real route ─────────────────────────────────────────────────────────────────────────────────────────────────────
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, json: JSON.parse(b) })) }).on('error', reject)
})
test('/api/control over a source holding a 20 MiB binary upload, a 3 MiB text body and a pre-D40 record: a small, prompt, labelled answer', async () => {
  const dir = tmpDir('asight-ctl-')
  const bin = Buffer.alloc(20 * 1024 * 1024, 7)
  const recs = [
    full({ id: 'up', at: 1, endpoint: '/api/oauth/file_upload', cls: 'files', reqBody: null, reqB64: bin.toString('base64'), wire: [bin.length, 9], headers: { 'user-agent': 'claude-cli/2', host: 'api.anthropic.com' } }),
    full({ id: 'tx', at: 2, endpoint: '/api/event_logging/v2/batch', reqBody: 'z'.repeat(3 * 1024 * 1024), wire: [3 * 1024 * 1024, 9], headers: { 'user-agent': 'claude-cli/2', host: 'api.anthropic.com' } }),
    preD40({ id: 'old', at: 3, endpoint: '/api/event_logging/v2/batch' }),
  ]
  const file = path.join(dir, 'capture-2026-10-06.ndjson')
  fs.writeFileSync(file, recs.map(line).join(''))
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: file })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  try {
    const t0 = Date.now()
    const all = await get(port, '/api/control')
    assert.equal(all.status, 200)
    const byCls = Object.fromEntries(await Promise.all(all.json.classes.map(async (c) => [c.class, (await get(port, `/api/control?class=${c.class}`)).json.records])))
    const rows = Object.values(byCls).flat()
    assert.deepEqual(rows.map((r) => r.id).sort(), ['old', 'tx', 'up'])
    assert.ok(Date.now() - t0 < 8000, 'no stall')
    const sizeOf = JSON.stringify(rows).length
    assert.ok(sizeOf < 3 * BODY_SHOW_CHARS, `the answer is bounded, not 20 + 3 MiB of bodies (${sizeOf} bytes)`)
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    assert.equal(by.up.ctl.req.kind, 'binary'); assert.equal(by.up.ctl.req.bytes, bin.length)
    assert.ok(by.tx.ctl.req.clipped); assert.equal(by.tx.ctl.req.chars, 3 * 1024 * 1024)
    assert.equal(by.old.ctl.labels[0].label, '本条采于 D40 之前,只存了长度')
  } finally { server.close() }
})

test('F1 — over the real route: 150 session-less records of one class come back listed in full, 80 of them with bodies, and the answer is bounded', async () => {
  const dir = tmpDir('asight-ctl-bound-')
  const recs = Array.from({ length: 150 }, (_, i) => full({ id: `b${i}`, at: iso(i), endpoint: '/api/event_logging/v2/batch', reqBody: `${i}:` + 'q'.repeat(20000), wire: [20010, 9], headers: { 'user-agent': 'claude-cli/2', host: 'api.anthropic.com' } }))
  const file = path.join(dir, 'capture-2026-10-06.ndjson')
  fs.writeFileSync(file, recs.map(line).join(''))
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: file })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const r = await get(server.address().port, '/api/control?class=telemetry')
    assert.equal(r.status, 200)
    assert.deepEqual([r.json.records.length, r.json.total, r.json.detail_limit], [150, 150, 80])
    assert.equal(r.json.records.filter((x) => x.ctl.req && x.ctl.req.text).length, 80)
    assert.ok(r.body.length < 80 * 21000 + 150 * 3000, `bounded: ${r.body.length} bytes (every body would be ${150 * 20010})`)
  } finally { server.close() }
})
