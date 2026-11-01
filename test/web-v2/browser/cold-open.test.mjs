// test/web-v2/browser/cold-open.test.mjs — a cold replay open on the real face (2.3 §大致页面, D71①, 1.5 K-31 / K-32): a generated
// session (compactions, sealed packs) folded by the face's own worker, the worker left to idle out, then each run in a new browser
// context (empty caches) opening the desk by its URL. Asserted on ids, classes and data attributes, never on words. Browser suite only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { probe, withBoard, stats } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { barsThatFit } from '../../../src/web/v2/replay/timeline.mjs'
import { headFile } from '../../../src/query/ctx-files.mjs'
import { bigSession } from '../../query/big-session.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const RUNS = 20
const SHAPE = { subLanes: 3, late: 4, subEvery: 4, compactAt: 20_000, growth: 1_000 }
const CALLS = 1_700
const TIP = 'trocar.token' // core/http.mjs: the board's token slot (4.4 §每用户口令)

// what the page holds the moment it marks 'desk-rough' (taken inside performance.mark, before anything after it runs)
function atMark() {
  const mark = performance.mark.bind(performance)
  performance.mark = (name, o) => {
    const r = mark(name, o)
    if (name !== 'desk-rough' || window.__rough) return r
    const n = (sel) => document.querySelectorAll(sel).length, row = document.querySelector('#sawrow')
    const cols = row ? getComputedStyle(row.closest('.tkrow')).gridTemplateColumns.split(' ') : []
    const label = document.querySelector('#stepbar [data-n]'), cw = document.querySelector('#ctxwin')
    window.__rough = { t: r.startTime, overview: n('#ovstrip .ovbar') + n('#ovstrip polyline'), brush: n('#ovstrip #ovbrush'), bars: n('#sawrow .bar'),
      width: parseFloat(cols[cols.length - 1]) || 0, label: label ? Number(label.dataset.n) : null, rails: n('#rails .railname'),
      busy: n('#ctxwin [aria-busy="true"]'), ctxText: cw ? cw.textContent.trim() : null, ctxControls: n('#ctxwin button, #ctxwin a, #ctxwin input, #ctxwin [role="button"]') }
    return r
  }
}

// the folded world: one session, its head file written at the frontier with ≥ 3 sealed packs, the worker gone
let world = null
async function folded() {
  if (world) return world
  const userHome = tmpDir('trocar-cold-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, ...SHAPE }); s.append(CALLS)
  const b = await withBoard({ home: { userHome, home }, idleMs: 600, chromium: gate.chromium })
  const until = Date.now() + 240_000
  let head = null
  for (;;) {
    const r = await b.get('session', { id: s.id, head: '1' })
    head = r.doc
    const file = fs.existsSync(headFile(home, s.id)) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(headFile(home, s.id)))) : null
    if (file && file.tier === 1 && !file.pending && file.packs.length >= 3 && file.mark === head.mark) { head = file; break }
    assert.ok(Date.now() < until, `the session was not folded with its files in 240 s (${JSON.stringify(head && { tier: head.tier, pending: head.pending, packs: head.packs && head.packs.length })})`)
    await new Promise((ok) => setTimeout(ok, 500))
  }
  assert.ok(head.chapters.length >= 4, `≥ 3 compactions (${head.chapters.length} chapters)`)
  world = { b, id: s.id, head, project: (head.meta && head.meta.project_slug) || 'p' }
  return world
}
const idle = async (b) => { const until = Date.now() + 30_000; while (b.face.workers().length) { assert.ok(Date.now() < until, 'the query worker idles out'); await new Promise((ok) => setTimeout(ok, 100)) } }

// a new context on the world's face: the board's token in localStorage (as a #t= boot leaves it), the mark watcher, its /api requests
async function fresh(w, { route } = {}) {
  const browser = w.b.page.context().browser()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(([k, t]) => { try { localStorage.setItem(k, t) } catch { /* the test's own page: storage works */ } }, [TIP, w.b.face.token])
  await context.addInitScript(atMark)
  if (route) await context.route('**/api/d/head?**', route)
  const page = await context.newPage(), requests = [], errors = []
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) requests.push({ path: u.pathname, q: u.searchParams }) })
  page.on('pageerror', (e) => errors.push(String(e)))
  return { context, page, requests, errors }
}
const rough = (page) => page.waitForFunction(() => window.__rough, null, { timeout: 15_000 }).then((h) => h.jsonValue())
const chapterOf = (head, at) => head.chapters.find((c) => at >= c.s0 && at < c.s1)

test.after(async () => { if (world) await world.b.stop() })

