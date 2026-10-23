// invariants.test.mjs — every invariant of the sequence harness can go red on the real board: one board on makeWorld() with the probe
// installed and the Claude Code session open; V0 a settled, followed, grown desk breaks none; each V-<id> plants exactly that fault
// (through page.evaluate, a route, an unrecorded keydown, or growth with the session reads aborted) and check() names it; A17 a tiny
// static page the harness serves (not the board) proves the probe sees a long task. Runs only under `npm run test:browser`.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from '../harness.mjs'
import { makeWorld, mainCount } from './world.mjs'
import { installProbe, snap } from './probe.mjs'
import { check } from './invariants.mjs'

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
    const r = await check(ctx({ follow: true, grownAt }))
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

// A33 · E7: a lane's ledger chain (`ledger=`) is one read after another by design (3.5 §手里车道的页), not paced; the same chain
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
  await b.page.route('**/api/session?**', (r) => r.abort())
  try {
    const grownAt = Date.now(); world.grow(2)
    const r = await check(ctx({ follow: true, grownAt, faults: [{ name: 'abort-session', kind: 'route', from: grownAt, to: null }] }))
    assert.ok(ids(r).includes('I-follow'))
  } finally { await b.page.unroute('**/api/session?**') }
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
  await fresh()
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

// the page's own timer runs the loop (code run through page.evaluate is no task of the page's)
const planted = (loop) => `<!doctype html><meta charset="utf-8"><title>planted</title><p>planted</p><script>setTimeout(() => {
  ${loop ? 'const t = performance.now(); while (performance.now() - t < 120);' : ''} window.__planted = true }, 50)</script>`

test('A17 a planted 120 ms busy loop is a long task ≥ 100 ms and an I-longtask violation; the page without it is neither', { skip }, async () => {
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
