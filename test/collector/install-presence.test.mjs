// install-presence.test.mjs — 4.6 「这个 harness 装好了没有」 on install (D65④, D38): install places carriers only for a harness whose own footprint
// (`present`) is here; an absent one gets no file and stays out of install.harnesses; carriers already in the manifest stay until uninstall.
// Generated over the real descriptors, each given a footprint the test controls (`.fp-<name>`), in the seven-homes layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { installCollector, planOn, turnOn } from '../../src/collector/install.mjs'
import { driverCtx, driverSetup } from '../../src/collector/driver-setup.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { userUnit } from '../../src/collector/arch/linux/unit.mjs'
import { sevenHomes } from '../off/fixtures/seven-homes.mjs'
import { snapshot, fakeSystem, ROOTS } from '../cli/fixtures/on-ctx.mjs'
import { POSIX_WORLD } from '../helpers/platform-shape.mjs'

const OS = 'linux'
const REAL = (await loadHarnesses()).filter((d) => typeof d.inject === 'function')
const FP = REAL.map((d) => ({ ...d, present: [{ base: 'home', dir: `.fp-${d.name}` }] }))
// Q5: the agent is here but its inject has nothing to carry (Kimi without the installer's rc line, Codex that never ran: no home)
const STRIP = { 'kimi-code': '.bashrc', codex: '.codex' }

function box() {
  const home = tmpDir('trocar-presence-')
  const sh = sevenHomes(home)
  return { home, env: sh.env, dir: path.join(home, '.trocar', 'collector') }
}
const fpOf = (b, d) => path.join(b.home, `.fp-${d.name}`)
const place = (b, d, on) => (on ? fs.mkdirSync(fpOf(b, d), { recursive: true }) : fs.rmSync(fpOf(b, d), { recursive: true, force: true }))
const strip = (b, d) => fs.rmSync(path.join(b.home, STRIP[d.name]), { recursive: true, force: true })
const opts = (b, harnesses) => ({ home: b.home, env: b.env, osName: OS, harnesses, roots: ROOTS, freePort: async () => 47011 })
const install = (b, harnesses) => installCollector(opts(b, harnesses))
const plan = (b, harnesses) => planOn(opts(b, harnesses))
const outside = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => k !== '.trocar' && !k.startsWith('.trocar/')))
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k] && a[k] !== 'dir' && b[k] !== 'dir').sort()
/** The user files (relative to HOME, outside .trocar) the harness's own inject names here. */
const injectPaths = (b, d) => {
  const out = d.inject(driverCtx({ os: OS, home: b.home, env: b.env })) || {}
  return [...(out.entries || []), ...(out.owned || []), ...(out.files || [])].map((x) => path.relative(b.home, x.path)).filter((p) => !p.startsWith('.trocar'))
}
const itemsOf = (m, name) => [...m.entries, ...m.files].filter((x) => x.harness === name)
const harnessesOf = (b) => readManifest(b.dir).install.harnesses

test('4.6 targets: a harness is a target iff it is present with items from inject, or the manifest has its items; otherwise skipped names it', { skip: POSIX_WORLD }, async () => {
  for (const d of FP) {
    for (const cell of ['none', 'installed', ...(STRIP[d.name] ? ['q5'] : [])]) for (const present of [true, false]) {
      const b = box()
      if (cell === 'q5') strip(b, d)
      if (cell === 'installed') { place(b, d, true); await install(b, [d]) }
      place(b, d, present)
      const p = await plan(b, [d])
      const target = cell === 'installed' || (present && cell === 'none')
      const at = JSON.stringify({ h: d.name, cell, present })
      assert.equal(p.targets.includes(d.name), target, at)
      assert.equal(p.skipped.some((s) => s.what === d.name), !target, at)
    }
  }
})

test('4.6 absent: install writes no file of an absent harness, no manifest item and no install.harnesses name for it; a present one gets exactly its own inject paths', async () => {
  for (const half of [0, 1]) {
    const b = box()
    const present = FP.filter((_, i) => i % 2 === half)
    for (const d of present) place(b, d, true)
    const want = present.flatMap((d) => injectPaths(b, d))
    const before = outside(snapshot(b.home))
    await install(b, FP)
    assert.deepEqual(diff(before, outside(snapshot(b.home))), [...new Set(want)].sort())
    const m = readManifest(b.dir)
    for (const d of FP.filter((x) => !present.includes(x))) {
      assert.deepEqual(itemsOf(m, d.name), [], d.name)
      assert.ok(!m.install.harnesses.includes(d.name), d.name)
    }
  }
})

