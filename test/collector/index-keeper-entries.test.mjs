// test/collector/index-keeper-entries.test.mjs — the keeper indexes the lines the store just wrote WITHOUT reading
// them back (D62, 1.6 §3.1 「采集一次请求的 CPU ≤ 5 ms」): store.mjs hands `onRecord` the envelope, the offset, the line
// number and the stored bytes, and index-build's `fromEntries` takes them only when they account for the segment
// exactly. The contract is that this changes nothing about the ANSWER: the document the keeper writes this way MUST be
// the one a fresh rebuild writes (the index is a rebuildable projection, invariant 2), and the raw bytes MUST be the
// bytes the store wrote. Both are asserted here over the real pair (no injected index), with the shapes that must fall
// back to the scan: a line nobody told the keeper about, and a segment rewritten under it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { createRecordStore } from '../../src/collector/core/record/store.mjs'
import { createIndexKeeper } from '../../src/collector/index-keeper.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const home = () => { const h = tmpDir('trocar-keeper-entries-'); fs.mkdirSync(path.join(h, 'collector'), { recursive: true }); return h }

/** One envelope with every field the index reads: a session key in the body, a harness, a class, wire bytes. */
const envOf = (i, body = 'x'.repeat(64)) => ({
  id: `r${i}`, ts: `2026-10-20T00:00:0${i % 10}.000Z`, ts_request: `2026-10-20T00:00:0${i % 10}.000Z`,
  method: 'POST', endpoint: '/v1/responses', host: 'api.openai.com', traffic_class: 'llm', is_llm_call: true,
  req_headers: { 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/1.0', 'x-app': 'cli' },
  req_body: JSON.stringify({ model: 'gpt-5', prompt_cache_key: `sess-${i % 3}`, input: body }),
  body_wire_bytes: { req: 100 + i, resp: 200 + i },
  resp: { status: 200, kind: 'json', body: { ok: true } },
  proc: { pid: 4242, agent: 'codex' }, scheme: 'https', dst: '1.2.3.4:443', flow_id: `f${i}`, seq: 1,
  req_head_raw: 'POST /v1/responses HTTP/1.1\r\n\r\n', resp_head_raw: 'HTTP/1.1 200 OK\r\n\r\n',
})

/** A store with the keeper really hung on it, as the daemon does. → { h, store, keeper, segment } */
function world({ debounceMs = 5 } = {}) {
  const h = home()
  const store = createRecordStore({ root: path.join(h, 'collector') })
  const keeper = createIndexKeeper({ home: h, debounceMs })
  store.onRecord((seg, facts) => keeper.wrote(seg, facts))
  return { h, store, keeper }
}

const docOf = (h, segment) => fs.readFileSync(path.join(h, 'index', `${segment}.json`), 'utf8')
const settle = async (keeper, ms = 60) => { await new Promise((r) => setTimeout(r, ms)); await keeper.idle() }
/** What a document ASSERTS: its entry lines in order, and its last mark without the file timestamps (which belong to
 *  the file, not to the index). The document itself is append-only, so a keeper that passed twice has two marks and a
 *  rebuild has one — that difference is the format's, not the answer's (4.2 §段索引). */
const asserts = (text) => {
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const m = lines.filter((o) => o.m).pop().m
  return { entries: lines.filter((o) => !o.m && !o.p), problems: lines.filter((o) => o.p).map((o) => o.p), mark: { size: m.size, end: m.end, lines: m.lines, fp: m.fp } }
}

/** The same segment's index built from scratch by a reader that owns it, in its own HOME: what a rebuild writes. */
async function rebuilt(h, segment) {
  const to = home()
  fs.mkdirSync(path.join(to, 'raw'), { recursive: true })
  fs.copyFileSync(path.join(h, 'raw', `${segment}.ndjson`), path.join(to, 'raw', `${segment}.ndjson`))
  await segmentIndex({ home: to, segment, owner: true })
  return docOf(to, segment)
}

test('the keeper indexes from the envelopes it was handed, and the document equals a fresh rebuild', async () => {
  const { h, store, keeper } = world()
  for (let i = 1; i <= 7; i++) assert.equal(store.envelope(envOf(i)).ok, true)
  const segment = store.currentSegment
  await settle(keeper)
  const raw = fs.readFileSync(path.join(h, 'raw', `${segment}.ndjson`))
  // the entries are the scan's entries, to the byte — including stored_bytes, offset and what the mark asserts
  assert.deepEqual(asserts(docOf(h, segment)), asserts(await rebuilt(h, segment)), 'the keeper wrote what a rebuild writes')
  const entries = asserts(docOf(h, segment)).entries
  assert.equal(entries.length, 7)
  assert.deepEqual(entries.map((e) => e.id), Array.from({ length: 7 }, (_, i) => `${segment}:${i + 1}`))
  // every entry's offset lands on its own line, and the mark covers the file to its last byte
  const text = raw.toString('utf8').split('\n')
  for (const e of entries) assert.equal(raw.subarray(e.offset, e.offset + e.stored_bytes).toString('utf8'), text[Number(e.id.split(':')[1]) - 1])
  assert.equal(asserts(docOf(h, segment)).mark.size, raw.length, 'the mark covers every byte the store wrote')
  await keeper.stop(); store.close()
})

test('a pass after a line the keeper was not told about indexes it from the segment, and still equals a rebuild', async () => {
  const { h, store, keeper } = world({ debounceMs: 1_000 })
  assert.equal(store.envelope(envOf(1)).ok, true)
  const segment = store.currentSegment
  await keeper.flush(segment)                            // the first pass: one entry, handed over
  // a line appended by something else (a crash recovery, another writer): the keeper has no entry for it
  fs.appendFileSync(path.join(h, 'raw', `${segment}.ndjson`), `${JSON.stringify(envOf(2))}\n`)
  const k2 = createIndexKeeper({ home: h, debounceMs: 1 })
  store.onRecord((seg, facts) => k2.wrote(seg, facts))
  assert.equal(store.envelope(envOf(3)).ok, true)        // its entry's offset is past the untold line
  await settle(k2)
  assert.deepEqual(asserts(docOf(h, segment)), asserts(await rebuilt(h, segment)), 'the scan caught the untold line; the document asserts a rebuild\'s')
  assert.deepEqual(asserts(docOf(h, segment)).entries.map((o) => o.id), [`${segment}:1`, `${segment}:2`, `${segment}:3`], 'all three records, in line order')
  await k2.stop(); await keeper.stop(); store.close()
})

test('the raw bytes are the store\'s alone: the keeper appends to index/ and nothing else', async () => {
  const { h, store, keeper } = world()
  const lines = []
  for (let i = 1; i <= 4; i++) { const e = envOf(i, 'y'.repeat(4096)); lines.push(`${JSON.stringify(e)}\n`); store.envelope(e) }
  const segment = store.currentSegment
  await settle(keeper)
  assert.equal(fs.readFileSync(path.join(h, 'raw', `${segment}.ndjson`), 'utf8'), lines.join(''), 'byte-identical to what the store serialized')
  assert.deepEqual(fs.readdirSync(h).sort(), ['collector', 'index', 'raw'], 'nothing else was written in the home')
  await keeper.stop(); store.close()
})
