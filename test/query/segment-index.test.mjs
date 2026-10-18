// test/query/segment-index.test.mjs — the segment index (RFC 1.6 §4.1 「只读原始记录与可删的索引」, 4.2 §段索引):
// built on first read, kept in ~/.asight/index/, refreshed by APPENDED bytes only, and rebuildable at any time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { segmentIndex, allSegments, indexDir } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z', SEG2 = '20261018T110000Z'

test('记录 id 从 1 起,索引第一次读到段时建在 index/ 里', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ ts: '2026-10-18T10:00:00.000Z' }, { ts: '2026-10-18T10:00:01.000Z', class: 'telemetry', is_llm: false, status: 204 }])
  const { records } = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.deepEqual(records[1], { id: `${SEG}:2`, ts: '2026-10-18T10:00:01.000Z', harness: 'claude-code', class: 'telemetry', host: 'api.anthropic.com', path: '/v1/messages', status: 204, stored_bytes: records[1].stored_bytes, wire_bytes: 30, session_key: null, is_llm: false,
    // the session facts, so `sessions` never reads a record back (1.6 §4.1 ≤ 1 s): the harness the board decides,
    // where the record's bytes are, and the kind of call it is
    harness_id: 'cc', has_proc: true, has_headers: true, harness_inferred: false, entrypoint: null, log_only: false, subagent: false, synth_hash: null, offset: records[1].offset })
  assert.equal(records[0].offset, 0)
  assert.equal(records[1].offset, records[0].stored_bytes + 1) // the byte the line starts at, newline included
  assert.equal(fs.existsSync(path.join(indexDir(home), `${SEG}.json`)), true)
})

test('正在写的段按偏移增量补:只读新字节,已有 id 不变', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  const first = await segmentIndex({ home, segment: SEG })
  const idxFile = path.join(indexDir(home), `${SEG}.json`)
  const mark = JSON.parse(fs.readFileSync(idxFile, 'utf8')).mark
  writeSegment(home, SEG, [{ id: 'b', ts: '2026-10-18T10:05:00.000Z' }])
  const again = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(again.records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.deepEqual(again.records[0], first.records[0])
  assert.equal(again.bytesRead, JSON.parse(fs.readFileSync(idxFile, 'utf8')).mark.size - mark.end) // only the appended bytes
})

test('半行不被索引,补全后成为下一条记录', async () => {
  const home = rawHome()
  const f = writeSegment(home, SEG, [{ id: 'a' }])
  fs.appendFileSync(f, '{"id":"half"')
  const half = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(half.records.map((r) => r.id), [`${SEG}:1`])
  fs.appendFileSync(f, ',"ts_request":"2026-10-18T10:09:00.000Z","traffic_class":"other"}\n')
  const whole = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(whole.records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.equal(whole.records[1].class, 'other')
})

test('段被改写(不是追加)时整段重建', async () => {
  const home = rawHome()
  const f = writeSegment(home, SEG, [{ id: 'a' }, { id: 'b' }])
  await segmentIndex({ home, segment: SEG })
  fs.writeFileSync(f, envLine({ id: 'c', class: 'files' }) + '\n')
  const after = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(after.records.map((r) => [r.id, r.class]), [[`${SEG}:1`, 'files']])
})

test('删掉 index/ 后重建,结果逐字段相等', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a', sessionKey: 's-1', harness: 'opencode' }, { id: 'b', class: 'account' }])
  const withIndex = await segmentIndex({ home, segment: SEG })
  fs.rmSync(indexDir(home), { recursive: true })
  const rebuilt = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(rebuilt.records, withIndex.records)
  assert.equal(withIndex.records[0].session_key, 's-1')
})

