// invariants.test.mjs — every invariant of the sequence harness can go red on the real board: one board on makeWorld() with the probe
// installed and the Claude Code session open; V0 a settled, followed, grown desk breaks none; each V-<id> plants exactly that fault
// (through page.evaluate, a route, an unrecorded keydown, or growth with the session reads aborted) and check() names it; a tiny
// static page the harness serves (not the board) proves the probe sees a long task; two more static pages break I-chapter and I-pack.
// Runs only under `npm run test:browser`.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from '../harness.mjs'
import { makeWorld, mainCount } from './world.mjs'
import { installProbe, snap } from './probe.mjs'
import { check } from './invariants.mjs'
import { ACTIONS } from './actions.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
let world, b, id, hash, actions, baseline

const act = (a) => actions.push({ t: Date.now(), a })
const drawn = (page) => page.waitForFunction(() => !!document.querySelector('#stepbar .sb-no') && !!document.querySelector('#ctxwin .cblk') && !document.querySelector('#ctxwin .cwload'), null, { timeout: 20000 })
const ctx = (o = {}) => ({ page: b.page, requests: b.requests, errors: b.errors, actions, faults: [], hidden: [], follow: false, grownAt: null, truth: () => mainCount(b.get, id), real: false, baseline, ...o })
const ids = (r) => r.violations.map((v) => v.id)
const quiet = () => b.page.waitForTimeout(700) // past the last reader action's window
async function go(h) { act('route'); await b.page.evaluate((x) => { location.hash = x }, h) }
async function revisit() { await go('#/sessions'); await b.page.waitForTimeout(1000); await go(hash); await drawn(b.page); await quiet() }
// a fresh page on the open session: logs, probe and baselines start over
async function fresh() {
  actions = []; baseline = new Map(); b.errors.length = 0; b.requests.length = 0
  act('reload'); await b.page.reload({ waitUntil: 'load' }); await drawn(b.page); await quiet()
}
// the desk is done reading: its step bar counts the server's m steps, no read is in flight and the last one ended ≥ 500 ms ago (its
// answer applied and drawn). A URL planted before that is rewritten by the desk's next draw (syncUrl names the shown step), so a slow
// page — a 2-vCPU box, a 6x CPU throttle — still drawing the reload's reads erased V-url's plant before check could see it.
async function settledDesk() {
  const m = await mainCount(b.get, id)
  await b.page.waitForFunction((k) => {
    const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || ''), s = window.__seq.snap()
    return !!x && +x[2] === k && s.inflight === 0 && Date.now() - Math.max(0, ...s.fetchLog.map((e) => e.end ?? Infinity)) >= 500
  }, m, { timeout: 20000, polling: 100 })
}
// the desk follows the newest step of the settled session: its step bar shows m / m (m = the server's main-lane count) with
// 跟随最新 on, and the URL names no step (1.2 §路由: a following desk's URL names neither step nor call, so a reload follows
// too). Both are waited for, never assumed: the first answer can be a pending fold's part (13 of 27 steps).
async function following() {
  const m = await mainCount(b.get, id)
  await b.page.waitForFunction((k) => {
    const x = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
    return !!x && +x[1] === k && +x[2] === k && document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'true' &&
      !new URLSearchParams(location.hash.split('?')[1] || '').has('step')
  }, m, { timeout: 20000 })
}
const frames = (n) => b.page.evaluate((k) => new Promise((r) => { const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f) }), n)

before(async () => {
  if (skip) return
  world = makeWorld({ seed: 7 })
  b = await withBoard({ home: world, chromium: gate.chromium, setup: installProbe })
  id = world.sessions.find((s) => s.wire === 'http').id
  const row = (await b.get('sessions')).doc.sessions.find((s) => s.session_id === id)
  hash = `#/replay/${encodeURIComponent(row.project_slug)}/${encodeURIComponent(id)}`
  await b.page.evaluate((h) => { location.hash = h }, hash)
  await drawn(b.page)
  await following()
})
after(async () => { await b?.stop() })

