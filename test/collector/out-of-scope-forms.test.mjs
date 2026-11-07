// test/collector/out-of-scope-forms.test.mjs — 4.11 CM43: a form out of scope (`verified` reason out-of-scope, D56⑥) counts as not on the machine, for install,
// on, setup and status alike. Generated over every such form of every descriptor on each OS, in a world where it is the only one of its harness present.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { contractWorld, daemonFor, placesOf, snapshot } from '../helpers/contract-world.mjs'
import { diff, TROCAR } from '../helpers/switch-kit.mjs'
import { formsHere, outOfScope, scopeNamed } from '../../src/collector/core/proxymode/sources.mjs'
import { setupOf } from '../../src/collector/core/proxymode/status-facts.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { presentForms, outOfScopeForms, sourcesCtx } from '../../src/collector/arch/model-backends.mjs'
import { dirsOf as winDirs } from '../../src/collector/arch/win32/policy.mjs'
import { dirsOf as macDirs } from '../../src/collector/arch/darwin/policy.mjs'
import { statusSummary, statusDetail } from '../../src/cli/status-text.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'

const harnesses = (await loadHarnesses()).filter((d) => d.proxyMode)
const USER_PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'

/** One world per form: only that form placed, and the user's own certificate file set where the harness reads one (a user file install must not touch). */
async function world(os, d, f) {
  const names = (d.proxyMode.userCertFiles || []).filter((u) => u.env).map((u) => u.env)
  const w = await contractWorld({ os, env: (home) => Object.fromEntries(names.map((n) => [n, path.join(home, 'certs', 'mine.pem')])) })
  w.harnesses = harnesses
  const own = w.install
  w.install = (o) => own({ ...o, harnesses })
  if (names.length) { fs.mkdirSync(path.join(w.home, 'certs')); fs.writeFileSync(path.join(w.home, 'certs', 'mine.pem'), USER_PEM) }
  w.place(placesOf(f, w.ctx)[0])
  return w
}
const outside = (a, b) => diff(a, b).filter(({ p }) => !TROCAR.test(p))
const desiredOn = (w, h) => { try { return JSON.parse(fs.readFileSync(path.join(w.dir, 'state.json'), 'utf8')).harnesses[h]?.desired === 'on' } catch { return false } }

const cases = ['darwin', 'win32'].flatMap((os) => harnesses.flatMap((d) => d.proxyMode.forms.filter((f) => f.os.includes(os) && outOfScope(f, os)).map((f) => ({ os, d, f }))))
let alone = 0
describe('CM43: a form out of scope, alone on the machine', { concurrency: 1 }, () => {
  for (const { os, d, f } of cases) {
    it(`${os} ${f.id}`, async () => {
      const w = await world(os, d, f)
      if (formsHere(d.proxyMode, os, w.ctx).length) return // it shares its place with a covered form: that form is what is on the machine
      alone++
      const s0 = snapshot(w)
      await w.cmd.install()
      const s1 = snapshot(w)
      assert.deepEqual(outside(s0, s1), [], 'install wrote nothing of its own for it, the user\'s certificate file included')
      const m = readManifest(w.dir, fs)
      assert.ok(!m.install.harnesses.includes(d.name), 'install does not count the harness')
      assert.equal(setupOf(d, { os, manifest: m, ctx: w.ctx, fs }).state, 'ready', 'setup does not judge it')
      const daemon = await daemonFor(w)
      try {
        const named = await w.cmd.on([d.name])
        assert.deepEqual(named.on, [])
        assert.deepEqual(named.refused.map((x) => [x.harness, x.reason]), [[d.name, 'not-routed']])
        assert.ok(named.refused[0].why, 'the refusal says why')
        assert.equal(named.exit, 1)
        const all = await w.cmd.on()
        assert.deepEqual([all.on, all.refused, all.routes, all.exit], [[], [], [], 0], 'on with no names has nothing to do and that is no failure')
        // an install record of an older build counted the harness: on with no names skips it, and says so
        m.install.harnesses = [...m.install.harnesses, d.name]
        saveManifest(w.dir, m, fs)
        const old = await w.cmd.on()
        assert.deepEqual([old.on, old.refused, old.routes, old.exit], [[], [], [], 0], 'the same with an older record')
        assert.ok(old.notes.some((n) => n.harness === d.name), 'the skip is said')
        // one already on (the form went away, or an older build turned it on): skipped either way, its state not touched, no word of capture
        writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), [d.name], 'on'))
        const wasOn = await w.cmd.on([d.name])
        assert.deepEqual([wasOn.on, wasOn.refused, wasOn.routes, wasOn.exit], [[], [], [], 0], 'on <it> while it is on')
        assert.ok(wasOn.notes.some((n) => n.harness === d.name), 'the skip is said')
        assert.equal(desiredOn(w, d.name), true, 'its state stays')
        writeStateAtomic(path.join(w.dir, 'state.json'), emptyState())
      } finally { await daemon.close() }
      assert.deepEqual(daemon.asked.filter((q) => q.startsWith('POST')), [], 'the daemon was not asked to open anything')
      assert.deepEqual(outside(s1, snapshot(w)), [], 'on wrote no entry')
      assert.equal(desiredOn(w, d.name), false, 'on wrote no desired state')
      const named = scopeNamed(harnesses, os, w.ctx)
      if (f.scopeWhat) assert.deepEqual(named, [{ harness: d.name, form: f.id, what: f.scopeWhat }])
      else assert.deepEqual(named, [], 'a form that does not prove the agent is there is not named')
    })
  }
  it('some form is alone on a machine', () => assert.ok(alone > 0))
})

