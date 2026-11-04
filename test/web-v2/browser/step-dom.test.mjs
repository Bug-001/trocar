// test/web-v2/browser/step-dom.test.mjs — 2.3 #34 · D71②: a ±1 step on the mounted desk touches DOM in proportion to what changed
// and to the window's height, not to the list length. Over desk-long's generated long conversation (desk-world.mjs `talk`: main lane ~1,800 steps, the newest
// list 1,000–1,400 blocks), for 30 seeded adjacent pairs (→ and ←, and one with a turn card the reader opened) plus a
// step across a compaction (a generated world whose main lane compacts), a MutationObserver on #ctxwin (subtree, childList) counts the nodes added and removed from the key press
// until two animation frames after the step is drawn; Δ = the list positions whose key (bid#occurrence) differs between the two
// steps' lists, as the reference server hands them to the page. Every pair: count ≤ 4Δ + 64 on the legacy desk, 4Δ + 2B + 8 on the new
// one (B: the closed rows three box heights hold; a landing that moves the box swaps one band for another). Runs only under
// `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, DESK_NEXT, gapInPage, windowGap } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
// which desk a case is about (2.3 rule 4): the legacy desk's groups, or the new desk's virtual list
const legacyOnly = skip || (DESK_NEXT ? "the legacy desk's groups (2.3 rule 4, 旧台)" : false)
const nextOnly = skip || (DESK_NEXT ? false : "the new desk's virtual list (2.3 rule 4)")
const PAIRS = 30

const keysOf = (list) => { const seen = new Map(); return list.map((b) => { const n = seen.get(b) || 0; seen.set(b, n + 1); return `${b}#${n}` }) }
const delta = (a, b) => { const A = keysOf(a), B = keysOf(b); let d = 0; for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) d++; return d }
function rng(seed) { let a = seed >>> 0 || 1; return () => ((a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) + 0x9e3779b9 >>> 0) / 4294967296) }

const NO = /(\d+)\s*\/\s*(\d+)/
// the board serving world `w`, with: go(k) = the main lane's step k by name, drawn and settled; count(key) = the nodes added +
// removed under #ctxwin from the key press until two frames after the step head changed and the window drew
async function onBoard(w, fn) {
  const b = await withBoard({ bytes: 1e5, width: 1440, chromium: gate.chromium })
  try {
    const { page } = b
    await serveWorld(page, w)
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) }))
    const go = async (k) => {
      await page.evaluate((k) => { location.hash = `#/replay/p/S?step=${k}` }, k)
      await page.waitForFunction(([k, re]) => {
        const x = new RegExp(re).exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
        return !!x && +x[1] === k && !document.querySelector('#ctxwin .cwload')
      }, [k, NO.source], { timeout: 30000, polling: 'raf' })
      await page.waitForTimeout(400)
    }
    const count = async (key) => {
      const was = await page.evaluate((re) => new RegExp(re).exec(document.querySelector('#stepbar .sb-no')?.textContent || '')?.[1] ?? null, NO.source)
      await page.evaluate(() => {
        window.__mut = 0
        window.__mo = new MutationObserver((rs) => { for (const r of rs) window.__mut += r.addedNodes.length + r.removedNodes.length })
        window.__mo.observe(document.querySelector('#ctxwin'), { subtree: true, childList: true })
      })
      await page.keyboard.press(key)
      return page.evaluate(([was, re]) => new Promise((resolve, reject) => {
        const t0 = performance.now(), raf = () => new Promise((r) => requestAnimationFrame(r))
        const tick = async () => {
          const x = new RegExp(re).exec(document.querySelector('#stepbar .sb-no')?.textContent || '')
          if (x && x[1] !== was && !document.querySelector('#ctxwin .cwload')) {
            await raf(); await raf()
            for (const r of window.__mo.takeRecords()) window.__mut += r.addedNodes.length + r.removedNodes.length
            window.__mo.disconnect()
            return resolve({ n: window.__mut, from: +was, to: +x[1], h: document.querySelector('#ctxwin').clientHeight })
          }
          if (performance.now() - t0 > 10000) return reject(new Error(`step not drawn in 10 s after ${was}`))
          requestAnimationFrame(tick)
        }
        tick()
      }), [was, NO.source])
    }
    await fn({ page, go, count: async (key) => ({ ...(await count(key)), pitch: DESK_NEXT ? (await windowGap(page)).pitch : 0 }) })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
}
const mainRids = (w) => w.laneRidsAt().get(w.full().lanes.find((l) => l.kind === 'main').lane)

