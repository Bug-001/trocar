// test/server/control-setup.test.mjs — 4.4 #13 (§控制面 Set up, D65④ · D26②; 1.6 §3.2 V67): POST /control/setup runs `trocar install`'s own
// function for one harness. A REAL startDaemon (test/helpers/model-daemon.mjs) mounts the board; its query worker is the real one
// (test/helpers/worker-fork.mjs) with the deps module of test/helpers/board-world.mjs, whose key custody and user root store are files shared by
// the test, the daemon and the worker (sharedTrust). Harness A (codex) is installed; harness B (z-code: a present form whose carrier is not the
// root) appears afterwards. Sandbox HOMEs only; no trust store, no launchd, no scheduled task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf, unservable } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { depsFile, sharedTrust, standInUnit } from '../helpers/board-world.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { request } from './face.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { readManifest, saveManifest, itemsOfPhase, manifestPath } from '../../src/off/manifest.mjs'
import { setupOf } from '../../src/collector/core/proxymode/status-facts.mjs'
import { createServer } from '../../src/server.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { VERBS } from '../../src/control/board.mjs'
import { driverSetup, driverCtx } from '../../src/collector/driver-setup.mjs'
import { planOn } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { installedHome, ROOTS } from '../off/fixtures/off-ctx.mjs'
import { setKey } from '../../src/off/json-text.mjs'
import { removeTrocarText } from '../../src/off/text-edit.mjs'

const A = 'codex', B = 'z-code' // B: its CLI form is present when ~/.zcode is, and carries the root through a config key (a carrier of its own)
const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
const FLOWS = '.trocar/collector/flows/' // the run's records (install-note): every install run appends one
const quiet = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(FLOWS)))
const items = (w) => itemsOfPhase(readManifest(w.dir), 'install')

