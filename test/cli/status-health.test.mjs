// test/cli/status-health.test.mjs — 1.6 附录 C.3 `health` and `failures.groups`, V92: the document carries captureHealth's verdict as one top-level
// field, and the failures fold by level + where + code with the newest record's reason; `status --failures` prints one line per problem group.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureHealth } from '../../src/health/read.mjs'
import { HARNESS_IDS } from '../../src/off/harness-names.mjs'
import { failureBrief } from '../../src/cli/words.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
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
  return captureHealth({ harnesses: HARNESS_IDS, home: h, now: NOW, alive: () => true, identity: () => ({ start_time: '900', boot_id: 'b1' }) })
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
  for (const g of doc.failures.groups) assert.deepEqual(Object.keys(g).filter((k) => !['level', 'where', 'code', 'count', 'first_ts', 'last_ts', 'harness', 'process', 'pid', 'reason'].includes(k)), [])
  const text = (await s.run(['status', '--failures'], { deps })).io.stdoutText()
  const problems = doc.failures.groups.filter((g) => g.level === 'problem')
  for (const g of problems) assert.equal(text.split('\n').filter((l) => l.includes(failureBrief(g))).length, 1, failureBrief(g))
})

test('V102: a failure names its harness whether the record says `agent` or `harness`: the agents row and the status group both name codex', async () => {
  const health = healthOver([
    { ts: at(200), event: 'failure', where: 'engine', code: 'trust-rejected', harness: 'codex', reason: 'r' },
    { ts: at(100), event: 'failure', where: 'engine', code: 'leaf-error', agent: 'codex', reason: 'r' },
  ])
  const row = health.collector.agents.find((a) => a.agent === 'codex')
  assert.equal(typeof (row && row.last_failure), 'string')
  const doc = (await sandbox().run(['status', '--json'], { deps: { captureHealth: () => health } })).io.json()
  const mine = doc.failures.groups.filter((g) => ['trust-rejected', 'leaf-error'].includes(g.code))
  assert.ok(mine.some((g) => g.code === 'trust-rejected') && mine.some((g) => g.code === 'leaf-error'))
  for (const g of mine) assert.equal(g.harness, 'codex', `${g.level} ${g.code}`)
})

test('C.3 · a failure group whose newest record names its process carries process + pid, and --failures and failureBrief name that program; a group whose newest does not carries neither', async () => {
  const health = healthOver([
    { ts: at(300), event: 'failure', where: 'ingress', code: 'ingress-unknown', peer: { address: '127.0.0.1', port: 50001 }, pid: 11, process: 'older-tool', reason: 'an HTTP request that is not CONNECT (HEAD)' },
    { ts: at(200), event: 'failure', where: 'ingress', code: 'ingress-unknown', peer: { address: '127.0.0.1', port: 50002 }, pid: 4321, process: 'codex', method: 'HEAD', host: 'probe.example', reason: 'an HTTP request that is not CONNECT (HEAD)' },
    { ts: at(100), event: 'failure', where: 'engine', code: 'leaf-error', reason: 'r' },
  ])
  const s = sandbox(), deps = { captureHealth: () => health }
  const doc = (await s.run(['status', '--json'], { deps })).io.json()
  const g = doc.failures.groups.find((x) => x.code === 'ingress-unknown')
  assert.deepEqual([g.count, g.process, g.pid], [2, 'codex', 4321])
  const plain = doc.failures.groups.find((x) => x.code === 'leaf-error')
  assert.equal('process' in plain || 'pid' in plain, false)
  assert.ok(failureBrief(g).includes('codex') && failureBrief(g).includes('4321'), failureBrief(g))
  assert.equal(failureBrief(plain).includes('pid'), false)
  const one = (t) => t.replace(/\s+/g, ' ') // a row folds inside 80 columns
  assert.ok(one((await s.run(['status', '--failures'], { deps })).io.stdoutText()).includes(one(failureBrief(g))), 'the --failures row carries the sentence that names the program')
})

test('4.6 F9: a capture health that cannot be read is no `health`, an `errors` entry with the reason, and exit 3 — never empty, never "0 failures"', async () => {
  const h = tmpDir('trocar-health-'), c = path.join(h, 'collector')
  fs.mkdirSync(c, { recursive: true })
  fs.writeFileSync(path.join(c, 'install-manifest.json'), JSON.stringify({ version: 3, install: { state: 'complete' }, created_at: at(9999), entries: [], files: [] }))
  fs.writeFileSync(path.join(c, 'flows'), 'x') // flows/ is not a directory: captureHealth throws
  const r = await sandbox().run(['status', '--json'], { deps: { captureHealth: () => captureHealth({ harnesses: HARNESS_IDS, home: h, now: NOW, alive: () => true, identity: () => ({}) }) } })
  const doc = r.io.json()
  assert.equal('health' in doc, false, 'no verdict is made up')
  const e = doc.errors.find((x) => x.where === 'capture health')
  assert.ok(e && typeof e.reason === 'string' && e.reason.length > 0, JSON.stringify(doc.errors))
  assert.equal(r.exit, EXIT.unknown)
})

// C.3 `failures`: the three counts are one unit (each level's groups' counts summed — a standing condition is one record) and `since` is the window's start
test('C.3 failures: each count is the sum of its level\'s group counts, a resolved group included; since is the start of the 24 h window', async () => {
  const health = healthOver([
    { ts: at(500), event: 'helper-down', reason: 'not found' },
    { ts: at(400), event: 'failure', where: 'helper', code: 'helper-error', reason: 'a' },
    { ts: at(390), event: 'failure', where: 'helper', code: 'helper-error', reason: 'b' },
    { ts: at(300), event: 'failure', where: 'engine', code: 'tls-client-error', reason: 'c' },
  ])
  const doc = (await sandbox().run(['status', '--json'], { deps: { captureHealth: () => health } })).io.json()
  const f = doc.failures
  for (const level of ['problem', 'note']) assert.equal(f[level], f.groups.filter((g) => g.level === level).reduce((n, g) => n + g.count, 0), `${level}: ${JSON.stringify(f)}`)
  assert.ok(f.note >= 1, 'the helper-down condition is a note group')
  assert.equal(Date.parse(f.since), Date.parse(health.generated_at) - 24 * 3600e3)
})
