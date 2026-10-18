// test/query/segment-index.test.mjs — the segment index (RFC 1.6 §4.1 「只读原始记录与可删的索引」, 4.2 §段索引):
// built on first read, kept in ~/.asight/index/, refreshed by APPENDED bytes only, and rebuildable at any time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { segmentIndex, allSegments, indexDir } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z', SEG2 = '20261018T110000Z'
// The stored mark: the last complete `{"m":…}` line of the append-only index document (4.2 §段索引).
const markOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.m).pop().m

test('记录 id 从 1 起,读取侧不把明文段的索引落盘(那份文件是守护进程的)', async () => {
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
  // D62 谁写哪一笔: a plaintext segment's index belongs to the daemon's keeper, and a reader never writes one — it
  // answers from the segment itself. The owner's pass is what puts the file there.
  assert.equal(fs.existsSync(path.join(indexDir(home), `${SEG}.json`)), false)
  await segmentIndex({ home, segment: SEG, owner: true })
  assert.equal(fs.existsSync(path.join(indexDir(home), `${SEG}.json`)), true)
})

// D62: keeping the index of the segment being written current costs the NEW records, never the whole document —
// so every pass of the owner only APPENDS (the bytes before a pass are a prefix of the bytes after it).
test('只追加:守护进程每趟补索引只往索引文件末尾写,已有的字节一个不改', async () => {
  const home = rawHome()
  const idx = path.join(indexDir(home), `${SEG}.json`)
  writeSegment(home, SEG, [{ id: 'a' }])
  await segmentIndex({ home, segment: SEG, owner: true })
  for (let i = 0; i < 5; i++) {
    const before = fs.readFileSync(idx)
    fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), envLine({ id: `r${i}` }) + '\n')
    const pass = await segmentIndex({ home, segment: SEG, owner: true })
    const after = fs.readFileSync(idx)
    assert.ok(after.length > before.length, 'the pass stored its record')
    assert.ok(after.subarray(0, before.length).equals(before), `pass ${i} rewrote bytes it should only have appended to`)
    assert.deepEqual(pass.records.map((r) => r.id), [`${SEG}:${i + 2}`], 'the owner reports what IT indexed, without reading the stored entries back')
  }
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).records.map((r) => r.id), Array.from({ length: 6 }, (_, i) => `${SEG}:${i + 1}`))
})

// The reader's half of the same rule: it reads the covered part, scans the tail in memory, and leaves the file alone.
test('读者不写明文段的索引:尾巴还没被覆盖时,索引文件字节不变,答案仍然完整', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  await segmentIndex({ home, segment: SEG, owner: true })
  fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), envLine({ id: 'b' }) + '\n')
  const idx = path.join(indexDir(home), `${SEG}.json`)
  const before = fs.readFileSync(idx)
  const read = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(read.records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.ok(read.bytesRead > 0, 'the uncovered tail was scanned')
  assert.ok(fs.readFileSync(idx).equals(before), 'a reader wrote to the index of a plaintext segment')
})

// A pass that died mid-append leaves a torn batch after the last mark. A reader must not take it for a fact, and the
// next pass of the owner must not stack its entries on top of it.
test('最后一批写到一半:读者忽略它,守护进程下一趟把它修好', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  await segmentIndex({ home, segment: SEG, owner: true })
  const idx = path.join(indexDir(home), `${SEG}.json`)
  const whole = fs.readFileSync(idx)
  fs.appendFileSync(idx, '{"id":"20261018T100000Z:2","ts":null,"stored') // a batch cut off mid-line
  const torn = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(torn.records.map((r) => r.id), [`${SEG}:1`], 'the torn batch is not a fact')
  fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), envLine({ id: 'b' }) + '\n')
  await segmentIndex({ home, segment: SEG, owner: true })
  const fixed = fs.readFileSync(idx)
  assert.ok(fixed.subarray(0, whole.length).equals(whole), 'the pass cut the torn batch back to the last mark')
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
})

test('正在写的段按偏移增量补:只读新字节,已有 id 不变', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  const first = await segmentIndex({ home, segment: SEG, owner: true })
  const idxFile = path.join(indexDir(home), `${SEG}.json`)
  const mark = markOf(idxFile)
  writeSegment(home, SEG, [{ id: 'b', ts: '2026-10-18T10:05:00.000Z' }])
  const again = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(again.records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.deepEqual(again.records[0], first.records[0])
  await segmentIndex({ home, segment: SEG, owner: true })
  assert.equal(again.bytesRead, markOf(idxFile).size - mark.end) // only the appended bytes
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
  const withIndex = await segmentIndex({ home, segment: SEG, owner: true })
  fs.rmSync(indexDir(home), { recursive: true })
  const rebuilt = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(rebuilt.records, withIndex.records)
  assert.equal(withIndex.records[0].session_key, 's-1')
})

// D62: `maxBytes` is what lets the daemon's keeper index a backlog in chunks without blocking its event loop. The
// chunks must add up to exactly the records one pass stores (the file itself differs by one mark line per chunk), and
// one line bigger than a chunk must still make progress — otherwise the keeper would loop for ever on a 10 MB record.
test('分块补索引(maxBytes):每块只读新字节,合起来的记录与一次建完相同;单行大于一块也照样推进', async () => {
  const home = rawHome()
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, ts: `2026-10-18T10:00:${String(i).padStart(2, '0')}.000Z` }))
  writeSegment(home, SEG, many)
  const whole = await segmentIndex({ home, segment: SEG, owner: true })
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
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).records, whole.records, 'the chunked catch-up indexes what one pass indexes')
  assert.equal(markOf(path.join(indexDir(home), `${SEG}.json`)).size, size)

  // a chunk smaller than one record: the scan reads on until it has a whole line, so a call always makes progress
  // (a keeper that looped on a 10 MB record would never catch up)
  const big = rawHome()
  writeSegment(big, SEG, [{ id: 'huge', body: 'x' }])
  fs.appendFileSync(path.join(big, 'raw', `${SEG}.ndjson`), envLine({ id: 'huge2' }) + '\n')
  let n = 0, last
  do { last = await segmentIndex({ home: big, segment: SEG, owner: true, maxBytes: 1 }); n++ } while (!last.done && n < 5)
  assert.ok(last.done, 'a chunk smaller than a record still finishes')
  assert.equal((await segmentIndex({ home: big, segment: SEG })).records.length, 2)
})

