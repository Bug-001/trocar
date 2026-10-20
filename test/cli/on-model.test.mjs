// test/cli/on-model.test.mjs — `trocar on` on macOS / Windows through the CLI (1.6 §1.1, §1.6): no install record → cert-not-installed,
// exit 1, nothing written and no daemon started; --dry-run prints the planned entries and writes nothing; R6 — a file beyond confirmed_paths with no
// terminal and no --yes → the plan only, exit 2; --opt-in is not the model's yet → exit 2.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { snapshot } from './fixtures/on-ctx.mjs'

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
// `registered()` is a READ (1.6 §3.3: `on` asks before it writes) — the login entry install made is there; nothing of it may be changed
const neverStarts = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => { throw new Error('the unit must not be touched') }, start: () => { throw new Error('the unit must not be touched') }, startNow: () => { throw new Error('the unit must not be touched') } }
const on = (w, os, argv, unit = neverStarts) => {
  const io = fakeIo()
  const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } }
  return runOnCli(argv, { io, env: w.env, home: w.home, platform: os, deps }).then((exit) => ({ exit, io }))
}

for (const os of ['darwin', 'win32']) {
  test(`1.6 §1.1 (${os}): on with no install record → cert-not-installed, exit 1, through the CLI; nothing written, the unit untouched`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    const { exit, io } = await on(w, os, ['--yes', '--json'])
    assert.equal(exit, 1, io.text())
    assert.equal(io.json().error.code, 'cert-not-installed')
    assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false)
  })

  test(`1.6 §1.1 · R6 (${os}): --dry-run prints the planned entry and writes nothing; no terminal and no --yes → exit 2, nothing written; --opt-in → exit 2`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const manifest = path.join(w.dir, 'install-manifest.json')
    const before = fs.readFileSync(manifest)
    const dry = await on(w, os, ['--dry-run'])
    assert.equal(dry.exit, 0, dry.io.text())
    assert.match(dry.io.text(), /codex +.*\.codex[/\\]\.env/, 'the plan names the harness and the file it would change')
    assertEnglish(dry.io.text(), 'the dry-run plan of on')
    const ask = await on(w, os, [])
    assert.equal(ask.exit, 2, ask.io.text())
    assert.match(ask.io.text(), /run it again with --yes/)
    assertEnglish(ask.io.text(), 'the refusal of on without --yes')
    assert.equal((await on(w, os, ['--opt-in', 'codex.cli'])).exit, 2)
    assert.deepEqual(fs.readFileSync(manifest), before, 'the manifest is as install left it')
    assert.equal(fs.existsSync(path.join(w.dir, 'state.json')), false, 'no desired state written')
    assert.equal(fs.existsSync(path.join(w.home, '.codex', '.env')), false, 'no entry written')
  })

  // D61 / 1.6 §3.3 (H-2): the login entry is install's, so an `on` with none would leave the agents pointing at doors nobody opens
  // after the next login — it refuses before its first write. A --dry-run says so in `blocked` and still exits 0.
  test(`1.6 §3.3 (${os}): no login entry registered → autostart-missing, exit 2, HOME byte for byte unchanged; --dry-run exits 0 with it in blocked`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const gone = { ...neverStarts, registered: () => ({ state: 'absent' }) }
    const mine = (h) => Object.fromEntries(Object.entries(snapshot(h)).filter(([k]) => !k.includes('collector/flows'))) // everything but trocar's own record of the refusal (D38: a failure is never silent)
    const before = mine(w.home)
    const r = await on(w, os, ['--yes', '--json'], gone)
    assert.deepEqual([r.exit, r.io.json().error.code, r.io.json().ok], [2, 'autostart-missing', false], r.io.text())
    assert.equal(r.io.json().undo, null, '附录 C.1: nothing was changed, so there is nothing to undo (macOS + Windows test machines 2026-10-19)')
    assert.match(r.io.json().error.message, /trocar install/)
    assert.deepEqual(mine(w.home), before, 'nothing of yours and no state of trocar\'s was written')
    assert.match(fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join(''), /"code":"autostart-missing"/, 'D38: the refusal is recorded')
    const dry = await on(w, os, ['--dry-run', '--json'], gone)
    assert.deepEqual([dry.exit, dry.io.json().blocked.map((b) => b.what)], [0, ['trocar on']], dry.io.text())
    assert.equal(dry.io.json().error, undefined, 'a dry run carries no error: nothing went wrong')
    // an answer that could not be read is not a yes either (the unit's `unknown`)
    const unreadable = await on(w, os, ['--yes', '--json'], { ...neverStarts, registered: () => ({ state: 'unknown', err: 'launchctl print did not run' }) })
    assert.deepEqual([unreadable.exit, unreadable.io.json().error.code, unreadable.io.json().undo], [2, 'autostart-missing', null], unreadable.io.text())
    assert.deepEqual(mine(w.home), before)
  })
}
