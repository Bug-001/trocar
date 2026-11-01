// test/web-v2/browser/chapter-jump.test.mjs — 1.3 §章 (D71④), acceptance 18, on the real face: a generated session with
// ≥ 4 compactions folded by the face's own worker, opened in a new browser context; ‹ / › clicked and [ / ] pressed, each timed from
// the input event to the moment the new chapter's label and bars are in the page — p95 ≤ BOARD_LINES.chapterJump. Once more with
// every pack outside the last chapter held back by a route: the bars and the label still come within the line (from the head's
// cols), and the window's rows fill, bar for bar, when the packs land. Asserted on ids and data attributes, never on words.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { probe, withBoard, stats } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { chapterAt, chapterJump } from '../../../src/web/v2/replay/timeline.mjs'
import { headFile } from '../../../src/query/ctx-files.mjs'
import { bigSession } from '../../query/big-session.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const SHAPE = { subLanes: 3, late: 4, subEvery: 4, compactAt: 20_000, growth: 1_000 }
const CALLS = 1_700
const TIP = 'trocar.token' // core/http.mjs: the board's token slot (4.4 §每用户口令)

let world = null
async function folded() {
  if (world) return world
  const userHome = tmpDir('trocar-chap-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, ...SHAPE }); s.append(CALLS)
  const b = await withBoard({ home: { userHome, home }, chromium: gate.chromium })
  const until = Date.now() + 240_000
  let head = null
  for (;;) {
    const r = await b.get('session', { id: s.id, head: '1' })
    const file = fs.existsSync(headFile(home, s.id)) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(headFile(home, s.id)))) : null
    if (file && file.tier === 1 && !file.pending && file.packs.length >= 3 && file.mark === r.doc.mark) { head = file; break }
    assert.ok(Date.now() < until, 'the session was folded with its files in 240 s')
    await new Promise((ok) => setTimeout(ok, 500))
  }
  assert.ok(head.chapters.length >= 5, `≥ 4 compactions (${head.chapters.length} chapters)`)
  world = { b, id: s.id, head, project: (head.meta && head.meta.project_slug) || 'p' }
  return world
}
test.after(async () => { if (world) await world.b.stop() })

// in the page: the input's own timestamp, and the first moment after it that the chapter row names part `want` and every bar of the
// row is a step of that part (performance marks 'chapter-input' / 'chapter-painted')
function watch() {
  const on = (e) => { if (e.type === 'click' ? e.target.closest && e.target.closest('.chapbtn') : e.key === '[' || e.key === ']') window.__in = e.timeStamp }
  document.addEventListener('click', on, true); document.addEventListener('keydown', on, true)
  window.__arm = (want, s0, s1) => {
    window.__in = null; window.__done = null
    const ok = () => {
      const lab = document.querySelector('#chapnav .chaplabel'), bars = [...document.querySelectorAll('#sawrow .bar')]
      return lab && lab.dataset.part === String(want) && bars.length > 0 &&
        bars.every((b) => { const g = b.dataset.step != null ? +b.dataset.step : null; return g == null || (g >= s0 && g < s1) })
    }
    const mo = new MutationObserver(() => {
      if (window.__in == null || !ok()) return
      mo.disconnect()
      performance.mark('chapter-input', { startTime: window.__in }); performance.mark('chapter-painted')
      window.__done = performance.measure('chapter-jump', 'chapter-input', 'chapter-painted').duration
    })
    mo.observe(document.querySelector('#saw'), { subtree: true, childList: true, attributes: true })
  }
}

async function fresh(w, route) {
  const context = await w.b.page.context().browser().newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(([k, t]) => { try { localStorage.setItem(k, t) } catch { /* the test's own page: storage works */ } }, [TIP, w.b.face.token])
  await context.addInitScript(watch)
  if (route) await context.route('**/api/d/p*', route)
  const page = await context.newPage(), errors = [], packs = { asked: 0, done: 0 }
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (/\/api\/d\/p\d+\./.test(r.url())) packs.asked++ })
  page.on('requestfinished', (r) => { if (/\/api\/d\/p\d+\./.test(r.url())) packs.done++ })
  return { context, page, errors, packs }
}
const open = (w, c, step) => c.page.goto(`${w.b.url}/#/replay/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}${step ? `?step=${step}` : ''}`)
const allPacks = async (w, c) => { const until = Date.now() + 60_000; while (c.packs.done < 2 * w.head.packs.length) { assert.ok(Date.now() < until, `every pack read (${c.packs.done}/${2 * w.head.packs.length})`); await new Promise((ok) => setTimeout(ok, 100)) } }

