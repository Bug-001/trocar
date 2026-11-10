// driver-setup.test.mjs — V91 on Linux (4.11 P4b, 4.6 「这个 harness 装好了没有」, D65④, D38): the one setup judgement over driver-mode data. One form per harness,
// present = a place of the descriptor's own footprint (`present`) is there, a `{ command }` over the user's recorded PATH; carriers = the install-phase
// manifest items, no root-missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { driverPresent, driverSetup } from '../../src/collector/driver-setup.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { newManifest, saveManifest, readManifest, writeOwnedFile, applyJsonKey } from '../../src/collector/core/trust/journal.mjs'
import { collectorHome } from '../../src/paths.mjs'
import { collectorDir, USER_PATH_FILE } from '../../src/off/paths.mjs'
import { recordUserPath, presentEnvNames } from '../../src/off/user-path.mjs'
import { resolveLoc } from '../../src/off/loc.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { POSIX_WORLD } from '../helpers/platform-shape.mjs'

const OS = 'linux'
const collectorOf = (home) => collectorHome(path.join(home, '.trocar'))
const ownedOf = (home) => path.join(home, 'fx-plugin.mjs')
const jsonOf = (home) => path.join(home, 'fx.json')
const KEYS = ['env', 'CA']

// a harness whose certificate is one file trocar owns and one key in the agent's config, for as long as the agent's directory is there
const FX = { name: 'fx', present: [{ base: 'home', dir: '.fx' }], inject: (ctx) => (fs.existsSync(path.join(ctx.home, '.fx'))
  ? { owned: [{ path: ownedOf(ctx.home), role: 'plugin', data: 'trocar plugin\n' }], entries: [{ kind: 'json-key', path: jsonOf(ctx.home), keys: KEYS, value: path.join(ctx.collectorDir, 'ca', 'trocar-ca.pem') }] }
  : { notes: ['fx has not run for this user'] }) }

/** A home with the install's own records for fx (`item` none = install placed nothing), read back from disk as `status` reads them. */
function installed({ present, item, seen }) {
  const home = tmpDir('trocar-driver-setup-')
  const dir = collectorOf(home)
  if (present) fs.mkdirSync(path.join(home, '.fx'))
  const m = newManifest()
  m.install = { state: 'complete', pending: [], harnesses: seen ? ['fx'] : [] }
  if (item !== 'none') {
    writeOwnedFile({ dir, manifest: m, harness: 'fx', role: 'plugin', phase: 'install', file: ownedOf(home), data: 'trocar plugin\n' })
    applyJsonKey({ dir, manifest: m, harness: 'fx', phase: 'install', file: jsonOf(home), keys: KEYS, value: path.join(dir, 'ca', 'trocar-ca.pem'), home })
  }
  saveManifest(dir, m)
  if (item === 'owned-changed') fs.writeFileSync(ownedOf(home), 'the harness\'s own update\n')
  if (item === 'owned-deleted') fs.unlinkSync(ownedOf(home))
  if (item === 'key-replaced') fs.writeFileSync(jsonOf(home), JSON.stringify({ env: { CA: '/the/user/own.pem' } }))
  if (item === 'json-deleted') fs.unlinkSync(jsonOf(home))
  return { home, manifest: readManifest(dir) }
}

const LOSS = { none: 'carrier-absent', intact: null, 'owned-changed': 'carrier-overwritten', 'owned-deleted': 'carrier-absent', 'key-replaced': 'carrier-overwritten', 'json-deleted': 'carrier-absent' }

test('V91-L1 · 4.6: per cell — an absent form needs nothing; none or deleted → carrier-absent, changed or replaced → carrier-overwritten, form = the harness name, never a root-missing', () => {
  for (const present of [true, false]) for (const item of Object.keys(LOSS)) for (const seen of [true, false]) {
    if (!seen && item !== 'none') continue // install never saw it: it placed nothing for it
    const { home, manifest } = installed({ present, item, seen })
    const what = present ? LOSS[item] : null
    const want = what ? ['needed', [{ form: 'fx', what }]] : ['ready', []]
    const s = driverSetup(FX, { os: OS, home, env: {}, manifest })
    assert.deepEqual([s.state, s.missing], want, JSON.stringify({ present, item, seen }))
  }
})

