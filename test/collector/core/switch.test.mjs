// test/collector/core/switch.test.mjs — acceptance S6 / S7 (degraded) / S9 at unit level.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSwitch, readState } from '../../../src/collector/core/switch.mjs'
import { checkRecord } from '../../../src/health/codes.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

// A kernel stand-in: attach/detach flip links; status reads them back (like the helper's bpf_link info).
function fakeRedirector({ failAttach = false } = {}) {
  const calls = []
  let links = []
  return {
    calls,
    async attach() { calls.push('attach'); if (failAttach) throw new Error('attach failed'); links = [{ name: 'connect4', id: 1 }, { name: 'connect6', id: 2 }, { name: 'sockops', id: 3 }] },
    async detach() { calls.push('detach'); links = [] },
    async status() { return { attached: links.length === 3, links, hb_age_ms: 10 } },
    yank() { links = [] }, // the kernel lost the links behind our back
  }
}
const tmpState = () => path.join(tmpDir('asight-sw-'), 'collector', 'state.json')

test('switch: on attaches, records, persists desired=on 0600; status is read from the kernel', async () => {
  const stateFile = tmpState(); const r = fakeRedirector()
  const sw = createSwitch({ redirector: r, stateFile })
  const s = await sw.on()
  assert.deepEqual([s.desired, s.actual, s.mismatch, s.recording], ['on', 'on', false, true])
  assert.equal(readState(stateFile).desired, 'on')
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)
  r.yank()
  const t = await sw.report()
  assert.deepEqual([t.desired, t.actual, t.mismatch], ['on', 'off', true])
})

test('switch: off stops recording before it detaches', async () => {
  const r = fakeRedirector(); const sw = createSwitch({ redirector: r, stateFile: tmpState() })
  await sw.on()
  let recordingAtDetach = null
  const detach = r.detach; r.detach = async () => { recordingAtDetach = sw.isRecording(); return detach() }
  const s = await sw.off()
  assert.equal(recordingAtDetach, false)
  assert.deepEqual([s.desired, s.actual, s.recording], ['off', 'off', false])
})

test('switch: on,on and off,off are no-ops (S6)', async () => {
  const stateFile = tmpState(); const r = fakeRedirector(); const events = []
  const sw = createSwitch({ redirector: r, stateFile, onEvent: (e) => events.push(e.event) })
  await sw.on(); const m1 = fs.statSync(stateFile).mtimeMs; const bytes = fs.readFileSync(stateFile)
  await new Promise((res) => setTimeout(res, 15))
  const again = await sw.on()
  assert.equal(again.noop, true)
  assert.equal(fs.statSync(stateFile).mtimeMs, m1); assert.deepEqual(fs.readFileSync(stateFile), bytes)
  await sw.off(); const off2 = await sw.off()
  assert.equal(off2.noop, true)
  assert.deepEqual(events, ['switch', 'switch'])
})

test('switch: desired state survives a new switch instance (S9)', async () => {
  const stateFile = tmpState()
  await createSwitch({ redirector: fakeRedirector(), stateFile }).on({ policy: 'all', extra_hosts: ['relay.example.com'] })
  const r2 = fakeRedirector()
  const s = await createSwitch({ redirector: r2, stateFile }).restore()
  assert.deepEqual([s.desired, s.actual, s.policy, s.extra_hosts], ['on', 'on', 'all', ['relay.example.com']])
  assert.deepEqual(r2.calls, ['attach'])
  const r3 = fakeRedirector()
  const fresh = await createSwitch({ redirector: r3, stateFile: tmpState() }).restore()
  assert.deepEqual([fresh.desired, fresh.actual], ['off', 'off'])
  assert.deepEqual(r3.calls, []) // a fresh helper starts detached: off is confirmed from the kernel, no detach needed
})

test('switch: a helper death marks the switch degraded and actual off; on() runs ensureReady first (S7, G12)', async () => {
  const r = fakeRedirector(); const order = []
  const sw = createSwitch({ redirector: r, stateFile: tmpState(), ensureReady: async () => { order.push('ensureReady') } })
  await sw.on(); r.yank()
  sw.markDown('helper killed by SIGKILL')
  const s = await sw.report()
  assert.deepEqual([s.actual, s.degraded && s.degraded.reason, s.recording], ['off', 'helper killed by SIGKILL', true])
  const back = await sw.on()
  assert.deepEqual([back.actual, back.degraded], ['on', null])
  assert.deepEqual(order, ['ensureReady', 'ensureReady'])
})

