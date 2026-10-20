// test/cli/status-health.test.mjs — 1.6 附录 C.3 `health` and `failures.groups`, V92: the document carries captureHealth's verdict as one top-level
// field, and the failures fold by level + where + code with the newest record's reason; `status --failures` prints one line per problem group.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureHealth } from '../../src/health/read.mjs'
import { failureBrief } from '../../src/cli/words.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox } from './fixtures/dispatch-ctx.mjs'

const NOW = Date.now()
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString()
const STATES = ['not-running', 'not-responding', 'failing', 'unknown', 'off', 'ok', 'residue', 'not-installed'] // C.3 `health.state`

/** An installed collector with a running daemon whose flows/ holds `recs` after its daemon-start → captureHealth over it. */
function healthOver(recs) {
  const h = tmpDir('trocar-health-'), c = path.join(h, 'collector')
  fs.mkdirSync(path.join(c, 'flows'), { recursive: true })
  fs.writeFileSync(path.join(c, 'install-manifest.json'), JSON.stringify({ version: 3, install: { state: 'complete' }, created_at: at(9999), entries: [], files: [] }))
  fs.writeFileSync(path.join(c, 'lock'), JSON.stringify({ pid: 4242, start_time: '900', boot_id: 'b1' }))
  fs.writeFileSync(path.join(c, 'flows', `${at(0).slice(0, 10)}.ndjson`), [{ ts: at(600), event: 'daemon-start', pid: 4242 }, ...recs].map((r) => JSON.stringify(r) + '\n').join(''))
  return captureHealth({ home: h, now: NOW, alive: () => true, identity: () => ({ start_time: '900', boot_id: 'b1' }) })
}

test('C.3 `health`: status --json carries captureHealth\'s verdict, its state in the closed set, only keys that have a value', async () => {
  for (const recs of [[], [{ ts: at(60), event: 'failure', where: 'engine', code: 'tls-client-error', reason: 'r' }]]) {
    const health = healthOver(recs)
    const doc = (await sandbox().run(['status', '--json'], { deps: { captureHealth: () => health } })).io.json()
    assert.ok(STATES.includes(doc.health.state), JSON.stringify(doc.health))
    assert.equal(doc.health.state, health.summary.state)
    for (const [k, v] of Object.entries(doc.health)) assert.ok(['state', 'since', 'reason', 'signal', 'n', 'read_errors'].includes(k) && v != null, k)
  }
})

test('V92: two failures sharing a code under two `where`s are two groups, each with its newest reason squashed; --failures prints one line per problem group', async () => {
  const health = healthOver([
    { ts: at(300), event: 'failure', where: 'daemon', code: 'start-failed', reason: 'first' },
    { ts: at(200), event: 'failure', where: 'daemon', code: 'start-failed', reason: 'newest\n  of   daemon' },
    { ts: at(100), event: 'failure', where: 'start', code: 'start-failed', reason: 'of start' },
  ])
  const s = sandbox(), deps = { captureHealth: () => health }
  const doc = (await s.run(['status', '--json'], { deps })).io.json()
  const mine = doc.failures.groups.filter((g) => g.code === 'start-failed')
  assert.deepEqual(mine.map((g) => [g.level, g.where, g.count, g.reason]).sort(), [['problem', 'daemon', 2, 'newest of daemon'], ['problem', 'start', 1, 'of start']])
  for (const g of doc.failures.groups) assert.deepEqual(Object.keys(g).filter((k) => !['level', 'where', 'code', 'count', 'first_ts', 'last_ts', 'harness', 'reason'].includes(k)), [])
  const text = (await s.run(['status', '--failures'], { deps })).io.stdoutText()
  const problems = doc.failures.groups.filter((g) => g.level === 'problem')
  for (const g of problems) assert.equal(text.split('\n').filter((l) => l.includes(failureBrief(g))).length, 1, failureBrief(g))
})
