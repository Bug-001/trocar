// test/web-v2/failure-words.test.mjs — every failure code trocar's writers can put into a log has a sentence in the one catalog (src/cli/words.mjs
// FAILURE_WORDS + statusReason, via failureBrief), so no face shows a raw code (D58②); and the board keeps no twin of that catalog (0.1 §2).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAILURE_WORDS, briefText, failureBrief, failureWord } from '../../src/cli/words.mjs'
import * as C from '../../src/health/codes.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LABELS = path.join(ROOT, 'src', 'web', 'v2', 'labels')
const PART_WHERE = { trust: 'tracker' } // a trust reason is the code of an agent-untrusted line the tracker writes

// every (where, code) a writer can produce, from the closed sets (test/health/codes.test.mjs holds the writers to them)
function producerPairs() {
  const { doctor, legacy, note, ...parts } = C.CODES_BY_PART // doctor's findings and legacy names are no failure-log record; `ok` is a success
  return [
    ...Object.entries(parts).flatMap(([part, codes]) => codes.map((c) => [PART_WHERE[part] || part, c])),
    ...C.ROUTE_FAILURE_CODES.map((c) => [null, c]),
    ...C.NET_FAILURE_CODES.map((c) => ['netenv', c]),
    ...C.NOT_CAPTURED_FAILURE.map((c) => ['flow', c]), // a connection row's group (src/cli/status.mjs failuresOf)
    ...[...C.NOT_CAPTURED_EXPECTED, ...Object.values(C.NOT_CAPTURED_BY_DESIGN).flat()].map((c) => ['flow', c]), // an expected group (status.mjs, keyed by expectedKey): the board's foot and `--failures`' Expected
    ...C.FAILURE_EVENTS.map((e) => [e, e]), // a failure event with no code: the group's where and code are the event
    ...C.RAW_JOURNAL_FAILURES.map((c) => ['raw', c]),
    ...C.SEGMENT_PROBLEMS.map((c) => ['raw', c]),
  ]
}

test('every producer code reads as a sentence: failureBrief is the catalog word, never the code or the raw reason', () => {
  const bare = []
  for (const [where, code] of producerPairs()) {
    const w = failureWord(where, code)
    if (!w || failureBrief({ where, code, reason: 'RAW-REASON' }) !== w) bare.push(`${where}/${code}`)
  }
  assert.deepEqual(bare, [])
})

test('a reason cut to its head stays ASCII and within the width (1.6 §1.1 ⑦: the old Windows console prints no other symbol)', () => {
  const t = briefText('x'.repeat(300), 100)
  assert.ok(/^[\x20-\x7e]*$/.test(t) && t.length <= 100, t)
})

test('an unknown code is never hidden: it falls back to where/code with the reason', () => {
  assert.equal(failureBrief({ where: 'engine', code: 'no-such-code', reason: 'why' }), 'engine/no-such-code why')
  assert.equal(failureBrief({ where: 'engine', code: 'EPERM', reason: 'chmod' }), 'EPERM chmod')
})

test('the raw layer\'s producers write only the closed outcomes and problem codes', () => {
  const seal = fs.readFileSync(path.join(ROOT, 'src/raw/seal.mjs'), 'utf8')
  const outcomes = [...seal.matchAll(/outcome: ([^,]+),/g)].flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]))
  assert.ok(outcomes.length > 0)
  for (const o of outcomes) assert.ok(o === 'ok' || C.RAW_JOURNAL_FAILURES.includes(o), o)
  const idx = fs.readFileSync(path.join(ROOT, 'src/query/index-build.mjs'), 'utf8')
  const codes = [...idx.matchAll(/problems\.push\(\{ code: '([a-z-]+)'/g)].map((m) => m[1])
  assert.ok(codes.length > 0)
  for (const c of codes) assert.ok(C.SEGMENT_PROBLEMS.includes(c), c)
})

test('no board label table keys a code the CLI\'s catalog words', async () => {
  const keys = new Set(Object.keys(FAILURE_WORDS)), hits = [] // a sentence twin: a string under a key of the catalog
  for (const f of fs.readdirSync(LABELS).filter((n) => n.endsWith('.mjs'))) {
    const mod = await import(pathToFileURL(path.join(LABELS, f)).href)
    for (const [name, v] of Object.entries(mod)) if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string' && keys.has(k)) hits.push(`${f}:${name}.${k}`)
  }
  assert.deepEqual(hits, [])
})
