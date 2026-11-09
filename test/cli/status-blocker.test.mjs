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

async function status(w, argv, table = []) {
  const r = { pid: 99, doors: w.doors, harnesses: { 'z-code': { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => (w.app && p === APP) || (String(p).startsWith(w.home + path.sep) && fs.existsSync(p)) }
  await runStatusCli(argv, { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => table, spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: w.store, user: 'alice', fs: fsx } })
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
      const together = ['z-code.desktop'] // on macOS the desktop's agent is the app's Helper, the CLI forms other program files (ZCode 3.14.4 measured): judged alone
      // a setting not read leaves the desktop not known; a form judged with it is forwarded either way, so then the harness is not captured
      assert.equal(x.captured, s.captured === null && together.length > 1 ? false : s.captured, `harness verdict: ${JSON.stringify([x.captured, x.reason])}`)
      const desk = x.forms.find((f) => f.form === 'z-code.desktop')
      assert.ok(desk, JSON.stringify(x.forms.map((f) => f.form)))
      assert.equal(desk.route && desk.route.reason, s.reason)
      assert.ok(String(desk.route.at).includes('setting.json'), JSON.stringify(desk.route))
      // the door judges a process against the forms its program file may be (collector.mjs judge → judgedForms, 4.11 P11), so a blocker on one of them
      // keeps those from being decrypted and no other: status says so for each of them, never "points at trocar" beside a door that splices. On macOS the
      // desktop's agent is the app's Helper, so the CLI forms are judged apart and stay routed (a CLI spliced by the desktop's setting: mac test machine)
      for (const f of x.forms) assert.equal(f.route && f.route.reason, together.includes(f.form) ? s.reason : undefined, `${f.form}: ${JSON.stringify(f.route)}`)
      for (const f of x.forms.filter((y) => y.form !== 'z-code.desktop' && y.route)) assert.equal(f.route.form, 'z-code.desktop', 'a co-judged form names the form whose blocker it is')
      // a co-judged form's entry is written: its connections reach the door, which forwards them unread (the CLI's flows on a macOS test machine: splice,
      // not-routed), so its branch has trocar on the path, forwarded only, and is not captured; the blocked desktop itself goes direct (measured)
      const t = j.topology['z-code'], node = new Map(t.nodes.map((n) => [n.id, n]))
      for (const b of t.branches) {
        const via = b.path.map((id) => node.get(id)).filter((n) => n.trocar)
        if (b.form === 'z-code.desktop') { assert.equal(via.length, 0, `the desktop has no trocar hop: ${JSON.stringify(b)}`); continue }
        if (together.includes(b.form)) assert.deepEqual([b.on_path, b.captured, via.map((n) => n.mode)], [true, false, ['forward-only']], `${b.form}: ${JSON.stringify(b)}`)
        else assert.ok(b.on_path === true && b.captured !== false && via.every((n) => n.mode !== 'forward-only'), `${b.form} is judged apart: ${JSON.stringify(b)}`)
      }
      const text = await status(w, ['z-code'])
      assert.doesNotMatch(text.split('\n')[0], /, captured$/, text.split('\n')[0])
      const block = text.slice(text.indexOf('  Forms'), text.indexOf('  Routes'))
      const desktop = block.split('\n').find((l) => l.startsWith('  z-code.desktop'))
      assert.match(desktop, s.reason === 'blocker' ? /route\s+not routed/ : /route\s+unknown/, desktop) // the blocked form's own line leads with the route verdict
      const row = (f) => block.slice(block.indexOf(`  ${f} `)).split(/\n  (?=\S)/)[0].replace(/\s+/g, ' ')
      const routes = text.slice(text.indexOf('  Routes')).split('\n'), route = (f) => { const i = routes.findIndex((l) => l.includes(`new processes (${f})`)); return /->/.test(routes[i]) ? routes[i] : routes[i + 1] } // a long path folds under its label
      assert.doesNotMatch(row('z-code.desktop'), /points at trocar/)
      assert.doesNotMatch(route('z-code.desktop'), /trocar/)
      for (const f of ['z-code.cli', 'z-code.cli-node']) {
        if (together.includes(f)) { // its row and its route say what the door does: forwarded only, and why
          assert.match(row(f), /route forwarded only/)
          if (s.reason === 'blocker') assert.match(row(f), /cannot tell it from z-code\.desktop/)
          assert.match(route(f), /z-code -> trocar :\d+ \(forwarded only\) -> /)
        } else { assert.match(row(f), /points at trocar/); assert.doesNotMatch(route(f), /forwarded only/) }
      }
      assert.ok(!block.includes(w.home), 'HOME paths print as ~')
      // §1.1⑥ over the Why value (Fix and Check list one step a line): a line is laid out at the width it is printed with, so within a sentence the next line's first word never fits after it
      const head = text.slice(0, text.indexOf('  Fix')).split('\n'), col = head[2].search(/\S/) + head[2].trimStart().search(/\s{2,}\S/) + head[2].trimStart().match(/\s{2,}/)[0].length
      for (let i = 2; i + 1 < head.length; i++) {
        const next = head[i + 1].slice(col), word = next.trimStart().split(' ').slice(0, next.trimStart().startsWith('trocar ') ? 2 : 1).join(' ') // `trocar <word>` is one word (§1.1⑥)
        if (!head[i + 1].slice(0, col).trim() && next && !/^\s/.test(next) && !/[.:]$/.test(head[i])) assert.ok(head[i].length + 1 + word.length > 80, `"${word}" fits after "${head[i].trim()}"`)
      }
    } finally { try { fs.chmodSync(SETTING(w.home), 0o600) } catch {} }
  })
}