// D62: `maxBytes` is what lets the daemon's keeper index a backlog in chunks without blocking its event loop. The
// chunks must add up to exactly what one pass stores, and one line bigger than a chunk must still make progress —
// otherwise the keeper would loop for ever on a 10 MB record.
test('分块补索引(maxBytes):每块只读新字节,合起来与一次建完全相同;单行大于一块也照样推进', async () => {
  const home = rawHome()
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, ts: `2026-10-18T10:00:${String(i).padStart(2, '0')}.000Z` }))
  writeSegment(home, SEG, many)
  const whole = await segmentIndex({ home, segment: SEG, owner: true })
  const oneGo = fs.readFileSync(path.join(indexDir(home), `${SEG}.json`))
  fs.rmSync(indexDir(home), { recursive: true })
  let passes = 0, read = 0
  for (;;) {
    const r = await segmentIndex({ home, segment: SEG, owner: true, maxBytes: 1000 })
    passes++; read += r.bytesRead
    if (r.done) break
    assert.ok(passes < 50, 'the chunked catch-up does not finish')
  }
  assert.ok(passes > 2, `more than one chunk was needed (${passes})`)
  const size = fs.statSync(path.join(home, 'raw', `${SEG}.ndjson`)).size
  // every byte is read, and the only bytes read twice are the partial line a chunk ended in (at most one per chunk)
  assert.ok(read >= size && read - size < passes * 1000, `${read} bytes read for a ${size}-byte segment in ${passes} chunks`)
  assert.ok(fs.readFileSync(path.join(indexDir(home), `${SEG}.json`)).equals(oneGo), 'the chunked index is byte for byte the index of one pass')
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).records, whole.records)

  // a chunk smaller than one record: the scan reads on until it has a whole line, so a call always makes progress
  // (a keeper that looped on a 10 MB record would never catch up)
  const big = rawHome()
  writeSegment(big, SEG, [{ id: 'huge', body: 'x' }])
  fs.appendFileSync(path.join(big, 'raw', `${SEG}.ndjson`), envLine({ id: 'huge2' }) + '\n')
  let n = 0, last
  do { last = await segmentIndex({ home: big, segment: SEG, owner: true, maxBytes: 1 }); n++ } while (!last.done && n < 5)
  assert.ok(last.done, 'a chunk smaller than a record still finishes')
  assert.equal(last.records.length, 2)
})

// D62 · D38: when the daemon did NOT keep the index current, the query that pays for it says so — the one case where
// the lazy build is still taken (no daemon ever wrote this segment, index/ deleted, INDEX_V bumped). The threshold is
// cost: more than one of the keeper's chunks (KEEPER_CHUNK_BYTES), which the keeper itself never leaves behind.
test('冷建索引不静默:读取侧自己建了超过一块的索引时,在 errors 里说清楚;第二次读没有这条', async () => {
  const home = rawHome()
  // > 4 MB of records (envLine's bodies are fixed, so the padding goes in by hand — the index only needs valid JSON)
  const fat = (i) => JSON.stringify({ ...JSON.parse(envLine({ id: `fat${i}` })), pad: 'z'.repeat(300_000) }) + '\n'
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(home, 'raw', `${SEG}.ndjson`), Array.from({ length: 20 }, (_, i) => fat(i)).join(''))
  const cold = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(cold.problems.map((p) => p.code), ['index-cold'])
  assert.match(cold.problems[0].reason, /MB of 20261018T100000Z itself \(the whole segment\)/)
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).problems, [], 'the index is current now: nothing to say')
  // the daemon doing the same work is not a problem to report: it IS the owner
  fs.rmSync(indexDir(home), { recursive: true })
  assert.deepEqual((await segmentIndex({ home, segment: SEG, owner: true })).problems, [])
})

test('段的状态:守护进程的当前段在写,其余关闭,带 .sealed 的已封存', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  writeSegment(home, SEG2, [{ id: 'b' }])
  const sealed = '20261017T090000Z'
  fs.writeFileSync(path.join(home, 'raw', `${sealed}.sealed`), 'not a real sealed file')
  const segs = await allSegments({ home, lockState: () => ({ state: 'running', lock: { pid: 1, segment: SEG2 } }) })
  assert.deepEqual(segs.map((s) => [s.segment, s.state]), [[sealed, 'sealed'], [SEG, 'closed'], [SEG2, 'writing']])
  assert.equal(segs[1].records, 1)
  assert.equal(segs[1].from, '2026-10-18T10:00:00.000Z')
  // a daemon that is not running holds no segment: both plaintext segments are closed
  const idle = await allSegments({ home, lockState: () => ({ state: 'stale', lock: { pid: 1, segment: SEG2 } }) })
  assert.deepEqual(idle.map((s) => s.state), ['sealed', 'closed', 'closed'])
})

