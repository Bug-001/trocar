// test/cli/status-forms-absent.test.mjs — 4.11 P5 「一个 harness 没有装着的形态时不写入口,`status` 说它没装」: in proxy mode a harness that is on but has
// none of its forms of this OS on the machine (descriptor `present`) is never `captured` — none of its routes or certificate carriers can apply, so
// whatever runs under its name (another install, such as an npm build the descriptor's `present` does not name) does not go through trocar. Generated
// axis: every harness with proxy-mode forms on macOS, with no process and with one process of it; the seed is the Kimi Code npm build on a
// macOS test machine (no ~/.kimi-code/bin/kimi: `status` said captured, the door recorded nothing). Every OS fact is injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'

/** `status --json <h>` with the daemon up and attached for `h`, its memory empty: `h`'s processes are judged from the disk. */
async function status(w, os, h, table, cmd = runStatusCli) {
  const r = { pid: 99, doors: {}, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const request = async (q) => (q.path === '/status' ? r : assert.fail(q.path))
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) } // hermetic: the dev machine's /Applications never makes a form present
  const exit = await cmd(['--json', h], { io, home: w.home, platform: os, env: w.env, deps: { request, socketPath: SOCK, procs: async () => table, spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: w.store, user: 'alice', fs: fsx } })
  return { exit, j: JSON.parse(io.stdoutText()) }
}

/** A world where trocar is installed (one present harness, so install has something), `h` was turned on, and none of `h`'s forms is present. */
async function world(os, h) {
  const w = await modelWorld({ os, commands: [] })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  await turnOnModel({ os, home: w.home, env: w.env, ids: [h], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), [h], 'on'))
  return w
}

const OSES = ['darwin'] // the judgement is OS-neutral (presentForms per OS, judgeHarness); the daemon stub here answers the way the macOS control socket does

test('4.11 P5: a harness that is on with none of its forms here is not captured (not-routed), with and without a process of it', async () => {
  const { loadHarnesses } = await import('../../src/collector/harness/index.mjs')
  const all = await loadHarnesses()
  let n = 0
  for (const os of OSES) {
    for (const d of all.filter((x) => x.proxyMode && x.proxyMode.forms.some((f) => f.os.includes(os)))) {
      const w = await world(os, d.name)
      const name = d.processes.names.find((x) => !x.entry && !x.args) // a plain name match of the harness, started after everything trocar wrote
      const tables = [[], ...(name ? [[{ pid: 4100, ppid: 1, uid: 501, startedAt: Date.now() + 60_000, exe: path.join(w.home, 'elsewhere', name.name), argv: [name.name], env: () => new Map() }]] : [])]
      for (const table of tables) {
        const { exit, j } = await status(w, os, d.name, table)
        const x = j.harnesses[d.name]
        assert.ok(x, `${os} ${d.name}: a row`)
        assert.equal(x.captured, false, `${os} ${d.name} (${table.length} process): not captured`)
        assert.equal(x.reason, 'not-routed', `${os} ${d.name}`)
        for (const p of x.processes) assert.deepEqual([p.captured, p.reason], [false, 'not-routed'], `${os} ${d.name} pid ${p.pid}`)
        assert.equal(exit, EXIT.incomplete, `${os} ${d.name}: exit 1`)
        n++
      }
    }
  }
  assert.ok(n > 10, 'the axis is generated over the descriptors')
})

test('4.11 P5 seed: Kimi Code with only its npm build is not captured, also beside its VS Code extension; the finding says to install a form of it', async () => {
  // the npm build puts `kimi` on PATH, none of Kimi's forms (its installer's program, the extension, the desktop app) is it
  const w = await modelWorld({ os: 'darwin', commands: ['kimi'] })
  const ext = path.join(w.home, '.vscode', 'extensions', 'moonshot-ai.kimi-code-0.4.1')
  fs.mkdirSync(ext, { recursive: true })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  assert.equal((await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['kimi-code'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), ['kimi-code'], 'on'))
  const npm = { pid: 4200, ppid: 1, uid: 501, startedAt: Date.now() + 60_000, exe: '/usr/local/bin/node', argv: ['node', '/usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'], env: () => new Map() }
  const said = (x) => x.processes.map((p) => [p.pid, p.captured, p.reason])
  // the extension there: its own row is captured, the npm process is on none of its forms
  { const x = (await status(w, 'darwin', 'kimi-code', [])).j.harnesses['kimi-code']; assert.equal(x.captured, true, `the extension alone: captured (${x.reason})`) }
  const beside = await status(w, 'darwin', 'kimi-code', [npm])
  assert.deepEqual(said(beside.j.harnesses['kimi-code']), [[4200, false, 'not-routed']])
  assert.equal(beside.j.harnesses['kimi-code'].captured, false)
  // the extension removed, trocar's VS Code entry still intact: nothing of Kimi's that trocar sets up is here
  fs.rmSync(path.join(w.home, '.vscode'), { recursive: true, force: true })
  for (const table of [[], [npm]]) {
    const { exit, j } = await status(w, 'darwin', 'kimi-code', table)
    const x = j.harnesses['kimi-code']
    assert.deepEqual([x.captured, x.reason], [false, 'not-routed'], `${table.length} process`)
    assert.deepEqual(said(x), table.map((p) => [p.pid, false, 'not-routed']))
    assert.equal(exit, EXIT.incomplete)
    const dj = (await status(w, 'darwin', 'kimi-code', table, runDoctor)).j
    const f = (dj.findings || []).find((y) => y.code === 'not-routed' && y.harness === 'kimi-code')
    assert.ok(f, 'a not-routed finding for kimi-code')
    assert.ok(f.commands.some((c) => c.run === 'trocar install'), 'its fix runs install once a form is there')
  }
})

test('V32 order: no form here comes after the daemon\'s own verdict on a process and before the entry; not known stays not known', async () => {
  const { judgeHarness } = await import('../../src/cli/status.mjs')
  const ready = { desired: 'on', attached: true, daemon: 'running', installedAt: 1 }
  for (const entryIntact of [true, false, null]) {
    assert.deepEqual(judgeHarness({ ...ready, entryIntact, formsHere: false }).rows, [{ captured: false, reason: 'not-routed' }], `entry ${entryIntact}`)
    assert.equal(judgeHarness({ ...ready, entryIntact, formsHere: false, procs: [{ pid: 7, trusted: true }] }).captured, true, 'the door decrypted it: captured')
    assert.equal(judgeHarness({ ...ready, entryIntact: true, formsHere: null }).captured, null)
  }
  assert.equal(judgeHarness({ ...ready, desired: 'off', entryIntact: true, formsHere: false }).rows[0].reason, 'desired-off')
})
