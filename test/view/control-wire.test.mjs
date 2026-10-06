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
import { controlRecordWire, BODY_SHOW_CHARS, HEX_SHOW_BYTES, hexDump } from '../../src/view/control-wire.mjs'
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