/** A model world with A installed through install's own function, the board's port recorded, and a daemon serving it; `run(ctx)` inside. */
async function withBoard(platform, run) {
  const w = await modelWorld({ os: platform, commands: [A] })
  const state = tmpDir('trocar-trust-')
  const trust = sharedTrust(state)
  assert.equal((await w.install({ custody: trust.custody, rootStore: trust.rootStore, unit: standInUnit(w.home) })).exit, 0)
  const port = await boardPortOf(w.dir) // tests running side by side never meet on one board (a 403)
  const deps = depsFile(w, platform, state)
  await withScratchCwd(platform, async () => {
    const box = await liveUnit({ w: { ...w, custody: trust.custody }, platform, parts: { helper: HELPER }, daemon: { fork: (h, _, role) => workerFork(h, deps, role) } })
    box.unit.start(); await box.starting
    const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
    const post = (body) => request(port, '/control/setup', { method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token }, body: JSON.stringify(body) })
      .then((r) => ({ ...r, json: JSON.parse(r.body) }))
    try { await run({ w, post, trust, state }) } finally { await box.stop() }
  })
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · 4.4 #13 · V67: Set up for a harness installed after install — a plan of its carriers only, a stale plan_id, confirm places them and nothing else; a second Set up changes nothing`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post, trust }) => {
      assert.equal((await post({ harness: 'not-a-harness' })).status, 400)
      fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
      let home0 = snapshot(w.home)
      const p1 = await post({ harness: B })
      assert.equal(p1.status, 409, p1.body)
      assert.deepEqual([p1.json.need, p1.json.receipt.command, p1.json.receipt.dry_run], ['confirm', 'install', true])
      assert.ok(p1.json.plan.length > 0 && p1.json.plan.every((r) => r.harness === B), p1.body)
      assert.deepEqual(snapshot(w.home), home0, 'the plan wrote nothing')
      // B's form goes between the two requests: the plan of now differs, so the old plan_id is stale → 409, nothing written
      fs.rmSync(path.join(w.home, '.zcode'), { recursive: true })
      home0 = snapshot(w.home)
      const p2 = await post({ harness: B, confirm: p1.json.plan_id })
      assert.equal(p2.status, 409, p2.body)
      assert.notEqual(p2.json.plan_id, p1.json.plan_id)
      assert.deepEqual(snapshot(w.home), home0, 'a stale confirm wrote nothing')
      fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
      // the last install ran on other code (npm put a newer copy here since): a Set up places one harness's carriers and is not that install
      const m0 = readManifest(w.dir); m0.install.code = '0.0.1'; saveManifest(w.dir, m0)
      const p3 = await post({ harness: B })
      const before = snapshot(w.home), held = items(w), calls0 = trust.calls().length
      const ok = await post({ harness: B, confirm: p3.json.plan_id })
      assert.equal(ok.status, 200, ok.body)
      assert.deepEqual(validateReceipt(ok.json), [], ok.body)
      assert.deepEqual([ok.json.command, ok.json.ok], ['install', true], ok.body)
      const rel = (p) => path.relative(w.home, p).split(path.sep).join('/')
      const mine = items(w).filter((i) => i.harness === B)
      assert.ok(mine.length && mine.every((i) => fs.existsSync(i.path)), 'B\'s carrier written and recorded')
      // A's carriers, the root's items, the login entry and trocar-off: byte for byte as they were
      const after = snapshot(w.home)
      for (const i of held.filter((x) => x.harness !== B && x.path && before[rel(x.path)])) assert.equal(after[rel(i.path)], before[rel(i.path)], i.path)
      for (const f of Object.keys(before).filter((k) => !k.startsWith('.trocar/'))) if (!mine.some((i) => rel(i.path) === f)) assert.equal(after[f], before[f], f)
      assert.deepEqual([after['trocar-unit'], after['trocar-unit.enabled']], [before['trocar-unit'], before['trocar-unit.enabled']], 'the login entry neither rewritten nor registered (its stand-in\'s text is per process)')
      assert.ok(!('autostart' in ok.json), 'Set up does not report on a login entry it did not touch')
      assert.equal(readManifest(w.dir).install.code, '0.0.1', 'the record still names the code that last ran install (1.6 §5.5: what update finishes against)')
      assert.deepEqual(trust.calls().slice(calls0).filter((c) => !['exists', 'has'].includes(c)), [], 'the root was read back, nothing asked')
      // status --json's harnesses[B].setup is this judgement (4.11 P4b; the board's test world has no OS network facts to draw the rest)
      assert.equal(setupOf(w.harnesses.find((d) => d.name === B), { os: platform, manifest: readManifest(w.dir), ctx: w.ctx }).state, 'ready')
      // V67: a second Set up for B — an empty plan; its confirm changes no byte and asks nothing
      const again = await post({ harness: B })
      assert.equal(again.status, 409, again.body)
      assert.deepEqual(again.json.plan, [])
      const home1 = snapshot(w.home), calls1 = trust.calls().length
      const ok2 = await post({ harness: B, confirm: again.json.plan_id })
      assert.equal(ok2.status, 200, ok2.body)
      assert.deepEqual(validateReceipt(ok2.json), [], ok2.body)
      assert.deepEqual(quiet(snapshot(w.home)), quiet(home1), 'a second Set up changed no byte')
      assert.deepEqual(trust.calls().slice(calls1).filter((c) => !['exists', 'has'].includes(c)), [], 'nothing asked of the custody or the root store')
      // the root gone from the user's store (status: B needed, root-missing): the plan names the root, so its confirm's dialog is what it said
      trust.setStore({ held: [], answer: 'ok' })
      const gone = await post({ harness: B })
      assert.deepEqual(gone.json.plan.map((r) => r.what), ['root'], gone.body)
      const back = await post({ harness: B, confirm: gone.json.plan_id })
      assert.equal(back.status, 200, back.body)
      assert.ok(back.json.items.some((i) => i.item === 'root-store' && i.state === 'added'), back.body)
    })
  })

  test(`${platform} · 4.11 ㉒: the root key gone before a Set up — no new root for one harness; pending names trocar install, no byte of A's or the store's changes`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post, trust, state }) => {
      fs.rmSync(path.join(state, 'custody.json'))
      fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
      const p = await post({ harness: B })
      const before = snapshot(w.home), held = items(w), calls0 = trust.calls().length
      const r = await post({ harness: B, confirm: p.json.plan_id })
      assert.equal(r.status, 200, r.body)
      assert.deepEqual(validateReceipt(r.json), [], r.body)
      assert.ok(r.json.pending.some((x) => x.item === 'root-key' && x.command === 'trocar install'), r.body)
      const rel = (f) => path.relative(w.home, f).split(path.sep).join('/'), after = snapshot(w.home)
      for (const i of held.filter((x) => x.path && before[rel(x.path)])) assert.equal(after[rel(i.path)], before[rel(i.path)], i.path)
      assert.deepEqual(trust.calls().slice(calls0).filter((c) => !['exists', 'has'].includes(c)), [], 'no key made, no root removed or added')
    })
  })

  test(`${platform} · 4.4 #13 「Set up 的三件实话」: a root not in the store and a dialog nobody answers → pending with trocar install; B's carrier placed all the same`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post, trust }) => {
      trust.setStore({ held: [], answer: 'pending' })
      fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
      const p = await post({ harness: B })
      assert.equal(p.status, 409, p.body)
      assert.ok(p.json.plan.some((x) => x.what === 'root'), p.body)
      const r = await post({ harness: B, confirm: p.json.plan_id })
      assert.equal(r.status, 200, r.body)
      assert.deepEqual(validateReceipt(r.json), [], r.body)
      assert.equal(r.json.ok, false)
      assert.ok(r.json.pending.some((x) => x.item === 'root-store' && x.state === 'pending' && x.command === 'trocar install'), r.body)
      assert.ok(r.json.carriers.some((c) => c.harness === B && c.state === 'placed'), r.body)
      assert.ok(items(w).some((i) => i.harness === B && fs.existsSync(i.path)))
    })
  })
}