test('2.3 #34 · D71②: a ±1 step adds and removes at most 4Δ + 64 nodes in #ctxwin (new desk: 4Δ + 2B + 8)', { skip }, async () => {
  const out = []
  const check = async (label, w, rids, step) => {
    const { n, from, to, h, pitch } = await step()
    const d = delta(w.list(rids[from - 1]), w.list(rids[to - 1]))
    out.push({ label, from, to, n, d, line: 4 * d + (DESK_NEXT ? 2 * Math.ceil(3 * h / pitch) + 8 : 64) })
  }
  // the long conversation: 30 seeded pairs, then a folded turn card the reader opened and a step each way
  const w = world(7, { calls: 2100, page: 2100, talk: { pre: 90, len: 1200, every: 40, tail: 800 } }), rids = mainRids(w), M = rids.length
  const r = rng(34)
  await onBoard(w, async ({ page, go, count }) => {
    for (let j = 0; j < PAIRS; j++) {
      const k = 2 + Math.floor(r() * (M - 2)), key = r() < 0.5 ? 'ArrowLeft' : 'ArrowRight'
      await go(k); await check('long', w, rids, () => count(key))
    }
    await go(M - 5)
    await page.click('#ctxwin .cwturn.collapsed .cwturnhd')
    await page.waitForTimeout(300)
    await check('open card', w, rids, () => count('ArrowLeft'))
    await check('open card', w, rids, () => count('ArrowRight'))
  })
  // a compaction: the first main step whose list does not extend its predecessor's, entered by → and left by ←
  const c = [1, 2, 3, 4, 5, 6].map((seed) => world(seed, { calls: 300, page: 300 })).map((x) => [x, mainRids(x)])
    .map(([x, rs]) => [x, rs, rs.findIndex((rid, i) => i > 1 && x.list(rid).length < x.list(rs[i - 1]).length)]).find(([, , i]) => i > 0)
  assert.ok(c, 'a generated world compacts its main lane')
  const [cw, crids, ci] = c
  await onBoard(cw, async ({ go, count }) => {
    await go(ci)
    await check('compaction', cw, crids, () => count('ArrowRight'))
    await check('compaction', cw, crids, () => count('ArrowLeft'))
  })

  const worst = out.reduce((a, x) => (x.n - x.line > a.n - a.line ? x : a))
  console.log(`# ±1 step DOM over ${out.length} pairs (long main ${M} steps): worst ${worst.label} ${worst.from}→${worst.to}: ${worst.n} nodes, Δ=${worst.d}, line ${worst.line}`)
  for (const x of out) assert.ok(x.n <= x.line, `${x.label} ${x.from}→${x.to}: ${x.n} nodes added+removed, over the line ${x.line} (Δ=${x.d})`)
})

// 1.4 §打开一步时落在哪: what a landing brings to the box's top is what the reader sees there. elementFromPoint a little inside the
// landed item's top, for steps landing on their first 「新」 row in a window short enough for it to reach the box's top, is inside that
// item: nothing lies over it. (The newest reply after `f`: replay-shots.test.mjs. The generated worlds draw no change line.)
test('1.4: the landed item is what is on top at its own top edge', { skip: nextOnly }, async () => {
  const w = world(7, { calls: 2100, page: 2100, talk: { pre: 90, len: 1200, every: 40, tail: 800 } }), M = mainRids(w).length, r = rng(14), rows = []
  await onBoard(w, async ({ page, go }) => {
    await page.setViewportSize({ width: 1440, height: 520 })
    for (let j = 0; j < 12; j++) {
      await go(2 + Math.floor(r() * (M - 2)))
      const x = await page.evaluate(() => {
        const el = document.querySelector('#ctxwin'), t = el.querySelector('.cblk.is-new')
        if (!t) return null
        const a = t.getBoundingClientRect(), hit = document.elementFromPoint(a.left + 24, a.top + 8)
        return { at: Math.round(a.top - el.getBoundingClientRect().top), h: el.clientHeight, own: t.contains(hit), hit: hit?.className ?? null }
      })
      if (x) rows.push(x)
    }
  })
  console.log(`# landed rows at ${rows.map((x) => x.at)} px`)
  assert.ok(rows.some((x) => x.at <= 2), 'some step lands on a 「新」 row at the box top')
  // a row off the box has no pixel to hit: the case judges what the box shows
  for (const x of rows.filter((r) => r.at >= 0 && r.at + 8 < r.h)) assert.ok(x.own, JSON.stringify(x))
})

