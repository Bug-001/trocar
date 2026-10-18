// test/off/daemon-read.test.mjs — the contracts of the CLI's read question to the daemon (src/off/daemon-read.mjs, RFC 4.8 §7, D62): the
// DEADLINE it waits (the fallback is one PowerShell, ~450 ms, so a daemon that does not answer must never cost more than the question it
// saves), the one failure that ends it for the rest of the command, and the closed verb subset. The transport is a stub `request`: nothing
// here opens a socket (the real seam has its own e2e, ./daemon-read-e2e.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { daemonReader, DAEMON_READ_VERBS, DAEMON_READ_MS, DAEMON_READ_CAP } from '../../src/off/daemon-read.mjs'
import { HELPER_VERBS } from '../../src/collector/arch/win32/helper.mjs'

const reader = (request, o = {}) => daemonReader({ platform: 'win32', socketPath: '\\\\.\\pipe\\x', request, ...o })

test('4.8 §7: the subset the CLI may ask through the daemon is a subset of the helper\'s own verbs, and holds no verb that reads another process\'s secrets', () => {
  const outside = DAEMON_READ_VERBS.filter((v) => !HELPER_VERBS.includes(v))
  assert.deepEqual(outside, [], 'DAEMON_READ_VERBS ⊆ HELPER_VERBS: a name the helper does not know could never be answered')
  for (const v of ['proc-env', 'token', 'roots', 'pipe-server']) assert.equal(DAEMON_READ_VERBS.includes(v), false, `${v} is not in the subset`)
})

test('D62: every read is capped at 2 × DAEMON_READ_MS, whatever the caller asks for — a stuck helper must not make a read-only command slower than the local question it replaced', async () => {
  const asked = []
  const r = reader(async (q) => { asked.push(q.timeoutMs); return { ok: true, data: { procs: [] } } })
  await r.call('ps', { all: true }, { timeoutMs: 10_000 }) // what arch/win32/netfacts.mjs gives its own helper
  await r.call('tcp-table', { states: ['listen'] })
  assert.deepEqual(asked, [DAEMON_READ_CAP, DAEMON_READ_MS], 'the caller\'s 10 s is cut to the cap; a caller that asks for nothing waits the default')
  assert.ok(DAEMON_READ_CAP <= 2 * DAEMON_READ_MS && DAEMON_READ_CAP < 10_000, `the cap is the short one (${DAEMON_READ_CAP} ms)`)
})

test('D62: the FIRST failure ends the daemon for the rest of the command — later verbs are refused at once and never waited on, and a failure that came as a reply ends it just as one that came as a throw', async () => {
  for (const [how, request] of [
    ['a dead channel', async () => { throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }) }],
    ['a reply that says it did not work', async () => ({ ok: false, error: 'ps: helper down: it exited with code 1' })],
  ]) {
    const calls = []
    const r = reader(async (q) => { calls.push(q.body.verb); return request(q) })
    await assert.rejects(() => r.call('ps', { all: true }), (e) => e.code === 'daemon-read-failed', how)
    for (const verb of ['tcp-table', 'reg-read']) {
      await assert.rejects(() => r.call(verb, {}), (e) => e.code === 'daemon-read-failed' && /already failed a read of this command/.test(e.message), `${how}: ${verb} is not asked again`)
    }
    assert.deepEqual(calls, ['ps'], `${how}: one question went out, not three (each wait is time the local question would have answered in)`)
  }
})

test('4.8 §10.1: inside one command a second ask with the same arguments is the same answer and no second question — a read-only command reports ONE moment', async () => {
  const calls = []
  const r = reader(async (q) => { calls.push(q.body); return { ok: true, data: { procs: [{ pid: 7, name: 'codex.exe' }] } } })
  const a = await r.call('ps', { all: true })
  const b = await r.call('ps', { all: true })
  assert.deepEqual(a, b, 'the same answer')
  assert.deepEqual(calls, [{ verb: 'ps', args: { all: true } }], 'asked once')
  await r.call('ps', { all: false })
  assert.equal(calls.length, 2, 'other arguments are another question')
})

test('4.8 §7: a verb outside the subset is refused by the client before anything is sent', async () => {
  const calls = []
  const r = reader(async (q) => { calls.push(q); return { ok: true, data: {} } })
  for (const verb of ['proc-env', 'token', 'write-anything']) {
    await assert.rejects(() => r.call(verb, {}), (e) => e.code === 'daemon-read-unknown-verb', verb)
  }
  assert.deepEqual(calls, [], 'nothing was sent, so the refusal cannot depend on the daemon')
})