test('4.4 #13 · 4.11 P4b: Set up is mounted on Linux too — POST /control/setup reaches the control verb; a root daemon mounts it nowhere', async () => {
  for (const uid of [501, 0]) {
    const seen = []
    const control = ({ verb, res }) => { seen.push(verb); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
    const { server } = createServer({ home: tmpDir('trocar-setup-linux-'), token: 't', uid, platform: 'linux', query: { relay: () => assert.fail('relayed'), control, warm: () => {} } })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const r = await request(server.address().port, '/control/setup', { method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: 't' }, body: JSON.stringify({ harness: B }) })
      if (uid === 0) assert.equal(r.status, 405)
      else { assert.notEqual(r.status, 405); assert.deepEqual(seen, ['setup']) }
    } finally { server.close() }
  }
})

/** Linux (driver mode): VERBS.setup over a HOME where install and on ran for Claude Code, and Z Code arrived after (4.6 「这个 harness 装好了没有」). */
const linuxSetupDeps = (s) => ({ platform: 'linux', env: s.sh.env, parts: { os: 'linux', harnesses: s.descs, scan: async () => [], match: () => ({ agent: null }), arch: null }, roots: ROOTS, exec: s.sys.exec.run, request: s.sys.daemon.request, getuid: () => 1000, helperState: () => ({ ok: true }) })
const outside = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith('.trocar/')))