test('2.3 §大致页面: a cold open paints the rough page from the head within BOARD_LINES.coldOpen (p95 of 20 new contexts)', { skip, timeout: 600_000 }, async () => {
  const w = await folded(), { head } = w, at = head.steps - 1, ch = chapterOf(head, at)
  const ms = []
  for (let i = 0; i < RUNS; i++) {
    await idle(w.b)
    const c = await fresh(w)
    try {
      await c.page.goto(`${w.b.url}/#/replay/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}`)
      const r = await rough(c.page)
      ms.push(r.t)
      assert.ok(r.overview > 0 && r.brush === 1, 'the whole-session overview and its brush')
      assert.equal(r.bars, Math.min(ch.s1 - ch.s0, barsThatFit(r.width)), 'the bars of the fitted window inside the playhead\'s chapter')
      assert.equal(r.label, head.steps, 'the step label names the playhead (following: the newest step)')
      assert.ok(r.rails > 0, 'the lane names')
      assert.ok(r.busy >= 1 && r.ctxText === '' && r.ctxControls === 0, 'the context window is an empty aria-busy frame: no text, no control')
      assert.deepEqual(c.requests.filter((q) => q.path === '/api/session'), [])
      assert.deepEqual(c.errors, [])
    } finally { await c.context.close() }
  }
  const { p50, p95 } = stats(ms)
  console.log(`# coldOpen: n=${ms.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${BOARD_LINES.coldOpen} ms`)
  assert.ok(p95 <= BOARD_LINES.coldOpen, `p95 ${p95.toFixed(1)} ms ≤ ${BOARD_LINES.coldOpen} ms`)
})

test('2.3 §点名的一步不在手里: a deep link into chapter 2 reads the pack holding that step first and lands on it', { skip, timeout: 300_000 }, async () => {
  const w = await folded(), { head } = w, ch = head.chapters[2]
  const k = Math.floor((ch.s0 + ch.s1) / 2) + 1, pack = head.packs.find((p) => k - 1 >= p.s0 && k - 1 < p.s1)
  assert.ok(pack, `step ${k} is in a sealed pack`)
  await idle(w.b)
  const c = await fresh(w)
  try {
    await c.page.goto(`${w.b.url}/#/replay/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}?step=${k}`)
    const r = await rough(c.page)
    assert.equal(r.label, k, 'the rough page names the linked step')
    assert.equal(r.bars, Math.min(ch.s1 - ch.s0, barsThatFit(r.width)), 'the bars of the linked step\'s chapter')
    await c.page.waitForSelector(`#stepbar .sb-no[data-n="${k}"]`, { timeout: 30_000 })
    const packs = c.requests.filter((q) => /^\/api\/d\/p\d+\./.test(q.path))
    assert.equal(packs[0] && packs[0].path, `/api/d/p${pack.n}.main`, 'the first pack read is the one holding the linked step')
    assert.deepEqual(c.requests.filter((q) => q.path === '/api/session'), [])
    const main = head.lanes.find((l) => l.lane === head.axis)
    assert.deepEqual(c.requests.filter((q) => q.path === '/api/lane' && q.q.has('to') && q.q.get('to') !== main.first).map((q) => q.q.get('to')), [], 'no page chain: a `lane --to` read only opens the ledger at the lane\'s first step')
    assert.deepEqual(c.errors, [])
  } finally { await c.context.close() }
})

test('1.5 K-32: a head behind the tip ids says so in place, with the count; 1.5 K-31: a tier-0 head says the first read', { skip, timeout: 300_000 }, async () => {
  const w = await folded(), { head } = w
  const [seg, line] = [head.mark.slice(0, head.mark.lastIndexOf(':')), Number(head.mark.slice(head.mark.lastIndexOf(':') + 1))]
  const after = [1, 2, 3, 4, 5].map((d) => `${seg}:${line + d}`)
  const doc = JSON.stringify(head)
  const behind = await fresh(w, { route: (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-trocar-tip': [head.mark, ...after].join(' ') }, body: doc }) })
  try {
    await behind.page.goto(`${w.b.url}/#/replay/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}`)
    const el = await behind.page.waitForSelector('[data-read-state="behind"]', { timeout: 15_000 })
    assert.equal(await el.getAttribute('data-behind'), String(after.length))
  } finally { await behind.context.close() }

  const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/session-read-contract.json', import.meta.url), 'utf8')).session_head_tier0
  const tier0 = await fresh(w, { route: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...fixture, id: w.id }) }) })
  try {
    await tier0.page.goto(`${w.b.url}/#/replay/${encodeURIComponent(w.project)}/${encodeURIComponent(w.id)}`)
    const r = await rough(tier0.page)
    assert.equal(r.bars, 0, 'tier 0: no bars')
    assert.ok(r.busy >= 1 && r.ctxText === '', 'tier 0: the context window is an empty frame')
    await tier0.page.waitForSelector('[data-read-state="reading"]', { timeout: 15_000 })
  } finally { await tier0.context.close() }
})
