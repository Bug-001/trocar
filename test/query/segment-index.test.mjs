// test/query/segment-index.test.mjs — the segment index (RFC 1.6 §4.1 「只读原始记录与可删的索引」, 4.2 §段索引):
// built on first read, kept in ~/.trocar/index/, refreshed by APPENDED bytes only, and rebuildable at any time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { segmentIndex, allSegments, indexDir, warmSegmentIndex } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z', SEG2 = '20261018T110000Z'
// The stored mark: the last complete `{"m":…}` line of the append-only index document (4.2 §段索引).
const markOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.m).pop().m

test('记录 id 从 1 起,读取侧不把明文段的索引落盘(那份文件是守护进程的)', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ ts: '2026-10-18T10:00:00.000Z' }, { ts: '2026-10-18T10:00:01.000Z', class: 'telemetry', is_llm: false, status: 204 }])
  const { records } = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`])
  assert.deepEqual(records[1], { id: `${SEG}:2`, ts: '2026-10-18T10:00:01.000Z', harness: 'claude-code', class: 'telemetry', host: 'api.anthropic.com', path: '/v1/messages', status: 204, stored_bytes: records[1].stored_bytes, sent_bytes: 10, received_bytes: 20, session_key: null, is_llm: false,
    // the session facts, so `sessions` never reads a record back (1.6 §4.1 ≤ 1 s): the harness the board decides,
    // where the record's bytes are, and the kind of call it is
    harness_id: 'cc', has_proc: true, has_headers: true, harness_inferred: false, entrypoint: null, log_only: false, subagent: false, synth_hash: null, kin_fp: null, kin_probe: null, offset: records[1].offset })
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

// 4.2 §段索引: each direction's wire bytes from body_wire_bytes; a value not recorded is null, never 0 (invariant 4).
test('条目的 sent_bytes / received_bytes 取自 body_wire_bytes,没记下的是 null,不是 0', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a', wireReq: 7, wireResp: null }, { id: 'b', noWire: true }])
  const { records } = await segmentIndex({ home, segment: SEG })
  assert.deepEqual(records.map((r) => [r.sent_bytes, r.received_bytes]), [[7, null], [null, null]])
})

// 4.2: an index of another version (v4 and earlier) is stale — the reader rebuilds it and never answers from it.
test('旧版本(v4)的索引文件:读者不信它,重建出的记录与新建的逐字段相等', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b', class: 'account' }])
  const fresh = await segmentIndex({ home, segment: SEG, owner: true })
  const idx = path.join(indexDir(home), `${SEG}.json`)
  const m = markOf(idx)
  fs.writeFileSync(idx, `{"id":"ghost"}\n${JSON.stringify({ m, v: 4 })}\n`)
  assert.deepEqual((await segmentIndex({ home, segment: SEG })).records, fresh.records)
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
  // the closed-set code is the contract (D38), not the wording; all the prose must do is name the segment it was about
  assert.ok(cold.problems[0].reason.includes(SEG), cold.problems[0].reason)
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
  // nor does a lock nobody refreshes any more: only a FRESH lock names the segment being written, which is the
  // whole evidence a reader has and the only one it needs — it asks no question about any process (the default
  // lock reader passes no identity, because on Windows that question costs a powershell.exe start per query).
  const wedged = await allSegments({ home, lockState: () => ({ state: 'unresponsive', lock: { pid: 1, segment: SEG2 }, age_ms: 60_000 }) })
  assert.deepEqual(wedged.map((s) => s.state), ['sealed', 'closed', 'closed'])
})

// 4.2:30 崩溃残留:明文与封存件并存 = 上次封存断在 rename 之后、删明文之前。明文为准 —— 读取侧每一条路都得这么说,
// 不然 128 MB 明文还在盘上,状态却报 `sealed`(2026-10-18 Windows run P1)。
test('明文与封存件并存时:状态不是 sealed,读的是明文的字节', async () => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  const { segmentLines } = await import('../../src/query/records.mjs')
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
  const sealer = Buffer.from(`{"m":{"size":99,"sealed":true},"v":5}\n`)
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

// D63 ① / 1.6 §4.1 附近的查询: there is ONE warm reading of a segment's index rows, and `allSegments` (the `segments`
// document, and the ordered segment list every other query starts from) reads through it like everybody else —
// reading `segmentIndex` directly meant re-reading and re-parsing every index file on every query (review of D63,
// 2026-10-20; the same miss `calls` had).
test('段列表走那唯一一处温读:同一个进程里第二次不再读索引文件', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  writeSegment(home, SEG2, [{ id: 'b' }])
  await segmentIndex({ home, segment: SEG, owner: true })
  await segmentIndex({ home, segment: SEG2, owner: true })
  const read = []
  const counting = { ...fs, readFileSync: (p, ...rest) => { if (String(p).startsWith(indexDir(home))) read.push(String(p)); return fs.readFileSync(p, ...rest) } }
  const first = await allSegments({ home, fs: counting, lockState: () => ({ state: 'none' }) })
  assert.equal(read.length, 2, 'the first call reads each segment\'s index once')
  read.length = 0
  const again = await allSegments({ home, fs: counting, lockState: () => ({ state: 'none' }) })
  assert.deepEqual(read, [], 'nothing moved, so no index file is read or parsed again')
  assert.deepEqual(again, first)
})

// The DEFAULT lock reader (no `lockState` injected), which is the one every `query segments` / `query classes`
// uses: the evidence is the lock file alone — its pid being alive and WHEN it was last refreshed. Nothing is
// asked of the OS about that process: on Windows the identity question (creation time + boot time, which only
// `off` needs, so that it cannot act on a reused pid) costs one powershell.exe start, ~450 ms per query on the
// test machine, and it was the whole of `segments`/`classes` being 673/703 ms there against 223/256 ms in a HOME with
// no lock file at all (2026-10-19).
test('a reader takes only a FRESH lock as "being written", and asks nothing about the process', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  const lock = path.join(home, 'collector', 'lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  // this very process, so the pid IS alive: what decides is the age, nothing else
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, segment: SEG }))
  assert.deepEqual((await allSegments({ home })).map((s) => s.state), ['writing'], 'a lock refreshed just now names the segment being written')
  const old = Date.now() / 1000 - 600
  fs.utimesSync(lock, old, old)
  assert.deepEqual((await allSegments({ home })).map((s) => s.state), ['closed'], 'a lock nobody has refreshed for ten minutes names nothing: the daemon that held it is gone')
})

// 4.2:49: a reader that read the segment's index before reads only past the last complete mark it read, while the index file is the
// same file and that mark line's bytes are unchanged; else whole. Over generated sequences of what happens to the index file — the
// keeper's appends (in chunks), a torn batch it later cuts back, the file cut back in place to an earlier mark, a whole rewrite
// (a new file by rename), lines the reader cannot parse, and sealing — the reader that kept reading answers what a whole read answers.
test('读者从上次读到的 mark 往后读:条目与问题和整读相同(残批截回、原地截短、整体重写、封存)', async () => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  for (let seed = 1; seed <= 6; seed++) {
    let x = seed * 7919
    const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647)
    const home = rawHome()
    const raw = path.join(home, 'raw', `${SEG}.ndjson`), idx = path.join(indexDir(home), `${SEG}.json`)
    const own = { ...fs } // its own warm entries: the reader that keeps reading
    let n = 0
    const grow = () => { const k = 1 + Math.floor(rnd() * 4); writeSegment(home, SEG, Array.from({ length: k }, () => (rnd() < 0.1 ? 'not json' : { id: `r${n++}` }))) }
    const keep = async () => { for (let i = 0; i < 8; i++) if ((await segmentIndex({ home, segment: SEG, owner: true, maxBytes: rnd() < 0.5 ? 400 : Infinity })).done) break }
    const ops = {
      keeper: keep,
      torn: () => { if (fs.existsSync(idx)) fs.appendFileSync(idx, `${JSON.stringify({ id: `${SEG}:999`, ts: null })}\n{"id":"${SEG}:10`) },
      shrink: () => { // cut back in place (same file) to its first mark
        if (!fs.existsSync(idx)) return
        const lines = fs.readFileSync(idx, 'utf8').split('\n'), m = lines.findIndex((l) => l.startsWith('{"m":'))
        if (m >= 0) fs.writeFileSync(idx, lines.slice(0, m + 1).join('\n') + '\n')
      },
      rewrite: async () => { fs.rmSync(idx, { force: true }); await keep() },
    }
    const names = Object.keys(ops)
    for (let step = 0; step < 30; step++) {
      grow() // the segment moves, so the reader reads again
      await ops[names[Math.floor(rnd() * names.length)]]()
      const kept = await warmSegmentIndex({ home, segment: SEG, fs: own }), whole = await segmentIndex({ home, segment: SEG })
      assert.deepEqual({ records: [...kept.records].map((r) => JSON.stringify(r)), problems: kept.problems }, { records: whole.records.map((r) => JSON.stringify(r)), problems: whole.problems }, `seed ${seed} step ${step}`)
    }
    await keep()
    await sealSegment(raw, { lockFile: path.join(home, 'collector', 'lock'), journal: null })
    const kept = await warmSegmentIndex({ home, segment: SEG, fs: own }), whole = await segmentIndex({ home, segment: SEG })
    assert.deepEqual({ records: [...kept.records].map((r) => JSON.stringify(r)), problems: kept.problems }, { records: whole.records.map((r) => JSON.stringify(r)), problems: whole.problems }, `seed ${seed} sealed`)
  }
})

