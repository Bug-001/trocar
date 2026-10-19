// test/cli/status-health.test.mjs — 1.6 附录 C.3 `health` and `failures.groups`, V92: the document carries captureHealth's verdict as one top-level
// field, and the failures fold by level + where + code with the newest record's reason; `status --failures` prints one line per problem group.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureHealth } from '../../src/health/read.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sandbox } from './fixtures/dispatch-ctx.mjs'

const NOW = Date.now()
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString()
const STATES = ['not-running', 'not-responding', 'failing', 'unknown', 'off', 'ok', 'residue', 'not-installed'] // C.3 `health.state`

/** An installed collector with a running daemon whose flows/ holds `recs` after its daemon-start → captureHealth over it. */
function healthOver(recs) {
  const h = tmpDir('asight-health-'), c = path.join(h, 'collector')
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
