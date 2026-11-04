// test/web-v2/browser/desk-load.test.mjs — 2.3 #29, #30 and #32 on the mounted desk, in the real Chrome, the answer files served from a
// generated long session (desk-world.mjs, 3.5 §会话读's reference server) in ≥ 6 sealed packs, every answer waiting L ms: the loader
// keeps ≤ 3 reads out (rows the reader opens meanwhile included), sends the next pack read as soon as one ends, asks for the packs in
// 2.3 加载器's order, has every pack in hand within its back-to-back time and reads no held pack again (#29); a named step in another
// pack is that pack's first read and lands directly, no step in between ever drawn (#30). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, blockBytes, stampFetches } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { packOrder } from '../../../web/legacy/replay/follow.mjs'
import { INTERVAL } from '../../../web/legacy/core/poll.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const P = 8 // members a pack: the long session is 20 sealed packs
const longSession = () => world(5, { calls: 160, page: 16, talk: { pre: 3, len: 60, every: 6, tail: 4 } })

// the step numbers #stepbar .sb-no shows, sampled every frame from now on: window.__steps = [{n, t}] on each change, t on stampFetches'
// clock (performance.timeOrigin + performance.now(), ms epoch), so it and the fetch stamps subtract cleanly
const sampleSteps = (page) => page.evaluate(() => {
  window.__steps = []
  let last = null
  const tick = () => {
    const x = /(\d+)\s*\/\s*\d+/.exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
    const n = x ? +x[1] : null
    if (n !== last) { last = n; if (n != null) window.__steps.push({ n, t: performance.timeOrigin + performance.now() }) }
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

test('2.3 #29: the loader keeps ≤ 3 reads out, reads the packs back to back in its order, has them all within their back-to-back time, reads none again', { skip }, async (t) => {
  const L = 150, w = longSession(), head = w.files(w.now, P).head
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium, setup: stampFetches })
  try {
    const { page } = b
    // every loader read (a pack file, lane, block) with when the page started it and when its body was in (ms epoch, the page's clock)
    const kind = (u) => (/^\/api\/d\/p\d/.test(u) ? 'pack' : /^\/api\/(lane|block)\?/.test(u) ? 'loader' : null)
    const loaderReads = async () => (await page.evaluate(() => globalThis.__fetches)).map((e) => ({ ...e, k: kind(e.url), path: e.url.split('?')[0] })).filter((e) => e.k).sort((x, y) => x.t0 - y.t0)
    await serveWorld(page, w, { latency: L, pack: P })
    await sampleSteps(page)
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    assert.ok(await until(page, async () => (await steps(page)).length > 0), 'the desk drew a step')
    const painted = (await steps(page))[0].t
    // the reader opens rows while the packs come: their bodies' reads go through the same loader (≤ 3 out still holds)
    const opened = await page.evaluate(() => { const hs = [...document.querySelectorAll('#ctxwin .cblk.collapsed:not(.removed):not([data-rp]) > .cbh')].slice(0, 4); for (const h of hs) h.click(); return hs.length })
    assert.ok(opened > 1, `the drawn step has rows to open (${opened})`)
    const files = 2 * head.packs.length, packs = async () => (await loaderReads()).filter((e) => e.k === 'pack')
    assert.ok(head.packs.length >= 6, `the session is long: ${head.packs.length} sealed packs`)
    assert.ok(await until(page, async () => new Set((await packs()).filter((e) => e.t1 != null).map((e) => e.path)).size === files, 20000), `every pack file came (${(await packs()).length} of ${files})`)
    const done = Math.max(...(await packs()).map((e) => e.t1))
    // (5) a poll round later no held pack is read again
    await page.waitForTimeout(2 * INTERVAL.session + 300)
    const log = await loaderReads(), P_ = log.filter((e) => e.k === 'pack')
    assert.equal(P_.length, files, 'no pack read twice')
    // (1) at no moment more than 3 loader reads out
    const edges = log.flatMap((e) => [[e.t0, 1], [e.t1 ?? Infinity, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
    let out = 0, most = 0
    for (const [, d] of edges) { out += d; most = Math.max(most, out) }
    assert.ok(most <= 3, `${most} loader reads were out at once`)
    // (2) each pack read but the first three goes out ≤ 50 ms after another loader read's body was in, or waits only while the loader is full: no poll beat
    const outAt = (x) => log.filter((e) => e.t0 <= x && (e.t1 ?? Infinity) > x).length
    const late = P_.slice(3).filter((e) => !log.some((o) => o.t1 != null && o.t1 <= e.t0 && e.t0 - o.t1 <= 50) && outAt(e.t0 - 51) < 3)
    assert.deepEqual(late.map((e) => e.path), [], 'pack reads that waited with the loader not full')
    // (3) the packs in 2.3 加载器's order for a desk that follows (main before rest of each)
    const firsts = [...new Set(P_.map((e) => +/p(\d+)/.exec(e.path)[1]))]
    assert.deepEqual(firsts, packOrder(head, null).map((x) => x.n), 'pack order')
    // (4) every pack file in hand within the files' back-to-back time
    t.diagnostic(`packs in ${done - painted} ms after the first paint; ${files} files; ${most} reads out at most`)
    assert.ok(done - painted <= (files / 3 + 2) * (L + 50), `packs in ${done - painted} ms after the first paint (${files} files, bound ${(files / 3 + 2) * (L + 50)} ms)`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('2.3 #30: a step named in another pack is that pack\'s first read and lands directly within 1 s, no other step drawn; Home waits on the drawn step', { skip }, async (t) => {
  const w = longSession(), head = w.files(w.now, P).head
  // a main step in a pack well before the newest: the middle of the third sealed pack
  const pk = head.packs[2], k = Math.floor((pk.s0 + pk.s1) / 2) + 1
  assert.ok(pk.s1 > pk.s0 && head.packs.length > 4, 'the world has a main step that far back')
  {
    const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
    try {
      const { page } = b
      const pr = [] // the pack reads in the order they went out
      page.on('request', (r) => { const u = new URL(r.url()); if (/^\/api\/d\/p\d/.test(u.pathname)) pr.push(u.pathname) })
      await serveWorld(page, w, { latency: 40, pack: P })
      await sampleSteps(page)
      const t0 = await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}`; return performance.timeOrigin + performance.now() }, k)
      assert.ok(await until(page, async () => (await steps(page)).length > 0), `step ${k} was drawn`)
      await page.waitForTimeout(300)
      const seen = await steps(page)
      assert.deepEqual(seen.map((x) => x.n), [k], 'the named step is the only step drawn')
      t.diagnostic(`step ${k} drawn ${seen[0].t - t0} ms after the navigation`)
      assert.ok(seen[0].t - t0 <= 1000, `step ${k} drawn ${seen[0].t - t0} ms after the navigation`)
      assert.match(await page.evaluate(() => location.hash), new RegExp(`[?&]step=${k}(&|$)`))
      assert.equal(pr[0], `/api/d/p${pk.n}.main`, 'the first pack read is the one holding the named step')
      assert.deepEqual(b.errors, [])
    } finally { await b.stop() }
  }
  {
    const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
    try {
      const { page } = b
      await serveWorld(page, w, { latency: 150, pack: P })
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
  const w = world(5, { calls: 60, page: 100, talk: { pre: 3, len: 30, every: 6, tail: 4 } }), R = 8
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
