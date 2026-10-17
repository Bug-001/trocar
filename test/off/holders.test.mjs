// test/off/holders.test.mjs — CM23 (unit, the judge half): who may still use a door after `off` (4.11 P12), from the manifest's
// `liveness.<h>` (identity, rereads, on_at, off_at, per_request) and an injected process table alone — the CLI side (daemon down) and the
// daemon's poll compute the same table. Generated over the start-time axis around the on window; never by counting connections.
import test from 'node:test'
import assert from 'node:assert/strict'
import { holdersOf } from '../../src/off/holders.mjs'
import { compileIdentity } from '../../src/off/identity.mjs'
import { serializeSignature } from '../../src/off/signature.mjs'

const ON = Date.parse('2026-10-15T10:00:00Z'), OFF = Date.parse('2026-10-15T11:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const identity = (name) => serializeSignature(compileIdentity({ harness: name, names: [{ name }] }))
const rec = (name, extra = {}) => ({ identity: identity(name), rereads: false, on_at: iso(ON), off_at: iso(OFF), ...extra })
const proc = (pid, name, startedAt) => ({ pid, ppid: 1, uid: 501, startedAt, exe: `/usr/local/bin/${name}`, argv: [name], env: () => null, envRead: false })
const manifest = (liveness) => ({ version: 3, liveness, entries: [], files: [] })

// the start-time axis: before on, at on, inside, at off, after off, unknown
const AXIS = [['before-on', ON - 1, false], ['at-on', ON, true], ['inside', ON + 60_000, true], ['at-off', OFF, false], ['after-off', OFF + 1, false], ['unknown-start', null, true]]

for (const [label, start, expected] of AXIS) {
  test(`a process of h started ${label} is ${expected ? '' : 'not '}a holder (no rereads)`, () => {
    const h = holdersOf({ manifest: manifest({ agentx: rec('agentx') }), procs: [proc(41, 'agentx', start)] })
    assert.equal(h.length, expected ? 1 : 0)
    if (expected) assert.deepEqual(h[0], { harness: 'agentx', pid: 41, start, why: start == null ? 'start-unknown' : 'started-in-window' })
  })
  test(`rereads: a process of h started ${label} is a holder iff it was alive at off_at`, () => {
    const h = holdersOf({ manifest: manifest({ agentx: rec('agentx', { rereads: true }) }), procs: [proc(42, 'agentx', start)] })
    const aliveAtOff = start == null || start < OFF
    assert.equal(h.length, aliveAtOff ? 1 : 0)
  })
}

test('an idle holder needs no connection: the judge reads only the process table (started-before-on is not a holder)', () => {
  const procs = [proc(1, 'agentx', ON - 5000), proc(2, 'agentx', ON + 5), proc(3, 'other', ON + 5)]
  assert.deepEqual(holdersOf({ manifest: manifest({ agentx: rec('agentx') }), procs }).map((x) => x.pid), [2])
})

// the record axis × procs: holders exist only after off — no on_at (Linux, the old model), on_at without off_at (still on) → none; both → the window
const RECORDS = [['no on_at', ({ on_at, off_at, ...r }) => r, false], ['on_at without off_at', ({ off_at, ...r }) => r, false], ['no on_at, off_at set', ({ on_at, ...r }) => r, false], ['both', (r) => r, true]]
const PROCSETS = [['inside', [proc(5, 'agentx', ON + 5)]], ['before on', [proc(5, 'agentx', ON - 5)]], ['after off', [proc(5, 'agentx', OFF + 5)]], ['start unknown', [proc(5, 'agentx', null)]], ['none', []]]
for (const [rl, shape, windowed] of RECORDS) for (const rr of [false, true]) for (const [pl, procs] of PROCSETS) {
  test(`record ${rl}${rr ? ' (rereads)' : ''} × process ${pl}: ${windowed ? 'the window decides' : 'no holder'}`, () => {
    const l = shape(rec('agentx', { rereads: rr }))
    const doorSeen = procs.filter((p) => p.startedAt == null || p.startedAt < ON + 1).map((p) => ({ harness: 'agentx', pid: p.pid, start: p.startedAt, at: ON + 1 })) // seen inside the window
    const h = holdersOf({ manifest: manifest({ agentx: l }), procs, doorSeen })
    if (!windowed) return assert.deepEqual(h, [])
    const s = procs.length ? procs[0].startedAt : undefined
    const want = s === undefined ? 0 : s == null || doorSeen.length || (rr ? s < OFF : s >= ON && s < OFF) ? 1 : 0
    assert.equal(h.length, want)
  })
}

test('doorSeen: a process the door identified during h\'s window holds, matched by pid AND start (a reused pid does not)', () => {
  const m = manifest({ agentx: rec('agentx') })
  const procs = [proc(7, 'helperbin', ON - 10), proc(8, 'helperbin', ON + 99)]
  const seen = [{ harness: 'agentx', pid: 7, start: ON - 10, at: ON + 10 }, { harness: 'agentx', pid: 8, start: ON + 1, at: ON + 200 }, { harness: 'agentx', pid: 7, start: ON - 10, at: OFF + 5 }]
  const h = holdersOf({ manifest: m, procs, doorSeen: seen })
  assert.deepEqual(h, [{ harness: 'agentx', pid: 7, start: ON - 10, why: 'door-seen' }])
})

test('a per-request harness (cordis-plugin: the hook re-reads the switch per request) never makes a holder, by identity or by doorSeen', () => {
  const m = manifest({ dsh: rec('dsh', { per_request: true, rereads: true }) })
  const procs = [proc(9, 'dsh', ON + 1)]
  assert.deepEqual(holdersOf({ manifest: m, procs, doorSeen: [{ harness: 'dsh', pid: 9, start: ON + 1, at: ON + 2 }] }), [])
})

test('one process two harnesses claim is a holder of each; the result is ordered and deduplicated per harness', () => {
  const both = { identity: { ...identity('agentx'), match: [...identity('agentx').match, ...identity('agenty').match] } }
  const m = manifest({ a: { ...rec('agentx'), ...both }, b: rec('agentx') })
  const h = holdersOf({ manifest: m, procs: [proc(11, 'agentx', ON + 1)], doorSeen: [{ harness: 'a', pid: 11, start: ON + 1, at: ON + 2 }] })
  assert.deepEqual(h.map((x) => [x.harness, x.pid]), [['a', 11], ['b', 11]])
})

test('no manifest, no liveness, or an unparsable on_at: no throw; an unknown on_at is the safe direction (alive → holder)', () => {
  assert.deepEqual(holdersOf({ manifest: null, procs: [proc(1, 'agentx', ON)] }), [])
  assert.deepEqual(holdersOf({ manifest: { version: 3 }, procs: [] }), [])
  assert.equal(holdersOf({ manifest: manifest({ agentx: rec('agentx', { on_at: 'garbage' }) }), procs: [proc(1, 'agentx', ON - 1e9)] }).length, 1)
})

test('off writes liveness.<h>.off_at, keeps the model record after its items are gone, and returns the holders; a record without on_at (Linux) is untouched', async () => {
  const { tmpDir } = await import('../helpers/tmp.mjs')
  const { newManifest, saveManifest, readManifest } = await import('../../src/off/manifest.mjs')
  const { undoHarnesses } = await import('../../src/off/undo.mjs')
  const dir = tmpDir('holders-off'), home = tmpDir('holders-home')
  const m = newManifest()
  const { off_at, ...open } = rec('agentx')
  m.liveness = { agentx: open, legacy: { identity: identity('legacy'), rereads: false, until: 'restart' } }
  saveManifest(dir, m)
  const at = new Date(OFF)
  const out = await undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [proc(3, 'agentx', ON + 5), proc(4, 'agentx', ON - 5)], now: at })
  assert.equal(off_at, iso(OFF))
  assert.deepEqual(out.holders, [{ harness: 'agentx', pid: 3, start: ON + 5, why: 'started-in-window' }])
  const back = readManifest(dir)
  assert.equal(back.liveness.agentx.off_at, iso(OFF))
  assert.deepEqual(back.liveness.legacy, m.liveness.legacy, 'a record of the old model gets no off_at')
  const failing = await undoHarnesses({ dir, home, manifest: readManifest(dir), procs: async () => { throw new Error('ps died') }, now: at })
  assert.equal(failing.holders, null, 'a table that cannot be read is "not known", never "none"')
})

