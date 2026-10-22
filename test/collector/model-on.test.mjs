// turnOnModel (RFC 4.11 §1 on, §3 ① ⑪; 1.6 §1.1; plan T20): no install record → cert-not-installed; CM28 / precondition ⑪ refuses only the harness
// whose install items are gone or changed, with `trocar install` (a Kimi-only machine: install placed the wrapper, on makes only the switch
// file, exit 0); and the REAL seam: turnOnModel ↔ the daemon's POST /on over a real socket at the endpoint controlEndpointFor resolves for a tmp HOME
// (control.json, as the darwin daemon writes it), a real startControlServer answering with stub doors — no request and no socket path injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { daemonMayStart, readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { isPresent } from '../../src/collector/core/proxymode/sources.mjs'
import { modelFormFacts } from '../../src/collector/core/proxymode/status-facts.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const TOKEN = 'k'.repeat(32)

async function installed({ kimiOnly = false } = {}) {
  const w = await modelWorld({ commands: kimiOnly ? [] : ['codex', 'dsh'] })
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, MACHO)
  if (!kimiOnly) fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  return { ...w, kimi }
}

/** A real control server at the endpoint the resolver gives for this HOME: control.json names a socket in the tmp HOME, with a token. */
async function daemon(w) {
  const sock = path.join(w.home, 'c.sock')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token: TOKEN }))
  const asked = []
  const server = await startControlServer({ socketPath: sock, token: TOKEN, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => { asked.push(body); return { doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) } },
  } })
  return { asked, close: () => server.close() }
}
const on = (w, over = {}) => turnOnModel({ os: 'darwin', home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, ...over })

test('1.6 §1.1: on without an install record refuses with cert-not-installed, exit 1, and writes nothing', async () => {
  const w = await modelWorld({ commands: ['codex'] })
  const r = await on(w)
  assert.deepEqual([r.code, r.exit], ['cert-not-installed', 1])
  assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false)
})

test('e2e: a Kimi-only machine — install placed the wrapper; on asks the daemon over its real socket, makes only the switch file with the door, exit 0', async () => {
  const w = await installed({ kimiOnly: true })
  const d = await daemon(w)
  try {
    const r = await on(w, { ids: ['kimi-code'] })
    assert.equal(r.exit, 0, JSON.stringify(r))
    assert.deepEqual(d.asked.map((b) => [b.harnesses, Object.keys(b.groups)]), [[['kimi-code'], ['kimi-code:switch']]], 'POST /on reached the daemon through control.json with its token')
    const sw = path.join(w.dir, 'switch', 'kimi-code')
    assert.equal(fs.readFileSync(sw, 'utf8'), r.doors['kimi-code:switch'], 'the switch file holds the door the daemon read back')
    const state = JSON.parse(fs.readFileSync(path.join(w.dir, 'state.json'), 'utf8'))
    assert.equal(state.harnesses['kimi-code'].desired, 'on')
    const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
    assert.ok(m.liveness['kimi-code'].on_at, 'the on window opened')
    assert.deepEqual(m.files.filter((f) => f.phase === 'on').map((f) => f.role), ['switch'], 'on wrote the switch file only: no certificate')
  } finally { await d.close() }
})

const DRIFTS = {
  'the wrapper replaced by the installer': (w) => fs.writeFileSync(w.kimi, Buffer.concat([MACHO, Buffer.from('new release')])),
}
for (const [name, drift] of Object.entries(DRIFTS)) {
  test(`CM28 · ⑪: ${name} → only kimi-code is refused, with trocar install; codex and deepseek-dsh are turned on`, async () => {
    const w = await installed()
    drift(w)
    const d = await daemon(w)
    try {
      const r = await on(w)
      assert.deepEqual(r.refused.map((x) => [x.harness, x.reason, x.command]), [['kimi-code', 'setup-needed', 'trocar install']])
      assert.ok(r.on.includes('deepseek-dsh') && r.on.includes('codex') && !r.on.includes('kimi-code'))
      assert.equal(fs.existsSync(path.join(w.dir, 'switch', 'kimi-code')), false)
      assert.ok(fs.existsSync(path.join(w.dir, 'switch', 'deepseek-dsh')))
      assert.equal(r.exit, 1, 'a refused harness makes the on not done')
    } finally { await d.close() }
  })
}

