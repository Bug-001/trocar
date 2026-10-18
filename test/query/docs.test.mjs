// test/query/docs.test.mjs — every named query's document against 附录 C.5 (RFC 1.6): the common keys,
// the per-name top-level keys, and the exit-2 cases (an unknown name or parameter).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from './raw-home.mjs'
import { QUERIES, runQuery, parseTime, QueryArgError } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'

const SEG = '20261018T100000Z'
const homeWithData = () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ ts: '2026-10-18T10:00:00.000Z' }, { ts: '2026-10-18T10:00:01.000Z', class: 'telemetry', is_llm: false }])
  return home
}

test('每个文档过 schema', async () => {
  const home = homeWithData()
  for (const name of Object.keys(QUERIES)) {
    const doc = await runQuery(name, {}, { home })
    assert.deepEqual(validateQueryDoc(doc, name), [], `${name}: ${JSON.stringify(doc)}`)
  }
})

test('segments 的顶层键与每段的键照 C.5', async () => {
  const home = homeWithData()
  const doc = await runQuery('segments', {}, { home })
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'errors', 'ok', 'schema', 'segments'])
  assert.deepEqual(Object.keys(doc.segments[0]).sort(), ['bytes', 'from', 'problems', 'ratio', 'records', 'sealed_bytes', 'segment', 'state', 'to'])
  assert.equal(doc.segments[0].records, 2)
  assert.equal(doc.segments[0].sealed_bytes, null)
})

test('segments 收 --since / --until,也收相对时间', async () => {
  const home = homeWithData()
  const now = () => Date.parse('2026-10-18T10:00:02.000Z')
  assert.equal((await runQuery('segments', { since: '1h' }, { home, now })).segments.length, 1)
  assert.equal((await runQuery('segments', { since: '2026-10-19T00:00:00Z' }, { home, now })).segments.length, 0)
  assert.equal((await runQuery('segments', { until: '2026-10-17T00:00:00Z' }, { home, now })).segments.length, 0)
  assert.equal(parseTime('24h', { now: 86400e3 * 2 }), 86400e3)
  assert.throws(() => parseTime('yesterday', { name: 'since' }), QueryArgError)
})

test('classes 的顶层键与每类的键照 C.5,条数与大小来自段索引', async () => {
  const home = homeWithData()
  const now = () => Date.parse('2026-10-18T11:00:00.000Z')
  const doc = await runQuery('classes', {}, { home, now })
  assert.deepEqual(Object.keys(doc).sort(), ['classes', 'command', 'disk', 'errors', 'file', 'last_change', 'ok', 'schema'])
  const llm = doc.classes.find((c) => c.class === 'llm')
  assert.deepEqual(Object.keys(llm).sort(), ['builtin', 'class', 'counts', 'keep', 'rules'])
  assert.deepEqual(Object.keys(llm.counts).sort(), ['all', 'd7', 'h24'])
  assert.equal(llm.counts.all.calls, 1)
  assert.equal(llm.counts.h24.calls, 1)
  assert.equal(doc.classes.find((c) => c.class === 'telemetry').counts.all.calls, 1)
  assert.ok(llm.counts.all.bytes > 0)
  assert.deepEqual(Object.keys(doc.disk).sort(), ['asight_bytes', 'legacy_bytes', 'records_bytes', 'sealed_bytes'])
  assert.equal(doc.disk.records_bytes, (await runQuery('segments', {}, { home, now })).segments[0].bytes)
  assert.equal(doc.file, null)

  // 24 h / 7 d are windows on the record's own time, not on everything on disk
  const later = await runQuery('classes', {}, { home, now: () => Date.parse('2026-10-30T00:00:00.000Z') })
  const l2 = later.classes.find((c) => c.class === 'llm')
  assert.deepEqual([l2.counts.h24.calls, l2.counts.d7.calls, l2.counts.all.calls], [0, 0, 1])
})

test('盘上没有数据时每个文档照样出,退 0 的形状', async () => {
  const home = rawHome()
  for (const name of Object.keys(QUERIES)) {
    const doc = await runQuery(name, {}, { home })
    assert.deepEqual(validateQueryDoc(doc, name), [])
    assert.equal(doc.ok, true)
  }
})

test('名字或参数不对 → QueryArgError(CLI 退 2)', async () => {
  const home = rawHome()
  await assert.rejects(() => runQuery('nope', {}, { home }), QueryArgError)
  await assert.rejects(() => runQuery('classes', { since: '1h' }, { home }), QueryArgError)
  await assert.rejects(() => runQuery('segments', { harness: 'codex' }, { home }), QueryArgError)
})
