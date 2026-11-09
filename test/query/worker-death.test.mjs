// test/query/worker-death.test.mjs — a query worker that dies is recorded with the cause it died of (D38; 4.6 §事件与码 `query-failed`): a fatal
// line V8 printed wins over a handled failure the worker reported earlier, however much output came between; a death that printed no fatal
// line says so and borrows no other line; an error it threw and did not handle is still its cause. The record's `detail` carries the last
// lines of its stderr for the daemon's log. The workers here are stand-ins that answer the warm-up and die on the next request, as
// query-service.test.mjs's do.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createQueryService } from '../../src/query/service.mjs'
import { rawHome } from './raw-home.mjs'
import { recorder } from './hand-world.mjs'

const HANDLED = 'trocar query worker: background work failed: Error: the heap holds no room for this session (256 MB budget)\n    at advance (session.mjs:517:40)\n'
const NOISE = '<--- Last few GCs --->\n' + '[123:0x1]  1000 ms: Mark-Compact 380.1 (390.2) -> 379.9 (390.2) MB, 900.1 / 0.0 ms  (average mu = 0.1) allocation failure\n'.repeat(60)
const FATAL = 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n'
const NATIVE = '----- Native stack trace -----\n' + ' 1: 0x10001 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/usr/local/bin/node]\n'.repeat(40)
// a stand-in worker: answers one query, then on the next writes `err` to stderr and ends as `end` says
const dying = (err, end) => () => spawn(process.execPath, ['-e', `let n = 0
process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) {
  if (++n > 1) { process.stderr.write(${JSON.stringify(err)}, () => { ${end} }); return }
  const b = Buffer.from(JSON.stringify({ segments: [] })); process.stdout.write(\`200 \${b.length} - 0 -\\n\`); process.stdout.write(b)
} })`], { stdio: ['pipe', 'pipe', 'pipe'] })

async function death(err, end) {
  const said = []
  const svc = createQueryService({ home: rawHome('trocar-death-'), failure: (where, e) => said.push(e), fork: dying(err, end) })
  try {
    const cold = recorder() // no worker yet: 503, and the warm-up is the stand-in's one answer
    await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: cold })
    assert.equal(cold.status, 503)
    await assert.rejects(svc.route({ query: new URLSearchParams({ name: 'segments' }), res: recorder() }), /query worker/)
  } finally { svc.stop() }
  assert.equal(said.length, 1)
  assert.equal(said[0].code, 'query-failed')
  return said[0]
}
// how V8 ends a process (SIGABRT on POSIX); an exit code here, so the same test holds where a process cannot signal itself (Windows)
const abort = 'process.exit(134)'

test('D38: a heap OOM after a handled no-room is recorded as the OOM, whatever came between, and its last stderr lines go with it', async () => {
  const e = await death(HANDLED + NOISE + FATAL + NATIVE, abort)
  assert.match(e.message, /\(code 134\): FATAL ERROR: Ineffective mark-compacts near heap limit/)
  assert.doesNotMatch(e.message, /no room/)
  assert.ok(Array.isArray(e.detail) && e.detail.length === 40, 'the last 40 lines')
  assert.match(e.detail.at(-1), /OOMErrorHandler/, 'they end where its stderr ended')
})

test('D38: a death that printed no fatal line says so and borrows no handled line', async () => {
  const e = await death(HANDLED + NOISE.split('\n').slice(0, 10).join('\n') + '\n', abort)
  assert.match(e.message, /\(code 134\); no fatal message was captured/)
  assert.doesNotMatch(e.message, /no room/)
  assert.match(e.detail.join('\n'), /no room/, 'the handled line is in the log lines, as what it was')
})

test('D38: an error the worker threw and did not handle is its cause, with its first frame', async () => {
  const e = await death(HANDLED + 'file:///x/worker.mjs:3\nthrow new Error(\'boom\')\n^\n\nError: boom\n    at serve (file:///x/worker.mjs:3:7) {\n  [cause]: Error: inner\n      at read (file:///x/a.mjs:1:1)\n}\n', 'process.exit(1)')
  assert.match(e.message, /\(code 1\): Error: boom · at serve/, 'the error thrown, not its cause')
})

test('D38: a V8 check failure is recorded by its Check failed line, not the banner above it', async () => {
  const e = await death('\n#\n# Fatal error in , line 0\n# Check failed: !IsDone().\n#\n#\n#\n#FailureMessage Object: 0x16f\n', abort)
  assert.match(e.message, /\(code 134\): # Check failed: !IsDone\(\)\./)
})
