// test/web-v2/browser/desk-return.test.mjs — 1.2 #23 (§路由「离开再回来」, D71③) on the mounted desk: a desk the reader leaves stays in
// the session cache. Back from the library (its row, or Back) or from the overview (Back), it draws the step it showed within
// BOARD_LINES.routeBack, the follow chip as it was, and reads the session once with `since` and no lane before its poll timer's first tick; a following desk still follows;
// the 4th session opened evicts the least recently seen one, whose next open is a full read. A new page opens in full. The session
// reads are answered from desk-world (3.5 §会话读's reference server) for any id. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, stats } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { INTERVAL } from '../../../src/web/v2/core/poll.mjs'

const gate = await probe()
// what a return reads is counted until just before the desk's own timer could poll (it restarts on the return)
const AFTER = INTERVAL.session * 0.8
const skip = gate.ok ? false : gate.reason

const w = world(9, { calls: 300, page: 60 }) // the anchor lane in pages of 60: older pages are read after the open
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000, polling: 'raf' })
const view = (page) => page.evaluate(() => ({ no: document.querySelector('#stepbar .sb-no')?.textContent ?? null,
  follow: document.querySelector('.sh-follow')?.getAttribute('aria-pressed') ?? null, step: new URLSearchParams(location.hash.split('?')[1] || '').get('step') }))
