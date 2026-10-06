// test/capture/keep-cli.test.mjs — `asight keep` (RFC 4.6 §记录「保存级别」·修改, acceptance K5, D40): show the table, set cells, expand
// `all`, refuse a name outside the closed sets with exit 2 and the file untouched, and work with no daemon at all. The last test
// runs the real CLI in a child process over a throwaway HOME: that is the wiring, not just the function.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runKeep, formatKeep } from '../../src/capture/keep.mjs'
import { retentionHarnessIds } from '../../src/dissect/traffic.mjs'
import { TRAFFIC_CLASSES } from '../../src/capture/retention.mjs'
import { retentionFile, retentionLog } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/asight.mjs')
const HARNESSES = retentionHarnessIds()
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
function rig() {
  const home = tmpDir('asight-keep-'); const file = retentionFile(home), logFile = retentionLog(home); const out = [], err = []
  return { home, file, logFile, out, err, run: (argv) => runKeep(argv, { out: (s) => out.push(s), err: (s) => err.push(s), file, logFile, harnesses: HARNESSES }) }
}

test('K5 `asight keep cc telemetry log`: the file is 0600 and gains only that cell; the change log gains one line; no daemon was needed', () => {
  const k = rig()
  assert.equal(k.run(['cc', 'telemetry', 'log']), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(k.file, 'utf8')).levels, { cc: { telemetry: 'log' } })
  assert.equal(fs.statSync(k.file).mode & 0o777, 0o600)
  const rows = fs.readFileSync(k.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rows.map(({ ts, ...r }) => r), [{ event: 'retention-set', harness: 'cc', class: 'telemetry', from: 'full', to: 'log', source: 'cli' }])
  assert.match(k.out.join('\n'), /cc · telemetry: full → log/); assert.match(k.out.join('\n'), /already stored is not changed/)
  assert.equal(k.run(['cc', 'telemetry', 'log']), 0); assert.match(k.out.at(-1), /no change/); assert.equal(fs.readFileSync(k.logFile, 'utf8').trim().split('\n').length, 1, 'a no-op writes no line')
})

test('K5 `asight keep all telemetry log` expands to one cell per harness (the table\'s seven and `unknown`); `all` for the class too', () => {
  const k = rig()
  assert.equal(k.run(['all', 'telemetry', 'log']), 0)
  const levels = JSON.parse(fs.readFileSync(k.file, 'utf8')).levels
  assert.deepEqual(Object.keys(levels), HARNESSES); assert.ok(Object.values(levels).every((r) => r.telemetry === 'log' && Object.keys(r).length === 1))
  assert.equal(fs.readFileSync(k.logFile, 'utf8').trim().split('\n').length, HARNESSES.length)
  assert.equal(k.run(['dsh', 'all', 'log']), 0)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(k.file, 'utf8')).levels.dsh).sort(), [...TRAFFIC_CLASSES].sort())
})

test('K5 an unknown harness, class or level: exit 2, the usage on stderr, the file and the log byte-identical', () => {
  const k = rig()
  k.run(['cc', 'files', 'log'])
  const before = [sha(k.file), sha(k.logFile)]
  for (const argv of [['nope', 'files', 'log'], ['cc', 'nope', 'log'], ['cc', 'files', 'half'], ['cc', 'files'], ['cc', 'files', 'log', 'extra'], ['all', 'all', 'LOG']]) {
    k.err.length = 0
    assert.equal(k.run(argv), 2, argv.join(' ')); assert.match(k.err.join('\n'), /usage:/)
    assert.deepEqual([sha(k.file), sha(k.logFile)], before, `${argv.join(' ')}: nothing was written`)
  }
})

test('keep with no arguments shows every harness × class; a setting shows as log; a file it cannot parse is said, with everything shown as full, and `keep` refuses to set over it', () => {
  const k = rig()
  k.run(['codex', 'files', 'log']); k.out.length = 0
  assert.equal(k.run([]), 0)
  const table = k.out.join('\n'); const rows = Object.fromEntries(table.split('\n').filter((l) => HARNESSES.some((h) => l.startsWith(`${h} `))).map((l) => [l.split(/\s+/)[0], l.split(/\s+/).slice(1)]))
  assert.deepEqual(Object.keys(rows), HARNESSES); assert.deepEqual(rows.codex, ['full', 'full', 'full', 'full', 'log', 'full', 'full']); assert.ok(rows.cc.every((v) => v === 'full'))
  assert.match(table, /never deleted or rewritten/)
  fs.writeFileSync(k.file, '{ torn'); k.out.length = 0; k.err.length = 0
  assert.equal(k.run([]), 0); const torn = k.out.join('\n')
  assert.match(torn, /⚠ .*cannot be parsed.*kept in full/)
  assert.ok(torn.split('\n').filter((l) => HARNESSES.some((h) => l.startsWith(`${h} `))).every((l) => l.split(/\s+/).slice(1).every((v) => v === 'full')), 'every cell reads full')
  assert.equal(k.run(['cc', 'files', 'log']), 1); assert.match(k.err.join('\n'), /cannot be parsed/); assert.equal(fs.readFileSync(k.file, 'utf8'), '{ torn')
  assert.match(formatKeep({ levels: {}, file: '/x', harnesses: ['cc'] }), /^what is kept of each call · \/x\n\nharness/)
})

test('the real CLI: `asight keep` in a child process over a throwaway HOME, exit codes included (no daemon, no collector dir)', () => {
  const home = tmpDir('asight-keep-home-')
  const run = (...a) => spawnSync(process.execPath, [BIN, 'keep', ...a], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  let r = run('cc', 'telemetry', 'log')
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /cc · telemetry: full → log/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.asight', 'retention.json'), 'utf8')).levels, { cc: { telemetry: 'log' } })
  assert.equal(fs.statSync(path.join(home, '.asight', 'retention.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(home, '.asight', 'logs', 'retention.ndjson')).mode & 0o777, 0o600)
  r = run(); assert.equal(r.status, 0); assert.match(r.stdout, /cc\s+full\s+full\s+full\s+log\s/)
  const before = sha(path.join(home, '.asight', 'retention.json'))
  r = run('cc', 'bogus', 'log'); assert.equal(r.status, 2); assert.match(r.stderr, /unknown class/); assert.equal(sha(path.join(home, '.asight', 'retention.json')), before)
  assert.ok(!fs.existsSync(path.join(home, '.asight', 'collector')), 'it did not need the collector')
})
