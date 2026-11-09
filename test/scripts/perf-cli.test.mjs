// test/scripts/perf-cli.test.mjs — scripts/perf-cli.mjs refuses an --only name it does not measure, before any work,
// and names what it does measure: every named read the 1.6 §4.1 budget covers, including `calls` in its list forms.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/perf-cli.mjs', import.meta.url))

test('perf-cli: an unknown --only name is an error that names it and lists the known ones', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--home', tmpDir('trocar-perf-'), '--only', 'sessions,nope'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /\bnope\b/)
  const known = /known: ([^)]*)\)/.exec(r.stderr)[1].split(', ')
  for (const n of ['sessions', 'traffic', 'overview', 'calls-class', 'calls-host', 'calls-ref']) assert.ok(known.includes(n), n)
})
