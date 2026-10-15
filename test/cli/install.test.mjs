// `asight install` (RFC 1.6 §1.1, §1.6): its own command; root refused before anything is read; a v2 manifest refused before any write;
// no terminal and no --yes → the plan only, exit 2, nothing written; --yes → the model install, its receipt and an install-note; exit 0 / 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { resolveAlias, commandNamed } from '../../src/cli/commands.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { MODEL_ON_WIRED } from '../../src/collector/model-install.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

function fakeIo({ tty = false } = {}) {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: tty }, stdout: { isTTY: tty }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
async function cli(argv, { tty = false, over = {} } = {}) {
  const w = await modelWorld({ commands: ['codex'] })
  const io = fakeIo({ tty })
  const deps = { getuid: () => 501, modelOnWired: true, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...over }
  const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { w, io, exit }
}

test('install is a command of its own, and `collector install` is its hidden alias (no longer `on`)', () => {
  assert.ok(commandNamed('install'))
  assert.deepEqual(resolveAlias(['collector', 'install', '--yes']).argv, ['install', '--yes'])
  assert.deepEqual(resolveAlias(['install']).argv, ['install'], 'install is no alias of on')
})

test('1.6 §1.6: as root, install refuses before it reads anything — exit 1, no ~/.asight', async () => {
  const { w, exit } = await cli(['--yes'], { over: { getuid: () => 0 } })
  assert.equal(exit, 1)
  assert.equal(fs.existsSync(path.join(w.home, '.asight')), false)
})

test('1.6 §1.6: no terminal and no --yes → the plan (cost and residual-risk lines) and exit 2, nothing written; --dry-run → exit 0, nothing written', async () => {
  const a = await cli([])
  assert.equal(a.exit, 2)
  assert.match(a.io.text(), /代价:证书在时/); assert.match(a.io.text(), /剩余风险:/); assert.match(a.io.text(), /codex\.cli/)
  assert.equal(fs.existsSync(path.join(a.w.home, '.asight', 'collector', 'install-manifest.json')), false)
  const b = await cli(['--dry-run'])
  assert.equal(b.exit, 0)
  assert.equal(fs.existsSync(path.join(b.w.home, '.asight', 'collector', 'install-manifest.json')), false)
})

test('4.11 ⑰: a version 2 manifest is refused before any write — exit 1, the file as it was', async () => {
  const w = await modelWorld()
  const f = path.join(w.home, '.asight', 'collector', 'install-manifest.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: [], files: [] }))
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501, modelOnWired: true } }), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2)
})

test('install --yes --json: the receipt (fingerprint, carriers, residual risk, commands) and an install-note; exit 0; a declined root store → exit 1', async () => {
  const { w, io, exit } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual([r.command, r.ok, typeof r.fp256, r.commands.includes('asight uninstall')], ['install', true, 'string', true])
  const day = fs.readdirSync(path.join(w.dir, 'flows')).find((n) => n.endsWith('.ndjson'))
  assert.ok(fs.readFileSync(path.join(w.dir, 'flows', day), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.event === 'install-note' && e.kind === 'result'))
  w.store.answer = 'declined'
  const again = await cli(['--yes'])
  again.w.store.answer = 'declined'
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: again.w.env, home: tmpHomeOf(again.w), platform: 'darwin', deps: { getuid: () => 501, modelOnWired: true, backends: { custody: again.w.custody, rootStore: again.w.store, dirs: again.w.ctx.dirs }, harnesses: [], owns: again.w.owns } }), 1)
})
const tmpHomeOf = () => tmpDir('asight-model-2-') // a second HOME, made where the leak guard sweeps

// the high finding of the branch review: until `asight on` on macOS / Windows is turnOnModel, install there would leave the old on unable to
// start (its loadOrCreateCa refuses an asight-ca.pem without ca.key). So install refuses there, writes nothing, and says to run on.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: until the model on is wired, install refuses (exit 1), writes nothing and says to run asight on`, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const io = fakeIo()
    assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps: { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, dirs: w.ctx.dirs }, harnesses: w.harnesses, owns: w.owns } }), 1)
    assert.match(io.text(), /直接跑 asight on/)
    assert.equal(fs.existsSync(path.join(w.home, '.asight')), false)
    assert.deepEqual([w.custody.calls, w.store.calls], [[], []])
  })
  // the documented order — install, then on — through the CLI, the gate forced open. While MODEL_ON_WIRED is false this pins the very failure the gate
  // exists for (the old on refuses the model install's root); the commit that flips it makes the same test demand that on starts.
  test(`${platform}: install then on through the CLI (temp HOME, stub backends) — ${MODEL_ON_WIRED ? 'on starts' : 'the old on cannot start over it: why install refuses'}`, async () => {
    const { runOnCli } = await import('../../src/cli/on.mjs')
    const { fakeDaemon, recordingExec, ROOTS } = await import('./fixtures/on-ctx.mjs')
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const deps = { getuid: () => 501, modelOnWired: true, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns }
    const io = fakeIo()
    assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
    const io2 = fakeIo()
    const exit = await runOnCli(['--yes'], { io: io2, env: w.env, home: w.home, platform, deps: { ...deps, exec: recordingExec().run, roots: ROOTS, parts: { os: platform, harnesses: w.harnesses.filter((d) => d.name === 'codex'), scan: async () => [], match: () => ({ agent: null }), arch: { osRoots: async () => ({ pem: ROOTS.osText }) } }, request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true, freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice' } })
    if (!MODEL_ON_WIRED) { assert.equal(exit, 1); assert.match(io2.text(), /CA is unusable.*ca\.key/); return }
    assert.doesNotMatch(io2.text(), /ca\.key|CA is unusable/, 'the old on refusing the model install\'s root (the finding)')
    assert.equal(exit, 0, io2.text())
  })
}
