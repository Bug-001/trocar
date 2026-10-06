// test/ci/count-tests.test.mjs — scripts/count-tests.mjs, what CI's `counts-agree` job runs: a Node version that ran fewer
// tests than another on the same OS is a failure, and so is a version that reported nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseCounts, compareCounts } from '../../scripts/count-tests.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/count-tests.mjs', import.meta.url))
const TAP = '# Subtest: x\nok 1 - x\n1..1\n# tests 1940\n# suites 0\n# pass 1807\n# fail 0\n# cancelled 0\n# skipped 133\n# todo 0\n# duration_ms 24658.1\n'
const SPEC = 'ℹ tests 1940\nℹ suites 0\nℹ pass 1807\nℹ fail 0\nℹ cancelled 0\nℹ skipped 133\nℹ todo 0\nℹ duration_ms 24658.1\n'
const e = (o, node, tests, extra = {}) => ({ os: o, node, tests, pass: tests, fail: 0, skipped: 0, ...extra })

test('count-tests: the TAP and spec summaries both parse, and the last summary wins', () => {
  const want = { tests: 1940, pass: 1807, fail: 0, cancelled: 0, skipped: 133, todo: 0 }
  assert.deepEqual(parseCounts(TAP), want)
  assert.deepEqual(parseCounts(SPEC), want)
  assert.equal(parseCounts('# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' + TAP).tests, 1940)
})

test('count-tests: output with no summary is an error, not a zero (a run that died must not look like a count)', () => {
  assert.throws(() => parseCounts('TAP version 13\nok 1 - a\n'), /no "tests" summary line/)
})

test('count-tests: the same count on both Node versions of each OS passes; one version short fails and names the OS and both counts', () => {
  const same = compareCounts([e('ubuntu-latest', '20', 1940), e('ubuntu-latest', '22', 1940), e('macos-latest', '20', 1938), e('macos-latest', '22', 1938)])
  assert.equal(same.ok, true)
  assert.equal(same.lines.length, 2)
  const short = compareCounts([e('ubuntu-latest', '20', 1903), e('ubuntu-latest', '22', 1940), e('macos-latest', '20', 1938), e('macos-latest', '22', 1938)])
  assert.equal(short.ok, false)
  assert.deepEqual(short.problems, ['ubuntu-latest: Node 20 ran 1903, Node 22 ran 1940 tests — a run is dropping results'])
})

test('count-tests: skips and passes may differ between versions (only the number of tests run must agree); a lone or missing version fails', () => {
  assert.equal(compareCounts([e('o', '20', 10, { pass: 9, skipped: 1 }), e('o', '22', 10, { pass: 10 })]).ok, true)
  assert.match(compareCounts([e('o', '20', 10)]).problems[0], /only Node 20 reported a count/)
  assert.deepEqual(compareCounts([]).problems, ['no counts to compare'])
})

test('count-tests: the CLI — read writes the JSON line, compare exits 1 on a mismatch and 0 on agreement', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-counts-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'test.log')
  fs.writeFileSync(log, TAP)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } })
  const read = run('read', log, 'ubuntu-latest', '20')
  assert.equal(read.status, 0)
  assert.deepEqual(JSON.parse(read.stdout), { os: 'ubuntu-latest', node: '20', tests: 1940, pass: 1807, fail: 0, cancelled: 0, skipped: 133, todo: 0 })
  const counts = path.join(dir, 'counts')
  fs.mkdirSync(counts)
  fs.writeFileSync(path.join(counts, 'a.json'), read.stdout)
  fs.writeFileSync(path.join(counts, 'b.json'), JSON.stringify({ ...JSON.parse(read.stdout), node: '22' }))
  assert.equal(run('compare', counts).status, 0)
  fs.writeFileSync(path.join(counts, 'b.json'), JSON.stringify({ ...JSON.parse(read.stdout), node: '22', tests: 1938 }))
  const bad = run('compare', counts)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /MISMATCH ubuntu-latest: Node 20 ran 1940, Node 22 ran 1938 tests/)
  // a job whose `read` died leaves an empty file (the shell redirect made it): the compare says so by name, and fails
  fs.writeFileSync(path.join(counts, 'b.json'), '')
  const empty = run('compare', counts)
  assert.equal(empty.status, 1)
  assert.match(empty.stdout, /MISMATCH b\.json: no usable count .* that job reported nothing/)
  assert.match(empty.stdout, /only Node 20 reported a count/, 'and what is left of the OS is not compared as if it were whole')
  assert.equal(run('compare').status, 2)
})
