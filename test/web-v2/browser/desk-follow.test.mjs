// test/web-v2/browser/desk-follow.test.mjs — 2.3 §读与画「快速拖动」(the followed step's bodies) on the mounted desk, in the real Chrome:
// a following desk on a session's first step takes one answer that jumps to the newest of ~600 calls while every `block` read is held.
// By 150 ms (+ a frame) after that answer's tails landed, the step head shows the newest step and the session head no longer reads the
// first-read line, the step's body read still held; once it is let go the reply bodies fill in with no reader action, no second `block`
// read asks for them, and the reply stays where the landing put it. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, stampFetches } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BUSY = 150 // 2.3 §车道未到手: the longest the desk is left as it is
const FRAME = 100 // the paint after the draw, sampled on the next frame; a loaded runner's timers run late (209 ms seen at load ~20)

test('2.3 跟随: the step head and the session head show the newest step by 150 ms after its answer landed; the bodies fill in from one read', { skip }, async (t) => {
  const w = world(3, { calls: 600, page: 100, talk: { pre: 3, len: 60, every: 6, tail: 4 } }), last = w.marks.length - 1
  const steps = (k) => w.files(w.marks[k], 32).head.steps, newest = steps(last)
  let from = 0
  while (steps(from) < 1) from++
  assert.ok(newest > steps(from) + 100, `the answer brings many steps (${steps(from)} → ${newest})`)
  const main = w.full().lanes.find((h) => h.kind === 'main').lane, tail = w.lane(main, {}), ref = new Map(tail.defs.map((d) => [d.bid, d.ref]))
  assert.ok(tail.steps.at(-1).reply.some((b) => ref.get(b)), 'the newest step has reply bodies to read')
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium, setup: (page) => stampFetches(page).then(() => page.addInitScript(() => {
    // each change of the step number (#stepbar data-n) and of the session head's read-state line, on stampFetches' clock
    window.__seen = []
    let at = null
    const tick = () => {
      const n = +(document.querySelector('#stepbar [data-n]')?.dataset.n ?? NaN), rs = document.querySelector('#deskhead .readstate')?.dataset.readState ?? null
      const k = `${n} ${rs}`
      if (n && k !== at) { at = k; window.__seen.push({ n, rs, t: performance.timeOrigin + performance.now() }) }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })) })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from, grow: last, paced: true })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar [data-n]')
    await page.waitForTimeout(800) // the first step's own reads are done
    assert.equal((await page.evaluate(() => window.__seen)).at(-1).rs, 'reading', 'the session head reads the first-read line before the answer')
    const held = [], blocks = [] // the held block routes; every block read after the answer, by its refs
    const hold = (route) => { held.push(route); blocks.push(new URL(route.request().url()).searchParams.getAll('ref')) }
    await page.route('**/api/block?**', hold)
    const since = await page.evaluate(() => performance.timeOrigin + performance.now())
    growth.more(1)
    const seen = () => page.evaluate(() => window.__seen)
    const shown = async () => (await seen()).find((x) => x.n === newest && x.rs == null)
    for (const t0 = Date.now(); !(await shown()) && Date.now() - t0 < 3000;) await page.waitForTimeout(20)
    const fetches = (await page.evaluate(() => globalThis.__fetches)).filter((e) => e.t0 >= since)
    // the answer: the first round's two tail reads after the grant, landed when the earlier of them was in
    const tails = fetches.filter((e) => e.url.startsWith('/api/d/open.')).slice(0, 2), out = fetches.filter((e) => e.url.startsWith('/api/block?'))
    assert.equal(tails.length, 2, 'the answer\'s tails were read')
    const landed = Math.min(...tails.map((e) => e.t1)), at = await shown()
    assert.ok(out.length && out.every((e) => e.t1 == null), `the followed step's body read went out and is held (${out.length})`)
    assert.ok(at, `the step head and the session head showed step ${newest} while its body read was held (seen ${JSON.stringify((await seen()).at(-1))})`)
    t.diagnostic(`step ${newest} and the session head drawn ${Math.round(at.t - landed)} ms after the answer landed`)
    assert.ok(at.t - landed <= BUSY + FRAME, `step ${newest} and the session head drawn ${Math.round(at.t - landed)} ms after the answer landed`)
    const reply = () => page.evaluate(() => { const r = document.querySelector('#ctxwin .cwreply'); const W = document.querySelector('#ctxwin'); return r && { waiting: r.querySelectorAll('pre[data-ref]').length, top: W.scrollTop, y: Math.round(r.getBoundingClientRect().top - W.getBoundingClientRect().top), sh: W.scrollHeight, h: W.clientHeight } })
    await page.waitForTimeout(300) // the landing on the reply has settled (the read still held)
    const before = await reply()
    assert.ok(before && before.waiting > 0, 'the reply rows wait for their bodies')
    const asked = new Set(blocks.flat()), n0 = blocks.length
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/block') blocks.push(u.searchParams.getAll('ref')) })
    await page.unroute('**/api/block?**', hold)
    for (const r of held.splice(0)) await r.fallback()
    await page.waitForFunction(() => { const r = document.querySelector('#ctxwin .cwreply'); return r && !r.querySelector('pre[data-ref]') && r.textContent.includes('body of ') }, null, { timeout: 5000 })
    await page.waitForTimeout(500)
    const after = await reply()
    assert.equal(after.y, before.y, `the reply stayed where the reader saw it when its bodies landed (${JSON.stringify({ before, after })})`)
    assert.deepEqual(blocks.slice(n0).flat().filter((x) => asked.has(x)), [], 'no second block read asks for those bodies')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