// The desk reads `sessions` with every 1.5 s tick (replay.mjs pollOnce → loadSessions), against 4.4's 3 s for that name, so at the
// default cadence I-rate goes red on the product (reported, not weakened). V0 runs where the rule holds: `sessions` answers take
// 1 s, so the poller's 3 × read-duration wait spaces every timer read ≥ 3 s.
test('V0 a settled, followed desk that grows breaks no invariant', { skip }, async () => {
  const slow = (r) => new Promise((ok) => setTimeout(ok, 1000)).then(() => r.continue()).catch(() => {})
  await b.page.route('**/api/sessions**', slow)
  try {
    await fresh()
    await following()
    await check(ctx()) // the first visit's baseline
    const grownAt = Date.now(); world.grow(2)
    await b.page.waitForTimeout(6000) // several timer reads at the desk's own cadence
    const r = await check(ctx({ follow: true, grownAt, stepAt: grownAt })) // the growth is the step (2.3 #27: the fresh page's first draw is not judged)
    assert.deepEqual(r.violations, [])
  } finally { await b.page.unroute('**/api/sessions**', slow) }
})

test('V-pageerror a throw in a timer', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { setTimeout(() => { throw new Error('planted') }) })
  await b.page.waitForTimeout(200)
  assert.ok(ids(await check(ctx())).includes('I-pageerror'))
})

test('V-console a console.error outside any armed fault window', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => console.error('planted'))
  assert.ok(ids(await check(ctx())).includes('I-console'))
})

test('V-blank #screen empty for three frames', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => new Promise((r) => {
    const sc = document.getElementById('screen'), kids = [...sc.childNodes]
    sc.replaceChildren()
    let k = 3; const f = () => (--k ? requestAnimationFrame(f) : (sc.replaceChildren(...kids), r())); requestAnimationFrame(f)
  }))
  assert.ok(ids(await check(ctx())).includes('I-blank'))
})

test('V-keep the never-drawn failure state over a drawn desk', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => new Promise((r) => {
    const w = document.getElementById('ctxwin'), kids = [...w.childNodes], e = document.createElement('div')
    e.className = 'empty'; e.textContent = 'x'; w.replaceChildren(e)
    let k = 3; const f = () => (--k ? requestAnimationFrame(f) : (w.replaceChildren(...kids), r())); requestAnimationFrame(f)
  }))
  assert.ok(ids(await check(ctx())).includes('I-keep'))
})

test('V-stack a native stack in the board\'s own failure line, never one inside a captured block', { skip }, async () => {
  const STACK = 'FATAL ERROR: Reached heap limit\n    at f (/srv/a.js:1:2)'
  await fresh()
  // a tool_result holding a trace is the session's content: the open block's verbatim body
  await b.page.evaluate((t) => { const e = document.createElement('pre'); e.className = 'cbpre'; e.textContent = t; document.querySelector('#ctxwin .cblk').append(e) }, STACK)
  assert.ok(!ids(await check(ctx())).includes('I-stack'), 'a stack in captured content is not the board\'s')
  await b.page.evaluate((t) => { const e = document.createElement('div'); e.className = 'emptywhy'; e.style.whiteSpace = 'pre-wrap'; e.textContent = t; document.getElementById('ctxwin').prepend(e) }, STACK)
  assert.ok(ids(await check(ctx())).includes('I-stack'), 'the same stack in a failure line is')
})

test('V-hscroll a 5000 px wide element', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { const e = document.createElement('div'); e.style.width = '5000px'; e.style.height = '1px'; document.body.append(e) })
  assert.ok(ids(await check(ctx())).includes('I-hscroll'))
})

test('V-rate ten timer-less reads of status in a row', { skip }, async () => {
  await fresh()
  await b.page.evaluate(async () => { for (let i = 0; i < 10; i++) await fetch('/api/status').catch(() => {}) })
  assert.ok(ids(await check(ctx())).includes('I-rate'))
})

