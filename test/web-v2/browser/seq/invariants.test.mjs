// invariants.test.mjs — every invariant of the sequence harness can go red on the real board: one board on makeWorld() with the probe
// installed and the Claude Code session open; V0 a settled, followed, grown desk breaks none; each V-<id> plants exactly that fault
// (through page.evaluate, a route, an unrecorded keydown, or growth with the session reads aborted) and check() names it; VP a long task
// lands in `pending`, never in `violations`. Runs only under `npm run test:browser`.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from '../harness.mjs'
import { makeWorld, mainCount } from './world.mjs'
import { installProbe } from './probe.mjs'
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

test('V-stack native stack text in the rendered page', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { const e = document.createElement('pre'); e.textContent = 'Error: x\n    at f (/srv/a.js:1:2)'; document.getElementById('screen').firstElementChild.append(e) })
  assert.ok(ids(await check(ctx())).includes('I-stack'))
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

test('V-cjk CJK text in the page', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { const e = document.createElement('p'); e.textContent = '中文'; document.getElementById('screen').firstElementChild.append(e) })
  assert.ok(ids(await check(ctx())).includes('I-cjk'))
})

test('VP a 120 ms busy loop is pending I-longtask, never a violation', { skip }, async () => {
  await fresh()
  await b.page.evaluate(() => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 120); }) }) // a task of its own: an evaluate is not one
  await b.page.waitForFunction(() => window.__seq.snap().longtaskMax > 0, null, { timeout: 5000 })
  const r = await check(ctx())
  assert.ok(r.pending.some((p) => p.id === 'I-longtask'))
  assert.ok(!ids(r).includes('I-longtask'))
})
