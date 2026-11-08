// test/cli/status-blocker.test.mjs — 4.11 ⑩ in `status`: a form a blocker keeps off trocar's route is not captured, and the document and the text say so —
// the harness's verdict (the headline) and the form's own row read the one route verdict the topology and the findings read. A blocker that cannot be read
// is not known, never captured (D38). A form the door cannot tell apart from a blocked one on the same route (it judges a process against every form it
// may be) is spliced too, so it reads the same. The seed: on a macOS test machine Z-Code's desktop CA setting (`httpProxyCaCertPath`) kept the desktop off
// the door, and the door spliced the CLI with not-routed, while `status` said "on, captured" and both forms "points at trocar". Every OS fact is injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { judgedForms } from '../../src/collector/core/proxymode/verdict.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'

const APP = '/Applications/ZCode.app' // the desktop app's place on macOS (the descriptor's `present`): the one path outside HOME this world says is there
const SETTING = (home) => path.join(home, '.zcode', 'v2', 'setting.json')

async function zcodeWorld(setting, { app = true } = {}) {
  const w = await modelWorld({ os: 'darwin' })
  const inner = w.ctx.exists
  w.app = app
  w.ctx.exists = (p) => (app && p === APP) || inner(p)
  fs.mkdirSync(path.join(w.home, '.zcode', 'cli'), { recursive: true })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  w.doors = {} // the doors `on` opened, which the daemon then reports listening
  const opens = async (q) => { if (q.path === '/on') Object.assign(w.doors, q.body.groups); return q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} } }
  setting(w)
  await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['z-code'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), ['z-code'], 'on'))
  return w
}

