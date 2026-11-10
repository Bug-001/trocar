// uncaptured-linux.test.mjs — a driver-mode form trocar does not capture (descriptor `uncaptured`, 4.6 「不采的形态」, 1.6 §3.5 · C.3) is said, never
// silent (D38): its places absent → nothing; one there → install records a harness-note, `on` (named or bare) carries it in its notes, `status --json`
// lists it in `harnesses[h].setup.uncaptured` and the text says the descriptor's own reason. Generated from the descriptors; no harness named.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedHome, flowEvents } from '../off/fixtures/off-ctx.mjs'
import { runStatus } from './fixtures/status-ctx.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { resolveLoc } from '../../src/off/loc.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { uncapturedOf } from '../../src/collector/core/proxymode/sources.mjs'
import { driverCtx } from '../../src/collector/driver-setup.mjs'
import { fakeIo, onCtx } from './fixtures/on-ctx.mjs'

const all = await loadHarnesses()
const withUncaptured = all.filter((d) => typeof d.inject === 'function' && (d.uncaptured || []).length)
const exec = () => ({ status: 0, stdout: '', stderr: '' })
const deps = { exec, netFactsDeps: async () => ({ harnesses: all, archFacts: linuxNetFacts }) }
const flat = (t) => t.replace(/\s+/g, ' ')
const notesFor = (d, u, notes) => notes.filter((n) => n.startsWith(`${d.name}: `) && n.includes(u.why))
/** The harness's own footprint taken away (the fixture's home layout may carry it). */
const unseed = (d, home, env) => { for (const p of d.present.filter((x) => x.base === 'home')) for (const f of resolveLoc(p, { os: 'linux', home, env, readdir: listDir })) fs.rmSync(f, { recursive: true, force: true }) }
const listDir = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
/** Each place of the form made there: a glob place gets one entry it matches. → the paths made. */
const seedPlaces = (u, home, env) => u.present.filter((p) => p.base === 'home').map((p) => {
  const at = resolveLoc({ ...p, glob: undefined }, { os: 'linux', home, env, readdir: listDir })[0]
  const f = p.glob ? path.join(at, p.glob.replace(/\*/g, '1.0.0')) : at
  fs.mkdirSync(f, { recursive: true })
  return f
})

test('every descriptor with uncaptured has at least one', () => assert.ok(withUncaptured.length > 0))

