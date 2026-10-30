// test/cli/own-table.test.mjs — CM39 (spec 4.11 §3 ㉓ · §5 CM39; 4.6 安装清单与卸载): every walk starts from this copy's own harness table. Two
// identical worlds, A and B, are installed and turned on for every harness that has a form on the OS; B alone also carries records of ids its
// table does not hold — X = `<h>-next`, written as a newer trocar would write them (manifest items whose files lie under HOME/.other, liveness,
// install.harnesses, state.json, door-seen.json rows, ingress.json groups). Then the steps run in lockstep on both, and after each: B exits as A
// does (I1); B's document never names an X (I2); it names the same table ids as A's (I3); X's records and files are as they were (I4); B
// changes the same HOME paths as A (I5). Expectations come from world A and the seeded bytes. The steps are a list, run in order.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { contractWorld, daemonFor, placesOf } from '../helpers/contract-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { renderWrapper as darwinWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { renderWrapper as win32Wrapper } from '../../src/collector/arch/win32/wrapper.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { VERBS } from '../../src/control/board.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

const PE = Buffer.from('MZ\x90\x00 a native program', 'latin1') // the contract world's own native-program bytes, so a second install writes what the first did
const kitOf = (os) => (os === 'win32' ? { renderWrapper: win32Wrapper, compile: (src) => Buffer.concat([PE, Buffer.from(String(src.length))]) } : { renderWrapper: darwinWrapper })
const statePorts = (w) => Object.keys((readJson(path.join(w.dir, 'state.json')) || { harnesses: {} }).harnesses)
/** The deps status, doctor and the board read with: the world's daemon answers GET /status for every id state.json holds (B's reply carries the X)
 *  and GET /holders with one holder per such id (so the holder walk sees the X too), the process table is empty, and nothing outside HOME is seen
 *  (status-forms-absent.test.mjs). */
function readDeps(w) {
  const ids = statePorts(w)
  const r = { pid: 99, doors: {}, harnesses: Object.fromEntries(ids.map((h) => [h, { desired: 'on', attached: true }])), holders: ids.length, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) }
  return { platform: w.os, env: w.env, request: async (q) => (q.path === '/status' ? r : q.path === '/holders' ? { holders: ids.map((h, i) => ({ harness: h, pid: 500 + i })) } : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }), rootStore: w.store, user: 'alice', fs: fsx }
}
const cli = async (fn, argv, w) => { const io = fakeIo(); const exit = await fn(argv, { io, home: w.home, env: w.env, platform: w.os, deps: readDeps(w) }); return { exit, doc: JSON.parse(io.stdoutText()) } }

