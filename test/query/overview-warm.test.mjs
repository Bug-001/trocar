// test/query/overview-warm.test.mjs — `overview` before `calls` in one process does not change what `calls` answers
// (RFC 3.5 §访问模式: a cache hit and a miss give the same document; V80). The usage fill of `overview` reads records the
// read-back cache could hand to a later `calls --ref`; whatever it derives from them must never land in that document.
// Cold and warm are isolated by distinct homes (the read-back cache is keyed by home) holding the same bytes (big-session.mjs
// is deterministic per seed), so the cold document is an independent expected value.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'

const homeOf = (wire) => {
  const home = path.join(tmpDir('trocar-ovwarm-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  bigSession({ home, wire, growth: 400, subEvery: 3 }).append(12)
  return home
}

for (const wire of ['http', 'threads', 'ws', 'chat'])
test(`3.5:41 / V80: a ${wire} call's \`calls\` document is the same after \`overview\` filled usage in the same process`, async () => {
  const cold = homeOf(wire), warm = homeOf(wire)
  const list = await runQuery('calls', { class: 'llm' }, { home: cold })
  assert.ok(list.records.length > 1, 'the session has calls')
  const ref = list.records[Math.floor(list.records.length / 2)].ref
  const one = await runQuery('calls', { ref }, { home: cold })
  await runQuery('overview', {}, { home: warm })
  assert.deepStrictEqual(await runQuery('calls', { ref }, { home: warm }), one)
  assert.deepStrictEqual(await runQuery('calls', { class: 'llm' }, { home: warm }), list)
})