test('CM28 · ⑪ · 4.11 P4b: a harness installed after trocar whose forms the root carries (present, install never saw it) needs no setup and is turned on', async () => {
  const w = await installed()
  fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.hermes', '.env'), '')
  const d = await daemon(w)
  try {
    const r = await on(w, { ids: ['codex', 'hermes'] })
    assert.deepEqual([r.refused, r.on], [[], ['codex', 'hermes']])
    const facts = await modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir, fs), root: { state: 'in-place' }, ctx: w.ctx, fs })
    assert.ok((facts.hermes || []).length, 'status draws the forms on turned on for it')
  } finally { await d.close() }
})

// the review of T20, item 2: precondition ⑪ is not vacuous when install's record went too — install keeps what it placed per harness (install.items), so
// an item gone from the manifest (with its file or without it) refuses that harness, setup-needed, like one gone from disk. Generated over every item install placed.
test('CM28 · ⑪: every item install placed, its record dropped from the manifest (file kept, or file gone too) → only its harness is refused, setup-needed, trocar install', async () => {
  const w0 = await installed()
  const m0 = JSON.parse(fs.readFileSync(path.join(w0.dir, 'install-manifest.json'), 'utf8'))
  const placed = Object.entries(m0.install.items).flatMap(([h, xs]) => xs.map((x, i) => ({ h, i })))
  assert.ok(placed.length >= 3, JSON.stringify(m0.install.items))
  for (const { h, i } of placed) {
    for (const fileToo of [false, true]) {
      const w = await installed()
      const mf = path.join(w.dir, 'install-manifest.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'))
      const p = m.install.items[h][i]
      const drop = (list) => list.filter((x) => !(x.harness === h && x.kind === p.kind && x.path === p.path))
      m.entries = drop(m.entries); m.files = drop(m.files)
      fs.writeFileSync(mf, JSON.stringify(m))
      if (fileToo && p.path && fs.existsSync(p.path)) fs.rmSync(p.path)
      const d = await daemon(w)
      try {
        const r = await on(w)
        // P4b: a form no longer on this machine is not counted (the file was its only `present` place): nothing to set up, so not refused
        const present = w.harnesses.find((d) => d.name === h).proxyMode.forms.some((f) => f.os.includes('darwin') && isPresent(f, w.ctx))
        assert.deepEqual(r.refused.map((x) => [x.harness, x.reason, x.command]), present ? [[h, 'setup-needed', 'trocar install']] : [], `${h} ${p.kind} ${p.path} (file too: ${fileToo})`)
        assert.ok(present ? !r.on.includes(h) && r.on.length > 0 : r.on.length > 0)
      } finally { await d.close() }
    }
  }
})

// the review of T20, item 3: an install whose root store was declined or left pending still has a root — on goes on for every harness, says what is pending
// with the command, exit 1 (1.6 §1.1: refuse only with no usable root or no install record); the daemon may start on it
for (const answer of ['declined', 'pending']) {
  test(`1.6 §1.1: install with the root store ${answer} → on turns every installed harness on, notes install-pending with trocar install, exit 1`, async () => {
    const w = await modelWorld({ commands: ['codex', 'dsh'] })
    fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
    w.store.answer = answer
    const ins = await w.install()
    assert.equal(ins.exit, 1)
    const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
    assert.equal(m.install.state, 'partial')
    assert.equal(daemonMayStart(m), true, 'the daemon may start on a partial install that has a root')
    const d = await daemon(w)
    try {
      const r = await on(w)
      assert.deepEqual([r.code, r.refused, r.on], [undefined, [], m.install.harnesses])
      assert.deepEqual(r.notes.filter((n) => n.code === 'install-pending').map((n) => [n.item, n.state, n.command]), [['root-store', answer, 'trocar install']])
      assert.equal(r.exit, 1)
      assert.ok(fs.existsSync(path.join(w.dir, 'switch', 'deepseek-dsh')), 'routed all the same')
    } finally { await d.close() }
  })
}

