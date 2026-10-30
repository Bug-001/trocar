// test/off/state.test.mjs — src/off/state.mjs: ~/.trocar/collector/state.json version 2 (1.6 §1.5, V28's file half). The daemon's switch
// (test/collector/core/switch.test.mjs) and the undo side both read and write it through here: version 1 reads as version 2 for the
// installed harnesses, a file that cannot be read is thrown (never read as "everything off" by this module), and a write is all or nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { STATE_VERSION, emptyState, migrateV1, readStateFile, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { HARNESS_IDS } from '../../src/off/harness-names.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const NOW = new Date('2026-10-07T10:00:00.000Z')
const file = () => path.join(tmpDir('trocar-state-'), 'collector', 'state.json')
const put = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)) }
const [A, B] = HARNESS_IDS

test('readStateFile: no file is the empty state from null; version 2 is read as written, an entry that says anything but "on" is off', () => {
  const f = file()
  assert.deepEqual(readStateFile(f), { state: emptyState(), from: null })
  assert.equal(STATE_VERSION, 2)
  put(f, { version: 2, updated_at: 'T0', harnesses: { [A]: { desired: 'on', policy: 'all', extra_hosts: ['h', 7], updated_at: 'T1' }, [B]: { desired: 'ON', policy: 'wide' }, junk: 7 } })
  const { state, from } = readStateFile(f)
  assert.equal(from, 2)
  assert.deepEqual(state.harnesses[A], { desired: 'on', policy: 'all', extra_hosts: ['h'], updated_at: 'T1' })
  assert.deepEqual(state.harnesses[B], { desired: 'off', updated_at: null }, 'an entry may omit policy and extra_hosts; this module never invents either')
  assert.deepEqual(state.harnesses.junk, { desired: 'off', updated_at: null })
  assert.equal(state.updated_at, 'T0')
})

test('readStateFile: version 1 (or an old file with no version) comes back migrated for the installed harnesses, the old updated_at kept', () => {
  const f = file()
  put(f, { version: 1, desired: 'on', policy: 'all', extra_hosts: ['x'], updated_at: 'T0' })
  const { state, from } = readStateFile(f, { installed: [A, B], now: NOW })
  assert.equal(from, 1)
  assert.deepEqual(state, migrateV1({ desired: 'on', policy: 'all', extra_hosts: ['x'], updated_at: 'T0' }, [A, B], NOW))
  for (const id of [A, B]) assert.deepEqual(state.harnesses[id], { desired: 'on', policy: 'all', extra_hosts: ['x'], updated_at: 'T0' })
  state.harnesses[A].extra_hosts.push('y')
  assert.deepEqual(state.harnesses[B].extra_hosts, ['x'], 'each harness has its own list')
  assert.deepEqual(readStateFile(f).state.harnesses, {}, 'no installed harness named: nothing to carry it to')
  put(f, { desired: 'on' }) // what a pre-versioning writer left: version 1's shape
  assert.deepEqual([readStateFile(f, { installed: [A], now: NOW }).from, readStateFile(f, { installed: [A], now: NOW }).state.harnesses[A]], [1, { desired: 'on', updated_at: NOW.toISOString() }])
})

test('migrateV1: a field that is not well formed reads as off or absent; policy and extra_hosts are copied only when the old file had them', () => {
  assert.deepEqual(migrateV1({ desired: 'maybe' }, [A], NOW), { version: 2, updated_at: NOW.toISOString(), harnesses: { [A]: { desired: 'off', updated_at: NOW.toISOString() } } })
  assert.deepEqual(migrateV1({ desired: 'on', policy: 'bogus', extra_hosts: 'x' }, [A], NOW).harnesses[A], { desired: 'on', updated_at: NOW.toISOString() })
  assert.deepEqual(migrateV1({ desired: 'on', extra_hosts: [1, 'a'] }, [], NOW).harnesses, {})
})

test('readStateFile throws what it cannot read: the errno of a file it could not read, state-unparsable for text that is not a state or a version it does not know', () => {
  const f = file()
  for (const text of ['{not json', '[]', 'null', '"on"']) { put(f, text); assert.throws(() => readStateFile(f), { code: 'state-unparsable' }, text) }
  put(f, { version: 3, harnesses: {} })
  assert.throws(() => readStateFile(f), (e) => e.code === 'state-unparsable' && /version 3/.test(e.message))
  fs.rmSync(f); fs.mkdirSync(f) // a directory where the file belongs
  assert.throws(() => readStateFile(f), { code: 'EISDIR' })
})

