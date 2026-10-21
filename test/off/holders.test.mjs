// test/off/holders.test.mjs — CM23 (unit, the judge half): who may still use a door after `off` (4.11 P12), from the manifest's
// `liveness.<h>` (identity, rereads, on_at, off_at, per_request) and an injected process table alone — the CLI side (daemon down) and the
// daemon's poll compute the same table. Generated over the start-time axis around the on window; never by counting connections.
import test from 'node:test'
import assert from 'node:assert/strict'
import { holdersOf, sawEntry, WINDOWS_MAX } from '../../src/off/holders.mjs'
import { compileIdentity } from '../../src/off/identity.mjs'
import { serializeSignature } from '../../src/off/signature.mjs'
import { listProcs } from '../../src/off/proc.mjs'
import { darwinTools } from './fixtures/darwin-tools.mjs'
import { fakeProc } from '../collector/arch/linux/fixtures/fake-proc.mjs'

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

// P12 `windows`: the earlier on windows of the same door count as the latest does — for the holder after the next off and for `status`'s
// "read an entry" (sawEntry, 4.11 P11 status); the gap between two windows (the harness off: no entry to read) counts for neither
const W0 = { on_at: iso(ON - 7_200_000), off_at: iso(ON - 3_600_000) }
for (const [label, start, inside] of [['in the earlier window', ON - 5_000_000, true], ['in the gap', ON - 1_000_000, false], ['before every window', ON - 9_000_000, false], ['in the latest window', ON + 5, true]]) {
  test(`windows: a process started ${label} is ${inside ? '' : 'not '}a holder and ${inside ? 'read' : 'did not read'} an entry`, () => {
    const l = rec('agentx', { windows: [W0] })
    assert.equal(holdersOf({ manifest: manifest({ agentx: l }), procs: [proc(7, 'agentx', start)] }).length, inside ? 1 : 0)
    const { off_at, ...on } = l
    assert.equal(sawEntry({ startedAt: start }, on), inside, 'while on (the latest window open)')
  })
}
test('windows: a full list makes its earliest start unknown (the safe direction), not its end; no window read nothing', () => {
  const full = Array.from({ length: WINDOWS_MAX }, (_, i) => ({ on_at: iso(ON - (WINDOWS_MAX - i) * 2000), off_at: iso(ON - (WINDOWS_MAX - i) * 2000 + 1000) }))
  const l = rec('agentx', { windows: full }), firstOff = ON - WINDOWS_MAX * 2000 + 1000
  assert.equal(sawEntry({ startedAt: firstOff - 5_000_000 }, l), true, 'before the earliest window ended: its start is not known')
  assert.equal(sawEntry({ startedAt: firstOff + 500 }, l), false, 'in the gap after the earliest window: the harness was off')
  assert.equal(holdersOf({ manifest: manifest({ agentx: l }), procs: [proc(7, 'agentx', firstOff + 500)] }).length, 0, 'and it holds no door after off')
  assert.equal(sawEntry({ startedAt: ON + 5 }, { identity: identity('agentx') }), false)
  assert.equal(sawEntry({ startedAt: null }, rec('agentx')), null)
})

// V32 (1.6 A.2 row 32): a start the reader read only to the whole second (macOS `lstart`, which the row states as `startGrain`) that falls in
// on_at's second read the entry; a start read finer is taken as it is, even one that happens to fall on a whole second. Generated over the three
// readers (src/off/proc.mjs listProcs through its injected OS), each answering a process that truly started k ms after the whole second S:
// darwin prints S's second (true start = on_at, inside); win32 and Linux give S itself, k ms before on_at (outside).
const S = Math.floor(ON / 1000) * 1000 + 3_000
const READERS = {
  darwin: async (at) => listProcs({ platform: 'darwin', uid: 501, exec: darwinTools([{ pid: 7, at: new Date(at), exe: '/usr/local/bin/agentx' }]).run }),
  win32: async (at) => { const ps = { run: (file, args) => (/Win32_Process \| ForEach-Object/.test(args.join(' ')) ? { status: 0, stdout: JSON.stringify([{ p: 7, pp: 1, n: 'agentx.exe', x: 'C:\\a\\agentx.exe', s: at, c: 'agentx' }]), stderr: '' } : { status: 1, stdout: '', stderr: '' }) }; return listProcs({ platform: 'win32', exec: ps.run }) },
  linux: async (at) => { const p = fakeProc(); try { p.add(7, { uid: 1000, exe: '/usr/bin/agentx', argv: ['agentx'], startTicks: (at / 1000 - p.btime) * 100 }); return await listProcs({ platform: 'linux', uid: 1000, root: p.root }) } finally { p.done() } },
}
for (const [os, read] of Object.entries(READERS)) {
  for (const k of [10, 250, 999]) { // from Linux's grain (one clock tick, 10 ms) up: within a tick no reader tells the two apart
    test(`same second (${os}): on_at = S + ${k} ms; the process started at ${os === 'darwin' ? 'on_at, read as S' : 'S, read finer than a second'} ${os === 'darwin' ? 'read' : 'did not read'} the entry; one a second earlier did not`, async () => {
      const l = rec('agentx', { on_at: iso(S + k) })
      delete l.off_at
      const truly = os === 'darwin' ? S + k : S
      const [row] = await read(truly)
      assert.equal(row.startedAt, S, 'the reader gives a start on the whole second S')
      assert.equal(sawEntry(row, l), os === 'darwin')
      const [earlier] = await read(truly - 1000)
      assert.equal(sawEntry(earlier, l), false)
    })
  }
}
