// status-setup-linux.test.mjs — driver mode (Linux) judges each harness's setup the same way as proxy mode (4.11 P4b, 4.6 「这个 harness 装好了没有」, 1.6 §3.5 · C.3, V91):
// `harnesses[h].setup` of `status --json` and of GET /control/status, over a sandbox HOME where install and on really ran, and the listing of a harness found on this machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, down, SOCK } from './fixtures/status-ctx.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { VERBS } from '../../src/control/board.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { seedFootprint } from '../helpers/footprint.mjs'
import { resolveLoc } from '../../src/off/loc.mjs'

const all = await loadHarnesses()
const exec = () => ({ status: 0, stdout: '', stderr: '' }) // `ss`: no listener
const world = () => installedHome({ names: ['claude-code', 'z-code'], seed: (home) => fs.rmSync(path.join(home, '.zcode'), { recursive: true, force: true }) })
const depsOf = (s) => ({ exec, netFactsDeps: async () => ({ harnesses: s.descs || all, archFacts: linuxNetFacts }) })
const json = async (s, names = []) => { const r = await runStatus(s, ['--json', ...names], { deps: depsOf(s) }); return JSON.parse(r.text) }
const setup = (j, h) => { const x = j.harnesses[h].setup; return { state: x.state, missing: x.missing } }
const editJson = (f, edit) => { const v = JSON.parse(fs.readFileSync(f, 'utf8')); edit(v); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n') }
const forms = (j) => Object.values(j.harnesses).flatMap((h) => (h.setup && h.setup.missing) || [])

test('V91-S1: setup on Linux reads the carriers install wrote, per harness', async () => {
  const s = await world()
  let j = await json(s, ['claude-code'])
  assert.deepEqual(setup(j, 'claude-code'), { state: 'ready', missing: [] })

  const settings = path.join(s.home, '.claude', 'settings.json')
  const before = fs.readFileSync(settings)
  editJson(settings, (v) => { v.env.NODE_EXTRA_CA_CERTS = '/x.pem' })
  j = await json(s, ['claude-code'])
  assert.deepEqual(setup(j, 'claude-code'), { state: 'needed', missing: [{ form: 'claude-code', what: 'carrier-overwritten' }] })

  fs.rmSync(settings)
  j = await json(s, ['claude-code'])
  assert.deepEqual(setup(j, 'claude-code'), { state: 'needed', missing: [{ form: 'claude-code', what: 'carrier-absent' }] })
  fs.writeFileSync(settings, before)

  fs.mkdirSync(path.join(s.home, '.zcode', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(s.home, '.zcode', 'cli', 'config.json'), '{\n  "model": "lab/m"\n}\n')
  j = await json(s)
  assert.deepEqual(setup(j, 'z-code'), { state: 'needed', missing: [{ form: 'z-code', what: 'carrier-absent' }] })
  assert.ok(!forms(j).some((x) => x.form === null), 'no root-missing in driver mode')
})

test('V91-S2: an unreadable install manifest gives setup unknown with a reason, never ready (D38)', async () => {
  const s = await world()
  fs.writeFileSync(path.join(s.dir, 'install-manifest.json'), '{not json')
  const j = await json(s, ['claude-code', 'z-code'])
  for (const [h, x] of Object.entries(j.harnesses)) {
    assert.equal(x.setup.state, 'unknown', h)
    assert.ok(typeof x.setup.reason === 'string' && x.setup.reason.length > 0, h)
  }
})

const homePlaces = (d, home, env) => d.present.filter((p) => p && p.base === 'home').flatMap((p) => resolveLoc(p, { os: 'linux', home, env }))
const unseed = (d, home, env) => { for (const f of homePlaces(d, home, env)) fs.rmSync(f, { recursive: true, force: true }) }

test('1.6 §3.5 listing over harness × footprint: with no names a harness is listed when present or known to the install record; named it always is; trocar not installed adds none', async () => {
  const s = await installedHome({ names: ['claude-code'], seed: (home, sh) => { for (const d of all) if (d.name !== 'claude-code') unseed(d, home, sh.env) } })
  const deps = { exec, netFactsDeps: async () => ({ harnesses: all, archFacts: linuxNetFacts }) }
  const get = async (names = []) => JSON.parse((await runStatus(s, ['--json', ...names], { deps })).text).harnesses
  for (const d of all.filter((x) => x.name !== 'claude-code')) {
    assert.ok(!(d.name in await get()), `${d.name} absent`)
    assert.ok(d.name in await get([d.name]), `${d.name} absent, named`)
    seedFootprint(s.home, [d], s.sh.env)
    assert.ok(d.name in await get(), `${d.name} present`)
    unseed(d, s.home, s.sh.env)
  }
  unseed(all.find((x) => x.name === 'claude-code'), s.home, s.sh.env)
  const cc = (await get())['claude-code']
  assert.deepEqual({ state: cc.setup.state, missing: cc.setup.missing }, { state: 'ready', missing: [] })

  const bare = { home: tmpDir('trocar-st-bare-'), sh: { env: {} }, sys: { exec: { run: exec } } }
  seedFootprint(bare.home, all)
  assert.deepEqual(Object.keys(JSON.parse((await runStatus(bare, ['--json'], { deps })).text).harnesses), [])
})

test('V91-S3: GET /control/status gives the very setup status --json gives (4.4 §控制面)', async () => {
  const s = await world()
  fs.mkdirSync(path.join(s.home, '.zcode', 'cli'), { recursive: true })
  fs.writeFileSync(path.join(s.home, '.zcode', 'cli', 'config.json'), '{}\n')
  const env = { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') }
  const j = await json(s)
  const full = { request: down(), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), user: 'alice', ...depsOf(s), platform: 'linux', env }
  const r = await VERBS.status(null, { home: path.join(s.home, '.trocar'), deps: full })
  assert.deepEqual(r.doc.harnesses.map((x) => x.harness).sort(), Object.keys(j.harnesses).sort())
  for (const { harness, setup: x } of r.doc.harnesses) assert.deepEqual(x, j.harnesses[harness].setup, harness)
})
