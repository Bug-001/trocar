// test/collector/core/switch.test.mjs — acceptance S6 / S7 (degraded) / S9 at unit level, and 1.6 V28 (state.json version 2: per-harness
// desired state, the version 1 migration, what an unreadable file reads as) with the per-harness switch behind it (1.6 §1.5).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSwitch, readState, DEFAULT_POLICY } from '../../../src/collector/core/switch.mjs'
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
const tmpState = () => path.join(tmpDir('trocar-sw-'), 'collector', 'state.json')
const IN = () => ['claude-code', 'codex'] // the installed harnesses (the daemon: the ones its install manifest names)
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))
const mk = (redirector, stateFile, extra = {}) => createSwitch({ redirector, stateFile, installed: IN, ...extra })
const desiredIn = (f) => Object.fromEntries(Object.entries(readState(f, () => {}, { installed: IN() }).harnesses).map(([id, h]) => [id, h.desired]))
const rewrite = (f, fn) => { const s = JSON.parse(fs.readFileSync(f, 'utf8')); fn(s); fs.writeFileSync(f, JSON.stringify(s)) } // an operator's edit, in place

test('switch: on attaches, records, persists desired=on 0600; status is read from the kernel', async () => {
  const stateFile = tmpState(); const r = fakeRedirector()
  const sw = mk(r, stateFile)
  const s = await sw.on()
  assert.deepEqual([s.desired, s.actual, s.mismatch, s.recording], ['on', 'on', false, true])
  assert.deepEqual(desiredIn(stateFile), { 'claude-code': 'on', codex: 'on' })
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)
  r.yank()
  const t = await sw.report()
  assert.deepEqual([t.desired, t.actual, t.mismatch], ['on', 'off', true])
})

test('switch: off stops recording before it detaches', async () => {
  const r = fakeRedirector(); const sw = mk(r, tmpState())
  await sw.on()
  let recordingAtDetach = null
  const detach = r.detach; r.detach = async () => { recordingAtDetach = sw.isRecording('claude-code'); return detach() }
  const s = await sw.off()
  assert.equal(recordingAtDetach, false)
  assert.deepEqual([s.desired, s.actual, s.recording], ['off', 'off', false])
})

test('switch: on,on and off,off are no-ops (S6)', async () => {
  const stateFile = tmpState(); const r = fakeRedirector(); const events = []
  const sw = mk(r, stateFile, { onEvent: (e) => events.push(e.event) })
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
  await mk(fakeRedirector(), stateFile).on({ policy: 'all', extra_hosts: ['relay.example.com'] })
  const r2 = fakeRedirector()
  const s = await mk(r2, stateFile).restore()
  assert.deepEqual([s.desired, s.actual], ['on', 'on'])
  assert.deepEqual(pick(s.harnesses.codex, ['desired', 'policy', 'extra_hosts']), { desired: 'on', policy: 'all', extra_hosts: ['relay.example.com'] }, 'the policy of each harness survives the restart')
  assert.deepEqual(r2.calls, ['attach'])
  const r3 = fakeRedirector()
  const fresh = await mk(r3, tmpState()).restore()
  assert.deepEqual([fresh.desired, fresh.actual], ['off', 'off'])
  assert.deepEqual(r3.calls, []) // a fresh helper starts detached: off is confirmed from the kernel, no detach needed
})

test('switch: a helper death marks the switch degraded and actual off; on() runs ensureReady first (S7, G12)', async () => {
  const r = fakeRedirector(); const order = []
  const sw = mk(r, tmpState(), { ensureReady: async () => { order.push('ensureReady') } })
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
  const sw = mk(fakeRedirector({ failAttach: true }), tmpState(), { onEvent: (e) => events.push(e) })
  const s = await sw.on()
  assert.deepEqual([s.desired, s.actual, s.mismatch, s.recording], ['on', 'off', true, false])
  assert.equal(events[0].event, 'attach-failed')
})

test('switch: an unreadable state file means desired=off, not a crash — and it is reported, a missing one is not (D38)', () => {
  const f = tmpState(); fs.mkdirSync(path.dirname(f), { recursive: true })
  const seen = []; const read = () => readState(f, (e) => seen.push(e), { installed: IN() })
  assert.deepEqual(read().harnesses, {}, 'no file yet: nothing is on')
  assert.equal(seen.length, 0, 'no file yet: the first start, nothing to report')
  fs.writeFileSync(f, '{ nope')
  assert.deepEqual(Object.values(read().harnesses).map((h) => h.desired), ['off', 'off'], 'every harness it knows reads as off')
  assert.equal(seen.length, 1)
  const events = []
  mk(fakeRedirector(), f, { onEvent: (e) => events.push(e) })
  assert.equal(events[0].event, 'failure')
  assert.match(events[0].reason, /is unreadable \(.*JSON.*\); the desired state reads as off/)
  assert.deepEqual([events[0].where, events[0].code], ['state', 'state-unparsable'], 'a parse error has no errno: it still carries a code (the fold key)')
  assert.deepEqual(checkRecord(events[0]), [])
})

