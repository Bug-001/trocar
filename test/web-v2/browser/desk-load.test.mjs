// test/web-v2/browser/desk-load.test.mjs — 2.3 #29, #30 and #32 on the mounted desk, in the real Chrome, the session reads answered from a
// generated long session (desk-world.mjs, 3.5 §会话读's reference server) whose skeleton and anchor lane each come in ≥ 6 pages and
// whose every answer waits L ms: the loader keeps ≤ 3 reads out (rows the reader opens meanwhile included), each history chain sends its next read as soon as the last one ended,
// and the whole history is in within the two chains' back-to-back time (#29); a named step older than the held part lands directly,
// no step in between is ever drawn (#30). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, blockBytes } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const SPAGE = 16
const longSession = () => world(5, { calls: 160, page: 16, spage: SPAGE, talk: { pre: 3, len: 60, every: 6, tail: 4 } })

// the step numbers #stepbar .sb-no shows, sampled every frame from now on: window.__steps = [{n, t (ms epoch)}] on each change
const sampleSteps = (page) => page.evaluate(() => {
  window.__steps = []
  let last = null
  const tick = () => {
    const x = /(\d+)\s*\/\s*\d+/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
    const n = x ? +x[1] : null
    if (n !== last) { last = n; if (n != null) window.__steps.push({ n, t: Date.now() }) }
    requestAnimationFrame(tick)
  }
  tick()
})
const steps = (page) => page.evaluate(() => window.__steps)
async function until(page, what, ms = 15000) {
  const t0 = Date.now()
  while (!(await what())) { if (Date.now() - t0 > ms) return false; await page.waitForTimeout(20) }
  return true
}

