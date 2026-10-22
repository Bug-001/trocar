// test/cli/status-verdict.test.mjs — 4.11 P11 `status`: a process the daemon has not listed is judged by the door's evidence first (its durable
// door-seen.json row, a Chromium host's network service), then rule 3, then only inside known history; what history cannot tell is `not-seen`
// (captured null, no restart), and `not-seen` never makes a harness `no` (1.6 §2 判词, A.2 rows 32–33). Generated axes: the start of a process
// against the carrier and the on windows × `since` × a routed ancestor; the 2026-10-20 main-Mac capture is the regression seed. Every OS fact is
// injected (a temp HOME, a fake process table, a daemon stub); nothing here reads the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { EXIT, validateReceipt } from '../../src/cli/schema.mjs'
import { holdersOf } from '../../src/off/holders.mjs'
import { writeDoorSeen, DOOR_SEEN_FILE } from '../../src/off/door-seen.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

// the seed (a macOS machine, 2026-10-20): the carrier, the earliest on window; two claude processes started between them, with no `since`
const CARRIER = Date.parse('2026-10-20T16:45:14.503Z')
const T0 = Date.parse('2026-10-20T18:14:31Z')
const MIN = 60_000
const W1 = { on_at: new Date(T0).toISOString(), off_at: new Date(T0 + 60 * MIN).toISOString() } // an earlier window; a known gap after it
const ON_AT = T0 + 120 * MIN // the current window, still open
const START = {
  'before-carrier': CARRIER - MIN,
  'before-window': Date.parse('2026-10-20T16:47:34Z'),
  window: T0 + 30 * MIN,
  gap: T0 + 90 * MIN,
  'window-before-move': T0 + 30 * MIN, // with one door group moved at the current on
}