test('1.6 §1.1: an install record with no root on record (the custody was unreachable) → cert-not-installed, nothing routed', async () => {
  const w = await modelWorld({ commands: ['codex'] })
  w.custody.switches.unavailable = true
  await w.install()
  const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
  assert.equal(m.install.state, 'partial')
  assert.equal(daemonMayStart(m), false)
  const r = await on(w)
  assert.deepEqual([r.code, r.exit], ['cert-not-installed', 1])
})

// the review of T20, item 1, on the model: install, on, off (undoHarnesses as off runs it: phase on only), then on again with no install — every byte
// install wrote is as it was, its records are all there, and the second on turns every harness on again (exit 0)
test('D55① · model: after install → on → off, every phase-install item is byte for byte and on record, and the next on needs no install', async () => {
  const w = await installed()
  const mf = path.join(w.dir, 'install-manifest.json')
  const items = () => { const m = JSON.parse(fs.readFileSync(mf, 'utf8')); return [...m.entries, ...m.files].filter((x) => x.phase === 'install').map((x) => [x.kind, x.role ?? null, x.path, x.path && fs.existsSync(x.path) && fs.statSync(x.path).isFile() ? sha256(fs.readFileSync(x.path)) : null]) }
  const before = items()
  const d = await daemon(w)
  try {
    const first = await on(w)
    assert.equal(first.exit, 0, JSON.stringify(first))
    const off = await undoHarnesses({ dir: w.dir, home: w.home, manifest: readManifest(w.dir), ids: null, procs: async () => [] })
    assert.deepEqual(off.left, [])
    assert.deepEqual(items(), before, 'off spared every item install wrote')
    assert.equal(JSON.parse(fs.readFileSync(mf, 'utf8')).files.filter((f) => f.phase === 'on').length, 0, 'and took every item on wrote')
    const again = await on(w)
    assert.deepEqual([again.exit, again.refused, again.on.sort()], [0, [], [...first.on].sort()], JSON.stringify(again.refused))
  } finally { await d.close() }
})

