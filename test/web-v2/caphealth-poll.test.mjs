// caphealth-poll.test.mjs — 1.5 §采集状态 轮询 (MUST) with 4.4 §live-poll's period: while the page is visible one `status` read per period,
// none while hidden, one at once when it is visible again, never two in flight; two missed periods → 「未刷新」 (stale).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pollCaptureHealth, captureVerdict, CAPH_MS } from '../../src/web/v2/core/capture-verdict.mjs'

// the period, read off 4.4's live-poll table (one fact, one place)
const PERIOD = (() => {
  const row = fs.readFileSync(new URL('../../spec/01-asight-rfc/4.4-server.md', import.meta.url), 'utf8').split('\n').find((l) => l.includes('| `status` |'))
  return Number(/\*\*(\d+) s\*\*/.exec(row)[1]) * 1000
})()

function world({ answer = () => ({ ok: true, data: { health: { state: 'ok' } } }) } = {}) {
  const listeners = new Map(), doc = { hidden: false, addEventListener: (t, f) => listeners.set(t, f), removeEventListener: (t) => listeners.delete(t) }
  let state = {}, reads = 0, inFlight = 0, maxInFlight = 0
  const pending = []
  const api = {
    now: () => Date.now(),
    get: () => { reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); return new Promise((res) => pending.push(() => { inFlight--; res(answer()) })) },
  }
  const store = { get: () => state, set: (p) => { state = { ...state, ...p } } }
  const flush = async () => { while (pending.length) { pending.shift()(); await new Promise((r) => setImmediate(r)) } }
  return { doc, api, store, flush, vis: () => listeners.get('visibilitychange')(), get reads() { return reads }, get maxInFlight() { return maxInFlight } }
}

test('the period is 4.4\'s: visible → one read per period; hidden → none; visible again → one at once; never two in flight', async (t) => {
  assert.equal(CAPH_MS, PERIOD)
  mock.timers.enable({ apis: ['setTimeout', 'Date'] }); t.after(() => mock.timers.reset())
  const w = world()
  const p = pollCaptureHealth({ api: w.api, store: w.store, doc: w.doc })
  assert.equal(w.reads, 1); await w.flush()
  for (let i = 2; i <= 4; i++) { mock.timers.tick(PERIOD - 1); assert.equal(w.reads, i - 1); mock.timers.tick(1); assert.equal(w.reads, i); await w.flush() }
  w.doc.hidden = true
  mock.timers.tick(PERIOD * 5); assert.equal(w.reads, 4)
  w.doc.hidden = false; w.vis(); assert.equal(w.reads, 5)
  // a read still out: the period passes and visibility flips, and no second read starts
  mock.timers.tick(PERIOD * 3); w.vis(); p.refresh()
  assert.equal(w.reads, 5); assert.equal(w.maxInFlight, 1)
  await w.flush(); p.stop()
})

test('two missed periods → captureVerdict says stale', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 }); t.after(() => mock.timers.reset())
  let fail = false
  const w = world({ answer: () => (fail ? { ok: false, status: 0, error: 'down' } : { ok: true, data: { health: { state: 'ok', since: '2026-10-20T09:00:00Z' } } }) })
  const p = pollCaptureHealth({ api: w.api, store: w.store, doc: w.doc })
  await w.flush()
  const verdict = () => { const s = w.store.get(); return captureVerdict(s.capH, { okAt: s.capHOkAt, err: s.capHErr }).state }
  assert.equal(verdict(), 'ok')
  fail = true
  for (let i = 0; i < 2; i++) { mock.timers.tick(PERIOD); await w.flush() }
  mock.timers.tick(1)
  assert.equal(verdict(), 'stale')
  p.stop()
})