// one jump from global step g in direction dir by `act`: → {ms, to}
async function jump(c, chs, g, dir, act) {
  const to = chapterJump(chs, g, dir), k = chapterAt(chs, to), ch = chs[k]
  await c.page.evaluate(([want, s0, s1]) => window.__arm(want, s0, s1), [k + 1, ch.s0, ch.s1])
  await act(dir)
  const ms = await c.page.waitForFunction(() => window.__done, null, { timeout: 15_000 }).then((h) => h.jsonValue())
  const lab = await c.page.$eval('#chapnav .chaplabel', (e) => ({ ...e.dataset }))
  assert.deepEqual([lab.part, lab.of, lab.s0], [String(k + 1), String(chs.length), String(ch.s0)])
  return { ms, to }
}

test('1.3 §章 · 18: ‹ › clicked and [ ] pressed paint the next / previous chapter within BOARD_LINES.chapterJump (p95)', { skip, timeout: 600_000 }, async () => {
  const w = await folded(), chs = w.head.chapters, last = chs.length - 1
  const c = await fresh(w)
  try {
    await open(w, c, 1)
    await c.page.waitForSelector('#stepbar .sb-no[data-n="1"]', { timeout: 30_000 })
    await allPacks(w, c)
    assert.equal(await c.page.$eval('#chapPrev', (b) => b.disabled), true, 'the first chapter\'s ‹ is disabled')
    const click = (dir) => c.page.click(dir > 0 ? '#chapNext' : '#chapPrev')
    const press = (dir) => c.page.keyboard.press(dir > 0 ? 'BracketRight' : 'BracketLeft')
    const runs = { click: [], key: [] }
    let g = 0, dir = 1
    for (const [name, act, n] of [['click', click, 20], ['key', press, 10]]) {
      for (let i = 0; i < 2 * n; i++) {
        const k = chapterAt(chs, g)
        if ((dir > 0 && k === last) || (dir < 0 && k === 0)) dir = -dir
        const r = await jump(c, chs, g, dir, act)
        runs[name].push(r.ms); g = r.to
        await c.page.waitForSelector(`#stepbar .sb-no[data-n="${g + 1}"]`, { timeout: 15_000 })
      }
    }
    assert.equal(await c.page.$eval('#chapNext', (b) => b.disabled), chapterAt(chs, g) === last)
    const ms = [...runs.click, ...runs.key], { p50, p95 } = stats(ms)
    console.log(`# chapterJump: n=${ms.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.chapterJump} ms`)
    assert.ok(p95 <= BOARD_LINES.chapterJump, `p95 ${p95.toFixed(1)} ms ≤ ${BOARD_LINES.chapterJump} ms`)
    assert.deepEqual(c.errors, [])
  } finally { await c.context.close() }
})

test('1.3 §章 · 18: a jump into a chapter whose packs are not here paints from the head within the line; its rows fill, bar for bar, when they land', { skip, timeout: 300_000 }, async () => {
  const w = await folded(), chs = w.head.chapters, [p0, p1] = w.head.packs
  // chapter A ends past the first pack, its next chapter B starts inside the second: open on A's first step with only the first pack
  // let through, then › to B, whose rows are held back
  const a = chapterAt(chs, p0.s1 - 1), b = chs[a + 1]
  assert.ok(chs[a].s0 < p0.s1 && b && b.s0 >= p1.s0 && b.s0 < p1.s1, 'the generated session has a chapter edge inside the second pack')
  let release = null
  const gate2 = new Promise((ok) => { release = ok })
  const c = await fresh(w, async (route) => {
    if (Number(new URL(route.request().url()).pathname.match(/\/p(\d+)\./)[1]) !== p0.n) await gate2
    await route.continue()
  })
  try {
    await open(w, c, chs[a].s0 + 1)
    await c.page.waitForSelector(`#stepbar .sb-no[data-n="${chs[a].s0 + 1}"]`, { timeout: 30_000 })
    const r = await jump(c, chs, chs[a].s0, 1, () => c.page.click('#chapNext'))
    console.log(`# chapterJump (packs not here): ${r.ms.toFixed(1)} ms line=${BOARD_LINES.chapterJump} ms`)
    assert.ok(r.ms <= BOARD_LINES.chapterJump, `${r.ms.toFixed(1)} ms ≤ ${BOARD_LINES.chapterJump} ms`)
    const rough = await c.page.$$eval('#sawrow .bar', (bs) => bs.map((b) => b.dataset.step))
    assert.ok(rough.length > 0 && rough.every((x) => x != null), 'the bars come from the head (no row yet)')
    release()
    await c.page.waitForSelector(`#stepbar .sb-no[data-n="${r.to + 1}"]`, { timeout: 30_000 })
    await allPacks(w, c)
    await c.page.waitForFunction((n) => { const bs = document.querySelectorAll('#sawrow .bar'); return bs.length === n && [...bs].every((b) => b.dataset.i != null) }, rough.length, { timeout: 15_000 })
    assert.deepEqual(c.errors, [])
  } finally { release(); await c.context.close() }
})