// 2.3 §窗口按 bid 打补丁 · rule 4: inside open cards only the groups within one window height above and below the visible box are
// rows; the rest are sized placeholders. Settled at the newest step (an 800-block open turn) and again after scrolling half way:
// no drawn group lies wholly outside that band unless it holds an open row or the change line, and no placeholder lies inside the
// visible box.
test('2.3 #34 · rule 4: inside open cards only the groups near the visible box are rows', { skip: legacyOnly }, async () => {
  const w = world(7, { calls: 2100, page: 2100, talk: { pre: 90, len: 1200, every: 40, tail: 800 } }), M = mainRids(w).length
  await onBoard(w, async ({ page, go }) => {
    const faults = () => page.evaluate(() => {
      const el = document.querySelector('#ctxwin'), box = el.getBoundingClientRect(), h = el.clientHeight, out = []
      for (const g of el.querySelectorAll('.cwgroup')) {
        const busy = g.hasAttribute('aria-busy'), a = (busy ? g : g.firstElementChild).getBoundingClientRect(), b = (busy ? g : g.lastElementChild).getBoundingClientRect()
        if (busy && b.bottom > box.top && a.top < box.bottom) out.push('a placeholder in view')
        if (!busy && (b.bottom < box.top - h - 1 || a.top > box.bottom + h + 1) && !g.querySelector('.cblk:not(.collapsed), #cachebrk')) out.push('a drawn group far from view')
      }
      return { out, groups: el.querySelectorAll('.cwgroup').length, rows: el.querySelectorAll('.cblk[data-bi]').length }
    })
    await go(M)
    const top = await faults()
    await page.evaluate(() => { const el = document.querySelector('#ctxwin'); el.scrollTop = el.scrollHeight / 2 })
    await page.waitForTimeout(400)
    const mid = await faults()
    console.log(`# newest step: ${top.groups} groups, ${top.rows} rows drawn; half way down: ${mid.rows} rows drawn`)
    assert.ok(top.groups > 4, 'the newest step has many groups (the shape this case is about)')
    assert.deepEqual(top.out, [])
    assert.deepEqual(mid.out, [])
  })
})

// 2.3 #28 · rule 4 (新台): the virtual list holds only the items within one window height above and below the visible box, and the
// pinned ones (the change line #cachebrk, the reply, the item holding focus, the item holding the selection); no aria-busy group; and
// the visible box has no gap (harness gapInPage). Settled at the newest step and half way down, and on the first animation frame after
// each of 20 ←/→ presses: a keydown capture listener arms one requestAnimationFrame, which runs after the step's synchronous commit and
// before its first paint.
test('2.3 #28: the rendered window holds only the items within one window height of the view, and the pinned ones; the visible box has no gap', { skip: nextOnly }, async () => {
  const w = world(7, { calls: 2100, page: 2100, talk: { pre: 90, len: 1200, every: 40, tail: 800 } }), M = mainRids(w).length
  await onBoard(w, async ({ page, go }) => {
    const faults = () => page.evaluate(() => {
      const el = document.querySelector('#ctxwin'), box = el.getBoundingClientRect(), h = el.clientHeight, out = []
      const sel = document.getSelection(), anchor = sel && sel.rangeCount ? sel.anchorNode : null
      const pinned = (it) => !!it.querySelector('#cachebrk, .cwreply') || it.matches('.cwreply') || it.contains(document.activeElement) || (!!anchor && it.contains(anchor))
      const items = [...el.querySelectorAll('.cwit')]
      for (const it of items) {
        const r = it.getBoundingClientRect()
        if ((r.bottom < box.top - h - 1 || r.top > box.bottom + h + 1) && !pinned(it)) out.push(`${it.dataset.key} (${it.firstElementChild?.className}) ${Math.round(r.top - box.top)} px from the box top, box ${h} px`)
      }
      if (el.querySelector('[aria-busy]')) out.push('an aria-busy group')
      return { out, items: items.length }
    })
    const atRest = async () => ({ ...(await faults()), ...(await windowGap(page)) })
    await go(M)
    const top = await atRest()
    await page.evaluate(() => { const el = document.querySelector('#ctxwin'); el.scrollTop = el.scrollHeight / 2 })
    await page.waitForTimeout(400)
    const mid = await atRest()
    // the first frame after each press
    await page.evaluate(`window.__gaps = []; addEventListener('keydown', () => requestAnimationFrame(() => window.__gaps.push((${gapInPage})())), true)`)
    const no = () => page.evaluate(() => document.querySelector('#stepbar .sb-no')?.textContent)
    for (const key of [...Array(10).fill('ArrowLeft'), ...Array(10).fill('ArrowRight')]) {
      const was = await no()
      await page.keyboard.press(key)
      await page.waitForFunction((was) => document.querySelector('#stepbar .sb-no')?.textContent !== was, was, { timeout: 10000, polling: 'raf' })
      await page.waitForTimeout(100)
    }
    const first = await page.evaluate(() => window.__gaps)
    console.log(`# newest step: ${top.items} items, gap ${top.gap} px; half way: ${mid.items} items, gap ${mid.gap} px; first frames: worst gap ${Math.max(...first.map((g) => g.gap))} px (pitch ${top.pitch} px)`)
    assert.ok(top.pitch > 0, 'one --cblk-pitch measures a height')
    assert.deepEqual(top.out, [])
    assert.deepEqual(mid.out, [])
    assert.ok(top.gap <= top.pitch && mid.gap <= mid.pitch, `a gap in the visible box at rest: ${top.gap} / ${mid.gap} px, pitch ${top.pitch}`)
    assert.equal(first.length, 20, 'one record per press')
    assert.deepEqual(first.filter((g) => !(g.gap <= g.pitch)), [], 'a gap in the visible box on the first frame after a step')
  })
})
