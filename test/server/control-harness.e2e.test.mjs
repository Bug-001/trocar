// test/server/control-harness.e2e.test.mjs — 4.4 #11 (§控制面「先计划后确认」, D26②): POST /control/harness runs the very functions `trocar on` /
// `trocar off` run. A REAL startDaemon (the model collector, test/helpers/model-daemon.mjs) mounts the board on the port install recorded; its
// query worker is the real one (test/helpers/worker-fork.mjs) with the on/off OS fakes as its deps module (test/helpers/board-world.mjs); the
// test talks to the board's real TCP port with the board.token, and `on` inside the worker finds the daemon through controlEndpointFor —
// nothing is injected into a request or a socket path. Sandbox HOMEs only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf, unservable } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { depsFile } from '../helpers/board-world.mjs'
import { request } from './face.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { loadIngressConfig } from '../../src/collector/core/ingress-config.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { createServer } from '../../src/server.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
const flows = (dir) => { const d = path.join(dir, 'flows'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [] }

/** A model world with codex installed and the board's port recorded, and a daemon serving it; `run(ctx)` inside, the daemon stopped after. */
async function withBoard(platform, run) {
  const w = await modelWorld({ os: platform, commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const port = await boardPortOf(w.dir)
  const deps = depsFile(w, platform)
  await withScratchCwd(platform, async () => {
    const box = await liveUnit({ w, platform, parts: { helper: HELPER }, daemon: { fork: (h) => workerFork(h, deps) } })
    box.unit.start(); await box.starting
    const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
    const post = (body, headers = { [CONTROL_TOKEN_HEADER]: token }) => request(port, '/control/harness', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
      .then((r) => ({ ...r, json: JSON.parse(r.body) }))
    // V91: the board's status poll (GET /api/status, the query worker) and GET /control/status (the control verbs) read the machine one way
    const sameView = async (when) => {
      const get = (p) => request(port, p, { headers: { [CONTROL_TOKEN_HEADER]: token } }).then((r) => { assert.equal(r.status, 200, `${p} ${when}: ${r.body}`); return JSON.parse(r.body) })
      const [api, ctl] = await Promise.all([get('/api/status'), get('/control/status')])
      assert.deepEqual(Object.keys(api.harnesses).sort(), ctl.harnesses.map((h) => h.harness).sort(), when)
      for (const h of ctl.harnesses) assert.deepEqual({ desired: api.harnesses[h.harness].desired, setup: api.harnesses[h.harness].setup }, { desired: h.desired, setup: h.setup }, `${h.harness} ${when}`)
      return ctl
    }
    try { await run({ w: { ...w, token, port }, post, sameView }) } finally { await box.stop() }
  })
}

for (const platform of ['darwin', 'win32']) {
  const skip = await unservable(platform) // a darwin world on a win32 host: its unix socket cannot be listened on there
  test(`${platform} · 4.4 #11: on and off from the board — 409 with the plan and nothing written, a stale plan_id → a new plan, confirm → the CLI's receipt; off keeps the user's edit`, { skip, timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post, sameView }) => {
      const envFile = path.join(w.home, '.codex', '.env')
      fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, '# the user\'s own\nOPENAI_BASE_URL=https://relay.example\n')
      const before = fs.readFileSync(envFile)
      const old = new Set(flows(w.dir).map((r) => JSON.stringify(r)))
      await sameView('before on')
      let home0 = snapshot(w.home)
      const p1 = await post({ harness: 'codex', on: true })
      assert.equal(p1.status, 409, p1.body)
      assert.deepEqual([p1.json.need, typeof p1.json.plan_id, p1.json.receipt.dry_run], ['confirm', 'string', true])
      assert.deepEqual(p1.json.plan, p1.json.receipt.planned)
      assert.ok(p1.json.plan.some((x) => x.harness === 'codex' && x.paths.includes(envFile)), p1.body)
      assert.deepEqual(snapshot(w.home), home0, 'the plan wrote nothing')
      // the machine changes between the two requests (a codex form appears): the old plan_id is stale → a new plan, still nothing written
      fs.mkdirSync(path.join(w.home, '.vscode', 'extensions', 'openai.chatgpt-1.0.0'), { recursive: true })
      home0 = snapshot(w.home)
      const p2 = await post({ harness: 'codex', on: true, confirm: p1.json.plan_id })
      assert.equal(p2.status, 409, p2.body)
      assert.notEqual(p2.json.plan_id, p1.json.plan_id)
      assert.deepEqual(snapshot(w.home), home0, 'a stale confirm wrote nothing')
      // the door port recorded for codex is held by another program: the on run moves it and writes its engine-port-taken record (a record of the on run)
      const { groupPorts } = await loadIngressConfig({ dir: w.dir, groups: [...new Set(p2.json.plan.map((x) => `${x.harness}:${x.route}`))] })
      const squatter = net.createServer().listen(Object.values(groupPorts)[0], '127.0.0.1'); await once(squatter, 'listening')
      const on = await post({ harness: 'codex', on: true, confirm: p2.json.plan_id }).finally(() => squatter.close())
      assert.equal(on.status, 200, on.body)
      assert.deepEqual(validateReceipt(on.json), [], on.body)
      assert.deepEqual([on.json.command, on.json.ok, on.json.harnesses], ['on', true, ['codex']], on.body)
      assert.equal((await sameView('after a confirmed on')).harnesses.find((h) => h.harness === 'codex').desired, 'on')
      const wrote = fs.readFileSync(envFile, 'utf8')
      assert.match(wrote, /127\.0\.0\.1:\d+/, 'the entry with the door the daemon opened')
      const backups = path.join(w.home, '.trocar', 'backup')
      const held = fs.readdirSync(backups, { recursive: true }).map((n) => path.join(backups, n)).filter((f) => fs.statSync(f).isFile())
      assert.ok(held.some((f) => fs.readFileSync(f).equals(before)), 'the pre-image is in ~/.trocar/backup/')
      // an unrelated edit of the user's in the same file, kept byte for byte by off
      fs.writeFileSync(envFile, wrote.replace('relay.example', 'relay2.example'))
      const edited = Buffer.from(before.toString('utf8').replace('relay.example', 'relay2.example'))
      const p3 = await post({ harness: 'codex', on: false })
      assert.equal(p3.status, 409, p3.body)
      assert.deepEqual([p3.json.receipt.command, p3.json.receipt.dry_run], ['off', true])
      const off = await post({ harness: 'codex', on: false, confirm: p3.json.plan_id })
      assert.equal(off.status, 200, off.body)
      assert.deepEqual([off.json.command, off.json.ok], ['off', true], off.body)
      assert.deepEqual(fs.readFileSync(envFile), edited, "trocar's entry gone, the user's edit kept")
      // what a CLI off leaves: status --json's own document (GET /control/status) says desired off
      const st = await request(w.port, '/control/status', { headers: { [CONTROL_TOKEN_HEADER]: w.token } })
      assert.equal(st.status, 200, st.body)
      assert.equal(JSON.parse(st.body).harnesses.find((h) => h.harness === 'codex').desired, 'off')
      // every flows/ record of the two runs is marked as the board's and is in the closed sets
      const recs = flows(w.dir).filter((r) => !old.has(JSON.stringify(r)))
      assert.ok(recs.some((r) => r.code === 'engine-port-taken'), JSON.stringify(recs))
      assert.ok(recs.some((r) => r.event === 'off-note' && r.kind === 'result'), JSON.stringify(recs))
      for (const r of recs) assert.equal(r.source, 'board', JSON.stringify(r))
      for (const r of recs) assert.deepEqual(checkRecord(r), [], JSON.stringify(r))
    })
  })

  test(`${platform} · 4.4 #11 gates: no token → 403, a daemon as root → 405, a bad body → 400; nothing written`, { skip, timeout: 60_000 }, async () => {
    await withBoard(platform, async ({ w, post }) => {
      const home0 = snapshot(w.home)
      assert.equal((await post({ harness: 'codex', on: true }, {})).status, 403)
      for (const body of [{ harness: 'nope', on: true }, { harness: 'codex', on: 'yes' }, { on: false }]) assert.equal((await post(body)).status, 400, JSON.stringify(body))
      const { server } = createServer({ home: path.join(w.home, '.trocar'), token: w.token, uid: 0, query: { relay: () => assert.fail('relayed'), control: () => assert.fail('relayed'), warm: () => {} } })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      try {
        const r = await request(server.address().port, '/control/harness', { method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: w.token }, body: JSON.stringify({ harness: 'codex', on: true }) })
        assert.equal(r.status, 405)
      } finally { server.close() }
      assert.deepEqual(snapshot(w.home), home0)
    })
  })
}