for (const d of withUncaptured) {
  test(`${d.name}: no uncaptured place here → no note, setup.uncaptured empty`, async () => {
    const s = await installedHome({ names: [d.name] })
    const whys = d.uncaptured.map((u) => u.why)
    assert.ok(!flowEvents(s.dir).some((e) => whys.some((w) => String(e.reason).includes(w))))
    const r = await s.on({ ids: [d.name] })
    assert.ok(!r.receipt.notes.some((n) => whys.some((w) => n.includes(w))))
    const j = JSON.parse((await runStatus(s, ['--json', d.name], { deps })).text)
    assert.deepEqual(j.harnesses[d.name].setup.uncaptured, [])
  })

  for (const u of d.uncaptured) {
    test(`${d.name}: ${u.form} there → install records it, on says it, status lists it`, async () => {
      let made = []
      const s = await installedHome({ names: [d.name], seed: (home, sh) => { made = seedPlaces(u, home, sh.env) } })
      assert.ok(made.length)
      const rec = flowEvents(s.dir).filter((e) => e.harness === d.name && e.code === 'harness-note' && e.reason.includes(u.why))
      assert.ok(rec.length >= 1) // install, and the fixture's first on
      for (const f of made) assert.ok(rec[0].reason.includes(f), f)
      for (const ids of [[d.name], null]) {
        const r = await s.on({ ids })
        assert.ok(r.receipt.notes.some((n) => n.startsWith(`${d.name}: `) && n.includes(u.why)), JSON.stringify(ids))
      }
      const j = JSON.parse((await runStatus(s, ['--json', d.name], { deps })).text)
      assert.deepEqual(j.harnesses[d.name].setup.uncaptured, [{ form: u.form, why: u.why, paths: made }])
      assert.equal(j.harnesses[d.name].present, true)
      assert.ok(flat((await runStatus(s, [d.name], { deps })).text).includes(u.why))
      assert.ok(flat((await runStatus(s, [], { deps })).text).includes(u.why))
    })

    test(`${d.name}: only ${u.form} there, none of its own footprint → install's receipt and record say it, on says it, status lists the harness with it`, async () => {
      const home = tmpDir('trocar-uncap-only-')
      const made = seedPlaces(u, home, {})
      for (const os of ['linux', 'darwin', 'win32']) assert.equal(uncapturedOf(d, driverCtx({ os, home, env: {} })).length, u.os.includes(os) ? 1 : 0, os)
      const io = fakeIo()
      const ctx = { ...onCtx(home, io, { harnesses: [d] }), platform: 'linux' }
      ctx.deps.parts.os = 'linux' // the form is read on the OS its `os` names
      assert.equal(await runInstallCli(['--yes', '--json'], ctx), 0, io.text())
      assert.equal(notesFor(d, u, JSON.parse(io.text()).notes).length, 1)
      let s
      const before = (x) => flowEvents(x.dir).filter((e) => e.code === 'harness-note' && e.reason.includes(u.why)).length
      s = await installedHome({ names: ['claude-code'], seed: (h, sh) => { unseed(d, h, sh.env); made.splice(0, made.length, ...seedPlaces(u, h, sh.env)) } })
      const n = before(s)
      await s.install({ harnesses: [...s.descs, d] }) // nothing to write: the already-installed run records it too
      assert.equal(before(s), n + 1)
      const r = await s.on({ ids: [d.name], harnesses: [...s.descs, d] })
      assert.equal(notesFor(d, u, r.receipt.notes).length, 1)
      assert.ok(r.exit !== 0 && !r.receipt.harnesses.includes(d.name), 'on claims nothing for it')
      const j = JSON.parse((await runStatus(s, ['--json'], { deps })).text)
      assert.ok(d.name in j.harnesses, 'listed with no name given')
      assert.equal(j.harnesses[d.name].present, false)
      assert.deepEqual(j.harnesses[d.name].setup.uncaptured, [{ form: u.form, why: u.why, paths: made }])
      const text = flat((await runStatus(s, [d.name], { deps })).text)
      assert.ok(text.includes(u.why) && !text.includes(s.home), 'paths under HOME print with ~')
      assert.ok(!text.includes(`trocar on ${d.name}`), 'no fix that cannot work')
    })
  }
}

test('load refuses a malformed uncaptured', async () => {
  const base = all.find((d) => typeof d.inject === 'function')
  const src = pathToFileURL(path.resolve('src/collector/harness', `${base.name}.mjs`)).href
  const ok = { form: 'x.y', os: ['linux'], present: [{ base: 'home', path: '.x' }], why: 'a reason' }
  const bads = [{}, [{ ...ok, why: '' }], [{ ...ok, form: 1 }], [{ ...ok, os: undefined }], [{ ...ok, os: [] }], [{ ...ok, os: ['plan9'] }], [{ ...ok, present: [] }], [{ ...ok, present: [{ perOs: {} }] }]]
  for (const bad of bads) for (const inject of ['d.inject', 'undefined']) { // a descriptor without inject is checked too
    const dir = tmpDir('trocar-uncap-')
    fs.writeFileSync(path.join(dir, 'h.mjs'), `import d from ${JSON.stringify(src)}\nexport default { ...d, inject: ${inject}, uncaptured: ${JSON.stringify(bad)} }\n`)
    await assert.rejects(loadHarnesses(pathToFileURL(dir + '/')), /uncaptured/, `${JSON.stringify(bad)} inject ${inject}`)
  }
  const dir = tmpDir('trocar-uncap-')
  fs.writeFileSync(path.join(dir, 'h.mjs'), `import d from ${JSON.stringify(src)}\nexport default { ...d, uncaptured: [${JSON.stringify(ok)}] }\n`)
  assert.equal((await loadHarnesses(pathToFileURL(dir + '/'))).length, 1)
})