test('switch: off detaches even when the desired state cannot be written, and records why (D-8, D38)', async () => {
  const f = tmpState(); const r = fakeRedirector(); const events = []
  const sw = mk(r, f, { onEvent: (e) => events.push(e) })
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
    assert.deepEqual(desiredIn(f), { 'claude-code': 'on', codex: 'on' }, 'the file is what the next start reads — and the record says so')
  } finally { fs.chmodSync(path.dirname(f), 0o700) }
})

test('switch: a state file that cannot be written fails the request and leaves no temp file behind', async () => {
  const f = tmpState(); fs.mkdirSync(f, { recursive: true }) // a directory where the file belongs
  const sw = mk(fakeRedirector(), f, { onEvent: () => {} })
  await assert.rejects(sw.on())
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')), [])
})

// ── state.json version 2 (1.6 §1.5, V28) ──────────────────────────────────────────────────────────────────────────────────────
test('V28: version 1 reads as version 2 for every installed harness; unreadable reads all off with one failure; the file written back carries both updated_at', async () => {
  const dir = tmpDir('trocar-sw-'), file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, desired: 'on', policy: 'all', extra_hosts: ['x'] }))
  const s = readState(file, () => {}, { installed: ['claude-code', 'codex'] })
  assert.equal(s.version, 2)
  for (const id of ['claude-code', 'codex']) assert.deepEqual(pick(s.harnesses[id], ['desired', 'policy', 'extra_hosts']), { desired: 'on', policy: 'all', extra_hosts: ['x'] })
  fs.writeFileSync(file, '{not json')
  const errs = []; const bad = readState(file, (e) => errs.push(e), { installed: ['claude-code'] })
  assert.equal(bad.harnesses['claude-code'].desired, 'off'); assert.equal(errs.length, 1)
  const sw = createSwitch({ redirector: fakeRedirector(), stateFile: file, installed: () => ['claude-code', 'codex'], onEvent: () => {} })
  await sw.off({ harnesses: ['codex'] })
  const back = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(back.version, 2)
  assert.ok(back.updated_at && back.harnesses.codex.updated_at && back.harnesses['claude-code'].updated_at, 'the top level and each harness say when')
  assert.equal((fs.statSync(file).mode & 0o777), 0o600)
})

test('V28: a version 2 entry without policy or extra_hosts reads as the default policy and no hosts; a version this build does not know is unreadable, not "on"', () => {
  const f = tmpState(); fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ version: 2, updated_at: 'T0', harnesses: { codex: { desired: 'on', updated_at: 'T1' }, hermes: { desired: 'sideways', policy: 'auto' }, junk: 7 } }))
  const s = readState(f, () => {}, { installed: IN() })
  assert.equal(DEFAULT_POLICY, 'all', 'D40: the default is decrypt-all')
  assert.deepEqual(pick(s.harnesses.codex, ['desired', 'policy', 'extra_hosts', 'updated_at']), { desired: 'on', policy: DEFAULT_POLICY, extra_hosts: [], updated_at: 'T1' })
  assert.deepEqual([s.harnesses.hermes.desired, s.harnesses.junk.desired], ['off', 'off'], 'anything but "on" is off')
  assert.equal(s.updated_at, 'T0')
  fs.writeFileSync(f, JSON.stringify({ version: 3, harnesses: { codex: { desired: 'on' } } }))
  const errs = []; const unknown = readState(f, (e) => errs.push(e), { installed: IN() })
  assert.deepEqual([errs.length, errs[0] && errs[0].code, unknown.harnesses.codex.desired], [1, 'state-unparsable', 'off'])
})