// 4.2 §段索引 失效与增量: a home cloned, restored from a backup or moved by Migration Assistant has every file's bytes and
// mtime but a new inode and ctime. The derived files over it are still right (不变式 2), so they are reused, not rebuilt (D71③).
test('克隆 / 恢复出来的 home(字节与 mtime 相同,inode 与 ctime 全换):段索引照用不重建,答案逐字节相同;封存段改一个字节就重建', async () => {
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  const { runQuery } = await import('../../src/query/named/index.mjs')
  const home = rawHome()
  const T = 1_790_000_000 // whole seconds, so a copy can carry the mtime exactly
  const sealedF = writeSegment(home, SEG, [{ id: 'a', sessionKey: 's-1', harness: 'opencode' }, { id: 'b', sessionKey: 's-1', harness: 'opencode', ts: '2026-10-18T10:00:02.000Z' }])
  writeSegment(home, SEG2, [{ id: 'c', sessionKey: 's-1', harness: 'opencode', ts: '2026-10-18T11:00:00.000Z' }])
  await sealSegment(sealedF, { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  for (const f of fs.readdirSync(path.join(home, 'raw'))) fs.utimesSync(path.join(home, 'raw', f), T, T)
  await segmentIndex({ home, segment: SEG2, owner: true })
  const id = (await runQuery('sessions', {}, { home })).sessions[0].session_id
  const want = JSON.stringify(await runQuery('session', { id }, { home }))
  const idx = (h) => path.join(indexDir(h), `${SEG}.json`)
  assert.ok(fs.existsSync(idx(home)), 'the sealed segment has its index')
  const copy = rawHome()
  const clone = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); clone(a, b) } else { fs.copyFileSync(a, b); const st = fs.statSync(a); fs.utimesSync(b, st.atimeMs / 1000, st.mtimeMs / 1000) }
    }
  }
  clone(home, copy)
  const before = { bytes: fs.readFileSync(idx(copy)), mtimeMs: fs.statSync(idx(copy)).mtimeMs }
  assert.equal(JSON.stringify(await runQuery('session', { id }, { home: copy })), want)
  assert.deepEqual({ bytes: fs.readFileSync(idx(copy)), mtimeMs: fs.statSync(idx(copy)).mtimeMs }, before, 'the index of the copy is not rewritten')
  // same size, same mtime, one byte different: not the bytes that were indexed
  const sealedCopy = path.join(copy, 'raw', `${SEG}.sealed`), buf = fs.readFileSync(sealedCopy)
  buf[buf.length >> 1] ^= 0xff
  fs.writeFileSync(sealedCopy, buf)
  fs.utimesSync(sealedCopy, T, T)
  await segmentIndex({ home: copy, segment: SEG })
  assert.notDeepEqual(fs.readFileSync(idx(copy)), before.bytes, 'a sealed segment whose bytes changed is indexed again')
})