// a lane's ledger chain (`ledger=`) is one read after another by design (3.5 §手里车道的页), not paced; the same chain
// as `from=` reads with no session delta between them is
test('V-rate a ledger chain is not paced; the same chain of from= reads is', { skip }, async () => {
  const chain = (param) => b.page.evaluate(async ([sid, p]) => {
    const base = `/api/lane?id=${encodeURIComponent(sid)}&lane=L1`
    await fetch(base).catch(() => {})
    for (let i = 1; i <= 6; i++) { await new Promise((r) => setTimeout(r, 50)); await fetch(`${base}&${p}=c${i}`).catch(() => {}) }
  }, [id, param])
  await fresh()
  await chain('ledger')
  assert.ok(!ids(await check(ctx())).includes('I-rate'), 'a ledger chain is not paced')
  await fresh()
  await chain('from')
  assert.ok(ids(await check(ctx())).includes('I-rate'), 'from= reads are')
})

test('V-write a POST from the page', { skip }, async () => {
  await fresh()
  await b.page.route('**/api/seq-write', (r) => r.fulfill({ status: 204 }))
  try {
    await b.page.evaluate(() => fetch('/api/seq-write', { method: 'POST', body: '{}' }))
    assert.ok(ids(await check(ctx())).includes('I-write'))
  } finally { await b.page.unroute('**/api/seq-write') }
})

test('V-leak fifty window listeners kept across a revisit', { skip }, async () => {
  await fresh()
  await check(ctx())
  await b.page.evaluate(() => { for (let i = 0; i < 50; i++) window.addEventListener('resize', () => {}) })
  await revisit()
  assert.ok(ids(await check(ctx())).includes('I-leak'))
})

test('V-mem the DOM inflated across a revisit', { skip }, async () => {
  await fresh()
  await check(ctx())
  await b.page.evaluate(() => { const box = document.createElement('div'); box.hidden = true; for (let i = 0; i < 30000; i++) box.append(document.createElement('i')); document.body.append(box) })
  await revisit()
  assert.ok(ids(await check(ctx())).includes('I-mem'))
})

test('V-follow following, the session grows and its reads are aborted', { skip }, async () => {
  await fresh()
  await b.page.route('**/api/d/**', (r) => r.abort())
  try {
    const grownAt = Date.now(); world.grow(2)
    const r = await check(ctx({ follow: true, grownAt, faults: [{ name: 'abort-d', kind: 'route', from: grownAt, to: null }] }))
    assert.ok(ids(r).includes('I-follow'))
  } finally { await b.page.unroute('**/api/d/**') }
})

test('V-hold not following, growth and an unrecorded step key', { skip }, async () => {
  await fresh()
  act('ArrowLeft'); await b.page.keyboard.press('ArrowLeft'); await quiet()
  const { view } = await check(ctx())
  const grownAt = Date.now(); world.grow(2)
  await b.page.waitForTimeout(3500) // the desk's next timer reads take the growth in
  await b.page.keyboard.press('ArrowRight')
  await b.page.waitForTimeout(500)
  const r = await check(ctx({ prev: view, grownAt }))
  assert.ok(ids(r).includes('I-hold'))
})

test('V-url the hash names another step than the one shown', { skip }, async () => {
  await fresh(); await settledDesk()
  await b.page.evaluate(() => {
    const n = +/(\d+)\s*\//.exec(document.querySelector('#stepbar .sb-no').textContent)[1]
    const [route, q] = location.hash.split('?'), p = new URLSearchParams(q || '')
    p.set('step', String(n === 1 ? 2 : 1)); history.replaceState(null, '', `${route}?${p}`)
  })
  assert.ok(ids(await check(ctx())).includes('I-url'))
})

test('V-url-follow the hash names no step while the desk does not follow', { skip }, async () => {
  await fresh()
  await go(hash) // the earlier cases leave a step in the URL: a stepless desk route follows (1.2 §路由)
  await following()
  act('f'); await b.page.keyboard.press('f') // 跟随最新 off: the desk writes the shown step
  await b.page.waitForFunction(() => document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'false' && /[?&]step=/.test(location.hash))
  await settledDesk()
  await b.page.evaluate(() => {
    const [route, q] = location.hash.split('?'), p = new URLSearchParams(q || '')
    p.delete('step'); history.replaceState(null, '', p.size ? `${route}?${p}` : route)
  })
  assert.ok(ids(await check(ctx())).includes('I-url'))
})