test('4.6 empty HOME, the real descriptors: every new path is under .trocar, install.harnesses is empty, no harness item in the manifest', async () => {
  const home = tmpDir('trocar-presence-empty-')
  const b = { home, env: { HOME: home }, dir: path.join(home, '.trocar', 'collector') }
  // an `abs` place is outside the temp HOME: the host's own (an /opt install on a Linux machine) would answer, so it is left out here (present-data covers it)
  await install(b, REAL.map((d) => ({ ...d, present: d.present.filter((p) => p.base !== 'abs') })))
  for (const p of Object.keys(snapshot(home))) assert.ok(p.startsWith('.trocar'), p)
  const m = readManifest(b.dir)
  assert.deepEqual(m.install.harnesses, [])
  assert.deepEqual([...m.entries, ...m.files].filter((x) => x.harness), [])
})

test('4.6 present: the HOME change outside .trocar is the paths its own inject names, and it is in install.harnesses', async () => {
  for (const d of FP) {
    const b = box()
    place(b, d, true)
    const want = injectPaths(b, d)
    assert.ok(want.length, d.name)
    const before = outside(snapshot(b.home))
    await install(b, [d])
    assert.deepEqual(diff(before, outside(snapshot(b.home))), [...new Set(want)].sort(), d.name)
    assert.ok(harnessesOf(b).includes(d.name), d.name)
  }
})

test('4.6 Q5: present, inject gives nothing — install writes no byte for it, skipped carries it with a reason, it is in install.harnesses', async () => {
  for (const d of FP.filter((x) => STRIP[x.name])) {
    const b = box()
    strip(b, d); place(b, d, true)
    assert.deepEqual(injectPaths(b, d), [], d.name)
    const skip = (await plan(b, [d])).skipped.find((s) => s.what === d.name)
    assert.ok(skip && skip.reason, d.name)
    const before = outside(snapshot(b.home))
    await install(b, [d])
    assert.deepEqual(outside(snapshot(b.home)), before, d.name)
    assert.deepEqual(itemsOf(readManifest(b.dir), d.name), [], d.name)
    assert.ok(harnessesOf(b).includes(d.name), d.name)
  }
})

test('4.6 absent after install: install again keeps its manifest items and carrier bytes, it stays a target, setup is ready', { skip: POSIX_WORLD }, async () => {
  for (const d of FP) {
    const b = box()
    place(b, d, true)
    await install(b, [d])
    const items = itemsOf(readManifest(b.dir), d.name)
    const bytes = outside(snapshot(b.home))
    place(b, d, false)
    delete bytes[`.fp-${d.name}`]
    await install(b, [d])
    const m = readManifest(b.dir)
    assert.deepEqual(itemsOf(m, d.name), items, d.name)
    assert.deepEqual(outside(snapshot(b.home)), bytes, d.name)
    assert.ok((await plan(b, [d])).targets.includes(d.name), d.name)
    assert.equal(driverSetup(d, { os: OS, home: b.home, env: b.env, manifest: m }).state, 'ready', d.name)
  }
})

test('4.6 arrives later: absent at install, its footprint made, install again places its carriers, it joins install.harnesses, the rest is byte-identical', { skip: POSIX_WORLD }, async () => {
  for (const [i, d] of FP.entries()) {
    const other = FP[(i + 1) % FP.length]
    const b = box()
    place(b, other, true)
    await install(b, [d, other])
    assert.ok(!harnessesOf(b).includes(d.name), d.name)
    place(b, d, true)
    const own = injectPaths(b, d)
    const before = outside(snapshot(b.home))
    await install(b, [d, other])
    assert.deepEqual(diff(before, outside(snapshot(b.home))), [...new Set(own)].sort(), d.name)
    assert.ok(harnessesOf(b).includes(d.name), d.name)
  }
})

test('4.6 on <absent, never installed> by name: exit 1, it is skipped, no desired on for it', { skip: POSIX_WORLD }, async () => {
  for (const [i, d] of FP.entries()) {
    const other = FP[(i + 1) % FP.length]
    const b = box()
    place(b, other, true)
    await install(b, [d, other])
    const sys = fakeSystem()
    const r = await turnOn({ ...opts(b, [d, other]), ids: [d.name], confirm: async () => true, unit: userUnit({ home: b.home, node: '/usr/bin/node', script: '/repo/bin/trocar.mjs', run: sys.exec.run }), request: sys.daemon.request, socketPath: '/x/collector.sock', sleep: async () => {}, linger: () => true, user: 'alice' })
    assert.equal(r.exit, 1, d.name)
    assert.ok(r.receipt.skipped.some((s) => s.what === d.name), d.name)
    const f = path.join(b.dir, 'state.json')
    const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { harnesses: {} }
    assert.notEqual((st.harnesses[d.name] || {}).desired, 'on', d.name)
  }
})
