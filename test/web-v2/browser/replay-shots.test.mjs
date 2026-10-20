// test/web-v2/browser/replay-shots.test.mjs — the replay desk's layout at 1280 and 1024 × light / dark on the real face (1.2 §会话头
// 让位次序, §回放台 B 布局 上下文窗的高度, §窄屏): no head or step-bar part clipped, every ellipsis carries a title, #ctxwin holds at
// least half the available height at 900 px, the document never scrolls sideways, and the raw panel reaches the right page's
// bottom. Shots: the replay, the bottom sheet open at 1024, the cost view. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6

// the session with the most calls: the busiest step head and window the face has
async function openBusiest(b) {
  const rows = (await b.get('sessions')).doc.sessions
  const r = [...rows].sort((x, y) => (y.calls || 0) - (x.calls || 0))[0]
  await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(r.project_slug)}/${encodeURIComponent(r.session_id)}`)
  await b.page.waitForFunction(() => !!document.querySelector('#stepbar .sb-no') && !!document.querySelector('#ctxwin') && !document.querySelector('#ctxwin .cwload'), null, { timeout: 15000 })
  await b.page.waitForLoadState('networkidle')
}

// every measured fact in one page pass
const layout = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const kids = (sel) => [...document.querySelectorAll(`${sel} > *, ${sel} > * > *`)].filter((e) => e.getClientRects().length)
  const clipped = [...kids('#deskhead'), ...kids('#stepbar')].filter((e) => e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).display !== 'inline')
    .map((e) => `${e.tagName}.${e.className} ${e.scrollWidth}>${e.clientWidth}`)
  const untitled = [...document.querySelectorAll('#content *')].filter((e) => e.getClientRects().length && getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 0.5 && !e.closest('[title]'))
    .map((e) => `${e.tagName}.${e.className}: ${e.textContent.slice(0, 40)}`)
  const h = (s) => { const e = q(s); return e && e.getClientRects().length ? e.getBoundingClientRect().height : 0 }
  const rp = q('#rightpage'), raw = q('#rawpanel')
  return {
    clipped, untitled,
    ctxwin: h('#ctxwin'),
    avail: innerHeight - h('#deskhead') - h('#rpbar'), // the head + its fidelity row; the bottom row only where it is drawn
    hscroll: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    rawGap: raw && raw.getClientRects().length && rp.getClientRects().length ? rp.getBoundingClientRect().bottom - raw.getBoundingClientRect().bottom : null,
  }
})

for (const width of [1280, 1024, 800]) {
  for (const theme of ['light', 'dark']) {
    test(`the replay desk fits at ${width} in ${theme}: nothing clipped, the window holds half the height, no side scroll`, { skip }, async () => {
      const b = await withBoard({ bytes: BYTES, width, theme, chromium: gate.chromium })
      try {
        await openBusiest(b)
        const L = await layout(b.page)
        const bad = [ // every finding at once: one run shows the whole picture
          ...L.clipped.map((x) => `clipped (M6): ${x}`),
          ...L.untitled.map((x) => `ellipsis without a title: ${x}`),
          ...(L.ctxwin >= 0.5 * L.avail ? [] : [`#ctxwin ${L.ctxwin}px < half of the available ${L.avail}px`]),
          ...(L.hscroll ? ['the document scrolls sideways'] : []),
          ...(L.rawGap == null || L.rawGap <= 8 ? [] : [`the raw panel stops ${L.rawGap}px above the right page's bottom`]),
        ]
        await shoot(b.page, 'replay-desk', { width, theme })
        if (width < 1200) { // the right page is the bottom row here: open it
          await b.page.click('#rpbar')
          await b.page.waitForSelector('#rightpage.open #rawpanel .rphd')
          const S = await layout(b.page)
          assert.equal(S.hscroll, false, 'the open sheet scrolls the document sideways')
          await shoot(b.page, 'replay-sheet', { width, theme })
          await b.page.click('#rpbar')
        }
        await b.page.click('#viewswitch [data-view="cost"]')
        await b.page.waitForSelector('#viewswitch [data-view="cost"][aria-pressed="true"]')
        assert.equal((await layout(b.page)).hscroll, false, 'the cost view scrolls the document sideways')
        await shoot(b.page, 'replay-cost', { width, theme })
        assert.deepEqual(b.errors, [])
        assert.deepEqual(bad, [])
      } finally { await b.stop() }
    })
  }
}
