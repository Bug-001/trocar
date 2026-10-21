// test/collector/core/proxymode/holders.test.mjs — CM23 (unit, the daemon half; 4.11 P12): the poll reads the process table every 10 s through
// injected timers and never a connection count; an idle holder keeps mayExit false until it dies; doorSeen is recorded at accept (pid + start).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHolderPoll, mayExit, createDoorSeen, HOLDER_POLL_MS } from '../../../../src/collector/core/proxymode/holders.mjs'
import { holdersOf } from '../../../../src/off/holders.mjs'
import { compileIdentity } from '../../../../src/off/identity.mjs'
import { serializeSignature } from '../../../../src/off/signature.mjs'
import { holdersRoute } from '../../../../src/collector/core/control.mjs'

const ON = 1_000_000, OFF = 2_000_000
const liveness = { agentx: { identity: serializeSignature(compileIdentity({ harness: 'agentx', names: [{ name: 'agentx' }] })), rereads: false, since: new Date(ON).toISOString(), on_at: new Date(ON).toISOString(), off_at: new Date(OFF).toISOString() } } // since: the first on's (P12)
const proc = (pid, startedAt, name = 'agentx') => ({ pid, startedAt, exe: `/opt/${name}`, argv: [name], env: () => null, envRead: false })
const fakeTimers = () => { const q = []; return { q, setTimeout: (fn, ms) => { q.push({ fn, ms }); return q.length }, clearTimeout: () => { q.length = 0 }, async fire() { const t = q.shift(); await t.fn() } } }
const flush = () => new Promise((r) => setImmediate(r))

test('CM23: an idle holder (no connection at off) keeps mayExit false; after it dies mayExit is true; the poll is every 10 s', async () => {
  let table = [proc(10, ON + 1), proc(11, ON - 1)] // 11 started before on: not a holder
  const timers = fakeTimers(), changes = []
  const poll = createHolderPoll({ list: async () => holdersOf({ manifest: { liveness }, procs: table }), timers, onChange: (r) => changes.push(r.map((x) => x.pid)) })
  assert.equal(HOLDER_POLL_MS, 10_000)
  poll.start(); await flush()
  assert.deepEqual(changes, [[10]])
  assert.equal(timers.q[0].ms, 10_000, 'the next poll is 10 s away')
  assert.equal(mayExit({ harnessesOn: [], holders: poll.now(), openConns: 0 }), false, 'idle, no connections, still a holder')
  table = [proc(11, ON - 1)]
  await timers.fire(); await flush()
  assert.deepEqual(changes, [[10], []])
  assert.equal(mayExit({ harnessesOn: [], holders: poll.now(), openConns: 0 }), true)
  assert.equal(mayExit({ harnessesOn: ['agentx'], holders: [], openConns: 0 }), false, 'a harness still on keeps it')
  assert.equal(mayExit({ harnessesOn: [], holders: [], openConns: 2 }), false, 'an open connection keeps it')
  poll.stop(); assert.equal(timers.q.length, 0)
})

test('a table that cannot be read keeps the last answer (never "nobody holds")', async () => {
  const timers = fakeTimers(), errs = []
  let fail = false
  const poll = createHolderPoll({ list: async () => { if (fail) throw new Error('ps died'); return [{ harness: 'agentx', pid: 1, start: 5 }] }, timers, onError: (e) => errs.push(e.message) })
  poll.start(); await flush()
  fail = true; await timers.fire(); await flush()
  assert.equal(poll.now().length, 1); assert.deepEqual(errs, ['ps died'])
  poll.stop()
})

test('doorSeen records pid + start at accept, once per process with its latest sighting, and holdersOf counts it within the on window', () => {
  let now = ON + 50
  const seen = createDoorSeen({ clock: () => now })
  seen.add({ harness: 'agentx', pid: 20, start: ON - 100 }); now = ON + 60; seen.add({ harness: 'agentx', pid: 20, start: ON - 100 })
  seen.add({ harness: 'agentx', pid: 'x' })
  assert.deepEqual(seen.list(), [{ harness: 'agentx', pid: 20, start: ON - 100, at: ON + 60 }])
  const rows = holdersOf({ manifest: { liveness }, procs: [proc(20, ON - 100, 'helper')], doorSeen: seen.list() })
  assert.deepEqual(rows.map((r) => [r.pid, r.why]), [[20, 'door-seen']])
})

test('GET /holders answers the count and the rows', async () => {
  const h = holdersRoute({ holders: () => [{ harness: 'agentx', pid: 1, start: 2, why: 'rereads' }] })
  assert.deepEqual(await h({}), { count: 1, holders: [{ harness: 'agentx', pid: 1, start: 2, why: 'rereads' }] })
  assert.deepEqual(await holdersRoute({ holders: () => null })({}), { count: null, holders: null, unknown: true }, 'no readable table yet: unknown, never 0')
})

test('mayExit: holders unknown (null, the poll before a first readable table) means the daemon may not exit, and never throws', () => {
  assert.equal(mayExit({ harnessesOn: [], holders: null, openConns: 0 }), false)
  assert.equal(mayExit({ harnessesOn: [], holders: [], openConns: 0 }), true)
})