test('2.3 #29: the loader keeps ≤ 3 reads out, each history chain reads back to back, the whole history is in within the chains\' time', { skip }, async (t) => {
  const L = 150, w = longSession()
  const main = w.full().lanes.find((h) => h.kind === 'main').lane
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b
    // every loader read (lane, block, session --before) with when it started and ended (ms epoch); the chains' ends from the answers
    const log = []
    const kind = (u) => { const p = u.pathname.slice(5); return p === 'lane' || p === 'block' || (p === 'session' && u.searchParams.has('before')) ? p : null }
    page.on('request', (r) => { const u = new URL(r.url()), k = kind(u); if (k) log.push({ r, k, q: u.searchParams, start: Date.now(), end: null, doc: null }) })
    page.on('requestfinished', async (r) => {
      const x = log.find((e) => e.r === r)
      if (!x) return
      x.end = Date.now()
      if (x.k !== 'block') x.doc = await (await r.response())?.json().catch(() => null)
    })
    page.on('requestfailed', (r) => { const x = log.find((e) => e.r === r); if (x) x.end = Date.now() })
    await serveWorld(page, w, { latency: L })
    await sampleSteps(page)
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    assert.ok(await until(page, async () => (await steps(page)).length > 0), 'the desk drew a step')
    const painted = (await steps(page))[0].t
    // the reader opens rows while the chains run: their bodies' reads go through the same loader (≤ 3 out still holds)
    const opened = await page.evaluate(() => { const hs = [...document.querySelectorAll('#ctxwin .cblk.collapsed:not(.removed):not([data-rp]) > .cbh')].slice(0, 4); for (const h of hs) h.click(); return hs.length })
    assert.ok(opened > 1, `the drawn step has rows to open (${opened})`)
    const skel = () => log.filter((e) => e.k === 'session'), anchor = () => log.filter((e) => e.k === 'lane' && e.q.get('lane') === main && (e.q.has('to') || e.q.has('ledger')))
    const ended = (xs, last) => xs.some((e) => e.doc && last(e.doc))
    assert.ok(await until(page, async () => ended(skel(), (d) => d.more === false) && ended(anchor().filter((e) => e.q.has('to')), (d) => d.prev === null), 20000),
      `both chains reached their ends (skeleton ${skel().length} pages, anchor lane ${anchor().length})`)
    await page.waitForTimeout(300)
    const S = skel(), A = anchor()
    assert.ok(S.length >= 6 && A.filter((e) => e.q.has('to')).length >= 5, `the session is long: ${S.length} skeleton pages, ${A.length} anchor lane chain reads`)
    // (1) at no moment more than 3 loader reads out
    const edges = log.flatMap((e) => [[e.start, 1], [e.end ?? Infinity, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
    let out = 0, most = 0
    for (const [, d] of edges) { out += d; most = Math.max(most, out) }
    assert.ok(most <= 3, `${most} loader reads were out at once`)
    // (2) on each chain the next read goes out ≤ 50 ms after the last one ended, or waits only while the loader is full (the reader's
    // reads go first): no poll beat in between
    const outAt = (t) => log.filter((e) => e.start <= t && (e.end ?? Infinity) > t).length
    for (const [name, xs] of [['skeleton', S], ['anchor lane', A]]) {
      const gaps = xs.slice(1).map((e, i) => e.start - xs[i].end)
      assert.ok(gaps.every((g, i) => g <= 50 || outAt(xs[i].end + 50) === 3), `${name} chain gaps (ms): ${gaps}`)
    }
    // (3) the whole history is in within the longer chain's back-to-back time
    const done = Math.max(...[...S, ...A].map((e) => e.end)), pages = Math.max(S.length, A.length)
    t.diagnostic(`history in ${done - painted} ms after the first paint; ${S.length} skeleton pages, ${A.length} anchor lane chain reads; ${most} reads out at most`)
    assert.ok(done - painted <= (pages + 2) * (L + 50), `history in ${done - painted} ms after the first paint (${pages} pages, bound ${(pages + 2) * (L + 50)} ms)`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('2.3 #30: a step named older than the held part lands directly within 1 s, no other step drawn; Home waits on the drawn step', { skip }, async (t) => {
  const w = longSession()
  const all = w.full(w.now, { limit: 0 }).calls, main = w.full().lanes.find((h) => h.kind === 'main').lane
  const mainRids = all.filter((r) => r.lane === main).map((r) => r.rid)
  // the newest main step at least 4 skeleton pages before the newest page
  const at = all.slice(0, all.length - 5 * SPAGE).findLast((r) => r.lane === main), k = mainRids.indexOf(at.rid) + 1
  assert.ok(k > 1, 'the world has a main step that far back')
  {
    const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w, { latency: 40 })
      await sampleSteps(page)
      const t0 = await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}`; return Date.now() }, k)
      assert.ok(await until(page, async () => (await steps(page)).length > 0), `step ${k} was drawn`)
      await page.waitForTimeout(300)
      const seen = await steps(page)
      assert.deepEqual(seen.map((x) => x.n), [k], 'the named step is the only step drawn')
      t.diagnostic(`step ${k} drawn ${seen[0].t - t0} ms after the navigation`)
      assert.ok(seen[0].t - t0 <= 1000, `step ${k} drawn ${seen[0].t - t0} ms after the navigation`)
      assert.match(await page.evaluate(() => location.hash), new RegExp(`[?&]step=${k}(&|$)`))
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
  {
    const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w, { latency: 150 })
      await page.evaluate(() => { location.hash = '#/replay/p/S' })
      await page.waitForSelector('#stepbar .sb-no')
      await sampleSteps(page)
      await page.keyboard.press('Home')
      assert.ok(await until(page, async () => (await steps(page)).some((x) => x.n === 1), 20000), 'Home landed on step 1')
      const seen = (await steps(page)).map((x) => x.n)
      assert.deepEqual(seen, [seen[0], 1], `until step 1 landed the step bar kept the drawn step: ${seen}`)
      assert.ok(seen[0] > 1)
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
})

test('2.3 #32: a rest of 100 ms reads the reply bodies of the anchor lane\'s ±8 held steps in one block read; stepping there draws them at once', { skip }, async () => {
  const w = world(5, { calls: 60, page: 100, spage: 100, talk: { pre: 3, len: 30, every: 6, tail: 4 } }), R = 8
  const main = w.full().lanes.find((h) => h.kind === 'main').lane
  // every main step's reply refs, from the lane's pages
  const replyRefs = new Map()
  for (let to, a; !a || a.prev != null; to = a.prev) {
    a = w.lane(main, { to })
    const ref = new Map(a.defs.map((d) => [d.bid, d.ref]))
    for (const st of a.steps) replyRefs.set(st.rid, st.reply.map((b) => ref.get(b)))
  }
  const failed = new Set(w.full(w.now, { limit: 0 }).calls.filter((c) => c.status !== 200).map((c) => c.rid)) // a failed call's reply shows no parts
  const rids = w.laneRidsAt().get(main), k = rids.length - 2 * R - 3 // 1-based, the 17 around it all held, away from the newest
  assert.ok(k - R >= 1, 'the main lane is long enough')
  const near = rids.slice(k - 1 - R, k + R), nearRefs = new Set(near.flatMap((rid) => replyRefs.get(rid)))
  assert.ok(nearRefs.size >= R, 'the steps around have replies')
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b
    const blocks = [] // every block read: when it went out, the refs it asked for
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/block') blocks.push({ t: Date.now(), refs: u.searchParams.getAll('ref') }) })
    await serveWorld(page, w, { latency: 200 })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    await page.waitForTimeout(800)
    const asked = new Set(blocks.flatMap((x) => x.refs)), t0 = Date.now()
    await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}` }, k)
    await page.waitForTimeout(600)
    // (1) exactly one block read, carrying every not-yet-read reply ref of the 17 steps
    const rest = blocks.filter((x) => x.t >= t0)
    assert.equal(rest.length, 1, `block reads after the rest on step ${k}: ${rest.length}`)
    const missing = [...nearRefs].filter((ref) => !asked.has(ref) && !rest[0].refs.includes(ref))
    assert.deepEqual(missing, [], 'the rest read carries the ±8 steps\' reply refs')
    // (2) each of the 17 steps, reached by ←/→ and rested on ≥ 150 ms, shows its open reply part with its bytes, no placeholder
    const t1 = Date.now()
    const at = async (n) => {
      assert.match(await page.textContent('#stepbar .sb-no'), new RegExp(`(^|\\D)${n}\\s*/`), `on step ${n}`)
      const reply = await page.evaluate(() => { const r = document.querySelector('#ctxwin .cwreply'); return r && { waiting: r.querySelectorAll('pre[data-ref]').length, text: r.textContent } })
      const refs = replyRefs.get(rids[n - 1])
      if (!refs.length || failed.has(rids[n - 1])) return
      assert.ok(reply, `step ${n}: the reply is drawn`)
      assert.equal(reply.waiting, 0, `step ${n}: the reply bodies are drawn, none waits`)
      assert.ok(refs.some((ref) => reply.text.includes(blockBytes(ref))), `step ${n}: a reply part shows its bytes`)
    }
    for (let n = k - 1; n >= k - R; n--) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150); await at(n) }
    for (let n = k - R + 1; n <= k + R; n++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150); await at(n) }
    // (3) no later block read asks for any of them again
    const again = blocks.filter((x) => x.t >= t1).flatMap((x) => x.refs).filter((ref) => nearRefs.has(ref))
    assert.deepEqual(again, [], 'no later block read carries the 17 steps\' reply refs')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