describe('CM43: status', () => {
  for (const [os, dirsOf] of [['darwin', macDirs], ['win32', winDirs]]) {
    for (const { d, f } of cases.filter((x) => x.os === os && x.f.scopeWhat)) {
      it(`${os} ${f.id}: present lists it not, and it is named`, async () => {
        const w = await world(os, d, f), env = w.env
        const real = sourcesCtx({ os, home: w.home, env, dirs: dirsOf(w.home, env), fs })
        const at = placesOf(f, real)[0].at
        const fsx = { ...fs, existsSync: (p) => p === at || (String(p).startsWith(w.home + path.sep) && fs.existsSync(p)) } // hermetic: only this form's place, on this machine's real paths
        assert.deepEqual((await presentForms({ os, home: w.home, env, harnesses, fs: fsx }))[d.name], [])
        assert.deepEqual(await outOfScopeForms({ os, home: w.home, env, harnesses, fs: fsx }), [{ harness: d.name, form: f.id, what: f.scopeWhat }])
      })
    }
  }
  it('the summary and the detail say what it is, as data', () => {
    const doc = { harnesses: {}, install: { harnesses: [] }, out_of_scope: [{ harness: 'h', form: 'h.app', what: 'the H app' }] }
    assert.ok(statusSummary(doc).some((l) => l.includes('the H app')), 'summary')
    assert.ok(!statusSummary(doc).some((l) => /trocar install/.test(l)), 'install cannot help: it is not the next step')
    assert.ok(statusDetail(doc, 'h').some((l) => l.includes('the H app')), 'detail')
  })
})