// A7 · 4.11 P12: `on` writes the history fields over a real run — the first on starts the history (`since`); an on that moves some door groups of h
// marks them (`door_since`) and keeps the windows, so a process from an earlier window is still a holder; one that moves every group restarts the
// history there, and a process from before is not a holder. Generic over the harness's groups: the test reads them from the run, never names one.
test('A7 · door moves per group: some moved → windows kept + door_since; all moved → windows gone, since = that on_at', async () => {
  const { holdersOf } = await import('../../src/off/holders.mjs')
  const w = await modelWorld({ commands: ['claude'] }) // the CLI and the desktop app: a harness with two door groups
  fs.mkdirSync(path.join(w.home, 'Applications', 'Claude.app'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const d = await daemon(w)
  const T0 = Date.now() + 60_000, at = (k) => new Date(T0 + k * 60_000)
  const L = () => readManifest(w.dir).liveness
  const ingress = () => JSON.parse(fs.readFileSync(path.join(w.dir, 'ingress.json'), 'utf8')).groupPorts
  const off = (k) => undoHarnesses({ dir: w.dir, home: w.home, manifest: readManifest(w.dir), ids: null, procs: async () => [], now: at(k) })
  try {
    const first = await on(w, { now: () => at(0) })
    assert.equal(first.exit, 0, JSON.stringify(first.problems))
    const groupsOf = (h) => [...new Set(first.planned.filter((x) => x.harness === h).map((x) => `${h}:${x.route}`))]
    const h = first.on.find((x) => groupsOf(x).length >= 2)
    assert.ok(h, 'some harness here has two door groups')
    assert.equal(L()[h].since, at(0).toISOString(), 'the first on starts the history')
    await off(1)
    await on(w, { now: () => at(2) }); await off(3)
    assert.deepEqual([L()[h].windows.length, L()[h].since, L()[h].door_since], [1, at(0).toISOString(), undefined], 'nothing moved: the window kept, no door_since')
    const [g] = groupsOf(h), taken = ingress()[g]
    await on(w, { now: () => at(4), isFree: async (p) => p !== taken }); await off(5)
    const some = L()[h]
    assert.deepEqual([some.windows.length, some.since, some.door_since], [2, at(0).toISOString(), { [g]: at(4).toISOString() }])
    // a process of h by its own identity (D51), from the first window: the candidates are its CLI and its app, kept when h's record names them
    const { harnessesOf } = await import('../../src/off/signature.mjs')
    const p = [path.join(w.home, '.local', 'bin', 'claude'), '/Applications/Claude.app/Contents/MacOS/Claude']
      .map((exe) => ({ pid: 77, ppid: 1, uid: 501, startedAt: T0 + 30_000, exe, argv: [exe], env: () => null, envRead: false }))
      .find((x) => harnessesOf({ [h]: L()[h] }, x).includes(h))
    assert.ok(p, `a process of ${h}`)
    const mine = holdersOf({ manifest: readManifest(w.dir), procs: [p], doorSeen: [{ harness: h, group: g, pid: 77, start: p.startedAt, kind: 'accept', at: at(0.6).toISOString(), n: 1 }] })
    assert.deepEqual(mine.filter((x) => x.harness === h).map((x) => x.why), ['started-in-window'], 'from the first window: a holder (the old door row is no evidence now)')
    assert.deepEqual(holdersOf({ manifest: readManifest(w.dir), procs: [p] }).filter((x) => x.harness === h).map((x) => x.why), ['started-in-window'], 'and without any row')
    const ports = ingress()
    await on(w, { now: () => at(6), isFree: async (q) => !groupsOf(h).some((x) => ports[x] === q) }); await off(7)
    const all = L()[h]
    assert.deepEqual([all.windows, all.since, all.door_since], [undefined, at(6).toISOString(), undefined])
    assert.deepEqual(holdersOf({ manifest: readManifest(w.dir), procs: [p] }).filter((x) => x.harness === h), [], 'from before every group moved: not a holder')
  } finally { await d.close() }
})

// 4.11 P12: `windows` keeps at most WINDOWS_MAX; the on that trims the earliest one deletes `since`, so a process started in the trimmed window (after
// the carrier) is judged in the safe direction (history-unknown), never as one from a known gap
test('P12 · an on over a full windows list trims the earliest and deletes since; a process from the trimmed window is a history-unknown holder', async () => {
  const { holdersOf, WINDOWS_MAX } = await import('../../src/off/holders.mjs')
  const { saveManifest } = await import('../../src/off/manifest.mjs')
  const { harnessesOf } = await import('../../src/off/signature.mjs')
  const w = await modelWorld({ commands: ['codex'] })
  assert.equal((await w.install()).exit, 0)
  const d = await daemon(w)
  try {
    const T0 = Date.now() + 60_000, at = (k) => new Date(T0 + k * 60_000)
    assert.equal((await on(w, { now: () => at(0) })).exit, 0)
    const m = readManifest(w.dir), h = Object.keys(m.liveness).find((x) => m.liveness[x] && m.liveness[x].on_at)
    m.liveness[h] = { ...m.liveness[h], windows: Array.from({ length: WINDOWS_MAX }, (_, k) => ({ on_at: at(2 * k).toISOString(), off_at: at(2 * k + 1).toISOString() })), on_at: at(2 * WINDOWS_MAX).toISOString(), off_at: at(2 * WINDOWS_MAX + 1).toISOString() }
    saveManifest(w.dir, m)
    assert.equal((await on(w, { now: () => at(2 * WINDOWS_MAX + 2) })).exit, 0)
    const l = readManifest(w.dir).liveness[h]
    assert.deepEqual([l.windows.length, l.windows[0].on_at, 'since' in l], [WINDOWS_MAX, at(2).toISOString(), false])
    await undoHarnesses({ dir: w.dir, home: w.home, manifest: readManifest(w.dir), ids: null, procs: async () => [], now: at(2 * WINDOWS_MAX + 3) })
    const p = [path.join(w.home, '.local', 'bin', h), path.join(w.home, 'bin', 'codex'), '/usr/local/bin/codex']
      .map((exe) => ({ pid: 88, ppid: 1, uid: 501, startedAt: T0 + 30_000, exe, argv: [exe], env: () => null, envRead: false }))
      .find((x) => harnessesOf({ [h]: l }, x).includes(h))
    assert.ok(p, `a process of ${h}`)
    assert.deepEqual(holdersOf({ manifest: readManifest(w.dir), procs: [p] }).filter((x) => x.harness === h).map((x) => x.why), ['history-unknown'])
  } finally { await d.close() }
})