test('setDesired: a new object with the harnesses named stamped (and the top level); policy and extra_hosts kept; the old state untouched', () => {
  const before = { version: 2, updated_at: 'T0', harnesses: { [A]: { desired: 'on', policy: 'all', extra_hosts: ['h'], updated_at: 'T0' }, [B]: { desired: 'on', updated_at: 'T0' } } }
  const snapshot = JSON.stringify(before)
  const after = setDesired(before, [A, 'new'], 'off', NOW)
  assert.equal(JSON.stringify(before), snapshot)
  assert.deepEqual(after, { version: 2, updated_at: NOW.toISOString(), harnesses: { [A]: { desired: 'off', policy: 'all', extra_hosts: ['h'], updated_at: NOW.toISOString() }, [B]: before.harnesses[B], new: { desired: 'off', updated_at: NOW.toISOString() } } })
  assert.equal(setDesired(before, [B], 'on', NOW).harnesses[B].desired, 'on')
  assert.equal(setDesired(before, [B], 'nonsense', NOW).harnesses[B].desired, 'off', 'only "on" turns anything on')
})

test('writeStateAtomic: the file is 0600 in a 0700 directory made for it, and what was written reads back', () => {
  const f = file()
  const s = setDesired(emptyState(), [A], 'on', NOW)
  writeStateAtomic(f, s)
  assert.deepEqual([fs.statSync(f).mode & 0o777, fs.statSync(path.dirname(f)).mode & 0o777], [0o600, 0o700])
  assert.deepEqual(readStateFile(f), { state: s, from: 2 })
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['state.json'], 'no temp file left')
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'))
})

// fs with the calls writeStateAtomic makes logged by name; `fail` = { op: errno } makes that call throw
function spyFs(fail = {}) {
  const ops = []; const names = new Map()
  const guard = (op, fn) => (...a) => { if (fail[op]) throw Object.assign(new Error(`${op} failed`), { code: fail[op] }); return fn(...a) }
  return {
    ops,
    fs: {
      mkdirSync: fs.mkdirSync, closeSync: fs.closeSync, chmodSync: fs.chmodSync, rmSync: fs.rmSync,
      openSync: guard('openSync', (p, flags, mode) => { const fd = fs.openSync(p, flags, mode); names.set(fd, path.basename(p)); ops.push(`open ${path.basename(p)} ${flags}`); return fd }),
      writeSync: guard('writeSync', fs.writeSync),
      fsyncSync: guard('fsyncSync', (fd) => { ops.push(`fsync ${names.get(fd)}`); return fs.fsyncSync(fd) }),
      renameSync: guard('renameSync', (a, b) => { ops.push('rename'); return fs.renameSync(a, b) }),
    },
  }
}

test('writeStateAtomic: temp file, fsync, rename, then fsync of the directory — in that order — and a failure at any step leaves the old file and no temp file (R12)', () => {
  const f = file(); const spy = spyFs()
  writeStateAtomic(f, emptyState(), { fs: spy.fs })
  const tmp = `state.json.tmp-${process.pid}`
  assert.deepEqual(spy.ops, [`open ${tmp} w`, `fsync ${tmp}`, 'rename', 'open collector r', 'fsync collector'])
  const old = fs.readFileSync(f, 'utf8')
  for (const failing of ['openSync', 'writeSync', 'fsyncSync', 'renameSync']) {
    assert.throws(() => writeStateAtomic(f, setDesired(emptyState(), [A], 'on', NOW), { fs: spyFs({ [failing]: 'EIO' }).fs }), { code: 'EIO' }, failing)
    assert.equal(fs.readFileSync(f, 'utf8'), old, `${failing}: the old file is intact`)
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['state.json'], `${failing}: no temp file`)
  }
})

test('writeStateAtomic: a directory that cannot fsync (EINVAL) is not a failed write; a file that cannot be written is thrown with its errno', () => {
  const f = file(); const spy = spyFs()
  const sync = spy.fs.fsyncSync
  writeStateAtomic(f, emptyState(), { fs: { ...spy.fs, fsyncSync: (fd) => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('not here'), { code: 'EINVAL' }); return sync(fd) } } })
  assert.equal(readStateFile(f).from, 2)
  fs.chmodSync(path.dirname(f), 0o500)
  try { assert.throws(() => writeStateAtomic(f, emptyState()), { code: 'EACCES' }) } finally { fs.chmodSync(path.dirname(f), 0o700) }
})
