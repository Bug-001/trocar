// test/web-v2/browser/desk-long.test.mjs — 2.3 #28 · D64② on the mounted desk over a long conversation: a generated session
// (desk-world.mjs `talk`) whose main lane has ~1,800 steps and ~1,000–1,400 blocks in its newest step's list, in two turn shapes —
// many turns of ~40 blocks, and one long newest turn. Opened at its newest step by name (no following), the reader steps by ←/→,
// Shift+←, Home/End and across the newest turn's first step: no task of the page's own runs over I-longtask's line, and a step
// change's p95 is within BOARD_LINES.stepClick. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, timed, stats } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { LIMITS } from './seq/invariants.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const LIST = [1000, 1400] // the newest step's request list (measured on a real session: a ~7k-node window at a tail step)

// installed before the board's own scripts: every long task of the page, in ms
function observeLongTasks() {
  window.__lt = []
  try { new PerformanceObserver((l) => { for (const x of l.getEntries()) window.__lt.push(x.duration) }).observe({ type: 'longtask', buffered: true }) } catch { /* no long-task timing here */ }
}

const SHAPES = [['many turns', { every: 40, tail: 0 }], ['one long newest turn', { every: 40, tail: 800 }]]

for (const [name, shape] of SHAPES) {
  test(`2.3 #28 · D64②: a long conversation (${name}) — step changes run no long task; step p95 within the line`, { skip }, async (t) => {
    const w = world(7, { calls: 2100, page: 2100, talk: { pre: 90, len: 1200, ...shape } })
    const main = w.full().lanes.find((l) => l.kind === 'main')
    const rids = w.laneRidsAt().get(main.lane), M = rids.length, len = w.list(rids.at(-1)).length
    if (len < LIST[0] || len > LIST[1]) return t.skip(`the newest step's list has ${len} blocks, outside [${LIST}]: the world does not have the shape this case is about`)
    // the newest turn's first step: the last step whose added blocks carry a human prompt
    const K = w.lane(main.lane).steps.findLastIndex((st, j) => j > 0 && Object.values(st.attrs).some((a) => a.query)) + 1
    if (K < 2) return t.skip('the main lane has no turn boundary after its first step')

    const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium, setup: (page) => page.addInitScript(observeLongTasks) })
    try {
      const { page } = b
      await serveWorld(page, w)
      await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
      const longTasks = () => page.evaluate(() => window.__lt.splice(0))
      const step = () => page.textContent('#stepbar .sb-no')
      const at = (n) => page.waitForFunction((n) => {
        const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
        return !!x && +x[1] === n && !document.querySelector('#ctxwin .cwload')
      }, n, { timeout: 30000, polling: 'raf' })
      await page.evaluate((m) => { location.hash = `#/replay/p/S?step=${m}` }, M)
      await at(M)
      await page.waitForTimeout(500)
      await longTasks() // the open is D64①'s, not this case's

      const samples = []
      const press = async (key, n = 1) => { for (let i = 0; i < n; i++) samples.push(await timed(page, 'step', await step(), () => page.keyboard.press(key))) }
      await press('ArrowLeft', 60)
      await press('ArrowRight', 60)
      await press('Shift+ArrowLeft', 5)
      await press('Home')
      await press('End')
      // across the newest turn's first step: into the turn before it and back
      await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}` }, K)
      await at(K)
      await press('ArrowLeft')
      await press('ArrowRight')
      await page.waitForTimeout(200)
      const lt = await longTasks()

      await page.keyboard.press('End')
      await at(M)
      const nodes = await page.evaluate(() => document.querySelectorAll('#ctxwin *').length)
      const { p50, p95 } = stats(samples)
      console.log(`# long conversation (${name}): main ${M} steps, newest list ${len} blocks, turn boundary at step ${K}; step n=${samples.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.stepClick} ms; long tasks n=${lt.length} max=${Math.round(Math.max(0, ...lt))} ms; #ctxwin nodes at the newest step ${nodes}`)
      assert.ok(Math.max(0, ...lt) <= LIMITS.longtaskMs, `a long task of ${Math.round(Math.max(...lt))} ms`)
      assert.ok(p95 <= BOARD_LINES.stepClick, `step change p95 ${p95.toFixed(1)} ms over the ${BOARD_LINES.stepClick} ms line`)
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  })
}
