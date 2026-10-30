// worker-killed-write.test.mjs — a query handed to a worker the OS just killed (SIGKILL, the heap OOM of 2026-10-21) fails that
// query with a recorded reason; it never takes the server process down. Found by the sequence soak (seed 101, a worker kill at step
// 23): service.mjs run() writes the query line to the dead worker's stdin before its 'close' arrives, and start() puts no 'error'
// listener on c.stdin, so the EPIPE is an uncaught exception in the board server. The scenario runs in a child process, so an
// uncaught exception there is its exit code, not a crash of this test file. Still open in the query service.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { within } from '../helpers/bounded.mjs'

const SERVICE = fileURLToPath(new URL('../../src/query/service.mjs', import.meta.url))

// The child: a stub worker that answers every line with an empty document. Warm it, SIGKILL it and block the event loop until it is
// dead, so the service has not seen its 'close' yet (the soak's window, made certain), then relay the next query. Prints one JSON
// line {failed, recorded}; an uncaught exception exits non-zero.
const SCENARIO = `
import { spawn } from 'node:child_process'
const { createQueryService } = await import(process.argv[1])
const stub = () => spawn(process.execPath, ['-e', "process.stdin.on('data', (d) => { for (const l of String(d).split('\\\\n').filter(Boolean)) process.stdout.write('200 2\\\\n{}') })"], { stdio: ['pipe', 'pipe', 'pipe'] })
const sink = () => ({ writeHead() {}, write: () => true, end() {}, once() {}, on() {}, destroy() {} })
const recorded = []
let kid
const svc = createQueryService({ home: process.cwd(), deadlineMs: 600000, say: () => {}, failure: (where, e) => recorded.push(e.code + ' ' + e.message), fork: () => (kid = stub()) })
await svc.relay({ name: 'segments', res: sink() })
kid.kill('SIGKILL')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
const failed = await svc.relay({ name: 'segments', res: sink() }).then(() => null, (e) => e.message)
console.log(JSON.stringify({ failed, recorded }))
svc.stop()
`

test('a query written to a worker that was just killed fails with a recorded reason; the process survives', async () => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', SCENARIO, SERVICE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  const [code] = await within(new Promise((ok) => c.on('close', (...a) => ok(a))), 20000, 'the scenario process', () => c.kill('SIGKILL'))
  assert.equal(code, 0, `the process died: ${err.split('\n').slice(0, 4).join(' / ')}`)
  const r = JSON.parse(out.trim().split('\n').pop())
  assert.equal(typeof r.failed, 'string', 'the query is failed, not answered (the 600 s deadline would outlast within())')
  assert.ok(r.recorded.some((x) => x.startsWith('query-failed ')), 'the failure is recorded (D38)')
})