test('switch: links stay while any harness is on; isRecording follows the harness; reload only takes away', async () => {
  const file = tmpState(); const r = fakeRedirector(); const hooks = []
  const sw = mk(r, file, { reconcile: async ({ turnedOff }) => { hooks.push({ turnedOff: [...turnedOff], attached: (await r.status()).attached }) } })
  const s = await sw.on()
  assert.deepEqual([...sw.enabled()].sort(), ['claude-code', 'codex'])
  assert.deepEqual(Object.fromEntries(Object.entries(s.harnesses).map(([id, h]) => [id, h.desired])), { 'claude-code': 'on', codex: 'on' })
  await sw.off({ harnesses: ['codex'] })
  assert.deepEqual([sw.isRecording('codex'), sw.isRecording('claude-code'), sw.desiredOf('codex'), sw.desiredOf('claude-code'), sw.anyOn()], [false, true, 'off', 'on', true])
  assert.deepEqual([r.calls, (await r.status()).attached], [['attach'], true], 'one harness still on: the links stay')
  assert.deepEqual(hooks, [{ turnedOff: ['codex'], attached: true }], 'the table is reconciled while the links are still there')

  rewrite(file, (st) => { st.harnesses['claude-code'].desired = 'off' }) // the operator's CLI wrote the last harness off
  const gone = await sw.reloadIfChanged()
  assert.deepEqual([gone.changed, gone.turnedOff], [true, ['claude-code']])
  assert.deepEqual(r.calls, ['attach', 'detach'], 'detached once, because none is left on')
  assert.deepEqual(hooks[1], { turnedOff: ['claude-code'], attached: true }, 'unwatch comes before the links go, not after')
  assert.deepEqual([sw.isRecording('claude-code'), sw.anyOn(), (await sw.report()).desired], [false, false, 'off'])

  rewrite(file, (st) => { st.harnesses['claude-code'].desired = 'on'; st.harnesses.codex.desired = 'on' }) // …and later wrote it on again: only `on` attaches
  const back = await sw.reloadIfChanged()
  assert.deepEqual([back.changed, back.turnedOff], [true, []])
  assert.deepEqual([sw.desiredOf('claude-code'), sw.isRecording('claude-code'), sw.anyOn(), r.calls], ['off', false, false, ['attach', 'detach']], 'the file asking for on attaches nothing')
  assert.equal((await sw.reloadIfChanged()).changed, false, 'a file that did not change is not read again')
  await sw.on({ harnesses: ['claude-code'] }) // the request that follows the write is what attaches
  assert.deepEqual([sw.desiredOf('claude-code'), sw.desiredOf('codex'), sw.isRecording('claude-code'), r.calls], ['on', 'off', true, ['attach', 'detach', 'attach']])
})

test('switch: an unreadable state file seen by a reload takes every harness away, once, with a reason (D38)', async () => {
  const file = tmpState(); const r = fakeRedirector(); const events = []
  const sw = mk(r, file, { onEvent: (e) => events.push(e) })
  await sw.on()
  fs.writeFileSync(file, '{ torn')
  const res = await sw.reloadIfChanged()
  assert.deepEqual([res.changed, [...res.turnedOff].sort(), sw.anyOn(), r.calls], [true, ['claude-code', 'codex'], false, ['attach', 'detach']])
  assert.equal((await sw.reloadIfChanged()).changed, false)
  const fails = events.filter((e) => e.event === 'failure')
  assert.deepEqual([fails.length, fails[0].where, fails[0].code], [1, 'state', 'state-unparsable'])
  assert.deepEqual(checkRecord(fails[0]), [])
})

test('switch: a reload that turns nothing off leaves the links and the table alone; a reload that turns a harness off writes one switch event', async () => {
  const file = tmpState(); const r = fakeRedirector(); const events = []; let hooked = 0
  const sw = mk(r, file, { onEvent: (e) => events.push(e), reconcile: async () => { hooked++ } })
  await sw.on(); events.length = 0
  rewrite(file, (st) => { st.harnesses.codex.policy = 'all' }) // an edit that takes nothing away
  const same = await sw.reloadIfChanged()
  assert.deepEqual([same.changed, same.turnedOff, hooked, r.calls, sw.state().harnesses.codex.policy], [true, [], 0, ['attach'], 'all'], 'the policy is adopted, the hook is for what is taken away')
  rewrite(file, (st) => { st.harnesses.codex.desired = 'off' })
  await sw.reloadIfChanged()
  const sws = events.filter((e) => e.event === 'switch')
  assert.deepEqual([hooked, sws.length, sws[0].desired, sws[0].actual, /codex/.test(sws[0].reason)], [1, 1, 'on', 'on', true])
  assert.deepEqual(checkRecord(sws[0]), [])
})

