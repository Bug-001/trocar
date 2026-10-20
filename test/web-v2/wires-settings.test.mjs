// wires-settings.test.mjs — settings · storage and settings · prices (1.11) read the C.5 documents as they are: the disk
// figures from `classes.disk` and `classes[].counts`, one read-only row per `classes[]` entry, the read problems from
// `segments[].problems` and the documents' `errors[]`, the price rows from `pricing.models[]`. Real face, real worker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { diskFigures, classRows, storageHtml, fileProblems, problemCount } from '../../src/web/v2/settings/storage.mjs'
import { priceRows, sourceHtml } from '../../src/web/v2/settings/prices.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { writeSegment } from '../query/raw-home.mjs'

async function read(prep, names) {
  const h = boardHome({ bytes: 2e5 })
  if (prep) prep(h)
  const face = await serveBoard(h)
  try {
    const out = { h }
    for (const n of names) { const r = await face.get(n); assert.equal(r.status, 200, n); out[n] = r.doc }
    return out
  } finally { await face.close() }
}
const plain = read(null, ['classes', 'segments', 'pricing'])

test('(1) the disk total is classes.disk.trocar_bytes; the per-day figure is the sum of classes[].counts.h24.bytes', async () => {
  const { classes } = await plain
  for (const doc of [classes, { ...classes, classes: classes.classes.map((c, i) => ({ ...c, counts: { ...c.counts, h24: { calls: 1, bytes: 1000 * (i + 1) } } })) }]) {
    const f = diskFigures(doc)
    assert.equal(f.total, doc.disk.trocar_bytes)
    assert.equal(f.perDay, doc.classes.reduce((s, c) => s + c.counts.h24.bytes, 0))
  }
})

test('(2) one class row per classes[] entry, keep shown as a value with no control for it', async () => {
  const { classes, segments } = await plain
  assert.ok(classes.classes.some((c) => c.builtin), 'the built-ins are in the document')
  for (const w of ['h24', 'd7', 'all']) {
    const rows = classRows(classes, w)
    assert.deepEqual(rows.map((r) => r.id).sort(), classes.classes.map((c) => c.class).sort())
    for (const c of classes.classes) {
      const r = rows.find((x) => x.id === c.class)
      assert.equal(r.keep, c.keep)
      assert.deepEqual([r.calls, r.bytes], [c.counts[w].calls, c.counts[w].bytes])
    }
  }
  const tables = storageHtml({ classes, segments }, '24h').match(/<table[\s\S]*?<\/table>/g) || []
  assert.ok(tables.length > 0)
  for (const t of tables) assert.doesNotMatch(t, /<(input|button|select)\b|role="(radio|switch)/)
})

test('(3) the file problems are the segments\' problems and the documents\' errors[] entries', async () => {
  const { classes, segments } = await read(({ home }) => {
    writeSegment(home, '20260719T100000Z', ['{"not json', '{"also": not json}'])
    fs.writeFileSync(path.join(home, 'classes.json'), '{ broken')
  }, ['classes', 'segments'])
  const nProblems = segments.segments.reduce((s, x) => s + x.problems.length, 0)
  assert.ok(nProblems > 0 && classes.errors.length > 0, 'the fixture produced problems and errors')
  assert.equal(problemCount(segments), nProblems)
  const list = fileProblems(segments, classes)
  const key = (e) => `${e.where}\n${e.reason}`
  assert.deepEqual(new Set(list.map(key)), new Set([...segments.errors, ...classes.errors].map(key)))
  for (const s of segments.segments) if (s.problems.length) assert.ok(list.some((e) => e.where.includes(s.segment)), s.segment)
})

test('(4) the price rows are pricing.models[] and follow the file the board reads; the source line reads pricing.source', async () => {
  const { pricing } = await plain
  assert.deepEqual(priceRows(pricing).map((r) => r.id), pricing.models.map((m) => m.model))
  const file = { 'zz-fixture-model': [1.5, 2.5, 3.5, 4.5], opus: [7, 8, 9, 10] }
  const got = await read(({ home }) => fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify(file)), ['pricing'])
  const doc = got.pricing
  const rows = priceRows(doc)
  assert.deepEqual(rows.map((r) => r.id), doc.models.map((m) => m.model))
  for (const [k, [input, output, write, readc]] of Object.entries(file)) {
    assert.deepEqual(rows.find((r) => r.id === k), { id: k, input, output, write, read: readc })
  }
  assert.notEqual(doc.source, 'default')
  assert.ok(sourceHtml(doc).includes(doc.source))
  assert.ok(!sourceHtml(pricing).includes(doc.source))
})
