// driver-setup.test.mjs — V91 on Linux (4.11 P4b, 4.6 「这个 harness 装好了没有」, D65④, D38): the one setup judgement over driver-mode data. One form per harness,
// present = `inject` gives at least one item, carriers = the install-phase manifest items, no root-missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { driverPresent, driverSetup } from '../../src/collector/driver-setup.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { newManifest, saveManifest, readManifest, writeOwnedFile, applyJsonKey } from '../../src/collector/core/trust/journal.mjs'
import { collectorHome } from '../../src/paths.mjs'

const OS = 'linux'
const collectorOf = (home) => collectorHome(path.join(home, '.trocar'))
const ownedOf = (home) => path.join(home, 'fx-plugin.mjs')
const jsonOf = (home) => path.join(home, 'fx.json')
const KEYS = ['env', 'CA']

// a harness whose certificate is one file trocar owns and one key in the agent's config, for as long as the agent's directory is there
const FX = { name: 'fx', inject: (ctx) => (fs.existsSync(path.join(ctx.home, '.fx'))
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

test('V91-L2 · D38: an install record, a carrier file or an inject that cannot be read gives unknown with a reason, never ready', () => {
  const { home, manifest } = installed({ present: true, item: 'intact', seen: true })
  const denied = { ...fs, readFileSync: (f, ...a) => { if (f === ownedOf(home)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  const boom = { name: 'fx', inject: () => { throw new Error('unparsable config') } }
  for (const s of [
    driverSetup(FX, { os: OS, home, env: {}, manifest: { error: 'EACCES' } }),
    driverSetup(FX, { os: OS, home, env: {}, manifest, fs: denied }),
    driverSetup(boom, { os: OS, home, env: {}, manifest }),
  ]) {
    assert.equal(s.state, 'unknown')
    assert.deepEqual(s.missing, [])
    assert.ok(s.reason)
  }
})

test('V91-L3 · 4.6: a harness is listed with its one form when inject gives an item, and with none when it gives only notes', () => {
  for (const present of [true, false]) {
    const { home } = installed({ present, item: 'none', seen: true })
    assert.deepEqual(driverPresent({ os: OS, home, env: {}, harnesses: [FX, { name: 'no-inject' }] }), { fx: present ? ['fx'] : [] })
  }
})

test('4.6 presence on the real descriptors: Z-Code is not there over an empty HOME, and is once its config file exists', async () => {
  const harnesses = await loadHarnesses()
  const home = tmpDir('trocar-driver-setup-')
  assert.deepEqual(driverPresent({ os: OS, home, env: {}, harnesses })['z-code'], [])
  fs.mkdirSync(path.join(home, '.zcode', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(home, '.zcode', 'cli', 'config.json'), '{}')
  assert.deepEqual(driverPresent({ os: OS, home, env: {}, harnesses })['z-code'], ['z-code'])
})