// D62 · D38: when the daemon did NOT keep the index current, the query that pays for it says so — and keeps saying it,
// because a reader does not write a plaintext segment's index: only the daemon's pass makes the next query cheap.
test('冷建索引不静默:读取侧自己建了超过一块的索引时,在 errors 里说清楚;守护进程补过之后没有这条', async () => {
  const home = rawHome()
  // > 4 MB of records (envLine's bodies are fixed, so the padding goes in by hand — the index only needs valid JSON)
  const fat = (i) => JSON.stringify({ ...JSON.parse(envLine({ id: `fat${i}` })), pad: 'z'.repeat(300_000) }) + '\n'
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(home, 'raw', `${SEG}.ndjson`), Array.from({ length: 20 }, (_, i) => fat(i)).join(''))
  const cold = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(cold.problems.map((p) => p.code), ['index-cold'])
  assert.match(cold.problems[0].reason, /MB of 20261018T100000Z itself \(the whole segment\)/)
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).problems.map((p) => p.code), ['index-cold'], 'a reader does not store it, so the next query pays again and says so again')
  await segmentIndex({ home, segment: SEG, owner: true })
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).problems, [], 'the daemon kept it current: nothing to say')
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
  const before = await segmentIndex({ home, segment: SEG, owner: true })
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
  await segmentIndex({ home, segment: SEG, owner: true })
  assert.equal((await segmentIndex({ home, segment: SEG })).bytesRead, 0)
  assert.equal([...segmentLines({ home, segment: SEG })].length, 2)
  assert.deepEqual((await allRecords({ home })).map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
})

// A whole-document write goes through a temp next to the index and a rename. The temp name was the pid alone, so two
// whole writes of the same index at the same time (two processes with the same pid in different namespaces or
// containers, a rebuild and a sealer, one process rebuilding after a format bump) would write one file through one
// another's temp. The name has to be unique per CALL.
test('the temp of a whole-document index write is unique per call, not per pid', async () => {
  const h = rawHome()
  writeSegment(h, SEG, [envLine({ id: 'req_1' })])
  const temps = []
  const spy = { ...fs, writeFileSync: (f, ...rest) => { if (String(f).includes('.tmp-')) temps.push(String(f)); return fs.writeFileSync(f, ...rest) } }
  // a reader rebuilding a SEALED index writes the document whole (the plaintext case the keeper owns appends)
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  await sealSegment(path.join(h, 'raw', `${SEG}.ndjson`), { lockFile: path.join(h, 'collector', 'lock') })
  await segmentIndex({ home: h, segment: SEG, fs: spy })
  fs.rmSync(indexDir(h), { recursive: true, force: true })
  await segmentIndex({ home: h, segment: SEG, fs: spy })
  assert.equal(temps.length, 2, 'both builds wrote the document whole, through a temp')
  assert.notEqual(temps[0], temps[1], 'two whole writes of one index must not share a temp name')
})

// ONE WRITER (4.2 §段索引 谁写哪一笔, MUST): when a segment is handed over, the seal worker builds the sealed copy's
// index and renames it over this file. A keeper pass whose write LOSES that race must land on the inode it opened —
// the old, by then unlinked one — and never cut the new file down to its own idea of its length. That is why the
// append path works through an fd (ftruncate / write at an offset) and not through the path (review of D62, 2026-10-20).
test('一个写者:补索引的那一笔与封存器的 rename 相撞时,写在被 unlink 的旧 inode 上,新文件一个字节不动', async () => {
  const home = rawHome()
  const idx = path.join(indexDir(home), `${SEG}.json`)
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b' }])
  await segmentIndex({ home, segment: SEG, owner: true })
  // more records to index, and a torn batch at the end of the document, so the next pass has to cut back first
  fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), envLine({ id: 'c' }) + '\n')
  fs.appendFileSync(idx, '{"id":"torn"')
  // the seal worker's index of the sealed copy: built in its child and renamed over this one (storeIndex `at: null`),
  // at the moment this pass cuts its own file back
  const sealer = Buffer.from(`{"m":{"size":99,"sealed":true},"v":4}\n`)
  const race = () => { const tmp = `${idx}.sealer`; fs.writeFileSync(tmp, sealer); fs.renameSync(tmp, idx) }
  let raced = false
  const racing = { ...fs,
    ftruncateSync: (...a) => { if (!raced) { raced = true; race() } return fs.ftruncateSync(...a) },
    truncateSync: (...a) => { if (!raced) { raced = true; race() } return fs.truncateSync(...a) } }
  const got = await segmentIndex({ home, segment: SEG, owner: true, fs: racing })
  assert.equal(raced, true, 'the pass did cut its file back, which is where the rename was placed')
  assert.deepEqual(got.problems, [], 'the write itself succeeded — on the inode it had opened')
  assert.deepEqual(fs.readFileSync(idx), sealer, 'the file the sealer put there is exactly as the sealer wrote it')
})
