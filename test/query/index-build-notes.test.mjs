// test/query/index-build-notes.test.mjs — an index problem in a query document carries its closed-set code, and
// `index-cold` carries level 'note': this read was slow, nothing is missing (3.5 读不全, 4.2 §段索引 ③, D38).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { segmentIndex, KEEPER_CHUNK_BYTES } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'
const READS = [['sessions', {}], ['segments', {}], ['classes', {}], ['calls', { class: 'llm' }]]

// a segment bigger than one keeper chunk that no keeper pass covered: a reader indexes it itself
const coldHome = () => {
  const home = rawHome()
  const line = (i) => JSON.stringify({ ...JSON.parse(envLine({ id: `fat${i}` })), pad: 'z'.repeat(300_000) }) + '\n'
  const n = Math.ceil(KEEPER_CHUNK_BYTES / 300_000) + 2
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  fs.writeFileSync(path.join(home, 'raw', `${SEG}.ndjson`), Array.from({ length: n }, (_, i) => line(i)).join(''))
  return home
}

test('index-cold is a note: level note, a code apart from its reason, a valid document that is ok', async () => {
  for (const [name, params] of READS) {
    const doc = await runQuery(name, params, { home: coldHome() })
    assert.deepEqual(validateQueryDoc(doc, name), [], name)
    assert.ok(doc.errors.every((e) => e.level === 'note'), `${name}: ${JSON.stringify(doc.errors)}`)
    assert.equal(doc.ok, true, `${name}: only notes, so nothing went unread (C.5)`)
    const cold = doc.errors.filter((e) => e.code === 'index-cold')
    assert.ok(cold.length > 0, `${name}: ${JSON.stringify(doc.errors)}`)
    for (const e of cold) {
      assert.equal(e.level, 'note', name)
      assert.ok(!e.reason.startsWith(e.code), `${name}: ${e.reason}`)
    }
  }
})

test('a lost record is not a note: record-unparseable has its code and no level, and the document is not ok', async () => {
  const home = rawHome()
  writeSegment(home, SEG, [{ id: 'a' }, '{"this is not": json'])
  const doc = await runQuery('segments', {}, { home })
  assert.deepEqual(validateQueryDoc(doc, 'segments'), [])
  assert.equal(doc.ok, false)
  const bad = doc.errors.filter((e) => e.code === 'record-unparseable')
  assert.ok(bad.length > 0, JSON.stringify(doc.errors))
  for (const e of bad) assert.equal('level' in e, false)
})

test('the note is about this read: once the index is current no note remains', async () => {
  const home = coldHome()
  await segmentIndex({ home, segment: SEG, owner: true })
  for (const [name, params] of READS) {
    const doc = await runQuery(name, params, { home })
    assert.deepEqual(doc.errors.filter((e) => e.level === 'note'), [], name)
  }
})

test('the note is not remembered: a later read in the same process, or after the keeper indexed, has none', async () => {
  for (const [name, params] of READS) {
    const home = coldHome()
    const notes = async () => (await runQuery(name, params, { home })).errors.filter((e) => e.level === 'note')
    assert.ok((await notes()).some((e) => e.code === 'index-cold'), name)
    assert.deepEqual(await notes(), [], `${name}: second read`)
    await segmentIndex({ home, segment: SEG, owner: true })
    assert.deepEqual(await notes(), [], `${name}: after the keeper`)
  }
})