let world = null
async function codexOn() {
  if (world) return world
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  assert.equal((await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['codex'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
  const mf = path.join(w.dir, 'install-manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  for (const i of [...(m.entries || []), ...(m.files || [])]) if (i.phase === 'install' && i.installed_at) i.installed_at = new Date(CARRIER).toISOString() // the carrier the seed had
  fs.writeFileSync(mf, JSON.stringify(m))
  const groups = Object.keys(m.liveness.codex.door_since || {})
  world = { w, mf, base: m, group: groups[0] || 'codex:all' }
  return world
}

/** The manifest's liveness.codex for one case; `off` adds the off_at an `off` now would write (holders exist only after off). */
function liveness({ group }, { since, move, off = false }) {
  return { rereads: false, on_at: new Date(ON_AT).toISOString(), off_at: off ? new Date().toISOString() : null, windows: [W1], ...(since ? { since: W1.on_at } : {}), ...(move ? { door_since: { [group]: new Date(ON_AT).toISOString() } } : {}) }
}
function setWorld(c, l, rows) {
  const m = structuredClone(c.base)
  m.liveness.codex = { ...m.liveness.codex, ...l }
  for (const k of ['since', 'door_since']) if (!(k in l)) delete m.liveness.codex[k]
  fs.writeFileSync(c.mf, JSON.stringify(m))
  writeDoorSeen({ dir: c.w.dir, rows })
  writeStateAtomic(path.join(c.w.dir, 'state.json'), setDesired(emptyState(), ['codex'], 'on'))
  return m
}
const proc = (c, pid, startedAt, { ppid = 1, argv = ['codex'] } = {}) => ({ pid, ppid, uid: 501, startedAt, exe: path.join(c.w.home, 'bin', 'codex'), argv, env: () => new Map() })
const accept = (c, p, extra = { decrypt: true }) => ({ harness: 'codex', group: c.group, pid: p.pid, start: p.startedAt, kind: 'accept', at: Date.now(), n: 1, ...extra })

/** `status --json` (or `doctor --json`) with the daemon up and listening for codex, its memory empty (no `agents`): every process is judged from the disk. */
async function run(c, table, { cmd = runStatusCli, argv = ['--json'] } = {}) {
  const r = { pid: 99, doors: { [c.group]: 17995 }, harnesses: { codex: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const request = async (q) => (q.path === '/status' ? r : assert.fail(q.path))
  const io = fakeIo()
  const exit = await cmd(argv, { io, home: c.w.home, platform: 'darwin', env: c.w.env, deps: { request, socketPath: SOCK, procs: async () => table, spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: c.w.harnesses, archFacts: null }), rootStore: c.w.store, user: 'alice' } })
  return { exit, j: JSON.parse(io.stdoutText()) }
}
const said = (j, pid) => { const p = j.harnesses.codex.processes.find((x) => x.pid === pid); return p ? [p.captured, p.reason] : null }

// the case the spec's P11 `status` order gives for each cell (4.11 P11 status 3–5, 1.6 A.2 rows 32–33)
function expected(start, since, anc) {
  if (start === 'before-carrier') return [false, 'config-after-start']
  if (start === 'window') return [true, null]
  if (start === 'window-before-move') return [null, 'not-seen']
  if (start === 'before-window' && !since) return [null, 'not-seen']
  return anc ? [null, 'not-seen'] : [false, 'config-after-start'] // a known gap: what a routed ancestor may have handed down
}
const CELLS = Object.keys(START).flatMap((start) => [false, true].flatMap((since) => [false, true].map((anc) => ({ start, since, anc }))))
function cellWorld(c, { start, since, anc }) {
  const child = proc(c, 7002, START[start], { ppid: anc ? 7001 : 1 })
  const parent = anc ? proc(c, 7001, START[start] - MIN) : null
  const l = liveness(c, { since, move: start === 'window-before-move' })
  return { child, table: parent ? [parent, child] : [child], rows: parent ? [accept(c, parent)] : [], l }
}

test('A2 4.11 P11 status: start × since × a routed ancestor → the process row; the 2026-10-20 seed (no since, starts after the carrier and before the earliest window) is not-seen', async () => {
  const c = await codexOn()
  for (const cell of CELLS) {
    const x = cellWorld(c, cell)
    setWorld(c, x.l, x.rows)
    const { j } = await run(c, x.table)
    assert.deepEqual(validateReceipt(j), [], JSON.stringify(cell))
    assert.deepEqual(said(j, x.child.pid), expected(cell.start, cell.since, cell.anc), JSON.stringify(cell))
  }
  setWorld(c, liveness(c, { since: false }), [])
  const seed = [proc(c, 8101, Date.parse('2026-10-20T16:47:34Z')), proc(c, 8102, Date.parse('2026-10-20T17:11:24Z'))]
  const { j } = await run(c, seed)
  assert.deepEqual(seed.map((p) => said(j, p.pid)), [[null, 'not-seen'], [null, 'not-seen']])
})

test('P12 status: an unreadable door record, or one still carrying unknown_before (any value), never makes a process config-after-start', async () => {
  const c = await codexOn()
  const child = proc(c, 7302, START.gap) // a known gap with no ancestor: config-after-start when the record is known and empty (A2)
  const file = path.join(c.w.dir, DOOR_SEEN_FILE)
  for (const write of [() => fs.writeFileSync(file, '{not json'), () => writeDoorSeen({ dir: c.w.dir, rows: [], unknownBefore: Date.now() }),
    () => fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [], unknown_before: 'x' }))]) {
    setWorld(c, liveness(c, { since: true }), [])
    write()
    const { j } = await run(c, [child])
    assert.deepEqual(said(j, child.pid), [null, 'not-seen'])
  }
})

test('A3 P11 status and P12 holders are one judge: a process with no door row, started after every carrier, is config-after-start while on ⇔ the holders after off do not list it', async () => {
  const c = await codexOn()
  for (const cell of CELLS.filter((x) => x.start !== 'before-carrier')) {
    const x = cellWorld(c, cell)
    setWorld(c, x.l, x.rows)
    const { j } = await run(c, x.table)
    const m = setWorld(c, liveness(c, { since: cell.since, move: cell.start === 'window-before-move', off: true }), x.rows)
    const held = holdersOf({ manifest: m, procs: x.table, doorSeen: x.rows }).some((h) => h.pid === x.child.pid)
    assert.equal(said(j, x.child.pid)[1] === 'config-after-start', !held, JSON.stringify(cell))
  }
})

// A3 · one validity judge: a door row whose group belongs to another harness (row.harness ≠ the group's) is valid or stale by THAT group's
// door_since on both sides — status's verdict and the holders after off agree over (the group moved or not) × (the row before or after the move)
for (const moved of [false, true]) for (const atRel of [-MIN, MIN]) {
  test(`A3 · a codex row at a door group of another harness (${moved ? 'moved' : 'never moved'}, the row ${atRel < 0 ? 'before' : 'after'} the move): status and the holders agree`, async () => {
    const c = await codexOn()
    const child = proc(c, 7202, START.gap), group = 'zz:api'
    const rows = [{ ...accept(c, child), group, at: ON_AT + atRel }]
    const other = { zz: { rereads: false, ...(moved ? { door_since: { [group]: new Date(ON_AT).toISOString() } } : {}) } }
    const write = (m) => { m.liveness = { ...m.liveness, ...other }; fs.writeFileSync(c.mf, JSON.stringify(m)); return m }
    write(setWorld(c, liveness(c, { since: true }), rows))
    const { j } = await run(c, [child])
    const m = write(setWorld(c, liveness(c, { since: true, off: true }), rows))
    const held = holdersOf({ manifest: m, procs: [child], doorSeen: rows }).some((h) => h.pid === child.pid)
    const valid = !(moved && atRel < 0)
    assert.deepEqual(said(j, child.pid), valid ? [true, null] : [false, 'config-after-start'])
    assert.equal(held, valid)
  })
}

test('A5 status half: a Chromium host (no --type) shows its network service\'s door verdict; a same-name CLI child\'s row never folds up into its parent', async () => {
  const c = await codexOn()
  const NS = ['codex', '--type=utility', '--utility-sub-type=network.mojom.NetworkService']
  const host = proc(c, 63411, START.gap), ns = proc(c, 63420, START.gap + 1000, { ppid: 63411, argv: NS })
  const cli = proc(c, 63971, START.gap + 2000, { ppid: 63411 }), cliChild = proc(c, 63972, START.gap + 3000, { ppid: 63971 })
  const table = [host, ns, cli, cliChild]
  const l = liveness(c, { since: true })
  setWorld(c, l, [accept(c, ns), accept(c, cliChild)])
  const withRow = (await run(c, table)).j
  assert.deepEqual(said(withRow, host.pid), [true, null], 'the host is its network service')
  assert.deepEqual(said(withRow, cliChild.pid), [true, null])
  setWorld(c, l, [accept(c, ns)])
  const without = (await run(c, table)).j
  assert.deepEqual(said(withRow, cli.pid), said(without, cli.pid), 'the CLI parent\'s verdict does not depend on its child\'s row')
  setWorld(c, l, [])
  assert.deepEqual(said((await run(c, [host, ns])).j, host.pid), [false, 'config-after-start'], 'without the network service\'s row the host started in a known gap')
})

test('A8 1.6 §2 判词: captured + not-seen → the harness is captured (exit 0); only not-seen → unknown (exit 3); doctor gives no config-after-start for not-seen rows', async () => {
  const c = await codexOn()
  setWorld(c, liveness(c, { since: false }), [])
  const inWindow = proc(c, 9001, ON_AT + MIN), unseen = proc(c, 9002, START['before-window'])
  for (const [table, captured, exit] of [[[inWindow, unseen], true, EXIT.ok], [[unseen], null, EXIT.unknown]]) {
    const { exit: e, j } = await run(c, table)
    assert.deepEqual(validateReceipt(j), [])
    assert.deepEqual([j.harnesses.codex.captured, e], [captured, exit], JSON.stringify(j.harnesses.codex))
    assert.deepEqual(said(j, unseen.pid), [null, 'not-seen'])
    assert.equal(j.restart.some((r) => r.pid === unseen.pid), false, 'not-seen is no restart')
    const d = (await run(c, table, { cmd: runDoctor })).j
    assert.equal((d.findings || []).some((f) => f.code === 'config-after-start'), false, JSON.stringify(d.findings))
  }
})