test('V-cjk CJK text in the page', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { const e = document.createElement('p'); e.textContent = '中文'; document.getElementById('screen').firstElementChild.append(e) })
  assert.ok(ids(await check(ctx())).includes('I-cjk'))
})

test('V-loadstep a control inside an aria-busy frame of the desk', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { const f = document.createElement('div'); f.setAttribute('aria-busy', 'true'); document.getElementById('ctxwin').append(f) })
  assert.ok(!ids(await check(ctx())).includes('I-loadstep'), 'an empty busy frame is no load control')
  await b.page.evaluate(() => document.querySelector('#ctxwin > [aria-busy="true"]').append(document.createElement('button')))
  assert.ok(ids(await check(ctx())).includes('I-loadstep'))
})

// the page's own timer runs the loop once the document's boot is over (code run through page.evaluate is no task of the page's)
const planted = (loop) => `<!doctype html><meta charset="utf-8"><title>planted</title><p>planted</p><script>setTimeout(() => {
  ${loop ? 'const t = performance.now(); while (performance.now() - t < 120);' : ''} window.__planted = true }, 300)</script>`

test('a planted 120 ms busy loop is a long task ≥ 100 ms and an I-longtask violation; the page without it is neither', { skip }, async () => {
  for (const loop of [true, false]) {
    const pg = await b.page.context().newPage()
    try {
      await installProbe(pg)
      await pg.route('**/seq-planted.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: planted(loop) }))
      await pg.goto(`${b.url}/seq-planted.html`)
      await pg.waitForFunction(() => window.__planted === true)
      await pg.waitForTimeout(300) // the observer's entries are delivered after the task
      const r = await check({ page: pg })
      const { longtaskMax } = await snap(pg)
      assert.equal(longtaskMax >= 100, loop, `long task max ${longtaskMax} ms`)
      assert.equal(ids(r).includes('I-longtask'), loop)
    } finally { await pg.close() }
  }
})

// 2.3 #27: I-longtask judges a task that starts after the step starts, unless that step made the document (the whole step is its
// boot). A 120 ms loop in a task of the page's own 100 ms into a document the step opened, and one before the step starts, are seen
// by the probe and not judged; one after the step starts is.
test('V-longtask: a long task of the step that made the document or before the step starts is not judged; one after the step starts is', { skip }, async () => {
  const pg = await b.page.context().newPage()
  const at = () => pg.evaluate(() => performance.timeOrigin + performance.now())
  const busy = () => pg.evaluate(() => new Promise((ok) => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120); setTimeout(ok, 300) })))
  try {
    await installProbe(pg)
    await pg.route('**/seq-boot.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>boot</title><p>boot</p><script>setTimeout(() => { const t = performance.now(); while (performance.now() - t < 120); }, 100)</script>' }))
    await pg.goto('about:blank')
    const openAt = await at()
    await pg.goto(`${b.url}/seq-boot.html`)
    await pg.waitForTimeout(500) // past the 100 ms timer; the observer's entries are delivered after the task
    assert.ok((await snap(pg)).longtaskMax >= 100, 'the boot\'s long task is seen')
    assert.equal(ids(await check({ page: pg, stepAt: openAt })).includes('I-longtask'), false, 'the step that made the document is not judged')
    await busy()
    assert.equal(ids(await check({ page: pg, stepAt: await at() })).includes('I-longtask'), false, 'a task before the step starts is not judged')
    const stepAt = await at()
    await busy()
    assert.ok(ids(await check({ page: pg, stepAt })).includes('I-longtask'), 'a task after the step starts is judged')
  } finally { await pg.close() }
})