const STEPS = [
  { name: 'install', carriers: 'all', run: async (w) => {
    const io = fakeIo()
    // what the world's ctx sees (HOME and the apps placed on its fake machine), so the CLI judges the same forms present as the world's install did
    const inside = (p) => String(p).startsWith(w.home + path.sep)
    const fsx = { ...fs, existsSync: (p) => w.ctx.exists(p), readdirSync: (p, ...a) => (inside(p) ? fs.readdirSync(p, ...a) : w.ctx.readdir(p)) }
    const deps = { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: kitOf(w.os), dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, fs: fsx }
    const exit = await runInstallCli(['--json', '--yes'], { io, env: w.env, home: w.home, platform: w.os, deps })
    return { exit, doc: JSON.parse(io.stdoutText()) }
  } },
  { name: 'on', carriers: 'all', run: async (w, xs) => {
    // the X's door ports are held by the newer copy's engine: whatever `on` does, it must not move them
    const ing = readJson(path.join(w.dir, 'ingress.json')) || { groupPorts: {} }
    const theirs = new Set(Object.entries(ing.groupPorts).filter(([g]) => xs.some((x) => g === x || g.startsWith(`${x}:`))).map(([, p]) => p))
    try {
      const r = await turnOnModel({ os: w.os, home: w.home, env: w.env, ids: null, harnesses: w.harnesses, ctx: w.ctx, isFree: async (p) => !theirs.has(p), renderHook })
      return { exit: r.exit, doc: r }
    } catch (e) { return { exit: 70, doc: { error: String(e && e.message) } } }
  } },
  { name: 'status', carriers: 'all', run: (w) => cli(runStatusCli, ['--json'], w) },
  { name: 'doctor', carriers: 'all', run: (w) => cli(runDoctor, ['--json'], w) },
  { name: 'board', carriers: 'all', run: async (w) => { const r = await VERBS.status(null, { home: path.join(w.home, '.trocar'), deps: readDeps(w) }); return { exit: r.status, doc: r.doc } } },
  { name: 'off', carriers: 'all', run: async (w) => { const r = await w.cmd.off(['--json']); return { exit: r.exit, doc: JSON.parse(r.text) } } },
  { name: 'uninstall', carriers: 'manifest', run: async (w) => { const r = await w.cmd.uninstall(); return { exit: r.exit, doc: r.receipt } } },
]

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
const files = (root) => {
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[path.relative(root, p)] = fs.readFileSync(p).toString('base64') } }
  if (fs.existsSync(root)) walk(root)
  return out
}
// names drawn at random are not the worlds' to agree on: a backup's (its file's hash and the time it was taken) and a UUID-named file's
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).map((p) => p.replace(/^(\.trocar[\\/]backup[\\/]).+$/, '$1*').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')).sort()
const idsIn = (doc, table) => { const s = new Set(); (function walk(v) { if (typeof v === 'string') { if (table.includes(v)) s.add(v) } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x) })(doc); return [...s].sort() }

async function world(os) {
  const w = await contractWorld({ os })
  const on = []
  for (const h of w.harnesses) {
    const forms = h.proxyMode.forms.filter((f) => f.os.includes(os) && placesOf(f, w.ctx).length)
    for (const f of forms) for (const pl of placesOf(f, w.ctx)) w.place(pl)
    if (forms.length) on.push(h.name)
  }
  await w.cmd.install() // A and B are built alike; what install could not place (a win32 wrapper target this world lacks) is the same in both
  w.daemon = await daemonFor(w)
  await w.cmd.on(on)
  // the door's durable rows, as a daemon writes them: one per harness that is on (both worlds hold them; uninstall takes the file)
  writeJson(path.join(w.dir, 'door-seen.json'), { version: 1, rows: on.map((h, i) => ({ harness: h, group: h, pid: 900 + i, start: '1', kind: 'accept', at: 1, n: 1 })) })
  return w
}

/** What a newer trocar wrote for X, cloned from `h0`'s records with every HOME path moved under HOME/.other. → the list of X ids. */
function seedOthers(w) {
  const table = w.harnesses.map((h) => h.name)
  const mPath = path.join(w.dir, 'install-manifest.json'), m = readJson(mPath)
  const other = path.join(w.home, '.other')
  const move = (v) => typeof v === 'string' && (v === w.home || v.startsWith(w.home + path.sep)) ? path.join(other, path.relative(w.home, v)) : v
  const clone = (v, x) => JSON.parse(JSON.stringify(v), (k, s) => (k === 'harness' && typeof s === 'string' ? x : move(s)))
  const st = readJson(path.join(w.dir, 'state.json')), ds = readJson(path.join(w.dir, 'door-seen.json')), ing = readJson(path.join(w.dir, 'ingress.json'))
  const used = new Set(Object.values(ing.groupPorts))
  let port = 41000
  const xs = []
  for (const h0 of table) {
    const items = [...m.entries, ...m.files].filter((x) => x.harness === h0)
    if (!items.length) continue
    const x = `${h0}-next`
    assert.ok(!table.includes(x), x)
    xs.push(x)
    for (const it of items) for (const v of Object.values(it)) {
      if (typeof v === 'string' && v.startsWith(w.home + path.sep) && fs.existsSync(v)) { fs.mkdirSync(path.dirname(move(v)), { recursive: true }); fs.cpSync(v, move(v), { recursive: true }) }
    }
    m.entries.push(...m.entries.filter((e) => e.harness === h0).map((e) => clone(e, x)))
    m.files.push(...m.files.filter((f) => f.harness === h0).map((f) => clone(f, x)))
    if (m.liveness && m.liveness[h0]) m.liveness[x] = { ...clone(m.liveness[h0], x), on_at: m.liveness[h0].on_at || '2026-10-30T00:00:00.000Z', off_at: null }
    if (m.install) m.install.harnesses = [...(m.install.harnesses || []), x]
    if (st && st.harnesses[h0]) st.harnesses[x] = { ...st.harnesses[h0], desired: 'on' }
    ds.rows.push(...ds.rows.filter((r) => r.harness === h0).map((r) => ({ ...r, harness: x, group: x })))
    for (const g of Object.keys(ing.groupPorts).filter((g) => g === h0 || g.startsWith(`${h0}:`))) { while (used.has(port)) port++; used.add(port); ing.groupPorts[`${x}${g.slice(h0.length)}`] = port }
  }
  writeJson(mPath, m)
  if (st) writeJson(path.join(w.dir, 'state.json'), st)
  writeJson(path.join(w.dir, 'door-seen.json'), ds)
  writeJson(path.join(w.dir, 'ingress.json'), ing)
  return xs
}

