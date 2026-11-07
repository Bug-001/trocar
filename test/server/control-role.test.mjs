// test/server/control-role.test.mjs — 3.5 #64-#68 (§谁执行它, three roles): the board's control verbs run on a worker role of their own ('control'),
// so a verb waiting on the OS's root prompt holds no read of the main or light role. The router is the daemon's (src/query/router.mjs); its workers are
// the real query worker (test/helpers/worker-fork.mjs) with the deps of test/helpers/board-world.mjs, whose user root store holds an add at a gate file
// until the test opens it (the prompt answered). Harness codex is installed; z-code (a present form with a carrier of its own) is set up from the board,
// which asks the root store again. Sandbox HOMEs only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { depsFile, sharedTrust, standInUnit } from '../helpers/board-world.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { recorder } from '../query/hand-world.mjs'
import { createQueryRouter } from '../../src/query/router.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'

const A = 'codex', B = 'z-code'
const until = (f, ms, what) => within(new Promise((res) => { const t = setInterval(() => { if (f()) { clearInterval(t); res() } }, 10) }), ms, what)
const exited = (c) => c.exitCode !== null || c.signalCode !== null

/** A world with A installed, B's form present and the root store's add held at `gate`; `run(ctx)` inside, the router stopped after. */
async function withRouter(opts, run) {
  const w = await modelWorld({ os: 'darwin', commands: [A] })
  const state = tmpDir('trocar-trust-')
  const trust = sharedTrust(state)
  assert.equal((await w.install({ custody: trust.custody, rootStore: trust.rootStore, unit: standInUnit(w.home) })).exit, 0)
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  const gates = tmpDir('trocar-gate-')
  const gate = path.join(gates, 'open')
  trust.setStore({ held: [], answer: 'pending', gate })
  const deps = depsFile(w, 'darwin', state)
  const failures = [], kids = []
  const router = createQueryRouter({ home: path.join(w.home, '.trocar'), failure: (_, e) => failures.push({ code: e.code }), ...opts,
    fork: (h, _, role) => { const c = Object.assign(workerFork(h, deps, role), { role }); kids.push(c); return c } })
  const adds = () => trust.calls().filter((v) => v === 'add').length
  const adds0 = adds()
  /** a verb through the router → { status, json } once settled */
  const verb = async (v, body = {}) => { const res = recorder(); await router.control({ verb: v, body, res }); return { status: res.status, json: JSON.parse(res.text()) } }
  /** Set up B planned, then confirmed: → { done: the confirm's promise }, once the root store's add is in the dialog */
  const held = async () => {
    const n = adds()
    const plan = await within(verb('setup', { harness: B }), 20_000, 'the plan')
    assert.equal(plan.status, 409)
    const confirm = verb('setup', { harness: B, confirm: plan.json.plan_id })
    confirm.catch(() => {}) // a rejection is the caller's to assert
    await within(Promise.race([until(() => adds() > n, 20_000, 'the add'), confirm.then(() => assert.fail('settled before the dialog'), () => assert.fail('rejected before the dialog'))]), 20_000, 'the dialog')
    return { done: confirm }
  }
  const open = (g = gate) => fs.writeFileSync(g, '')
  try { await run({ router, trust, failures, kids, verb, held, open, adds: () => adds() - adds0, gates }) } finally { router.stop() }
}

const settledFlag = (p) => { const s = { settled: false }; p.then(() => { s.settled = true }, () => { s.settled = true }); return s }

test('3.5 #64: reads of the main and light roles are answered while a confirmed Set up waits in the root prompt; the verb then answers a valid receipt', { timeout: 60_000 }, async () => {
  await withRouter({}, async ({ router, held, open }) => {
    const { done } = await held()
    const s = settledFlag(done)
    for (const [name, params] of [['sessions', {}], ['session', { id: 'nobody' }], ['status', {}]]) {
      const res = recorder()
      await within(router.relay({ name, params, res }), 20_000, name)
      assert.equal(res.status, 200, name)
    }
    assert.equal(s.settled, false)
    open()
    const r = await within(done, 20_000, 'the confirm')
    assert.equal(r.status, 200)
    assert.deepEqual(validateReceipt(r.json), [])
  })
})

test('3.5 #65: a control verb waits behind the one in the root prompt, and is answered after it', { timeout: 60_000 }, async () => {
  await withRouter({}, async ({ held, verb, open }) => {
    const order = []
    const { done } = await held()
    const setup = done.then((r) => { order.push('setup'); return r })
    const status = verb('status').then((r) => { order.push('status'); return r })
    open()
    const [a, b] = await within(Promise.all([setup, status]), 20_000, 'both verbs')
    assert.deepEqual(order, ['setup', 'status'])
    assert.deepEqual([a.status, b.status], [200, 200])
  })
})

test('3.5 #66: a control worker killed in the root prompt fails the verb with a record, and the verb is not run again', { timeout: 60_000 }, async () => {
  await withRouter({}, async ({ held, kids, failures, adds }) => {
    const { done } = await held()
    const ctl = kids.filter((c) => c.role === 'control')
    assert.equal(ctl.length, 1)
    ctl[0].kill('SIGKILL')
    await assert.rejects(within(done, 20_000, 'the confirm'))
    assert.deepEqual(failures, [{ code: 'query-failed' }])
    assert.equal(adds(), 1)
    assert.deepEqual(kids.map((c) => c.role), ['control'])
  })
})

// the rest of install after the prompt takes about 2 s of worker silence here: the control deadline is set above the prompt plus that
test('3.5 #67: a control verb is bounded by the control deadline, not the read deadline', { timeout: 60_000 }, async () => {
  await withRouter({ deadlineMs: 500, controlDeadlineMs: 6000 }, async ({ held, open, failures, trust, gates }) => {
    const first = await held()
    setTimeout(open, 1500)
    assert.equal((await within(first.done, 20_000, 'the confirm')).status, 200)
    assert.deepEqual(failures, [])
    trust.setStore({ held: [], answer: 'pending', gate: path.join(gates, 'never') })
    const second = await held()
    await assert.rejects(within(second.done, 20_000, 'the unanswered confirm'))
    assert.deepEqual(failures, [{ code: 'query-failed' }])
  })
})

test('3.5 #68: the control worker forks on the first control verb and leaves when idle or stopped', { timeout: 60_000 }, async () => {
  await withRouter({ idleMs: 300 }, async ({ router, verb, kids }) => {
    const res = recorder()
    await within(router.relay({ name: 'status', params: {}, res }), 20_000, 'status')
    assert.equal(kids.filter((c) => c.role === 'control').length, 0)
    assert.equal((await within(verb('status'), 20_000, 'the status verb')).status, 200)
    const first = kids.filter((c) => c.role === 'control')
    assert.equal(first.length, 1)
    await until(() => exited(first[0]), 10_000, 'the idle control worker')
    assert.equal((await within(verb('status'), 20_000, 'the second status verb')).status, 200)
    const second = kids.filter((c) => c.role === 'control' && !exited(c))
    assert.equal(second.length, 1)
    router.stop()
    await until(() => exited(second[0]), 10_000, 'the stopped control worker')
  })
})
