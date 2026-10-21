// test/collector/core/proxymode/holders.test.mjs — CM23 (unit, the daemon half; 4.11 P12): the poll reads the process table every 10 s through
// injected timers and never a connection count; an idle holder keeps mayExit false until it dies; the door record (createDoorSeen) is bounded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHolderPoll, mayExit, createDoorSeen, HOLDER_POLL_MS } from '../../../../src/collector/core/proxymode/holders.mjs'
import { holdersOf } from '../../../../src/off/holders.mjs'
import { compileIdentity } from '../../../../src/off/identity.mjs'
import { serializeSignature } from '../../../../src/off/signature.mjs'
import { holdersRoute } from '../../../../src/collector/core/control.mjs'
import { readDoorSeen, DOOR_SEEN_MAX, DOOR_SEEN_FILE } from '../../../../src/off/door-seen.mjs'
import { isCode } from '../../../../src/health/codes.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'

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

test('A9 (c) · P12 the door record is bounded: past DOOR_SEEN_MAX lives the file keeps the newest DOOR_SEEN_MAX rows, and a reload lists them', () => {
  const dir = tmpDir()
  let now = ON
  const seen = createDoorSeen({ dir, clock: () => ++now, timers: fakeTimers() })
  const extra = 5
  for (let pid = 1; pid <= DOOR_SEEN_MAX + extra; pid++) seen.add({ harness: 'agentx', group: 'agentx:api', pid, start: ON - pid, kind: 'accept' })
  seen.close()
  const { rows } = readDoorSeen({ dir })
  assert.ok(rows.length <= DOOR_SEEN_MAX)
  assert.deepEqual(rows.map((r) => r.pid).sort((a, b) => a - b), Array.from({ length: DOOR_SEEN_MAX }, (_, i) => i + 1 + extra), 'the oldest lives went')
  assert.equal(createDoorSeen({ dir, timers: fakeTimers() }).list().length, rows.length)
})

// P12 an unreadable door record: the lives it held are not known, and stay not known in the file the daemon writes back, until no live process of a
// harness that was on started before (or at an unknown time before) the moment it was found unreadable. Axes: what the file held × the claimable table.
for (const bad of ['{not json', '{"version":1}', '[]']) {
  test(`P12 a door record that cannot be read (${JSON.stringify(bad)}) is said with its own code and is never written back as complete; it is cleared once no claimable life predates it`, () => {
    const dir = tmpDir(), T = 5_000_000
    fs.writeFileSync(path.join(dir, DOOR_SEEN_FILE), bad)
    let now = T
    const errs = []
    const open = () => createDoorSeen({ dir, clock: () => ++now, timers: fakeTimers(), onError: (e) => errs.push(e) })
    const a = open()
    assert.equal(errs[0].code, 'door-record-unreadable'); assert.ok(isCode(errs[0].code), 'in the closed set')
    assert.equal(a.list(), null)
    a.add({ harness: 'agentx', group: 'agentx:api', pid: 1, start: T + 10, kind: 'accept' })
    a.close()
    assert.equal(readDoorSeen({ dir }).rows, null, 'the file written back still says not known')
    for (const predates of [[proc(9, T - 1)], [proc(9, null)], [proc(1, T + 10), proc(9, T - 1)]]) {
      const b = open()
      assert.equal(b.list(), null, 'a restart reads it as not known')
      b.prune(() => true, predates); b.close()
      assert.equal(readDoorSeen({ dir }).rows, null, `a live claimable process started before: still not known (${JSON.stringify(predates.map((x) => x.startedAt))})`)
    }
    const c = open()
    c.prune(() => true, [proc(1, T + 10)])
    assert.deepEqual(c.list().map((r) => r.pid), [1], 'cleared: the rows met since are the record')
    c.close()
    assert.deepEqual(readDoorSeen({ dir }).rows.map((r) => r.pid), [1])
    const d = open(); d.prune(() => true, null); assert.ok(Array.isArray(d.list()), 'a readable record stays known')
  })
}

test('GET /holders answers the count and the rows', async () => {
  const h = holdersRoute({ holders: () => [{ harness: 'agentx', pid: 1, start: 2, why: 'rereads' }] })
  assert.deepEqual(await h({}), { count: 1, holders: [{ harness: 'agentx', pid: 1, start: 2, why: 'rereads' }] })
  assert.deepEqual(await holdersRoute({ holders: () => null })({}), { count: null, holders: null, unknown: true }, 'no readable table yet: unknown, never 0')
})

test('mayExit: holders unknown (null, the poll before a first readable table) means the daemon may not exit, and never throws', () => {
  assert.equal(mayExit({ harnessesOn: [], holders: null, openConns: 0 }), false)
  assert.equal(mayExit({ harnessesOn: [], holders: [], openConns: 0 }), true)
})
