// test/server/control-setup.test.mjs — 4.4 #13 (§控制面 Set up, D65④ · D26②; 1.6 §3.2 V67): POST /control/setup runs `asight install`'s own
// function for one harness. A REAL startDaemon (test/helpers/model-daemon.mjs) mounts the board; its query worker is the real one
// (test/helpers/worker-fork.mjs) with the deps module of test/helpers/board-world.mjs, whose key custody and user root store are files shared by
// the test, the daemon and the worker (sharedTrust). Harness A (codex) is installed; harness B (z-code: a present form whose carrier is not the
// root) appears afterwards. Sandbox HOMEs only; no trust store, no launchd, no scheduled task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { depsFile, sharedTrust, standInUnit } from '../helpers/board-world.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { request } from './face.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { ensureBoardPort } from '../../src/collector/core/ingress-config.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { readManifest, itemsOfPhase } from '../../src/off/manifest.mjs'
import { setupOf } from '../../src/collector/core/proxymode/status-facts.mjs'
import { createServer } from '../../src/server.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'

const A = 'codex', B = 'z-code' // B: its CLI form is present when ~/.zcode is, and carries the root through a config key (a carrier of its own)
const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
const FLOWS = '.asight/collector/flows/' // the run's records (install-note): every install run appends one
const quiet = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith(FLOWS)))
const items = (w) => itemsOfPhase(readManifest(w.dir), 'install')

/** A model world with A installed through install's own function, the board's port recorded, and a daemon serving it; `run(ctx)` inside. */
async function withBoard(platform, run) {
  const w = await modelWorld({ os: platform, commands: [A] })
  const state = tmpDir('asight-trust-')
  const trust = sharedTrust(state)
  assert.equal((await w.install({ custody: trust.custody, rootStore: trust.rootStore, unit: standInUnit(w.home) })).exit, 0)
  // the board's port as install records it, then moved to a port the OS hands out: tests running side by side never meet on one board (a 403)
  await ensureBoardPort({ dir: w.dir, isFree: async () => true })
  const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; probe.close()
  const ingress = path.join(w.dir, 'ingress.json')
  fs.writeFileSync(ingress, JSON.stringify({ ...JSON.parse(fs.readFileSync(ingress, 'utf8')), boardPort: port }))
  const deps = depsFile(w, platform, state)
  await withScratchCwd(platform, async () => {
    const box = await liveUnit({ w: { ...w, custody: trust.custody }, platform, parts: { helper: HELPER }, daemon: { fork: (h) => workerFork(h, deps) } })
    box.unit.start(); await box.starting
    const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
    const post = (body) => request(port, '/control/setup', { method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token }, body: JSON.stringify(body) })
      .then((r) => ({ ...r, json: JSON.parse(r.body) }))
    try { await run({ w, post, trust }) } finally { await box.stop() }
  })
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · 4.4 #13 · V67: Set up for a harness installed after install — a plan of its carriers only, a stale plan_id, confirm places them and nothing else; a second Set up changes nothing`, { timeout: 60_000 }, async () => {
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
      const p3 = await post({ harness: B })
      const before = snapshot(w.home), held = items(w), calls0 = trust.calls().length
      const ok = await post({ harness: B, confirm: p3.json.plan_id })
      assert.equal(ok.status, 200, ok.body)
      assert.deepEqual(validateReceipt(ok.json), [], ok.body)
      assert.deepEqual([ok.json.command, ok.json.ok], ['install', true], ok.body)
      const rel = (p) => path.relative(w.home, p).split(path.sep).join('/')
      const mine = items(w).filter((i) => i.harness === B)
      assert.ok(mine.length && mine.every((i) => fs.existsSync(i.path)), 'B\'s carrier written and recorded')
      // A's carriers, the root's items, the login entry and asight-off: byte for byte as they were
      const after = snapshot(w.home)
      for (const i of held.filter((x) => x.harness !== B && x.path && before[rel(x.path)])) assert.equal(after[rel(i.path)], before[rel(i.path)], i.path)
      for (const f of Object.keys(before).filter((k) => !k.startsWith('.asight/'))) if (!mine.some((i) => rel(i.path) === f)) assert.equal(after[f], before[f], f)
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
    })
  })

  test(`${platform} · 4.4 #13 「Set up 的三件实话」: a root not in the store and a dialog nobody answers → pending with asight install; B's carrier placed all the same`, { timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post, trust }) => {
      trust.setStore({ held: [], answer: 'pending' })
      fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
      const p = await post({ harness: B })
      assert.equal(p.status, 409, p.body)
      const r = await post({ harness: B, confirm: p.json.plan_id })
      assert.equal(r.status, 200, r.body)
      assert.deepEqual(validateReceipt(r.json), [], r.body)
      assert.equal(r.json.ok, false)
      assert.ok(r.json.pending.some((x) => x.item === 'root-store' && x.state === 'pending' && x.command === 'asight install'), r.body)
      assert.ok(r.json.carriers.some((c) => c.harness === B && c.state === 'placed'), r.body)
      assert.ok(items(w).some((i) => i.harness === B && fs.existsSync(i.path)))
    })
  })
}

test('4.4 #13 · 4.11 P4b: on Linux the board has no Set up — POST /control/setup is 405 and nothing is written', async () => {
  const home = tmpDir('asight-setup-linux-')
  fs.mkdirSync(path.join(home, '.asight'))
  const home0 = snapshot(home)
  const { server } = createServer({ home: path.join(home, '.asight'), token: 't', uid: 501, platform: 'linux', query: { relay: () => assert.fail('relayed'), control: () => assert.fail('relayed'), warm: () => {} } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const r = await request(server.address().port, '/control/setup', { method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: 't' }, body: JSON.stringify({ harness: B }) })
    assert.equal(r.status, 405)
  } finally { server.close() }
  assert.deepEqual(snapshot(home), home0)
})
