// test/query/pricing-unreadable.test.mjs — a price file that does not read (RFC 3.5 §访问模式「价表读不出不静默」, #54; D38): `pricing`,
// `analysis` and `overview` answer from the built-in table and say so in `errors`; one bad row in a good file stays that row's own matter.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { PRICING_PROBLEMS } from '../../src/health/codes.mjs'

const ID = 'price-000-4a1b-9c2d-000000000001'
const write = (text) => (file) => fs.writeFileSync(file, text)
const UNREADABLE = {
  'not JSON': write('{"opus": [1, 2,'),
  'a number': write('42'),
  null: write('null'),
  'a string': write('"opus"'),
  'an array': write('[[1, 2, 3, 4]]'),
  'a directory': (file) => fs.mkdirSync(file),
}

/** The three documents, each with what it says about prices. */
async function read(home, file) {
  const ctx = { home, fs, env: { TROCAR_PRICING: file } }
  const pricing = await runQuery('pricing', {}, ctx), analysis = await runQuery('analysis', { id: ID }, ctx), overview = await runQuery('overview', {}, ctx)
  const unknown = await runQuery('analysis', { id: 'no-such-session' }, ctx)
  return { docs: { pricing, analysis, overview, unknown },
    answers: { pricing: [pricing.source, pricing.models], analysis: [analysis.pricing, analysis.totals, analysis.usd], overview: overview.usage } }
}

test('#54 an unreadable price file: the built-in table answers and errors says so; a bad row alone stays out of errors', async (t) => {
  const home = path.join(tmpDir('trocar-price-'), '.trocar'), dir = tmpDir('trocar-price-file-')
  bigSession({ home, id: ID, growth: 200 }).append(4)
  const builtin = await read(home, path.join(dir, 'absent.json'))
  assert.equal(builtin.docs.pricing.source, 'default')
  for (const name of ['pricing', 'analysis', 'overview']) assert.deepEqual(builtin.docs[name].errors, [], `${name}: no price file is no problem`)

  for (const [shape, make] of Object.entries(UNREADABLE)) {
    await t.test(shape, async () => {
      const file = path.join(tmpDir('trocar-price-bad-'), 'pricing.json')
      make(file)
      const { docs, answers } = await read(home, file)
      for (const [name, doc] of Object.entries(docs)) {
        const said = doc.errors.filter((e) => PRICING_PROBLEMS.includes(e.code))
        assert.equal(said.length, 1, `${name}: one entry says the table did not read`)
        assert.equal(said[0].where, 'pricing', name)
        assert.equal(doc.ok, false, name)
      }
      assert.deepEqual(answers, builtin.answers)
    })
  }

  await t.test('one good row, one bad row', async () => {
    const file = path.join(dir, 'rows.json')
    fs.writeFileSync(file, JSON.stringify({ opus: [1, 2, 3, 4], sonnet: [1, 2] }))
    const { docs } = await read(home, file)
    for (const name of ['pricing', 'analysis', 'overview']) assert.deepEqual(docs[name].errors, [], name)
    const row = (doc, model) => doc.models.find((m) => m.model === model)
    const { input, output, cache_write, cache_read } = row(docs.pricing, 'opus')
    assert.equal(docs.pricing.source, file)
    assert.deepEqual([input, output, cache_write, cache_read], [1, 2, 3, 4])
    assert.deepEqual(row(docs.pricing, 'sonnet'), row(builtin.docs.pricing, 'sonnet'))
  })
})
