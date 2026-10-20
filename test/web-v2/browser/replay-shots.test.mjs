// test/web-v2/browser/replay-shots.test.mjs — the replay desk's layout at 1280 and 1024 × light / dark on the real face (1.2 §会话头
// 让位次序, §回放台 B 布局 上下文窗的高度, §窄屏): no head or step-bar part clipped, every ellipsis carries a title, #ctxwin holds at
// least half the available height at 900 px, the document never scrolls sideways, and the raw panel reaches the right page's
// bottom. Shots: the replay, the bottom sheet open at 1024, the cost view. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot, layoutFaults } from './harness.mjs'

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
        const F = await layoutFaults(b.page) // the side panel's rows included: a resource's life text wraps, never cut (1.5)
        const bad = [
          ...F.overlap.map((x) => `drawn on one another: ${x}`), ...F.cut.map((x) => `cut off: ${x}`), ...F.untitled.map((x) => `ellipsis without a title: ${x}`), ...F.emptyIcons.map((x) => `empty icon: ${x}`), // every finding at once: one run shows the whole picture
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

// 2.4 · 1.5: a 「Files read」 row with a long path and a long life sentence (read at step N · removed by compaction at step M — the main
// Mac's shape) shows the whole sentence, wrapped under the name, and the name truncated with its full text on hover. The real answer,
// with the anchor lane's ledger given such files.
test('Files read: a long path and a long life sentence are never cut — the life wraps, the name has its full text on hover', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    await b.page.route((u) => new URL(u).pathname === '/api/session', async (r) => {
      const res = await r.fetch(), j = await res.json()
      for (const l of (j.analyzed && j.analyzed.lanes) || []) {
        const gis = (l.calls || []).map((c) => c && c.gi).filter((g) => g != null)
        if (gis.length < 3) continue
        l.resources = Array.from({ length: 6 }, (_, i) => ({ kind: 'file', label: `/private/tmp/a/rather/long/working/directory/for/the/project/src/web/module-${i}/server-side-file-${i}.mjs`, segments: [{ enter: gis[0], evict: gis[gis.length - 2] }] }))
      }
      await r.fulfill({ response: res, json: j })
    })
    await openBusiest(b)
    await b.page.waitForSelector('.navsub.dead .navlife', { timeout: 15000 })
    const F = await layoutFaults(b.page)
    assert.deepEqual({ overlap: F.overlap, cut: F.cut, untitled: F.untitled }, { overlap: [], cut: [], untitled: [] })
    await shoot(b.page, 'replay-files-read', { width: 1440, theme: 'light' })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.4 · 1.5: the System prompt row of a block that changes every call (Claude Code's billing header) carries a pill longer than the
// left panel is wide; it wraps inside its row and is never drawn past the panel's edge. The real answers, with such a block at the head of every step.
test('System prompt: the "changes every call" pill stays inside the left panel', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    // a billing-header block as src/view/analyze.mjs flattens it, put at the head of every shipped step's system prompt
    const bill = (k) => ({ sec: 'system', kind: 'system', role: 'system', label: 'billing header', text: 'x-anthropic-billing-header: cch=0', chars: 33, volatile: true, cc: null, key: `S:bill-${k}` })
    const mark = (o) => { if (Array.isArray(o)) o.forEach(mark); else if (o && typeof o === 'object') { if (Array.isArray(o.flat) && o.flat.length) o.flat.unshift(bill(o.flat.length)); Object.values(o).forEach(mark) } }
    await b.page.route((u) => new URL(u).pathname.startsWith('/api/'), async (r) => {
      const res = await r.fetch()
      if (!/json/.test(res.headers()['content-type'] || '')) return r.fulfill({ response: res })
      const j = await res.json(); mark(j)
      await r.fulfill({ response: res, json: j })
    })
    await openBusiest(b)
    await b.page.waitForSelector('.navsub .volbadge', { timeout: 15000 })
    const past = await b.page.evaluate(() => [...document.querySelectorAll('.navsub .volbadge')].filter((e) => e.getClientRects().length).map((e) => {
      const r = e.getBoundingClientRect(), row = e.closest('.navsub').getBoundingClientRect()
      return r.right > row.right + 0.5 || r.left < row.left - 0.5 ? `${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(row.left)}–${Math.round(row.right)}` : null
    }).filter(Boolean))
    assert.deepEqual(past, [])
    const F = await layoutFaults(b.page)
    assert.deepEqual({ overlap: F.overlap, cut: F.cut, untitled: F.untitled }, { overlap: [], cut: [], untitled: [] })
    await shoot(b.page, 'replay-volatile-pill', { width: 1440, theme: 'light' })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