test('switch: off hands the harnesses it turned off to the reconcile hook before it detaches, and keeps what the hook returns', async () => {
  const r = fakeRedirector(); const order = []
  const detach = r.detach; r.detach = async () => { order.push('detach'); return detach() }
  const sw = mk(r, tmpState(), { reconcile: async ({ turnedOff }) => { order.push(`reconcile ${turnedOff.join(',')}`); return { unwatched: [4242], failed: [] } } })
  await sw.on()
  const part = await sw.off({ harnesses: ['codex'] })
  assert.deepEqual([order, part.unwatched, part.desired], [['reconcile codex'], [4242], 'on'])
  const all = await sw.off()
  assert.deepEqual([order.slice(1), all.unwatched, all.desired, all.actual], [['reconcile claude-code', 'detach'], [4242], 'off', 'off'])
  const again = await sw.off()
  assert.deepEqual([again.noop, order.slice(3)], [true, ['reconcile ']], 'nothing left to turn off: no detach, but the hook runs for an `off` request — repeating it confirms (and retries) the table')
})

test('switch: a harness that is not known is still recorded as asked, and on / off of a named harness leaves the others as they were', async () => {
  const file = tmpState(); const r = fakeRedirector()
  const sw = mk(r, file)
  await sw.on({ harnesses: ['codex'] })
  assert.deepEqual([desiredIn(file), r.calls], [{ codex: 'on' }, ['attach']])
  await sw.on({ harnesses: ['claude-code'] })
  assert.deepEqual([desiredIn(file), sw.isRecording('codex'), sw.isRecording('claude-code'), sw.isRecording(null), sw.isRecording('nope')], [{ codex: 'on', 'claude-code': 'on' }, true, true, false, false])
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  await sw.on({ harnesses: ['codex'] })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before, 'asking for what is already so does not move any updated_at')
})

// D40 (RFC 4.6 §引擎 解密策略) on D39's per-harness state.json: the default decrypt policy is `all`; what is written on disk is respected
// (an old default `auto` cannot be told from a chosen one), so only an entry with NO policy gets `all`.
test('D40 default policy: no state file, or no policy written → all; an entry that says auto keeps auto; an unreadable file reads as the default', async () => {
  const dir = path.dirname(tmpState())
  fs.mkdirSync(dir, { recursive: true })
  const at = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(body)); return f }
  const pol = (f, onError) => readState(f, onError, { installed: ['codex'] }).harnesses.codex.policy
  const fresh = createSwitch({ redirector: fakeRedirector(), stateFile: path.join(dir, 'absent.json'), installed: () => ['codex'], onEvent: () => {} })
  assert.equal((await fresh.report()).harnesses.codex.policy, 'all', 'a fresh install: no file, no entry, the default')
  assert.equal(pol(at('nopolicy.json', { version: 1, desired: 'on', extra_hosts: [] })), 'all', 'a version 1 state that never named one')
  assert.equal(pol(at('auto.json', { version: 1, desired: 'on', policy: 'auto', extra_hosts: [] })), 'auto', 'written auto is kept')
  assert.equal(pol(at('all.json', { version: 1, desired: 'on', policy: 'all' })), 'all')
  assert.equal(pol(at('v2-auto.json', { version: 2, updated_at: 'T0', harnesses: { codex: { desired: 'on', policy: 'auto', updated_at: 'T0' } } })), 'auto', 'a version 2 entry that says auto keeps it')
  assert.equal(pol(at('v2-none.json', { version: 2, updated_at: 'T0', harnesses: { codex: { desired: 'on', updated_at: 'T0' } } })), 'all', 'a version 2 entry without one')
  const errs = []; const torn = path.join(dir, 'torn.json'); fs.writeFileSync(torn, '{ torn')
  assert.equal(pol(torn, (e) => errs.push(e)), 'all'); assert.equal(errs.length, 1, 'an unreadable file is still reported')
  // the first `on` of a fresh install writes `all`; a later `on` without a policy keeps what is there
  const stateFile = path.join(dir, 'fresh', 'state.json')
  await createSwitch({ redirector: fakeRedirector(), stateFile, installed: () => ['codex'], onEvent: () => {} }).on()
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).harnesses.codex.policy, 'all')
  const old = at('old-install.json', { version: 1, desired: 'off', policy: 'auto', extra_hosts: [] })
  const sw = createSwitch({ redirector: fakeRedirector(), stateFile: old, installed: () => ['codex'], onEvent: () => {} })
  assert.equal((await sw.on()).harnesses.codex.policy, 'auto', 'turning on does not change the policy of an install that wrote one')
  assert.equal((await sw.on({ policy: 'all' })).harnesses.codex.policy, 'all', 'the operator can still choose')
})