// the same on the real board: under a 6x CPU throttle a reload step's cold open (the rough page, then the rows and the packs the loader
// reads behind them, D71①) runs long tasks that I-longtask does not judge; a long task that the next step's key starts is judged
test('V-longtask board: a throttled reload step is not judged; a long task after the next step\'s key is', { skip }, async () => {
  const cdp = await b.page.context().newCDPSession(b.page)
  const at = () => b.page.evaluate(() => performance.timeOrigin + performance.now())
  try {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    const reloadAt = await at()
    await b.page.reload({ waitUntil: 'load' }); await drawn(b.page)
    await b.page.waitForTimeout(1500) // the loader's packs behind the rows
    assert.ok((await snap(b.page)).longtaskMax > 50, 'the throttled cold open runs long tasks')
    assert.equal(ids(await check({ page: b.page, stepAt: reloadAt })).includes('I-longtask'), false, 'the reload step is not judged')
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await quiet()
    // the key's own task runs a 120 ms loop of the page's
    await b.page.evaluate(() => document.addEventListener('keydown', () => { const t = performance.now(); while (performance.now() - t < 120); }, { once: true }))
    const keyAt = await at()
    await b.page.keyboard.press('ArrowLeft')
    await b.page.waitForTimeout(500)
    assert.ok(ids(await check({ page: b.page, stepAt: keyAt })).includes('I-longtask'), 'a long task after the key is judged')
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {}); await cdp.detach().catch(() => {})
    await b.page.evaluate((h) => { location.hash = h }, hash) // the key named a step: the next case's reload follows again
  }
})

// 2.3 #27 (D64 ①②③): 50 ms holds only a step inside the open session; a step that opens the session from the library is held to the
// 0.5 s line. A 70 ms task of the page's own after each step tells the two apart.
test('V-longtask scope: a 70 ms task after the step that opened the session is not judged; one after ← in that session is', { skip }, async () => {
  await fresh()
  const at = () => b.page.evaluate(() => [performance.timeOrigin + performance.now(), location.hash])
  const busy = () => b.page.evaluate(() => new Promise((ok) => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 70); setTimeout(ok, 300) })))
  try {
    await go('#/sessions'); await b.page.waitForTimeout(1000)
    let [stepAt, stepHash] = await at()
    await go(hash); await drawn(b.page); await busy()
    assert.equal(ids(await check({ page: b.page, stepAt, stepHash })).includes('I-longtask'), false, 'the step that opened the session')
    ;[stepAt, stepHash] = await at()
    await b.page.keyboard.press('ArrowLeft'); await busy()
    assert.ok(ids(await check({ page: b.page, stepAt, stepHash })).includes('I-longtask'), 'a step inside the open session')
  } finally { await b.page.evaluate((h) => { location.hash = h }, hash) }
})