test('Linux · 4.4 #13 · V67: Set up places only the harness\'s missing carriers, keeps install.code, and a second Set up changes nothing', async () => {
  const s = await installedHome({ names: ['claude-code', B], seed: (home) => fs.rmSync(path.join(home, '.zcode'), { recursive: true, force: true }) })
  const zc = path.join(s.home, '.zcode', 'cli', 'config.json')
  fs.mkdirSync(path.dirname(zc), { recursive: true }); fs.writeFileSync(zc, '{\n  "model": "lab/m"\n}\n')
  const ctx = { home: path.join(s.home, '.trocar'), deps: linuxSetupDeps(s) }
  const setup = (body) => VERBS.setup(body, ctx)
  // (a)
  assert.equal((await setup({ harness: 'nope' })).status, 400)
  // (b)
  const m0 = s.manifest(); m0.install.code = 'another-copy'; saveManifest(s.dir, m0) // install ran from another code: Set up is not an install run and keeps it
  const home0 = snapshot(s.home), claude0 = fs.readFileSync(path.join(s.home, '.claude', 'settings.json')), code0 = s.manifest().install.code
  const p = await setup({ harness: B })
  assert.equal(p.status, 409, JSON.stringify(p.doc))
  assert.equal(p.doc.need, 'confirm')
  assert.ok(p.doc.plan.length > 0 && p.doc.plan.every((r) => r.what === B), JSON.stringify(p.doc.plan))
  assert.deepEqual(snapshot(s.home), home0, 'the plan wrote nothing')
  // (c)
  const r = await setup({ harness: B, confirm: p.doc.plan_id })
  assert.equal(r.status, 200, JSON.stringify(r.doc))
  assert.deepEqual(validateReceipt(r.doc), [])
  assert.equal(r.doc.command, 'install')
  const home1 = snapshot(s.home), a = outside(home0), b = outside(home1)
  assert.deepEqual([...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]), ['.zcode/cli/config.json'])
  assert.deepEqual(fs.readFileSync(path.join(s.home, '.claude', 'settings.json')), claude0)
  assert.equal(s.manifest().install.code, code0)
  const desc = s.descs.find((d) => d.name === B)
  const after = driverSetup(desc, { os: 'linux', home: s.home, env: s.sh.env, manifest: s.manifest() })
  assert.deepEqual([after.state, after.missing], ['ready', []])
  // (d)
  const p2 = await setup({ harness: B })
  assert.equal(p2.status, 409, JSON.stringify(p2.doc))
  assert.deepEqual(p2.doc.plan, [])
  assert.equal((await setup({ harness: B, confirm: p2.doc.plan_id })).status, 200)
  assert.deepEqual(quiet(snapshot(s.home)), quiet(home1))
  assert.equal(s.manifest().install.code, code0)
})

test('Linux · 4.4 #13 · 4.6: Set up on a HOME without an install record is cert-not-installed and writes nothing', async () => {
  const s = await installedHome({ names: [B] })
  const home = tmpDir('trocar-setup-bare-')
  const zc = path.join(home, '.zcode', 'cli', 'config.json')
  fs.mkdirSync(path.dirname(zc), { recursive: true }); fs.writeFileSync(zc, '{}\n')
  const home0 = snapshot(home)
  const r = await VERBS.setup({ harness: B, confirm: 'x' }, { home: path.join(home, '.trocar'), deps: { ...linuxSetupDeps(s), env: { HOME: home } } })
  assert.equal(r.doc.ok, false, JSON.stringify(r.doc))
  assert.equal(r.doc.error.code, 'cert-not-installed')
  assert.deepEqual(snapshot(home), home0)
})