test('a repeated off keeps the first off_at (D54): a process started between the two offs is not a holder; an on after the off opens a new window', async () => {
  const { tmpDir } = await import('../helpers/tmp.mjs')
  const { newManifest, saveManifest, readManifest } = await import('../../src/off/manifest.mjs')
  const { undoHarnesses } = await import('../../src/off/undo.mjs')
  const dir = tmpDir('holders-reoff'), home = tmpDir('holders-reoff-home')
  const m = newManifest()
  const { off_at, ...open } = rec('agentx')
  m.liveness = { agentx: open }
  saveManifest(dir, m)
  const between = proc(6, 'agentx', OFF + 1000)
  await undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [between], now: new Date(OFF) })
  const second = await undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [between], now: new Date(OFF + 5000) })
  assert.equal(readManifest(dir).liveness.agentx.off_at, iso(OFF), 'the second off did not move off_at')
  assert.deepEqual(second.holders || [], [], 'the process started after the first off went direct: not a holder')
  const again = readManifest(dir)
  again.liveness.agentx.on_at = iso(OFF + 10_000) // on again: on_at is past the old off_at, so the next off closes the new window
  saveManifest(dir, again)
  await undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [], now: new Date(OFF + 20_000) })
  assert.equal(readManifest(dir).liveness.agentx.off_at, iso(OFF + 20_000))
})