test('V91-L2 · D38: an install record or a carrier file that cannot be read gives unknown with a reason, never ready', () => {
  const { home, manifest } = installed({ present: true, item: 'intact', seen: true })
  const denied = { ...fs, readFileSync: (f, ...a) => { if (f === ownedOf(home)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  for (const s of [
    driverSetup(FX, { os: OS, home, env: {}, manifest: { error: 'EACCES' } }),
    driverSetup(FX, { os: OS, home, env: {}, manifest, fs: denied }),
  ]) {
    assert.equal(s.state, 'unknown')
    assert.deepEqual(s.missing, [])
    assert.ok(s.reason)
  }
})

const denyAll = (paths) => ({ ...fs, readFileSync: (f, ...a) => { if (paths.includes(String(f))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } })

test('V91-L3 · 4.6: real descriptors × footprint present/absent × carrier none / installed / gone / unreadable', { skip: POSIX_WORLD }, async () => {
  const all = await loadHarnesses()
  const s = await installedHome({ names: all.map((d) => d.name) })
  const manifest = s.manifest()
  for (const real of all.filter((d) => typeof d.inject === 'function')) {
    const d = { ...real, present: [{ base: 'home', dir: `.fp-${real.name}` }] }
    const own = [...manifest.entries, ...manifest.files].filter((x) => x.harness === d.name && x.phase === 'install' && x.path)
    const paths = [...new Set(own.map((x) => x.path))]
    assert.ok(paths.length, `${d.name}: install placed a carrier`)
    const none = { ...manifest, entries: manifest.entries.filter((x) => x.harness !== d.name), files: manifest.files.filter((x) => x.harness !== d.name) }
    for (const present of [true, false]) {
      const fp = path.join(s.home, `.fp-${d.name}`)
      if (present) fs.mkdirSync(fp); else fs.rmSync(fp, { recursive: true, force: true })
      const at = (m, o = {}) => ({ ...driverSetup(d, { os: OS, home: s.home, env: s.sh.env, manifest: m, ...o }), cell: `${d.name} present=${present}` })
      const cells = { none: at(none), installed: at(manifest), unreadable: at(manifest, { fs: denyAll(paths) }) }
      const bytes = paths.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null])
      for (const f of paths) fs.rmSync(f, { force: true })
      cells.gone = at(manifest)
      for (const [f, b] of bytes) if (b) fs.writeFileSync(f, b)
      if (!present) { for (const c of Object.values(cells)) assert.deepEqual([c.state, c.missing], ['ready', []], c.cell); continue }
      assert.deepEqual([cells.none.state, cells.none.missing], ['needed', [{ form: d.name, what: 'carrier-absent' }]], cells.none.cell)
      assert.deepEqual([cells.installed.state, cells.installed.missing], ['ready', []], cells.installed.cell)
      assert.equal(cells.gone.state, 'needed', cells.gone.cell)
      for (const x of cells.gone.missing) assert.ok(x.form === d.name && ['carrier-overwritten', 'carrier-absent'].includes(x.what), cells.gone.cell)
      assert.equal(cells.unreadable.state, 'unknown', cells.unreadable.cell)
      assert.ok(cells.unreadable.reason, cells.unreadable.cell)
    }
  }
})

test('V91-L4 · 4.11 present: a { command } resolves over the PATH recorded in user-path.json, not the asker\'s; with none recorded, over the asker\'s', async () => {
  const all = (await loadHarnesses()).filter((d) => typeof d.inject === 'function')
  const withCmd = all.filter((d) => d.present.some((p) => p && 'command' in p))
  for (const d of withCmd) {
    const cmd = d.present.find((p) => p && 'command' in p).command
    const bin = tmpDir('trocar-driver-bin-')
    fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\n', { mode: 0o755 })
    const listed = (home, PATH) => driverPresent({ os: OS, home, env: { PATH }, harnesses: [d] })[d.name]
    const record = (home, PATH) => { fs.mkdirSync(collectorDir(home), { recursive: true }); fs.writeFileSync(path.join(collectorDir(home), USER_PATH_FILE), JSON.stringify({ PATH })) }
    let home = tmpDir('trocar-driver-setup-'); record(home, bin)
    assert.deepEqual(listed(home, '/nowhere'), [d.name], d.name)
    home = tmpDir('trocar-driver-setup-'); record(home, '/nowhere')
    assert.deepEqual(listed(home, bin), [], d.name)
    home = tmpDir('trocar-driver-setup-')
    assert.deepEqual(listed(home, bin), [d.name], d.name)
  }
  assert.ok(withCmd.some((d) => d.name === 'codex'))
})

// 4.6 「谁问都一样」: a footprint place a variable moves resolves by the value the terminal recorded, whichever env the asker (CLI, or the daemon
// started by the login service without the user's shell variables) has. Axes: every `present` <loc> with `env` × where the variable is set.
test('V91-L5 · 4.6 present: a place moved by a variable gives one answer to the terminal and to the daemon, by the recorded value', async () => {
  const all = (await loadHarnesses()).filter((d) => typeof d.inject === 'function')
  const moved = all.flatMap((d) => d.present.filter((p) => p && typeof p.env === 'string').map((p) => [d, p]))
  for (const [d, p] of moved) {
    for (const setIn of ['terminal', 'daemon']) {
      const home = tmpDir('trocar-driver-setup-'), to = path.join(home, 'moved-place')
      fs.mkdirSync(path.join(resolveLoc(p, { os: OS, home, cwd: home, env: { [p.env]: to } })[0]), { recursive: true }) // the agent's footprint, at the moved place only
      saveManifest(collectorOf(home), newManifest()) // installed: a terminal command records
      const terminal = { PATH: '', ...(setIn === 'terminal' ? { [p.env]: to } : {}) }, daemon = { PATH: '', ...(setIn === 'daemon' ? { [p.env]: to } : {}) }
      recordUserPath({ home, env: terminal, names: presentEnvNames(all) })
      const inHome = { ...fs, existsSync: (f) => String(f).startsWith(home) && fs.existsSync(f) }
      const ask = (env) => driverPresent({ os: OS, home, env, harnesses: [d], fs: inHome })[d.name]
      const want = setIn === 'terminal' ? [d.name] : [] // the user's own shell is the truth
      assert.deepEqual([ask(terminal), ask(daemon)], [want, want], `${d.name} ${p.env} set in the ${setIn}`)
    }
  }
  assert.ok(moved.length > 0)
})

test('4.6 presence on the real descriptors: none is there over an empty HOME', async () => {
  const harnesses = await loadHarnesses()
  const home = tmpDir('trocar-driver-setup-'), inHome = { ...fs, existsSync: (f) => String(f).startsWith(home) && fs.existsSync(f) } // the host's own /opt never answers
  const got = driverPresent({ os: OS, home, env: {}, harnesses, fs: inHome })
  for (const d of harnesses.filter((x) => typeof x.inject === 'function')) assert.deepEqual(got[d.name], [], d.name)
})
