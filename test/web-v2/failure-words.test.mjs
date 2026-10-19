// test/web-v2/failure-words.test.mjs — the board words a failure group with the CLI's one table (src/cli/words.mjs
// FAILURE_WORDS + failureBrief), not a twin of its own (one fact, one place). Expected values come from the CLI's table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAILURE_WORDS, failureBrief } from '../../src/cli/words.mjs'
import { failureSentence } from '../../src/web/v2/core/capture-verdict.mjs'

const LABELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'labels')
const group = (where, code) => ({ count: 1, last: { where, code } })

test('every (where, code) the CLI knows renders as the CLI\'s brief', () => {
  for (const k of Object.keys(FAILURE_WORDS)) {
    const i = k.indexOf('/'), g = group(k.slice(0, i), k.slice(i + 1))
    assert.equal(failureSentence(g).text, failureBrief(g), k)
  }
})

test('an unknown pair and an errno code fall back exactly as the CLI does', () => {
  for (const g of [group('engine', 'no-such-code-x'), group('record', 'ECONNRESET'), { count: 2, last: { where: 'zz', code: 'yy', reason: 'r\nr' } }]) {
    assert.equal(failureSentence(g).text, failureBrief(g), JSON.stringify(g))
  }
})

test('no board label table keys a (where, code) pair of the CLI\'s table', async () => {
  const keys = new Set(Object.keys(FAILURE_WORDS)), hits = []
  for (const f of fs.readdirSync(LABELS).filter((n) => n.endsWith('.mjs'))) {
    const mod = await import(pathToFileURL(path.join(LABELS, f)).href)
    for (const [name, v] of Object.entries(mod)) if (v && typeof v === 'object') for (const k of Object.keys(v)) if (keys.has(k)) hits.push(`${f}:${name}.${k}`)
  }
  assert.deepEqual(hits, [])
})