// 4.11 P4b · 4.6 (V67 / V91): what the judge calls `needed` is what install places again. Axes: every harness with an install-phase config item ×
// the item's file deleted / rewritten without trocar's text (its own update): the harness is still there, so setup is `needed`; Set up either
// places it again (→ `ready`, and `on <h>` turns it on) or, when its inject has nothing to place it from, refuses with setup-needed and changes
// no byte — never "nothing to set up" (4.6 「这个 harness 装好了没有」).
const DAMAGE = {
  deleted: (x) => fs.rmSync(x.path),
  overwritten: (x) => { const t = fs.readFileSync(x.path, 'utf8'); fs.writeFileSync(x.path, x.kind === 'json-key' ? setKey(t, x.keys, '/elsewhere/ca.pem').text : removeTrocarText(t, x.ops).text) },
}
for (const h of ['claude-code', 'codex', 'hermes', 'kimi-code', 'z-code']) for (const [how, damage] of Object.entries(DAMAGE)) {
  test(`Linux · V67 · V91: ${h}'s certificate item ${how} → setup needed; Set up places it again (→ ready, on ${h} turns it on) or refuses with setup-needed, writing nothing`, async () => {
    const s = await installedHome({ names: [h] })
    const desc = s.descs[0], judged = () => driverSetup(desc, { os: 'linux', home: s.home, env: s.sh.env, manifest: s.manifest() })
    const items = s.manifest().entries.filter((e) => e.harness === h && e.phase === 'install')
    for (const x of items) damage(x)
    const left = () => items.map((x) => (fs.existsSync(x.path) ? fs.readFileSync(x.path, 'utf8') : null)) // what the user (or the harness's own update) left
    const userLeft = left()
    assert.equal(judged().state, 'needed')
    const ctx = { home: path.join(s.home, '.trocar'), deps: linuxSetupDeps(s) }
    const record = () => fs.readFileSync(manifestPath(s.dir), 'utf8')
    const recorded = record()
    // which way it must go, from the data: does the harness's inject still give items on the damaged HOME (4.6: none → refuse, never guess)
    const given = desc.inject(driverCtx({ os: 'linux', home: s.home, env: s.sh.env })) || {}
    const places = [...(given.entries || []), ...(given.owned || []), ...(given.files || [])].length > 0
    const p = await VERBS.setup({ harness: h }, ctx)
    assert.equal(p.doc.ok !== false, places, JSON.stringify(p.doc))
    if (!places) {
      assert.equal(p.doc.error.code, 'setup-needed', JSON.stringify(p.doc))
      assert.deepEqual([left(), record()], [userLeft, recorded], 'a refused Set up writes nothing')
      assert.equal(judged().state, 'needed')
    } else {
      assert.equal(p.status, 409, JSON.stringify(p.doc))
      assert.ok(p.doc.plan.length > 0, JSON.stringify(p.doc))
      const r = await VERBS.setup({ harness: h, confirm: p.doc.plan_id }, ctx)
      assert.equal(r.status, 200, JSON.stringify(r.doc))
      assert.equal(r.doc.ok, true)
      assert.deepEqual([judged().state, judged().missing], ['ready', []])
      const on = await s.on({ ids: [h] })
      assert.equal(on.exit, 0, JSON.stringify(on.receipt))
      assert.ok(on.receipt.harnesses.includes(h) && !on.receipt.refused.length)
    }
    const un = await s.uninstall({ yes: true })
    assert.equal(un.exit, 0, JSON.stringify(un.receipt && un.receipt.problems))
    assert.deepEqual(left(), userLeft, 'uninstall puts back what the user left, byte for byte (invariant 5)')
  })
}

// 4.6 「这个 harness 装好了没有」: Set up has nothing to place — the agent is here but its inject gives no item (q5: never installed; lost: its carrier
// gone too), or it is not here at all (absent) → setup-needed with install's reason, no byte written, install.code kept. Each harness gets a
// footprint the test controls; STRIP takes away what its inject reads.
const STRIP = { codex: '.codex', 'kimi-code': '.bashrc' }
for (const h of Object.keys(STRIP)) for (const cell of ['q5', 'absent', 'lost']) {
  test(`Linux · 4.6: Set up ${h} (${cell}) with nothing to place → setup-needed with install's reason, nothing written`, async () => {
    const s = await installedHome({ names: cell === 'lost' ? ['claude-code', h] : ['claude-code'] })
    const real = (await loadHarnesses()).find((d) => d.name === h)
    const fp = { ...real, present: [{ base: 'home', dir: `.fp-${h}` }] }
    const descs = [...s.descs.filter((d) => d.name !== h), fp]
    if (cell !== 'absent') { fs.mkdirSync(path.join(s.home, `.fp-${h}`)); fs.rmSync(path.join(s.home, STRIP[h]), { recursive: true, force: true }) }
    const plan = await planOn({ home: s.home, env: s.sh.env, osName: 'linux', harnesses: descs, roots: ROOTS })
    const skip = plan.skipped.find((x) => x.what === h)
    assert.equal(!!skip, cell !== 'lost', JSON.stringify(plan.skipped))
    const home0 = outside(snapshot(s.home)), code0 = s.manifest().install.code
    const r = await VERBS.setup({ harness: h, confirm: 'x' }, { home: path.join(s.home, '.trocar'), deps: linuxSetupDeps({ ...s, descs }) })
    assert.equal(r.doc.ok, false, JSON.stringify(r.doc))
    assert.equal(r.doc.error.code, 'setup-needed')
    if (skip) assert.ok(skip.reason && r.doc.error.message.includes(skip.reason), JSON.stringify(r.doc.error))
    assert.deepEqual(outside(snapshot(s.home)), home0)
    assert.equal(s.manifest().install.code, code0)
  })
}