test('switch: a failing attach is reported, never thrown; desired stays on', async () => {
  const events = []
  const sw = createSwitch({ redirector: fakeRedirector({ failAttach: true }), stateFile: tmpState(), onEvent: (e) => events.push(e) })
  const s = await sw.on()
  assert.deepEqual([s.desired, s.actual, s.mismatch, s.recording], ['on', 'off', true, false])
  assert.equal(events[0].event, 'attach-failed')
})

test('switch: an unreadable state file means desired=off, not a crash — and it is reported, a missing one is not (D38)', () => {
  const f = tmpState(); fs.mkdirSync(path.dirname(f), { recursive: true })
  const seen = []
  assert.equal(readState(f, (e) => seen.push(e)).desired, 'off')
  assert.equal(seen.length, 0, 'no file yet: the first start, nothing to report')
  fs.writeFileSync(f, '{ nope')
  assert.equal(readState(f, (e) => seen.push(e)).desired, 'off')
  assert.equal(seen.length, 1)
  const events = []
  createSwitch({ redirector: fakeRedirector(), stateFile: f, onEvent: (e) => events.push(e) })
  assert.equal(events[0].event, 'failure')
  assert.match(events[0].reason, /is unreadable \(.*JSON.*\); the desired state reads as off/)
  assert.deepEqual([events[0].where, events[0].code], ['state', 'state-unparsable'], 'a parse error has no errno: it still carries a code (the fold key)')
  assert.deepEqual(checkRecord(events[0]), [])
})

test('switch: off detaches even when the desired state cannot be written, and records why (D-8, D38)', async () => {
  const f = tmpState(); const r = fakeRedirector(); const events = []
  const sw = createSwitch({ redirector: r, stateFile: f, onEvent: (e) => events.push(e) })
  await sw.on()
  fs.chmodSync(path.dirname(f), 0o500) // the temp file cannot be created next to it
  try {
    const s = await sw.off()
    assert.ok(r.calls.includes('detach'), 'the kernel stops steering although the state file still says on')
    assert.deepEqual([s.desired, s.actual, s.recording], ['off', 'off', false])
    const fail = events.find((e) => e.event === 'failure')
    assert.deepEqual([fail.where, fail.code], ['state', 'EACCES'])
    assert.match(fail.reason, /could not be written .*detaching anyway, but the next start restores the old desired state/)
    assert.deepEqual(checkRecord(fail), [])
    assert.equal(readState(f).desired, 'on', 'the file is what the next start reads — and the record says so')
  } finally { fs.chmodSync(path.dirname(f), 0o700) }
})

test('switch: a state file that cannot be written fails the request and leaves no temp file behind', async () => {
  const f = tmpState(); fs.mkdirSync(f, { recursive: true }) // a directory where the file belongs
  const sw = createSwitch({ redirector: fakeRedirector(), stateFile: f, onEvent: () => {} })
  await assert.rejects(sw.on())
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')), [])
})

// D40 (RFC 4.6 §引擎 解密策略): the default decrypt policy is `all`; what is written on disk is respected (an old default
// `auto` cannot be told from a chosen one), so only an install with NO policy gets `all`.
test('D40 default policy: no state file, or no policy written → all; a state.json that says auto keeps auto; an unreadable file reads as the default', async () => {
  const dir = path.dirname(tmpState())
  fs.mkdirSync(dir, { recursive: true })
  const at = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f }
  assert.equal(readState(path.join(dir, 'absent.json')).policy, 'all', 'a fresh install')
  assert.equal(readState(at('nopolicy.json', JSON.stringify({ version: 1, desired: 'on', extra_hosts: [] }))).policy, 'all', 'a state that never named one')
  assert.equal(readState(at('auto.json', JSON.stringify({ version: 1, desired: 'on', policy: 'auto', extra_hosts: [] }))).policy, 'auto', 'written auto is kept')
  assert.equal(readState(at('all.json', JSON.stringify({ version: 1, desired: 'on', policy: 'all' }))).policy, 'all')
  const errs = []
  assert.equal(readState(at('torn.json', '{ torn'), (e) => errs.push(e)).policy, 'all'); assert.equal(errs.length, 1, 'an unreadable file is still reported')
  // the first `on` of a fresh install writes `all`; a later `on` without a policy keeps what is there
  const stateFile = path.join(dir, 'fresh', 'state.json')
  await createSwitch({ redirector: fakeRedirector(), stateFile }).on()
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).policy, 'all')
  const old = at('old-install.json', JSON.stringify({ version: 1, desired: 'off', policy: 'auto', extra_hosts: [] }))
  const sw = createSwitch({ redirector: fakeRedirector(), stateFile: old })
  assert.equal((await sw.on()).policy, 'auto', 'turning on does not change the policy of an install that wrote one')
  assert.equal((await sw.on({ policy: 'all' })).policy, 'all', 'the operator can still choose')
})