/** X's carriers as they are now: `all` (off) = every record kind; `manifest` (uninstall) = its manifest items and the bytes under HOME/.other. */
function carriers(w, xs, which) {
  const m = readJson(path.join(w.dir, 'install-manifest.json')) || { entries: [], files: [] }
  const mine = (x) => xs.includes(x.harness)
  const out = { items: [...m.entries.filter(mine), ...m.files.filter(mine)], bytes: files(path.join(w.home, '.other')) }
  if (which === 'manifest') return out
  const st = readJson(path.join(w.dir, 'state.json')), ds = readJson(path.join(w.dir, 'door-seen.json')), ing = readJson(path.join(w.dir, 'ingress.json'))
  return { ...out,
    liveness: xs.map((x) => (m.liveness || {})[x] ?? null),
    installed: ((m.install && m.install.harnesses) || []).filter((h) => xs.includes(h)),
    state: xs.map((x) => (st && st.harnesses[x]) ?? null),
    door: ((ds && ds.rows) || []).filter(mine),
    groups: Object.entries((ing && ing.groupPorts) || {}).filter(([g]) => xs.some((x) => g === x || g.startsWith(`${x}:`))),
  }
}

process.chdir(tmpDir('trocar-pipes-')) // a win32 control endpoint is a pipe name, served as a socket path relative to the cwd (eighth.test.mjs)
describe('CM39: every command walks only its own harness table', { concurrency: 1 }, () => {
  for (const os of ['darwin', 'win32']) {
    it(`${os}: a world carrying records of ids outside the table ends as the world without them, and those records stay`, async () => {
      const A = await world(os), B = await world(os)
      try {
        const table = B.harnesses.map((h) => h.name)
        const xs = seedOthers(B)
        assert.ok(xs.length > 0, 'no harness has manifest records to clone')
        for (const step of STEPS) {
          const fa0 = files(A.home), fb0 = files(B.home), x0 = carriers(B, xs, step.carriers)
          const a = await step.run(A, []), b = await step.run(B, xs)
          const label = `${os} ${step.name}`
          assert.equal(b.exit, a.exit, `${label} I1: ${JSON.stringify(b.doc.problems || b.doc.error)}`)
          const text = JSON.stringify(b.doc)
          assert.deepEqual(xs.filter((x) => text.includes(x)), [], `${label} I2`)
          assert.deepEqual(idsIn(b.doc, table), idsIn(a.doc, table), `${label} I3`)
          assert.deepEqual(carriers(B, xs, step.carriers), x0, `${label} I4`)
          const fb = files(B.home)
          assert.deepEqual(changed(fb0, fb), changed(fa0, files(A.home)), `${label} I5`)
        }
      } finally { A.daemon.close(); B.daemon.close() }
    })
  }
})
