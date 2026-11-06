// test/web-v2/browser/desk-follow.test.mjs — 2.3 §读与画「快速拖动」(the followed step's bodies) on the mounted desk, in the real Chrome:
// a following desk on a session's first step takes one answer that jumps to the newest of ~600 calls while every `block` read is held.
// The step head shows the newest step within BUSY_MS (+ slack for frames) of the step's body read going out, the read still held; once
// it is let go the reply bodies fill in with no reader action, no second `block` read asks for them, and the window does not scroll.
// Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, stampFetches } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BUSY = 150 // 2.3 §车道未到手: the longest the desk is left as it is
const SLACK = 100 // a few frames and timer lateness on a busy runner

test('2.3 跟随: the followed step is drawn within 150 ms of its body read while the read is out; the bodies fill in from that one read', { skip }, async (t) => {
  const w = world(5, { calls: 600, page: 100, talk: { pre: 3, len: 60, every: 6, tail: 4 } }), last = w.marks.length - 1
  const steps = (k) => w.files(w.marks[k], 32).head.steps, newest = steps(last)
  let from = 0
  while (steps(from) < 1) from++
  assert.ok(newest > steps(from) + 100, `the answer brings many steps (${steps(from)} → ${newest})`)
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium, setup: (page) => stampFetches(page).then(() => page.addInitScript(() => {
    // the step number #stepbar .sb-no shows on each change, on stampFetches' clock
    window.__steps = []
    let at = null
    const tick = () => {
      const n = +(document.querySelector('#stepbar .sb-no')?.dataset.n ?? NaN)
      if (n && n !== at) { at = n; window.__steps.push({ n, t: performance.timeOrigin + performance.now() }) }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })) })
  try {
    const { page } = b
    const growth = await serveWorld(page, w, { from, grow: last, paced: true })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    await page.waitForTimeout(800) // the first step's own reads are done
    const held = [], blocks = [] // the held block routes; every block read after the answer, by its refs
    await page.route('**/api/block?**', (route) => { held.push(route); blocks.push(new URL(route.request().url()).searchParams.getAll('ref')) })
    const since = await page.evaluate(() => performance.timeOrigin + performance.now())
    growth.more(1)
    const reply = () => page.evaluate(() => { const r = document.querySelector('#ctxwin .cwreply'); return r && { waiting: r.querySelectorAll('pre[data-ref]').length, text: r.textContent, top: document.querySelector('#ctxwin').scrollTop } })
    const shown = async () => (await page.evaluate(() => window.__steps)).find((x) => x.n === newest)
    for (const t0 = Date.now(); !(await shown()) && Date.now() - t0 < 3000;) await page.waitForTimeout(20)
    const out = (await page.evaluate(() => globalThis.__fetches)).filter((e) => e.url.startsWith('/api/block?') && e.t0 >= since)
    assert.ok(out.length, 'the followed step asked for its bodies')
    const at = await shown(), before = await reply()
    assert.ok(at, `the step head showed step ${newest} while its body read was out (shows ${JSON.stringify((await page.evaluate(() => window.__steps)).at(-1))})`)
    assert.equal(out[0].t1, null, 'its body read is still out')
    t.diagnostic(`step ${newest} drawn ${Math.round(at.t - out[0].t0)} ms after its body read went out`)
    assert.ok(at.t - out[0].t0 <= BUSY + SLACK, `step ${newest} drawn ${Math.round(at.t - out[0].t0)} ms after its body read went out`)
    assert.ok(before && before.waiting > 0, 'the reply rows wait for their bodies')
    const asked = new Set(blocks.flat()), n0 = blocks.length
    for (const r of held.splice(0)) await r.fallback()
    await page.unroute('**/api/block?**')
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/block') blocks.push(u.searchParams.getAll('ref')) })
    await page.waitForFunction(() => { const r = document.querySelector('#ctxwin .cwreply'); return r && !r.querySelector('pre[data-ref]') && r.textContent.includes('body of ') }, null, { timeout: 5000 })
    await page.waitForTimeout(500)
    const after = await reply()
    assert.equal(after.top, before.top, 'the bodies landing did not scroll the window')
    assert.deepEqual(blocks.slice(n0).flat().filter((ref) => asked.has(ref)), [], 'no second block read asks for those bodies')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