async function status(w, argv) {
  const r = { pid: 99, doors: w.doors, harnesses: { 'z-code': { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => (w.app && p === APP) || (String(p).startsWith(w.home + path.sep) && fs.existsSync(p)) }
  await runStatusCli(argv, { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: w.store, user: 'alice', fs: fsx } })
  return io.stdoutText()
}

const SHAPES = {
  // the setting names a CA file: the desktop's agent goes direct (measured), its siblings stay on the shared route
  set: { write: (w) => { fs.mkdirSync(path.dirname(SETTING(w.home)), { recursive: true }); fs.writeFileSync(SETTING(w.home), JSON.stringify({ httpProxyCaCertPath: path.join(w.home, 'ca.pem') })) }, captured: false, reason: 'blocker' },
  // the setting file cannot be read: whether the desktop goes direct is not known
  unreadable: { write: (w) => { fs.mkdirSync(path.dirname(SETTING(w.home)), { recursive: true }); fs.writeFileSync(SETTING(w.home), '{}'); fs.chmodSync(SETTING(w.home), 0o000) }, captured: false, reason: 'blocker-unreadable' },
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
      // the door judges a process on a route against every verified form it may be (collector.mjs judge → judgedForms), so a blocker on one of them
      // keeps them all from being decrypted: status says so for each, never "points at trocar" beside a door that splices (mac test machine, z-code CLI)
      const desc = w.harnesses.find((d) => d.name === 'z-code')
      const together = judgedForms(desc, 'darwin', 'cli-config').map((f) => f.id)
      assert.ok(together.length > 1, `the CLI forms share the desktop's route: ${together}`)
      for (const f of x.forms) assert.equal(f.route && f.route.reason, together.includes(f.form) ? s.reason : undefined, `${f.form}: ${JSON.stringify(f.route)}`)
      for (const f of x.forms.filter((y) => y.form !== 'z-code.desktop' && y.route)) assert.equal(f.route.form, 'z-code.desktop', 'a co-judged form names the form whose blocker it is')
      // a co-judged form's entry is written: its connections reach the door, which forwards them unread (the CLI's flows on a macOS test machine: splice,
      // not-routed), so its branch has trocar on the path, forwarded only, and is not captured; the blocked desktop itself goes direct (measured)
      const t = j.topology['z-code'], node = new Map(t.nodes.map((n) => [n.id, n]))
      for (const b of t.branches) {
        const via = b.path.map((id) => node.get(id)).filter((n) => n.trocar)
        if (b.form === 'z-code.desktop') { assert.equal(via.length, 0, `the desktop has no trocar hop: ${JSON.stringify(b)}`); continue }
        assert.deepEqual([b.on_path, b.captured, via.map((n) => n.mode)], [true, false, ['forward-only']], `${b.form}: ${JSON.stringify(b)}`)
      }
      const text = await status(w, ['z-code'])
      assert.doesNotMatch(text.split('\n')[0], /, captured$/, text.split('\n')[0])
      const block = text.slice(text.indexOf('  Forms'), text.indexOf('  Routes'))
      const desktop = block.split('\n').find((l) => l.startsWith('  z-code.desktop'))
      assert.match(desktop, s.reason === 'blocker' ? /route\s+not routed/ : /route\s+unknown/, desktop) // the blocked form's own line leads with the route verdict
      assert.doesNotMatch(block, /points at trocar/, 'never "points at trocar" for a form the door splices')
      const cli = block.split('\n').find((l) => l.startsWith('  z-code.cli '))
      if (s.reason === 'blocker') assert.match(block.slice(block.indexOf(cli)).replace(/\s+/g, ' '), /cannot tell it from z-code\.desktop/, 'a co-judged form says why')
      assert.match(block.slice(block.indexOf(cli)).replace(/\s+/g, ' '), /^ ?z-code\.cli route forwarded only/, 'its row says what the door does')
      const routes = text.slice(text.indexOf('  Routes')).split('\n'), route = (f) => { const i = routes.findIndex((l) => l.includes(`new processes (${f})`)); return /->/.test(routes[i]) ? routes[i] : routes[i + 1] } // a long path folds under its label
      assert.match(route('z-code.cli'), /z-code -> trocar :\d+ \(forwarded only\) -> /)
      assert.doesNotMatch(route('z-code.desktop'), /trocar/)
      assert.match(text.slice(0, text.indexOf('  Fix')).replace(/\s+/g, ' '), /forwarded only/, 'the Why says the connections reach trocar')
      assert.ok(!block.includes(w.home), 'HOME paths print as ~')
      // §1.1⑥ over the Why value (Fix and Check list one step a line): a line is laid out at the width it is printed with, so within a sentence the next line's first word never fits after it
      const head = text.slice(0, text.indexOf('  Fix')).split('\n'), col = head[2].search(/\S/) + head[2].trimStart().search(/\s{2,}\S/) + head[2].trimStart().match(/\s{2,}/)[0].length
      for (let i = 2; i + 1 < head.length; i++) {
        const next = head[i + 1].slice(col), word = next.trimStart().split(' ')[0]
        if (!head[i + 1].slice(0, col).trim() && next && !/^\s/.test(next) && !/[.:]$/.test(head[i])) assert.ok(head[i].length + 1 + word.length > 80, `"${word}" fits after "${head[i].trim()}"`)
      }
    } finally { try { fs.chmodSync(SETTING(w.home), 0o600) } catch {} }
  })
}

// the door judges the route's verified forms whether or not their programs are here: an npm-only Z-Code (no app, only ~/.zcode) with the desktop's
// setting left behind is spliced too, so status says so (until the door judges absent forms no more)
test('4.11 ⑩ · status: with the desktop app absent, the desktop setting still keeps the form that is here from being decrypted, and status says so', async () => {
  const w = await zcodeWorld(SHAPES.set.write, { app: false })
  const x = JSON.parse(await status(w, ['--json', 'z-code'])).harnesses['z-code']
  assert.deepEqual(x.forms.map((f) => f.form), ['z-code.cli-node'], 'only the Node CLI is here')
  assert.deepEqual([x.forms[0].route && x.forms[0].route.reason, x.forms[0].route && x.forms[0].route.form], ['blocker', 'z-code.desktop'])
  assert.equal(x.captured, false)
})
