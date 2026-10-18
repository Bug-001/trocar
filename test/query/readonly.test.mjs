// test/query/readonly.test.mjs — V79 的 `query` 一半(RFC 1.6 §4.1): a query writes nothing in
// ~/.asight but index/, and a home it cannot write at all still yields a document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, snapshot } from './raw-home.mjs'
import { QUERIES, runQuery } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { indexDir } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'

test('跑前跑后 HOME 快照只差 index/', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b', class: 'telemetry', is_llm: false }])
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(home, 'logs', 'classes.ndjson'), '{"op":"set"}\n')
  fs.writeFileSync(path.join(home, 'capture-2026-10-01.ndjson'), '{"id":"old"}\n') // an older location: read, never touched
  const before = snapshot(home)
  for (const name of Object.keys(QUERIES)) assert.deepEqual(validateQueryDoc(await runQuery(name, {}, { home }), name), [])
  const after = snapshot(home)
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `${k} changed`)
  const added = Object.keys(after).filter((k) => !(k in before))
  assert.deepEqual(added, [`index/${SEG}.json`])
  assert.equal(after[added[0]].split(':')[1], '600') // the index holds derived facts of 0600 files
})

test('只读的 ~/.asight 仍出文档,写不下索引不静默', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }])
  const before = snapshot(home)
  fs.chmodSync(home, 0o500)
  try {
    const doc = await runQuery('segments', {}, { home })
    assert.deepEqual(validateQueryDoc(doc, 'segments'), [])
    assert.equal(doc.segments[0].records, 1)        // the answer comes from the segment itself
    assert.equal(doc.ok, false)
    assert.ok(doc.errors.some((e) => /index-unwritable/.test(e.reason)), JSON.stringify(doc.errors))
    assert.equal(fs.existsSync(indexDir(home)), false)
  } finally { fs.chmodSync(home, 0o700) }
  assert.deepEqual(snapshot(home), before)
})