test('Linux · invariant 5: a file trocar created in a directory it made, deleted and placed again by Set up, leaves neither behind at uninstall', async () => {
  const s = await installedHome({ names: ['claude-code'], seed: (home) => fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }) })
  const x = s.manifest().entries.find((e) => e.harness === 'claude-code' && e.phase === 'install')
  assert.deepEqual([x.existed_before, x.created_dirs.includes(path.dirname(x.path))], [false, true], 'install made the file and its directory')
  fs.rmSync(x.path)
  const ctx = { home: path.join(s.home, '.trocar'), deps: linuxSetupDeps(s) }
  const p = await VERBS.setup({ harness: 'claude-code' }, ctx)
  assert.equal((await VERBS.setup({ harness: 'claude-code', confirm: p.doc.plan_id }, ctx)).doc.ok, true)
  assert.ok(fs.existsSync(x.path), 'placed again')
  assert.equal((await s.uninstall({ yes: true })).exit, 0)
  assert.deepEqual([fs.existsSync(x.path), fs.existsSync(path.dirname(x.path))], [false, false])
})

test('Linux · 4.11 P4b · D38: a carrier file that cannot be read judges `unknown` with its reason, never ready; on goes on with a note, not a refusal', { skip: process.getuid && process.getuid() === 0 ? 'root reads a 000 file' : false }, async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const x = s.manifest().entries.find((e) => e.harness === 'claude-code' && e.phase === 'install')
  fs.chmodSync(x.path, 0o000)
  try {
    const j = driverSetup(s.descs[0], { os: 'linux', home: s.home, env: s.sh.env, manifest: s.manifest() })
    assert.equal(j.state, 'unknown', JSON.stringify(j)); assert.ok(j.reason)
    const on = await s.on({ ids: ['claude-code'] })
    assert.deepEqual([on.exit, on.receipt.refused, on.receipt.harnesses], [0, [], ['claude-code']], JSON.stringify(on.receipt))
    assert.ok(on.receipt.notes.some((n) => n.includes(x.path)), 'the note says which file was not read')
  } finally { fs.chmodSync(x.path, 0o600) }
})

test('Linux · D38: a carrier install cannot place again (its file now a link to nothing) → Set up refuses with setup-needed and writes nothing', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const x = s.manifest().entries.find((e) => e.harness === 'claude-code' && e.phase === 'install')
  fs.rmSync(x.path); fs.symlinkSync(path.join(s.home, 'gone', 'settings.json'), x.path)
  const desc = s.descs[0]
  assert.equal(driverSetup(desc, { os: 'linux', home: s.home, env: s.sh.env, manifest: s.manifest() }).state, 'needed')
  const seen = () => [fs.readlinkSync(x.path), fs.readFileSync(manifestPath(s.dir), 'utf8')] // a link to nothing: not a file a snapshot reads
  const before = seen()
  const r = await VERBS.setup({ harness: 'claude-code', confirm: 'x' }, { home: path.join(s.home, '.trocar'), deps: linuxSetupDeps(s) })
  assert.equal(r.doc.ok, false, JSON.stringify(r.doc))
  assert.equal(r.doc.error.code, 'setup-needed')
  assert.deepEqual(seen(), before)
})