// a static page the harness serves at `hash` (not the board), its /api/* answered by `api(url)` → {body, ms}; resolves once
// window.__planted is true
async function plantedPage(html, hash, api = () => ({ body: '{}' })) {
  const pg = await b.page.context().newPage()
  await installProbe(pg)
  await pg.route('**/seq-planted.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>planted</title>${html}` }))
  await pg.route('**/api/**', async (r) => { const a = api(new URL(r.request().url())); await new Promise((ok) => setTimeout(ok, a.ms || 0)); await r.fulfill({ contentType: 'application/json', body: a.body }).catch(() => {}) })
  await pg.goto(`${b.url}/seq-planted.html${hash}`)
  await pg.waitForFunction(() => window.__planted === true, null, { timeout: 10000 })
  return pg
}

// the chapter row of 1.3 §章 as the desk draws it: label [10, 20), the step label's data-n (1-based), the axis ends (1-based)
const chapterPage = (n, a, z) => `<div id="stepbar"><b class="sb-no" data-n="${n}">x</b></div><div id="chapnav"><span class="chaplabel" data-s0="10" data-s1="20"></span></div>
  <span id="sawstart">step ${a}</span><span id="sawend">step ${z}</span><script>window.__planted = true</script>`

test('I-chapter: a playhead or a drawn window outside the label\'s chapter is a violation; both inside it is none', { skip }, async () => {
  for (const [n, a, z, red] of [[15, 11, 20, false], [25, 11, 20, true], [15, 11, 21, true], [11, 10, 20, true]]) {
    const pg = await plantedPage(chapterPage(n, a, z), '#/replay/p/x')
    try { assert.equal(ids(await check({ page: pg })).includes('I-chapter'), red, `step ${n}, window ${a}-${z}`) } finally { await pg.close() }
  }
})

// the main track with a review range: `bars` = which bars are .reviewed, `w` = the bracket's width in px (0 = hidden)
const reviewPage = (bars, w) => `<div id="sawrow"><div id="reviewbracket" style="display:${w ? 'block' : 'none'};width:${w}px;height:3px"></div>
  ${bars.map((r) => `<div class="bar${r ? ' reviewed' : ''}"></div>`).join('')}</div><script>window.__planted = true</script>`

test('I-review: a bracket without reviewed bars, reviewed bars without a bracket, or reviewed bars that are no prefix is a violation', { skip }, async () => {
  for (const [bars, w, red] of [[[1, 1, 0, 0], 40, false], [[0, 0, 0], 0, false], [[0, 0, 0], 40, true], [[1, 0, 0], 0, true], [[1, 0, 1], 40, true]]) {
    const pg = await plantedPage(reviewPage(bars, w), '#/replay/p/x')
    try { assert.equal(ids(await check({ page: pg })).includes('I-review'), red, `${bars} · ${w}px`) } finally { await pg.close() }
  }
})

// the head names pack 0 at tag `a`; then the page reads `reads` (a list of /api/d/... paths, all at once)
const packPage = (reads) => `<script>(async () => {
  await (await fetch('/api/d/head?id=x')).json()
  const one = async (p) => (await fetch(p)).text()
  await Promise.all(${JSON.stringify(reads)}.map((r) => (Array.isArray(r) ? r.reduce((q, p) => q.then(() => one(p)), Promise.resolve()) : one(r))))
  window.__planted = true })()</script>`

test('I-pack: a pack read twice at one head tag, or four loader reads at once, is a violation; one read each and three at once are none', { skip }, async () => {
  const api = (u) => (u.pathname === '/api/d/head' ? { body: JSON.stringify({ packs: [{ n: 0, tag: 'a' }, { n: 1, tag: 'b' }] }) } : { body: '', ms: 300 })
  const P = (f) => `/api/d/${f}?id=x`
  for (const [reads, red] of [
    [[[P('p0.main'), P('p0.rest')]], false],
    [[[P('p0.main'), P('p0.main')]], true],
    [[P('p0.main'), P('p1.main'), '/api/block?id=x&ref=r1'], false],
    [[P('p0.main'), P('p1.main'), '/api/block?id=x&ref=r1', '/api/lane?id=x&lane=m&ledger=1'], true],
  ]) {
    const pg = await plantedPage(packPage(reads), '#/replay/p/x', api)
    try { assert.equal(ids(await check({ page: pg })).includes('I-pack'), red, JSON.stringify(reads)) } finally { await pg.close() }
  }
})

// I-select (1.2 §点击与选中文字): a toggle that still answers the click ending a drag-select. The planted listener sits on window in the
// capture phase, ahead of the board's own guard, and folds the first desk block on every click; the reader's select step over a block
// head then changes a fold while it made a selection.
test('V-select a click that ends a drag-select folds a block', { skip }, async () => {
  await fresh(); await following()
  await b.page.evaluate(() => { window.__plantFold = () => document.querySelector('#ctxwin .cblk')?.classList.toggle('collapsed'); window.addEventListener('click', window.__plantFold, true) })
  try {
    const sel = ACTIONS.find((x) => x.a === 'select'), c = { page: b.page }
    const r = await sel.run(c, { where: 'head', f: 0, span: 0.5 })
    assert.notEqual(r?.skipped, true, 'a block head with text to select')
    act('select'); await quiet()
    assert.ok(ids(await check(ctx({ drag: c.lastDrag }))).includes('I-select'))
  } finally { await b.page.evaluate(() => window.removeEventListener('click', window.__plantFold, true)) }
})
