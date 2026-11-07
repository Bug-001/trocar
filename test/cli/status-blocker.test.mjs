// test/cli/status-blocker.test.mjs — 4.11 ⑩ in `status`: a form a blocker keeps off trocar's route is not captured, and the document and the text say so —
// the harness's verdict (the headline) and the form's own row read the one route verdict the topology and the findings read. A blocker that cannot be read
// is not known, never captured (D38). The seed: on a macOS test machine Z-Code's desktop CA setting (`httpProxyCaCertPath`) kept the desktop off the door
// while `status` said "on, captured" and the desktop form "points at trocar". Every OS fact is injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'

const APP = '/Applications/ZCode.app' // the desktop app's place on macOS (the descriptor's `present`): the one path outside HOME this world says is there
const SETTING = (home) => path.join(home, '.zcode', 'v2', 'setting.json')

async function zcodeWorld(setting) {
  const w = await modelWorld({ os: 'darwin' })
  const inner = w.ctx.exists
  w.ctx.exists = (p) => p === APP || inner(p)
  fs.mkdirSync(path.join(w.home, '.zcode', 'cli'), { recursive: true })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  setting(w)
  await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['z-code'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), ['z-code'], 'on'))
  return w
}

async function status(w, argv) {
  const r = { pid: 99, doors: {}, harnesses: { 'z-code': { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => p === APP || (String(p).startsWith(w.home + path.sep) && fs.existsSync(p)) }
  await runStatusCli(argv, { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: w.store, user: 'alice', fs: fsx } })
  return io.stdoutText()
}

const SHAPES = {
  // the setting names a CA file: the desktop's agent goes direct (measured), its siblings stay on the shared route
  set: { write: (w) => { fs.mkdirSync(path.dirname(SETTING(w.home)), { recursive: true }); fs.writeFileSync(SETTING(w.home), JSON.stringify({ httpProxyCaCertPath: path.join(w.home, 'ca.pem') })) }, captured: false, reason: 'blocker' },
  // the setting file cannot be read: whether the desktop goes direct is not known
  unreadable: { write: (w) => { fs.mkdirSync(path.dirname(SETTING(w.home)), { recursive: true }); fs.writeFileSync(SETTING(w.home), '{}'); fs.chmodSync(SETTING(w.home), 0o000) }, captured: null, reason: 'blocker-unreadable' },
}

for (const [shape, s] of Object.entries(SHAPES)) {
  test(`4.11 ⑩ · status: a blocked form (${shape}) — the harness verdict and the form's row say what the route plan found, never "captured" / "points at trocar"`, async (t) => {
    if (shape === 'unreadable' && process.getuid && process.getuid() === 0) return t.skip('root reads a mode-000 file')
    const w = await zcodeWorld(s.write)
    try {
      const j = JSON.parse(await status(w, ['--json', 'z-code']))
      assert.deepEqual(validateReceipt(j), [], 'the document validates')
      const x = j.harnesses['z-code']
      assert.equal(x.captured, s.captured, `harness verdict: ${JSON.stringify([x.captured, x.reason])}`)
      const desk = x.forms.find((f) => f.form === 'z-code.desktop')
      assert.ok(desk, JSON.stringify(x.forms.map((f) => f.form)))
      assert.equal(desk.route && desk.route.reason, s.reason)
      assert.ok(String(desk.route.at).includes('setting.json'), JSON.stringify(desk.route))
      for (const f of x.forms.filter((y) => y.form !== 'z-code.desktop')) assert.equal(f.route, undefined, `${f.form} stays on the route`)
      const text = await status(w, ['z-code'])
      assert.doesNotMatch(text.split('\n')[0], /, captured$/, text.split('\n')[0])
      const block = text.slice(text.indexOf('  Forms'), text.indexOf('  Routes'))
      const deskRows = block.slice(block.indexOf('z-code.desktop')).split('\n').slice(0, 4).join('\n')
      assert.doesNotMatch(deskRows.slice(deskRows.indexOf('proxy')), /^proxy\s+points at trocar/, deskRows)
    } finally { try { fs.chmodSync(SETTING(w.home), 0o600) } catch {} }
  })
}
