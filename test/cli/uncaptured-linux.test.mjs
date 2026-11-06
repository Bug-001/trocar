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

const all = await loadHarnesses()
const withUncaptured = all.filter((d) => typeof d.inject === 'function' && (d.uncaptured || []).length)
const exec = () => ({ status: 0, stdout: '', stderr: '' })
const deps = { exec, netFactsDeps: async () => ({ harnesses: all, archFacts: linuxNetFacts }) }
const flat = (t) => t.replace(/\s+/g, ' ')
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
      assert.ok(flat((await runStatus(s, [d.name], { deps })).text).includes(u.why))
      assert.ok(flat((await runStatus(s, [], { deps })).text).includes(u.why))
    })
  }
}

test('load refuses a malformed uncaptured', async () => {
  const base = all.find((d) => typeof d.inject === 'function')
  const src = pathToFileURL(path.resolve('src/collector/harness', `${base.name}.mjs`)).href
  const ok = { form: 'x.y', present: [{ base: 'home', path: '.x' }], why: 'a reason' }
  for (const bad of [{}, [{ ...ok, why: '' }], [{ ...ok, form: 1 }], [{ ...ok, present: [] }], [{ ...ok, present: [{ perOs: {} }] }]]) {
    const dir = tmpDir('trocar-uncap-')
    fs.writeFileSync(path.join(dir, 'h.mjs'), `import d from ${JSON.stringify(src)}\nexport default { ...d, uncaptured: ${JSON.stringify(bad)} }\n`)
    await assert.rejects(loadHarnesses(pathToFileURL(dir + '/')), /uncaptured/, JSON.stringify(bad))
  }
  const dir = tmpDir('trocar-uncap-')
  fs.writeFileSync(path.join(dir, 'h.mjs'), `import d from ${JSON.stringify(src)}\nexport default { ...d, uncaptured: [${JSON.stringify(ok)}] }\n`)
  assert.equal((await loadHarnesses(pathToFileURL(dir + '/'))).length, 1)
})
