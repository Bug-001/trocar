// test/query/analysis-throttle.test.mjs — `analysis`'s throttle (RFC 3.5 §会话读「`analysis`」节流, #53). While a session's version moves, the
// worker sums its default document at most once per ANALYSIS_EVERY_MS and answers what it summed, with no tag, between. What it
// must never do is pin: a session that stops growing, a new price and the end of `pending` all get the true sums.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { answer } from '../../src/query/answers.mjs'
import { extendSession } from '../../src/query/named/session.mjs'
import { ANALYSIS_EVERY_MS } from '../../src/query/named/analysis.mjs'
import { INTERVAL } from '../../web/legacy/core/poll.mjs'

const MODEL = 'claude-opus-4-8'
const whole = ({ ok, errors, ...doc }) => doc // what was summed: errors are this moment's, and notes are about the read that made them

// a session and a worker's ctx on a clock of its own
function worker(shape, calls) {
  const dir = tmpDir('trocar-throttle-'), home = path.join(dir, '.trocar'), file = path.join(dir, 'pricing.json')
  fs.writeFileSync(file, JSON.stringify({ [MODEL]: [1, 2, 3, 4] }))
  const s = bigSession({ home, ...shape })
  s.append(calls)
  const w = { s, file, t: 1_000_000 }
  w.ctx = { home, fs, writer: true, now: () => w.t, env: { TROCAR_PRICING: file }, persist() {}, progress() {} }
  w.ask = async (params = {}, ctx = w.ctx) => {
    const got = await answer({ name: 'analysis', params: { id: s.id, ...params } }, ctx)
    assert.equal(got.status, 200)
    return { doc: JSON.parse(got.bytes), tag: got.tag }
  }
  w.fold = async () => { while (await extendSession(w.ctx, s.id, Infinity)); }
  w.fresh = async () => whole((await w.ask({}, { home, fs: { ...fs }, env: w.ctx.env })).doc) // another process: nothing warm shared
  return w
}
// folded and answered whole, then three more calls and a second later: the throttle is holding
async function holding() {
  const w = worker({ growth: 300, subEvery: 4 }, 30)
  await w.fold()
  w.first = (await w.ask()).doc
  assert.equal(w.first.pending, undefined)
  w.s.append(3)
  w.t += 1000
  return w
}

test('3.5 #53 held: a session that grew a second after its sums is answered those sums, with no tag', async () => {
  const w = await holding(), { doc, tag } = await w.ask()
  assert.equal(doc.mark, w.first.mark)
  assert.deepEqual(doc.totals, w.first.totals)
  assert.equal(tag, '-')
})

test('3.5 #53 due: ANALYSIS_EVERY_MS after the sums the answer is new, the new steps counted, and tagged', async () => {
  const w = await holding()
  await w.ask()
  await w.fold()
  w.t += ANALYSIS_EVERY_MS
  const { doc, tag } = await w.ask()
  assert.notEqual(doc.mark, w.first.mark)
  assert.ok(doc.totals.cost.total.priced > w.first.totals.cost.total.priced)
  assert.notEqual(tag, '-')
})

test('3.5 #53 not pinned: a session that stopped growing is answered as a new process answers it, and stays so', async () => {
  const w = await holding()
  await w.ask()
  await w.fold()
  await w.ask()
  w.t += ANALYSIS_EVERY_MS
  const fresh = await w.fresh()
  assert.deepEqual(whole((await w.ask()).doc), fresh)
  for (const step of [1000, ANALYSIS_EVERY_MS]) {
    w.t += step
    const { doc, tag } = await w.ask()
    assert.deepEqual(whole(doc), fresh)
    assert.notEqual(tag, '-')
  }
})

test('3.5 #53 a new price: answered at once, the totals and the mark both new', async () => {
  const w = await holding()
  await w.ask()
  await w.fold()
  fs.writeFileSync(w.file, JSON.stringify({ [MODEL]: [10, 20, 30, 40] }))
  const { doc } = await w.ask()
  assert.deepEqual(whole(doc), await w.fresh())
  assert.notEqual(doc.mark, w.first.mark)
})

test('3.5 #53 pending: it moves while the sums are held, and the answer it is gone from is whole, however soon', async () => {
  const w = worker({ growth: 4_000, subEvery: 3, compactAt: 40_000, subLanes: 3, late: 2 }, 160)
  const first = (await w.ask()).doc
  assert.ok(first.pending, 'the worker\'s slice left members above the mark')
  w.t += 1000
  let held = first
  for (let i = 0; i < 200 && held.pending.done === first.pending.done && held.pending.work === first.pending.work; i++) {
    await extendSession(w.ctx, w.s.id, 2)
    held = (await w.ask()).doc
    assert.ok(held.pending, 'not folded to the end yet')
  }
  assert.notDeepEqual(held.pending, first.pending)
  assert.deepEqual(held.totals, first.totals)
  assert.equal(held.mark, first.mark)
  await w.fold()
  w.t += 1000
  const { doc } = await w.ask()
  assert.equal(doc.pending, undefined)
  assert.deepEqual(whole(doc), await w.fresh())
})

for (const param of ['from', 'to', 'since']) {
  test(`3.5 #53 windows: --${param} is not held`, async () => {
    const w = await holding()
    await w.ask()
    await w.fold()
    const { mark } = await w.fresh()
    assert.notEqual(mark, w.first.mark)
    assert.equal((await w.ask({ [param]: 'not-a-step' })).doc.mark, mark)
  })
}

test('3.5 #53 the local path: a ctx that is no writer is answered the new sums at once', async () => {
  const w = await holding(), { writer, ...local } = w.ctx, { doc } = await w.ask({}, local)
  assert.notEqual(doc.mark, w.first.mark)
  assert.ok(doc.totals.cost.total.priced > w.first.totals.cost.total.priced)
})

test('3.5 #53 the period is the board\'s', () => {
  assert.equal(ANALYSIS_EVERY_MS, INTERVAL.other)
})
