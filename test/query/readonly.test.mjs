// test/query/readonly.test.mjs — V79 的 `query` 一半(RFC 1.6 §4.1): a query writes nothing in
// ~/.trocar but index/, and a home it cannot write at all still yields a document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, snapshot, requiredFor, DATA_QUERIES } from './raw-home.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { indexDir } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z', SEALED = '20261018T090000Z'

test('跑前跑后 HOME 快照只差 index/', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, { id: 'b', class: 'telemetry', is_llm: false }])
  // a SEALED segment too: that is the only index a reader writes (4.2 §段索引 谁写哪一笔 — a plaintext
  // segment's index is the daemon's, and a query never writes one), so the snapshot has something to compare
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  writeSegment(home, SEALED, [{ id: 'c', class: 'files' }])
  await sealSegment(path.join(home, 'raw', `${SEALED}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(home, 'logs', 'classes.ndjson'), '{"op":"set"}\n')
  fs.writeFileSync(path.join(home, 'capture-2026-10-01.ndjson'), '{"id":"old"}\n') // an older location: read, never touched
  const before = snapshot(home)
  for (const name of DATA_QUERIES) assert.deepEqual(validateQueryDoc(await runQuery(name, requiredFor(name, { segment: SEG }), { home }), name), [])
  const after = snapshot(home)
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `${k} changed`)
  const added = Object.keys(after).filter((k) => !(k in before))
  assert.deepEqual(added, [`index/${SEALED}.json`]) // spec 1.6:111 — nothing but index/, and only the sealed segment's
  for (const k of added) assert.equal(after[k].split(':')[1], '600') // the index holds derived facts of 0600 files
})

test('只读的 ~/.trocar 仍出文档,写不下索引不静默', async () => {
  const home = rawHome()
  // a sealed segment: the one index a reader writes, so "cannot write it" is a thing that can happen to a query
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  writeSegment(home, SEALED, [{ id: 'a' }])
  await sealSegment(path.join(home, 'raw', `${SEALED}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  const before = snapshot(home)
  fs.chmodSync(home, 0o500)
  try {
    const doc = await runQuery('segments', {}, { home })
    assert.deepEqual(validateQueryDoc(doc, 'segments'), [])
    assert.equal(doc.segments[0].records, 1)        // the answer comes from the segment itself
    assert.equal(doc.ok, false)
    assert.ok(doc.errors.some((e) => e.code === 'index-unwritable'), JSON.stringify(doc.errors))
    assert.equal(fs.existsSync(indexDir(home)), false)
  } finally { fs.chmodSync(home, 0o700) }
  assert.deepEqual(snapshot(home), before)
})
