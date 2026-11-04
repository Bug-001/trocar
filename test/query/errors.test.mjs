// test/query/errors.test.mjs — V81: 读不全照样给出文档、退 0、`errors` 点名(RFC 1.6 §4.1, D38),
// 以及索引是纯缓存——弄坏或删掉它,答案逐字段不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine, requiredFor, DATA_QUERIES } from './raw-home.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { indexDir, segmentIndex } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'
const everyDoc = async (home, now = Date.now) => {
  const docs = {}
  for (const name of DATA_QUERIES) {
    docs[name] = await runQuery(name, requiredFor(name, { segment: SEG }), { home, now })
    assert.deepEqual(validateQueryDoc(docs[name], name), [])
  }
  return docs
}

// `classes.disk.trocar_bytes` counts the index files themselves, and the index is exactly what these two tests
// break or delete: a reader does not rewrite a plaintext segment's index (4.2 §段索引 谁写哪一笔), so the size of
// the cache can differ while every answer about the DATA is the same.
const answers = (docs) => ({ ...docs, classes: { ...docs.classes, disk: { ...docs.classes.disk, trocar_bytes: null } } })

test('一条记录坏了:文档照出,errors 点名那条记录,其余 id 不变', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, '{"this is not": json', { id: 'c', class: 'files' }])
  const docs = await everyDoc(home)
  assert.equal(docs.segments.ok, false)
  assert.equal(docs.segments.segments[0].records, 2)
  assert.deepEqual(docs.segments.segments[0].problems.map((p) => p.code), ['record-unparseable'])
  assert.equal(docs.classes.classes.find((c) => c.class === 'files').counts.all.calls, 1)
  // 第二次读用的是存下来的索引(没有重扫),坏记录照样点名:只有建索引那一次报就是静默了(D38)
  const again = await runQuery('segments', {}, { home })
  assert.deepEqual([again.ok, again.errors], [docs.segments.ok, docs.segments.errors])
})

test('一个段读不出:文档照出,errors 说哪个段', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  fs.writeFileSync(path.join(home, 'raw', '20261017T090000Z.sealed'), 'this is not a sealed file')
  const docs = await everyDoc(home)
  assert.equal(docs.segments.ok, false)
  const broken = docs.segments.segments.find((s) => s.segment === '20261017T090000Z')
  assert.deepEqual(broken.problems.map((p) => p.code), ['segment-unreadable'])
  assert.equal(broken.records, 0)
  assert.equal(docs.segments.segments.find((s) => s.segment === SEG).records, 1) // the good segment is unaffected
  assert.ok(docs.classes.errors.some((e) => e.where === 'segments/20261017T090000Z'))
})

// 3.5 读不全不静默: the id may live in the segment that could not be read, so every read of one session says both facts.
test('一个段读不出时问一场没读到的会话:每条会话读都说段的问题,也说 session-unknown', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  fs.writeFileSync(path.join(home, 'raw', '20261017T090000Z.sealed'), 'this is not a sealed file')
  const reads = [
    ['session', {}], ['session', { head: true }], ['analysis', {}], ['analysis', { from: 'x' }],
    ['lane', { lane: 'x' }], ['lane', { pack: '0.main' }], ['lane', { tail: 'main' }],
  ]
  for (const [name, params] of reads) {
    const { errors } = await runQuery(name, { id: 'behind-the-bad-segment', ...params }, { home, env: {} })
    const said = JSON.stringify([name, params])
    assert.ok(errors.some((e) => e.code === 'segment-unreadable'), said)
    assert.ok(errors.some((e) => e.code === 'session-unknown'), said)
  }
})

// 4.3 §4 回收: a raw/ that cannot be listed (here a file in its place) is said in the read's `errors` as `where:'raw'`
// `segment-unreadable`; a raw/ that is not there is no segments, not an error.
test('raw/ 列不出:读的 errors 有 where raw 的 segment-unreadable;raw/ 不在时没有', async () => {
  const home = rawHome()
  fs.rmSync(path.join(home, 'raw'), { recursive: true })
  const lists = ['segments', 'sessions', 'classes'] // the reads that list raw/
  for (const name of lists) assert.equal((await runQuery(name, {}, { home })).errors.filter((e) => e.where === 'raw').length, 0, name)
  fs.writeFileSync(path.join(home, 'raw'), 'not a folder')
  for (const name of lists) {
    const doc = await runQuery(name, {}, { home })
    assert.deepEqual(validateQueryDoc(doc, name), [])
    assert.equal(doc.ok, false, name)
    assert.deepEqual(doc.errors.filter((e) => e.where === 'raw').map((e) => e.code), ['segment-unreadable'], name)
  }
})

test('一份索引坏了:下一次读把它重建,答案与好索引时逐字段相等', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a', sessionKey: 's-1' }, { id: 'b', class: 'account' }])
  const now = () => Date.parse('2026-10-18T11:00:00.000Z')
  await segmentIndex({ home, segment: SEG, owner: true }) // the daemon's index, as the queries find it
  const good = await everyDoc(home, now)
  fs.writeFileSync(path.join(indexDir(home), `${SEG}.json`), '{"v":1,"records":[{"id":"ghost"}')
  const afterBroken = await everyDoc(home, now)
  assert.deepEqual(answers(afterBroken), answers(good))
  // …and an index that is merely of an older shape is not trusted either
  fs.writeFileSync(path.join(indexDir(home), `${SEG}.json`), JSON.stringify({ v: 0, records: [{ id: 'ghost' }] }))
  assert.deepEqual(answers(await everyDoc(home, now)), answers(good))
})

test('删掉 index/ 后重建,每个文档逐字段相等', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b', class: 'telemetry', is_llm: false }])
  fs.writeFileSync(path.join(home, 'raw', `20261018T120000Z.ndjson`), envLine({ id: 'c', class: 'other' }) + '\n')
  const now = () => Date.parse('2026-10-18T13:00:00.000Z')
  for (const seg of [SEG, '20261018T120000Z']) await segmentIndex({ home, segment: seg, owner: true })
  const withIndex = await everyDoc(home, now)
  fs.rmSync(indexDir(home), { recursive: true })
  assert.deepEqual(answers(await everyDoc(home, now)), answers(withIndex))
})