// The whole command, on a machine with only such an app: the receipt and the exit, at the seam a user meets.
describe('CM43: trocar on, the command', { concurrency: 1 }, () => {
  for (const { os, d, f } of cases) {
    it(`${os} ${f.id}: on with no names exits 0, says nothing is captured, starts nothing; on <it> is refused`, async () => {
      const w = await world(os, d, f)
      if (formsHere(d.proxyMode, os, w.ctx).length) return // shares its place with a covered form
      await w.cmd.install()
      const unit = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => assert.fail('not its job'), start: () => assert.fail('no daemon for nothing'), startNow: () => assert.fail('no daemon for nothing') }
      const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses, which: w.ctx.which, fs: { ...fs, existsSync: w.ctx.exists }, daemonReader: { ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {}, self: () => null, call: async () => ({ procs: [] }) }, parts: { os, harnesses, arch: { unit: { userUnit: () => unit } } } }
      const before = snapshot(w)
      const on = async (argv) => { const out = []; const io = { out: (s) => out.push(s), err: (s) => out.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }; return { exit: await runOnCli(argv, { io, env: w.env, home: w.home, platform: os, deps }), text: out.join('\n') } }
      const all = await on(['--yes'])
      assert.equal(all.exit, 0, all.text)
      if (f.scopeWhat) assert.ok(all.text.includes(f.scopeWhat), `it says what is not captured: ${all.text}`)
      const j = JSON.parse((await on(['--yes', '--json'])).text)
      assert.deepEqual([j.ok, j.harnesses, j.refused, j.undo, j.error ?? null], [true, [], [], null, null])
      const one = await on([d.name, '--yes', '--json'])
      assert.equal(one.exit, 1, one.text)
      const r = JSON.parse(one.text)
      assert.deepEqual([r.ok, r.harnesses, r.refused.map((x) => x.harness), r.error.code], [false, [], [d.name], 'not-routed'])
      assert.deepEqual(outside(before, snapshot(w)), [], 'nothing written')
    })
  }
})

// An older record: a covered form was on the machine at install and is gone now, with only the out-of-scope app left. What that install wrote still comes out.
describe('CM43: a record from before', { concurrency: 1 }, () => {
  it('uninstall undoes what install wrote, the block in the user\'s own certificate file included', async () => {
    const d = harnesses.find((x) => x.name === 'kimi-code'), f = d.proxyMode.forms.find((x) => x.scopeWhat), cli = d.proxyMode.forms.find((x) => x.id === 'kimi-code.cli')
    const w = await world('win32', d, f)
    w.place(placesOf(cli, w.ctx)[0])
    const mine = path.join(w.home, 'certs', 'mine.pem')
    await w.cmd.install()
    assert.notEqual(fs.readFileSync(mine, 'utf8'), USER_PEM, 'install added its block')
    fs.rmSync(path.join(w.home, '.kimi-code'), { recursive: true })
    assert.deepEqual(formsHere(d.proxyMode, 'win32', w.ctx), [])
    const un = await w.cmd.uninstall()
    assert.equal(fs.readFileSync(mine, 'utf8'), USER_PEM, JSON.stringify(un.receipt.problems))
  })
})

// 4.11 P5: where a harness has forms measured on this system, one that is not (verified `not-measured`) gets no entry: writing an agent's config for a form never
// measured there can break it. Generated: every harness × OS with a measured form and an unmeasured one that can be on the machine alone.
const unmeasured = ['darwin', 'win32'].flatMap((os) => harnesses.flatMap((d) => {
  const here = d.proxyMode.forms.filter((f) => f.os.includes(os) && !outOfScope(f, os))
  return here.some((f) => f.verified && f.verified[os] === true) ? here.filter((f) => !(f.verified && f.verified[os] === true)).map((f) => ({ os, d, f })) : []
}))
describe('P5: a form not measured on this system, alone on the machine', { concurrency: 1 }, () => {
  let alone = 0
  for (const { os, d, f } of unmeasured) {
    it(`${os} ${f.id}`, async () => {
      const w = await world(os, d, f)
      const measured = formsHere(d.proxyMode, os, w.ctx).filter((x) => x.verified && x.verified[os] === true)
      if (measured.length) return // it shares its place with a measured form: that one is what is on the machine
      alone++
      await w.cmd.install()
      assert.ok(!readManifest(w.dir).install.harnesses.includes(d.name), 'install does not count the harness')
      const s1 = snapshot(w)
      const daemon = await daemonFor(w)
      try {
        const named = await w.cmd.on([d.name])
        assert.deepEqual([named.on, named.refused.map((x) => [x.harness, x.reason]), named.exit], [[], [[d.name, 'not-routed']], 1])
      } finally { await daemon.close() }
      assert.deepEqual(outside(s1, snapshot(w)), [], 'on wrote no entry')
      assert.equal(desiredOn(w, d.name), false)
    })
  }
  it('some unmeasured form is alone on a machine', () => assert.ok(alone > 0, `of ${unmeasured.map((x) => x.f.id).join(', ')}`))
})