// the door tells the Node CLI from the desktop by its program file (4.11 P11 `exe`), whether or not the app is installed: an npm-only Z-Code (no app,
// only ~/.zcode) with the desktop's setting left behind is not kept off trocar, and status says so
test('4.11 P11 · status: with the desktop app absent, a desktop setting left behind keeps the Node CLI on trocar', async () => {
  const w = await zcodeWorld(SHAPES.set.write, { app: false })
  const x = JSON.parse(await status(w, ['--json', 'z-code'])).harnesses['z-code']
  assert.deepEqual(x.forms.map((f) => f.form), ['z-code.cli-node'], 'only the Node CLI is here')
  assert.equal(x.forms[0].route, undefined, JSON.stringify(x.forms[0].route))
  assert.notEqual(x.captured, false, `${x.captured} ${x.reason}`)
  assert.match((await status(w, ['z-code'])).replace(/\s+/g, ' '), /z-code\.cli-node .*points at trocar/)
})


// 4.11 P11 in status, per process, as the door judges it: a process the door judges as several forms is forwarded when any of them is blocked
// (the door needs every form to decrypt). The seed: on a Windows test machine (ZCode 3.14.5) the desktop's Chromium network service, ZCode.exe with
// neither the desktop's nor the CLI's word, read captured while the desktop's CA setting was set; the door would judge it as the CLI and the desktop.
test('4.11 P11 · status: a process on a blocked form and an unblocked one is not captured, as at the door', async () => {
  const { judgeHarness, routeOfForms } = await import('../../src/netenv/verdict.mjs')
  const { judgedForms } = await import('../../src/collector/core/proxymode/verdict.mjs')
  const { loadHarnesses } = await import('../../src/collector/harness/index.mjs')
  const zc = (await loadHarnesses()).find((d) => d.name === 'z-code')
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\ZCode.exe'
  const formsOf = (argv) => judgedForms(zc, 'win32', null, exe, [exe, ...argv]).filter((f) => f.id !== 'z-code.cli-node').map((f) => f.id)
  const blocked = routeOfForms([{ id: 'z-code.desktop', route: { reason: 'blocker' } }, { id: 'z-code.cli', route: null }])
  const ready = { desired: 'on', entryIntact: true, attached: true, daemon: 'running', blocked }
  const row = (argv) => judgeHarness({ ...ready, procs: [{ pid: 12476, startedAt: new Date(Date.now() + 60_000).toISOString(), trusted: null, start: null, forms: formsOf(argv) }] }).rows[0]
  assert.deepEqual(formsOf(['--type=utility', '--utility-sub-type=network.mojom.NetworkService']), ['z-code.cli', 'z-code.desktop'], 'neither word: the door judges both')
  assert.deepEqual([row(['--type=utility', '--utility-sub-type=network.mojom.NetworkService']).captured, row(['--type=utility']).reason], [false, 'not-routed'])
  assert.equal(row(['resources\\glm\\zcode.cjs', '-p', 'hi']).captured, true, 'the CLI with -p is the CLI only: the desktop setting does not reach it')
  assert.deepEqual([row(['resources\\glm\\zcode.cjs', 'app-server']).captured, row(['resources\\glm\\zcode.cjs', 'app-server']).reason], [false, 'not-routed'])
})

