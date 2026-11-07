// test/cli/status-autostart.test.mjs — RFC 1.6 §3.5 Login line, 附录 C.3 `autostart`, 附录 B `autostart-missing` (D61): `status` asks the arch unit's
// `registered()` — the question `on` asks — and anything but a proven `present` is said with `trocar install`; `unknown` keeps its reason (D38).
// Sandbox HOME where install and on have run, an injected unit (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, reply, asDaemon, SOCK } from './fixtures/status-ctx.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { runStatusCli, statusDoc } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { entryState } from '../../src/collector/net-deps.mjs'

const unitAnswering = (q) => ({ name: 'trocar-collector.service', registered: () => q })
const CASES = [
  [{ state: 'present' }, { code: null, command: null }, 0],
  [{ state: 'absent' }, { code: 'autostart-missing', command: 'trocar install' }, 1],
  [{ state: 'disabled' }, { code: 'autostart-missing', command: 'trocar install' }, 1],
  [{ state: 'unknown', err: 'no systemd --user answered: Failed to connect to bus' }, { code: null, command: 'trocar install' }, 3],
]

test('D61: a masked unit: one way out, trocar install, which says it replaces the mask', async () => {
  const s = await installedHome()
  const q = { state: 'disabled', how: 'masked' }
  const r = await runStatus(s, ['--json'], { request: asDaemon(reply()), deps: { unit: unitAnswering(q) } })
  const a = r.io.json().autostart
  assert.deepEqual([a.state, a.code, a.command, 'first' in a], ['disabled', 'autostart-missing', 'trocar install', false])
  assert.match(a.reason, /masked/)
  assert.doesNotMatch(a.reason, /unmask/)
  assert.match(entryState('linux', null, q), /masked/)
  assert.doesNotMatch(entryState('linux', null, { state: 'disabled' }), /masked/)
})

test('D61: status --json says the login entry as registered() answers it; absent / disabled are a problem fixed by trocar install, unknown keeps its reason', async () => {
  const s = await installedHome()
  for (const [q, want, exit] of CASES) {
    const j = await runStatus(s, ['--json'], { request: asDaemon(reply()), deps: { unit: unitAnswering(q) } })
    const a = j.io.json().autostart
    assert.ok(a, `the document carries autostart (${q.state})`)
    assert.deepEqual([a.state, a.code, a.command], [q.state, want.code, want.command], JSON.stringify(a))
    assert.equal(typeof a.entry, 'string')
    if (q.state === 'present') assert.equal(a.reason, null)
    else assert.equal(typeof a.reason, 'string')
    if (q.err) assert.ok(a.reason.includes(q.err), `unknown says its reason: ${a.reason}`)
    assert.equal(j.exit, exit, `exit for ${q.state}`)
    const t = await runStatus(s, [], { request: asDaemon(reply()), deps: { unit: unitAnswering(q) } })
    assert.equal(t.exit, j.exit, 'the text run exits as the --json run does')
    const at = t.text.search(/^\s*Login\b/m), block = at < 0 ? '' : t.text.slice(at).split(/\n(?=\S|\s*\n|\s{2}\S)/)[0].replace(/\s+/g, ' ') // the Login row with its wrapped lines
    if (q.state === 'present') assert.equal(at, -1, t.text)
    else { assert.ok(block.includes('trocar install'), t.text); if (q.err) assert.ok(block.includes(q.err), t.text) }
  }
})

test('D61: with no install record there is nothing to ask: autostart is null and registered() is never called', async () => {
  const home = tmpDir('trocar-fresh-')
  const io = fakeIo()
  let asked = 0
  await runStatusCli(['--json'], { io, home, platform: 'linux', env: { HOME: home }, deps: { request: asDaemon(reply()), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), exec: () => ({ status: 0, stdout: '', stderr: '' }), unit: { registered: () => { asked++; return { state: 'absent' } } } } })
  assert.equal(io.json().autostart, null)
  assert.equal(asked, 0)
})

test('D61: doctor shows autostart-missing with trocar install when the entry is gone; none when it is there', async () => {
  const s = await installedHome()
  const doc = async (q) => {
    const io = fakeIo()
    await runDoctor(['--json'], { io, home: s.home, platform: 'linux', env: { ...s.sh.env }, deps: { spawn: absentSpawn, has: () => true, request: asDaemon(reply()), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice', exec: s.sys.exec.run, unit: unitAnswering(q) } })
    return io.json().findings.filter((f) => f.code === 'autostart-missing')
  }
  for (const q of [{ state: 'absent' }, { state: 'disabled' }, { state: 'unknown', err: 'launchctl print did not run (timeout)' }]) {
    const f = await doc(q)
    assert.equal(f.length, 1, q.state)
    assert.equal(f[0].class, 'problem')
    assert.deepEqual(f[0].commands.map((c) => c.run), ['trocar install'])
  }
  assert.deepEqual(await doc({ state: 'present' }), [])
})

test('D61 / D38: status <harness> exits 1 / 3 for the login entry and its detail says why, with trocar install', async () => {
  const s = await installedHome()
  for (const q of [{ state: 'absent' }, { state: 'unknown', err: 'launchctl print did not run (timeout)' }]) {
    const t = await runStatus(s, ['codex'], { request: asDaemon(reply()), deps: { unit: unitAnswering(q) } })
    const at = t.text.search(/^\s*Login\b/m)
    assert.ok(at >= 0, `the detail has the Login row (${q.state}):\n${t.text}`)
    const block = t.text.slice(at).replace(/\s+/g, ' ')
    assert.ok(block.includes('trocar install'), t.text)
    if (q.err) assert.ok(block.includes(q.err), t.text)
  }
})

test('1.6 §3.5: the worker asks registered() once and again when the install record changes or after 60 s; the CLI asks every time', async () => {
  const s = await installedHome()
  let asked = 0, now = Date.parse('2026-11-07T12:00:00Z')
  const unit = { name: 'trocar-collector.service', registered: () => { asked++; return { state: 'present' } } }
  const deps = (o = {}) => ({ request: asDaemon(reply()), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), user: 'alice', exec: s.sys.exec.run, unit, ms: () => now, platform: 'linux', ...o })
  const worker = () => statusDoc({ home: s.home, env: { ...s.sh.env }, platform: 'linux', deps: deps({ loginCache: true }) })
  await worker(); await worker()
  assert.equal(asked, 1, 'two worker polls, one question')
  const man = path.join(s.dir, 'install-manifest.json')
  fs.utimesSync(man, new Date(now), new Date(now + 5000))
  await worker()
  assert.equal(asked, 2, 'the install record changed: asked again')
  now += 61_000
  await worker()
  assert.equal(asked, 3, '60 s later: asked again (an outside change)')
  asked = 0
  await statusDoc({ home: s.home, env: { ...s.sh.env }, platform: 'linux', deps: deps() }); await statusDoc({ home: s.home, env: { ...s.sh.env }, platform: 'linux', deps: deps() })
  assert.equal(asked, 2, 'the CLI asks each time')
})
