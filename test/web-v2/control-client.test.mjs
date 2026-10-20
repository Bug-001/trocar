// control-client.test.mjs — the board's writes (4.4 §控制面, acceptance 11 client side; invariant 1 / D30): post() carries the token and a
// JSON body, and planConfirm sends a confirm only for a plan ask() said yes to, over the real face and the real class table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api } from '../../src/web/v2/core/api.mjs'
import { planConfirm } from '../../src/web/v2/core/control.mjs'
import { configure, onForbidden, post } from '../../src/web/v2/core/http.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { edit, readTable, keepOf } from '../../src/classes/table.mjs'
import { classesFile } from '../../src/paths.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// globalThis.fetch for one block; answer(url, init) → Response. Each call is logged with its parsed body and its answer's JSON.
async function withFetch(answer, fn) {
  const real = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init = {}) => {
    const r = await answer(String(url), init, real)
    let reply = null
    try { reply = await r.clone().json() } catch { /* no JSON answer */ }
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null, status: r.status, reply })
    return r
  }
  try { return await fn(calls) } finally { globalThis.fetch = real; configure({ token: null }) }
}

// the real face (real-face.mjs) reached from node: the board's relative path goes to the face's port
async function withFace(fn) {
  const h = boardHome()
  const b = await serveBoard(h)
  try {
    configure({ token: b.token })
    return await withFetch((url, init, real) => real(b.base + url, init), (calls) => fn({ ...h, calls }))
  } finally { await b.close() }
}
const bytesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null)
const SET = { kind: 'set', class: 'telemetry', keep: 'log' }

test('4.4 token: a post carries CONTROL_TOKEN_HEADER with the configured token and the JSON of its argument', async () => {
  await withFetch(() => json({ ok: true }), async (calls) => {
    configure({ token: 'T' })
    const body = { harness: 'codex', on: false }
    const r = await post('/control/harness', body)
    assert.equal(r.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers[CONTROL_TOKEN_HEADER], 'T')
    assert.deepEqual(calls[0].body, body)
  })
})

test('4.4 plan then confirm (D30): no yes → one POST without confirm and nothing written; yes → the confirm carries plan_id and the change lands', async () => {
  await withFace(async ({ home, calls }) => {
    const file = classesFile(home)
    const before = bytesOf(file)
    const no = await planConfirm({ api, verb: 'classes', body: SET, ask: async () => false })
    assert.equal(no.outcome, 'cancelled')
    assert.equal(calls.length, 1)
    assert.equal('confirm' in calls[0].body, false)
    assert.deepEqual(bytesOf(file), before)

    calls.length = 0
    const yes = await planConfirm({ api, verb: 'classes', body: SET, ask: async () => true })
    assert.equal(yes.outcome, 'done')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].status, 409)
    assert.equal(calls[1].body.confirm, calls[0].reply.plan_id)
    assert.equal(calls[1].status, 200)
    assert.equal(keepOf(readTable({ home }), 'telemetry'), 'log')
  })
})

test('4.4 stale plan: a change between plan and confirm → 409 with a new plan, asked again (stale), nothing of the old plan written', async () => {
  await withFace(async ({ home, calls }) => {
    const file = classesFile(home)
    const asked = []
    let after = null
    const r = await planConfirm({
      api, verb: 'classes', body: SET,
      ask: async (q) => {
        asked.push(q)
        if (asked.length > 1) return false
        assert.equal(edit({ kind: 'add', class: 'telemetry', host: 'interfere.example' }, { home }).ok, true)
        after = bytesOf(file)
        return true
      },
    })
    assert.equal(r.outcome, 'cancelled')
    assert.deepEqual(asked.map((q) => q.stale), [false, true])
    const statuses = calls.map((c) => c.status)
    assert.deepEqual(statuses, [409, 409])
    assert.equal(calls[1].body.confirm, calls[0].reply.plan_id)
    assert.notEqual(calls[1].reply.plan_id, calls[0].reply.plan_id)
    assert.deepEqual(asked[1].plan, calls[1].reply.plan)
    assert.deepEqual(bytesOf(file), after)
  })
})

test('4.4 400: an unknown class fails with the body\'s error and writes nothing', async () => {
  await withFace(async ({ home, calls }) => {
    const file = classesFile(home)
    const before = bytesOf(file)
    const r = await planConfirm({ api, verb: 'classes', body: { kind: 'set', class: 'no-such-class', keep: 'log' }, ask: async () => true })
    assert.equal(r.outcome, 'failed')
    assert.equal(r.status, 400)
    assert.equal(r.error, calls[0].reply.error)
    assert.equal(typeof r.error, 'string')
    assert.deepEqual(bytesOf(file), before)
  })
})

// last in this file: the K-30 latch is module state and stays shut
test('K-30: a 403 to a post fires onForbidden once; later get() and post() send nothing', async () => {
  let fired = 0
  onForbidden(() => fired++)
  await withFetch(() => json({ error: 'x' }, 403), async (calls) => {
    assert.equal((await post('/control/classes', SET)).status, 403)
    const n = calls.length
    assert.equal((await api.get('sessions')).status, 403)
    assert.equal((await api.control('classes', SET)).status, 403)
    assert.equal(calls.length, n)
  })
  assert.equal(fired, 1)
})