const drawn = (page) => until(page, () => !!document.querySelector('.desk #stepbar .sb-no') && !document.querySelector('#ctxwin [aria-busy="true"]'))
// the `name` reads that started at or after `from` (ms epoch)
const reads = (b, from, name) => b.requests.filter((r) => r.start >= from && r.url.startsWith(`/api/${name}?`)).map((r) => new URL(r.url, 'http://x').searchParams)
// the desk is settled once no session or lane read but the poll's `since` has answered for `quiet` ms (its older pages are all read)
async function settle(b, quiet = 4000) {
  const t0 = Date.now()
  for (;;) {
    const last = b.requests.filter((r) => /^\/api\/lane\?/.test(r.url) || (/^\/api\/session\?/.test(r.url) && !/[?&]since=/.test(r.url))).at(-1)
    if (!last || Date.now() - last.t > quiet) return
    assert.ok(Date.now() - t0 < 60000, 'the desk settles within a minute')
    await new Promise((r) => setTimeout(r, 250))
  }
}
// leave the desk, then come back by `back`; → {ms: from the navigation to the frame that shows step `no` again, at: the navigation's ms epoch}
async function roundTrip(page, away, back, no) {
  await page.evaluate((h) => { location.hash = h }, away)
  await until(page, () => !document.querySelector('.desk') && !!document.querySelector('#screen .page, #screen .lrow') && !document.querySelector('#screen .screenwait'))
  if (away === '#/sessions') await until(page, () => !!document.querySelector('.lrow'))
  return page.evaluate(([back, no]) => new Promise((resolve) => {
    const t0 = performance.now(), at = Date.now()
    if (back === 'back') history.back(); else document.querySelector(`a.lrow[href="${back}"]`).click()
    const tick = () => {
      const d = document.querySelector('.desk'), sb = document.querySelector('#stepbar .sb-no')
      if (d && d.isConnected && sb && sb.textContent === no && performance.now() - t0 < 10000) return resolve({ ms: performance.now() - t0, at })
      if (performance.now() - t0 >= 10000) return resolve({ ms: Infinity, at })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), [back, no])
}

async function board() {
  const b = await withBoard({ bytes: 1e5, width: 1280, chromium: gate.chromium })
  await serveWorld(b.page, w)
  await b.page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
  return b
}
// the first library row (the real home's session): the session under test, since the world answers for any id
async function firstRow(page) {
  await page.evaluate(() => { location.hash = '#/sessions' })
  await until(page, () => !!document.querySelector('a.lrow'))
  return page.evaluate(() => document.querySelector('a.lrow').getAttribute('href'))
}

test('1.2 #23 back to a parked desk (library row, overview Back, library Back): the same step, the same chip, one `since`, no lane, within routeBack', { skip }, async () => {
  const b = await board()
  try {
    const { page } = b
    const href = await firstRow(page)
    const mark = Date.now()
    await page.evaluate((h) => { location.hash = h }, href)
    await drawn(page)
    const first = reads(b, mark, 'session')
    assert.ok(first.length > 0 && !first[0].has('since'), 'a new page opens the session in full')
    const M = +(/\/\s*(\d+)/.exec((await view(page)).no) || [])[1]
    assert.ok(M > 120, `the anchor lane spans several pages (${M} steps)`)
    await page.evaluate(([h, n]) => { location.hash = `${h}?step=${n}` }, [href, Math.floor(M / 2)])
    await until(page, () => document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'false')
    await settle(b)
    const left = await view(page)
    assert.equal(left.follow, 'false')
    const ms = []
    for (const [name, away, back] of [['library row', '#/sessions', href], ['overview Back', '#/overview', 'back'], ['library Back', '#/sessions', 'back']]) {
      for (let i = 0; i < 3; i++) {
        const { ms: t, at } = await roundTrip(page, away, back, left.no)
        ms.push(t)
        await new Promise((r) => setTimeout(r, AFTER))
        const v = await view(page)
        assert.deepEqual([v.no, v.follow, v.step], [left.no, left.follow, left.step], `${name} #${i + 1}: the step, the chip and the URL as left`)
        const s = reads(b, at, 'session')
        assert.deepEqual(s.map((q) => q.has('since')), [true], `${name} #${i + 1}: one session read, with since`)
        assert.equal(reads(b, at, 'lane').length, 0, `${name} #${i + 1}: no lane read`)
      }
    }
    const { p95 } = stats(ms)
    assert.ok(p95 <= BOARD_LINES.routeBack, `navigation → drawn p95 ${p95.toFixed(1)} ms > ${BOARD_LINES.routeBack} ms (${ms.map((x) => x.toFixed(1))})`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('1.2 #23 a desk left while following comes back following, its URL naming no step', { skip }, async () => {
  const b = await board()
  try {
    const { page } = b
    const href = await firstRow(page)
    await page.evaluate((h) => { location.hash = h }, href)
    await drawn(page)
    await settle(b)
    const left = await view(page)
    assert.deepEqual([left.follow, left.step], ['true', null])
    const { ms, at } = await roundTrip(page, '#/sessions', 'back', left.no)
    assert.ok(ms < Infinity)
    await new Promise((r) => setTimeout(r, AFTER))
    const v = await view(page)
    assert.deepEqual([v.no, v.follow, v.step], [left.no, 'true', null])
    assert.deepEqual(reads(b, at, 'session').map((q) => q.has('since')), [true])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('1.2 #23 the 4th session opened evicts the least recently seen: back on the 1st, its first session read has no since', { skip }, async () => {
  const b = await board()
  try {
    const { page } = b
    for (const id of ['S1', 'S2', 'S3', 'S4']) {
      await page.evaluate((h) => { location.hash = h }, `#/replay/p/${id}`)
      await until(page, (id) => location.hash.startsWith(`#/replay/p/${id}`) && !!document.querySelector('.desk #stepbar .sb-no'), id)
    }
    const mark = Date.now()
    await page.evaluate(() => { location.hash = '#/replay/p/S1' })
    await drawn(page)
    const s = reads(b, mark, 'session').filter((q) => q.get('id') === 'S1')
    assert.ok(s.length > 0 && !s[0].has('since'), 'the evicted session opens in full')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('1.2 #24 a cold open of a replay route sends its first full `session` read before any status / pricing read, and only one', { skip }, async () => {
  const b = await board()
  try {
    const { page } = b
    const href = await firstRow(page)
    // a new document on the replay route with the token already in this tab's sessionStorage (the #t= boot put it there)
    await page.evaluate((h) => history.replaceState(null, '', h), href)
    await page.reload({ waitUntil: 'commit' })
    await until(page, () => !!document.querySelector('#stepbar .sb-no'))
    // in the order the page sent them (Resource Timing: a routed answer does not delay its entry's start)
    const sent = (await page.evaluate(() => performance.getEntriesByType('resource').map((e) => [e.startTime, e.name])))
      .sort((a, b) => a[0] - b[0]).map(([, n]) => new URL(n)).filter((u) => u.pathname.startsWith('/api/'))
    const full = (u) => u.pathname === '/api/session' && !u.searchParams.has('since') && !u.searchParams.has('before')
    const i = sent.findIndex(full), j = sent.findIndex((u) => u.pathname === '/api/status' || u.pathname === '/api/pricing')
    assert.ok(i >= 0 && (j < 0 || i < j), `the first full session read leads: ${sent.map((u) => u.pathname + u.search).join(' ')}`)
    assert.equal(sent.filter(full).length, 1, sent.map((u) => u.pathname + u.search).join(' '))
  } finally { await b.stop() }
})