// The same per route: the door judges a process against the forms of the route it came in on. Claude Code's CLI and VS Code forms share the settings
// route, its desktop is on the library route. A process status can tie to one route takes that route's word; one that may be on either, with the routes
// disagreeing, is not known (never captured on a guess), and says which way each goes.
test('4.11 P11 · status: a process is judged per route, as the door judges it; routes that disagree leave it not known', async () => {
  const { judgeHarness, routeOfForms } = await import('../../src/netenv/verdict.mjs')
  const { loadHarnesses } = await import('../../src/collector/harness/index.mjs')
  const cc = (await loadHarnesses()).find((d) => d.name === 'claude-code')
  const routeOf = Object.fromEntries(cc.proxyMode.forms.map((f) => [f.id, f.route]))
  const ready = { desired: 'on', entryIntact: true, attached: true, daemon: 'running', routeOf }
  const row = (blockedIds, forms) => judgeHarness({ ...ready, blocked: routeOfForms(blockedIds.map((id) => ({ id, route: { reason: 'blocker' } }))), procs: [{ pid: 7, trusted: null, start: null, forms }] }).rows[0]
  const SETTINGS = ['claude-code.cli', 'claude-code.vscode'], DESKTOP = ['claude-code.desktop']
  assert.deepEqual([row(DESKTOP, SETTINGS).captured, row(DESKTOP, SETTINGS).split], [true, undefined], "the CLI by name: the desktop's policy is on another route")
  assert.equal(row(SETTINGS, DESKTOP).captured, true, "the reverse: a managed proxy for the CLI does not reach the desktop's route")
  assert.deepEqual([row(SETTINGS, SETTINGS).captured, row(SETTINGS, SETTINGS).reason], [false, 'not-routed'])
  const both = row(DESKTOP, [...SETTINGS, ...DESKTOP])
  assert.deepEqual([both.captured, both.reason, both.split], [null, null, { decrypted: SETTINGS, forwarded: DESKTOP }], 'either route: not known')
  assert.deepEqual([row([...SETTINGS, ...DESKTOP], [...SETTINGS, ...DESKTOP]).captured], [false], 'every route forwards it')
  const gone = judgeHarness({ ...ready, entryIntact: false, blocked: routeOfForms([{ id: DESKTOP[0], route: { reason: 'blocker' } }]), procs: [{ pid: 7, trusted: null, start: null, forms: [...SETTINGS, ...DESKTOP] }] }).rows[0]
  assert.deepEqual([gone.captured, gone.reason], [false, 'entry-missing'], 'not known by route gives way to a certain no after it')
})

// The same through `status` and its drawing: a Z-Code process status cannot tie to one form (its program file not read: every form of the one route),
// with the desktop's CA setting set, reads not captured, and the CLI form's branch draws what the door does with it: through trocar's door, forwarded only.
test('4.11 P11 · status: a process on a blocked form and its form\'s branch agree: not captured, through the door, forwarded only', async () => {
  const w = await zcodeWorld(SHAPES.set.write)
  const p = { pid: 4321, ppid: 1, uid: 501, startedAt: Date.now() + 60_000, exe: null, argv: ['zcode-cli'], env: () => new Map() }
  const doc = JSON.parse(await status(w, ['--json', 'z-code'], [p]))
  assert.deepEqual(doc.harnesses['z-code'].processes.map((x) => [x.pid, x.captured, x.reason]), [[4321, false, 'not-routed']])
  const t = doc.topology['z-code'], b = t.branches.find((x) => x.form === 'z-code.cli')
  const kinds = b.path.map((id) => t.nodes.find((n) => n.id === id).kind)
  assert.deepEqual([b.on_path, b.captured, b.reason, kinds.includes('trocar-forwarder')], [true, false, 'not-routed', true], JSON.stringify(kinds))
})
