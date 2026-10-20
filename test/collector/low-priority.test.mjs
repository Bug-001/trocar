// test/collector/low-priority.test.mjs — the daemon's children run behind the agents' traffic (RFC 1.6 §3.1: nice ≥ 5).
//
// Why this exists: a macOS test machine's acceptance of 2026-10-20 found the seal worker at nice 0 — its header comment said
// "low priority", and nothing in it ever asked for one. So what is pinned here is the ASKING: one place says what the
// nice is, every child of the daemon that does heavy work calls it, and a real forked child is really at that nice.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NICE, lowerPriority } from '../../src/low-priority.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const src = (p) => fileURLToPath(new URL(`../../src/${p}`, import.meta.url))
// The children the daemon forks for work nobody waits on the agent's behalf: sealing a closed segment, and answering
// a query. Both MUST ask, and both MUST ask for the same thing (0.1 §2: one external fact, one place).
const CHILDREN = ['collector/seal-worker.mjs', 'query/worker.mjs']

test('nice ≥ 5 is asked for in one place, and both children of the daemon ask through it', () => {
  // The MEANING, not a number copied out of the source: "below normal on this OS". A literal 5 passed this very
  // assertion while lowering nothing on Windows — libuv maps nice to Windows priority classes in bands and
  // BELOW_NORMAL begins at 10, so nice 5 landed on NORMAL (Windows test machine, 2026-10-19).
  assert.equal(NICE, os.constants.priority.PRIORITY_BELOW_NORMAL, 'the one nice is node\'s own "below normal", on every platform')
  assert.ok(NICE >= 5, `1.6 §3.1 asks for nice ≥ 5 (this says ${NICE})`)
  for (const f of CHILDREN) {
    const text = fs.readFileSync(src(f), 'utf8')
    assert.match(text, /lowerPriority\(/, `${f} must ask for the lower priority`)
    assert.doesNotMatch(text, /setPriority\(/, `${f} must ask through src/low-priority.mjs, not with a nice of its own`)
  }
})

test('an OS that refuses to lower this process says so and goes on at its parent\'s priority — never throws', () => {
  const said = []
  const refusing = { setPriority: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }, getPriority: () => 0 }
  assert.equal(lowerPriority({ os: refusing, say: (m) => said.push(m) }), null)
  assert.equal(said.length, 1)
  assert.match(said[0], new RegExp(`nice ${NICE}`))
  // and the asking itself: this process's own nice, through the real os
  const asked = []
  assert.equal(lowerPriority({ os: { setPriority: (pid, n) => asked.push([pid, n]), getPriority: () => NICE }, say: () => {} }), NICE)
  assert.deepEqual(asked, [[0, NICE]], 'this process (0), at the one nice')
})

// The real thing on this OS, not the seam: a child forked exactly as the daemon forks it is at the nice while it runs.
// The query worker is the one that stays alive by itself (it waits for a request), so it is the one that can be read.
test('a real forked child runs at the nice it asked for', async (t) => {
  const home = path.join(tmpDir('trocar-nice-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const child = fork(src('query/worker.mjs'), [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, TROCAR_QUERY_IDLE_MS: '4000' } })
  t.after(() => { try { child.kill() } catch { /* already gone */ } })
  // it is at its nice before it answers anything: the first line of the child asks, and this read waits for the
  // child to have loaded (its first reply is proof it is past that line)
  child.stdin.write(`${JSON.stringify({ name: 'segments', params: {}, indent: 0 })}\n`)
  await new Promise((done, fail) => { child.stdout.once('data', done); child.once('exit', (c) => fail(new Error(`the worker exited with ${c}`))) })
  assert.ok(os.getPriority(child.pid) >= os.constants.priority.PRIORITY_BELOW_NORMAL,
    `the child is at nice ${os.getPriority(child.pid)}, which is not at or below ${os.constants.priority.PRIORITY_BELOW_NORMAL} ("below normal" on this OS)`)
})
