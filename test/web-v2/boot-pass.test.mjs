// test/web-v2/boot-pass.test.mjs — 1.2 §会话头 读取状态 · 1.5 K-31: a first read the worker's boot pass holds (after an update the index
// rows are read again, 3.5 §行表先读) says so, not "0 %"; the board learns of the pass from a 503 still-reading (core/http.mjs) and asks
// for one, paced (replay/model.mjs bootProbe), while its first read has not begun.
import test from 'node:test'
import assert from 'node:assert/strict'
import { get, configure, bootPass } from '../../web/legacy/core/http.mjs'
import { createDesk, bootProbe } from '../../web/legacy/replay/model.mjs'
import { INTERVAL } from '../../web/legacy/core/poll.mjs'
import { applyHead } from '../../web/legacy/replay/packs.mjs'
import { sessionHeadModel } from '../../web/src/screens/replay/models.mjs'
import { QUERY_WAIT_PROBLEMS } from '../../src/health/codes.mjs'

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
async function answered(path, status, body) { // one read of `path` through the board's own get(), answered as given
  const real = globalThis.fetch
  globalThis.fetch = async () => json(body, status)
  try { return await get(path, null, { hold: false }) } finally { globalThis.fetch = real; configure({ token: null }) }
}
const WAIT = { ok: false, errors: [{ where: 'daemon', code: QUERY_WAIT_PROBLEMS[0], reason: 'still reading the index rows' }] }
const deskAt = (tier, pending) => { const d = createDesk(); applyHead(d, { mark: tier ? 'S:1' : null, tier, lanes: [], steps: 9, pending }); return d }
const readOn = (desk) => sessionHeadModel({ desk, meta: { session_id: 'S' }, lanes: [] }).read

test('1.2 读取状态: during the boot pass a first read that has not begun says the index is being re-read, with no share; it moves, or the pass ends, and the share is back', async () => {
  await answered('/api/overview', 200, { ok: true })
  assert.equal(bootPass(), false)
  const held = deskAt(0, { done: 0, total: 9, calls: 9 })
  assert.equal(readOn(held).state, 'reading', 'no boot pass known: the first-read share')
  await answered('/api/overview', 503, WAIT)
  assert.equal(bootPass(), true, 'a 503 still-reading says the pass runs')
  const r = readOn(held)
  assert.equal(r.state, 'boot-pass')
  assert.doesNotMatch(r.text, /%/, 'no share: none is known')
  assert.equal(readOn(deskAt(0, { done: 1, total: 9, calls: 9 })).state, 'reading', 'the read moved: its share again')
  assert.equal(readOn(deskAt(1, { done: 0, total: 9, calls: 9 })).state, 'reading', 'a tier-1 head is being folded already')
  assert.equal(readOn(deskAt(0, { done: 0, total: 9, calls: 9, stopped: { code: 'fold-failed' } })).state, 'stopped')
  // answers no worker made say nothing of the pass: an answer file, a 304 (the daemon's stamp match), a stored list (4.4 §存下的答案)
  await answered('/api/d/head', 200, { ok: true })
  await answered('/api/sessions', 200, { ok: true, sessions: [], stored: { at: '2026-11-08T00:00:00Z' } })
  await answered('/api/overview', 304, {})
  assert.equal(bootPass(), true, 'an answer file, a stored list or a 304 is no sign the rows are read')
  for (const name of ['sessions', 'session', 'lane', 'overview']) {
    await answered('/api/overview', 503, WAIT)
    await answered(`/api/${name}`, 200, { ok: true })
    assert.equal(bootPass(), false, `a worker's ${name} answer says the pass has ended`)
  }
  assert.equal(readOn(held).state, 'reading')
})

test('bootProbe: while the first read has not begun, one overview read at the overview\'s pace (INTERVAL.other), never two at once, whatever is known of the pass', async () => {
  let t = 0
  const sent = [], pending = []
  const probe = bootProbe({ now: () => t, get: (n, p, o) => { sent.push([n, p, o.cond]); return new Promise((ok) => pending.push(ok)) } })
  const held = deskAt(0, { done: 0, total: 9, calls: 9 })
  const settle = () => new Promise((ok) => setImmediate(ok))
  assert.ok(probe(held), 'the first round asks')
  assert.deepEqual(sent, [['overview', { since: '24h' }, false]], 'the overview\'s default, a whole answer (no If-None-Match)')
  t = INTERVAL.other * 3
  assert.equal(probe(held), null, 'never two at once (a read parked through the pass)')
  pending.shift()({ ok: false, status: 503 }); await settle()
  t += 1
  assert.ok(probe(held), 'the pass known: it still asks, so the answer that ends the pass comes')
  pending.shift()({ ok: true, status: 200 }); await settle() // a fast 200
  const at = t
  for (const dt of [0, 1, 1000, INTERVAL.other - 1]) { t = at + dt; assert.equal(probe(held), null, `a fast answer brings no other read ${dt} ms after the last`) }
  t = at + INTERVAL.other; assert.ok(probe(held), 'at INTERVAL.other: one more'); pending.shift()({ ok: true })
  await settle(); t += INTERVAL.other
  assert.equal(probe(deskAt(0, { done: 1, total: 9, calls: 9 })), null, 'the read has begun: no probe')
  assert.equal(probe(deskAt(1, { done: 0, total: 9, calls: 9 })), null, 'a tier-1 head: no probe')
  assert.equal(sent.length, 3)
})
