// test/web-v2/failure-words.test.mjs — the board words a failure group with the CLI's one table (src/cli/words.mjs
// FAILURE_WORDS + failureBrief), not a twin of its own (one fact, one place). Expected values come from the CLI's table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAILURE_WORDS } from '../../src/cli/words.mjs'

const LABELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'labels')

test('no board label table keys a (where, code) pair of the CLI\'s table', async () => {
  const keys = new Set(Object.keys(FAILURE_WORDS)), hits = []
  for (const f of fs.readdirSync(LABELS).filter((n) => n.endsWith('.mjs'))) {
    const mod = await import(pathToFileURL(path.join(LABELS, f)).href)
    for (const [name, v] of Object.entries(mod)) if (v && typeof v === 'object') for (const k of Object.keys(v)) if (keys.has(k)) hits.push(`${f}:${name}.${k}`)
  }
  assert.deepEqual(hits, [])
})