test('封存后记录 id 与索引字段不变,封存件里每条记录按 id 回源仍是同一批字节(V88 读取侧)', async (t) => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  const { buildResolver } = await import('../../src/query/source.mjs')
  const home = rawHome()
  const f = writeSegment(home, SEG, [{ id: 'a', sessionKey: 's-1', harness: 'opencode' }, { id: 'b', class: 'files', is_llm: false, status: 404 }])
  const before = await segmentIndex({ home, segment: SEG })
  const refs = ['a', 'b'].map((id) => `_/${SEG}.ndjson#${id}`) // raw_ref (4.2 §回源指针); the stream name does not change when the segment is sealed
  const plain = await buildResolver(path.join(home, 'raw'))
  const wasBytes = refs.map((r) => plain(r))
  plain.dispose()
  assert.deepEqual(wasBytes, ['{"model":"m"}', '{"model":"m"}'], 'the plaintext read first, so the comparison means something')
  await sealSegment(f, { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  assert.equal(fs.existsSync(f), false, 'the plaintext is gone: only the sealed file is left to read')
  fs.rmSync(indexDir(home), { recursive: true })
  const after = await segmentIndex({ home, segment: SEG })
  // every field of the record is what it was; `offset` is not a field OF the record but where its bytes are in
  // the file the row was built from, and a sealed segment addresses them by line number instead (null)
  const noOffset = (rs) => rs.map(({ offset, ...r }) => r)
  assert.deepEqual(noOffset(after.records), noOffset(before.records))
  assert.deepEqual(after.records.map((r) => r.offset), [null, null])
  assert.deepEqual(after.problems, [])
  // the read side end to end: every record is found by its id in the SEALED file, byte for byte
  const sealedResolve = await buildResolver(path.join(home, 'raw'))
  t.after(() => sealedResolve.dispose())
  assert.deepEqual(refs.map((r) => sealedResolve(r)), wasBytes)
  const [seg] = await allSegments({ home, lockState: () => ({ state: 'none' }) })
  assert.equal(seg.state, 'sealed')
  assert.equal(seg.sealed_bytes, fs.statSync(path.join(home, 'raw', `${SEG}.sealed`)).size)
  assert.equal(seg.bytes, before.records.reduce((n, r) => n + r.stored_bytes + 1, 0)) // the plaintext bytes, from the sealed index
})

// 4.2:30 崩溃残留:明文与封存件并存 = 上次封存断在 rename 之后、删明文之前。明文为准 —— 读取侧每一条路都得这么说,
// 不然 128 MB 明文还在盘上,状态却报 `sealed`(2026-10-18 Windows run P1)。
test('明文与封存件并存时:状态不是 sealed,读的是明文的字节', async () => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  const { segmentLines, allRecords } = await import('../../src/query/records.mjs')
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  await sealSegment(path.join(home, 'raw', `${SEG}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b', ts: '2026-10-18T10:00:02.000Z' }]) // the plaintext the crash left, grown by one record
  const [seg] = await allSegments({ home, lockState: () => ({ state: 'none' }) })
  assert.equal(seg.state, 'closed')
  assert.equal(seg.path, path.join(home, 'raw', `${SEG}.ndjson`))
  assert.equal(seg.records, 2)
  assert.equal(seg.bytes, fs.statSync(path.join(home, 'raw', `${SEG}.ndjson`)).size)
  assert.equal((await segmentIndex({ home, segment: SEG })).source, seg.path)
  // and the index of that plaintext is REUSED, not rebuilt on every read: the stored mark names the source it was
  // built from (mac-run question: 明文与封存件并存 does not cost a rebuild per query)
  assert.equal((await segmentIndex({ home, segment: SEG })).bytesRead, 0)
  assert.equal([...segmentLines({ home, segment: SEG })].length, 2)
  assert.deepEqual((await allRecords({ home })).map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
})
