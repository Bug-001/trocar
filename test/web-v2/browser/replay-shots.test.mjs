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

// the session with the most calls: the busiest step head and window the face has (`fewest`: the one with the fewest calls)
async function openBusiest(b, fewest = false) {
  const rows = (await b.get('sessions')).doc.sessions.filter((x) => x.calls > 0)
  const r = [...rows].sort((x, y) => fewest ? x.calls - y.calls : (y.calls || 0) - (x.calls || 0))[0]
  await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(r.project_slug)}/${encodeURIComponent(r.session_id)}`)
  await b.page.waitForFunction(() => !!document.querySelector('#stepbar .sb-no') && !!document.querySelector('#ctxwin') && !document.querySelector('#ctxwin .cwload'), null, { timeout: 15000 })
  await b.page.waitForLoadState('networkidle')
}

// every measured fact in one page pass
const layout = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const kids = (sel) => [...document.querySelectorAll(`${sel} > *, ${sel} > * > *`)].filter((e) => e.getClientRects().length)
  // an ellipsis with its full text on hover is the designed give-way (1.2 §让位次序, 2.2 §步头放不下: the model name first), not a clip
  const clipped = [...kids('#deskhead'), ...kids('#stepbar')].filter((e) => e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).display !== 'inline' && !(getComputedStyle(e).textOverflow === 'ellipsis' && e.closest('[title]')))
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

// 1.2 §上下文窗的高度 at the short 1280 × 800 viewport (the audit's): the step bar stays one row (2.2 §步头放不下: at 1280 the
// model name shrinks, nothing wraps) and #ctxwin keeps half the available height. 1.3 §窗内步少时收窄: in the session with the
// fewest steps every detail lane is at most (bars in the window) × the bar cap wide; the whole-session strip keeps the full width.
test('at 1280 × 800 the step bar is one row, the window holds half the height, and a few-step session narrows its lanes', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, height: 800, chromium: gate.chromium })
  try {
    await openBusiest(b)
    const L = await layout(b.page)
    // one row: every drawn part's middle lies inside the arrows' box (center-aligned parts of different heights share a row)
    const off = await b.page.evaluate(() => {
      const nav = document.querySelector('#stepbar .sb-nav').getBoundingClientRect()
      return [...document.querySelectorAll('#stepbar > *')].filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => [e.className, e.getBoundingClientRect()]).filter(([, r]) => (r.top + r.bottom) / 2 < nav.top || (r.top + r.bottom) / 2 > nav.bottom).map(([c]) => c)
    })
    assert.deepEqual(off, [], 'the step bar wraps at 1280')
    assert.ok(L.ctxwin >= 0.5 * L.avail, `#ctxwin ${L.ctxwin}px < half of the available ${L.avail}px`)
    await openBusiest(b, true)
    const lanes = await b.page.evaluate(() => {
      const page = document.querySelector('#leftpage'), cs = getComputedStyle(document.querySelector('#saw'))
      const cap = parseFloat(cs.getPropertyValue('--barcap')), n = +getComputedStyle(page).getPropertyValue('--nbars')
      const w = (e) => e.getBoundingClientRect().width
      return { cap, n, detail: [...document.querySelectorAll('#saw .tkrow:not(.tkrow-ovw) > .tlane, #rails .tlane')].filter((e) => e.getClientRects().length).map(w),
        whole: w(document.querySelector('#saw .tkrow-ovw > .tlane')) }
    })
    assert.ok(lanes.n > 0 && lanes.cap > 0 && lanes.detail.length, JSON.stringify(lanes))
    for (const x of lanes.detail) assert.ok(x <= lanes.n * lanes.cap + 0.5, `a detail lane ${x}px > ${lanes.n} × ${lanes.cap}px`)
    assert.ok(lanes.whole > lanes.n * lanes.cap, 'the whole-session strip narrowed with the window')
    await shoot(b.page, 'replay-fewsteps', { width: 1280, theme: 'light' })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 1.4 §打开一步时落在哪: turning 跟随最新 on from a few steps back, with every body already on the page, lands the window on the
// newest reply ⑨ — the landing runs inside the repaint of the move, so the reason for the move must be known before it.
test('turning follow latest on from an earlier step lands the window on the newest reply', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, height: 800, chromium: gate.chromium })
  try {
    await openBusiest(b)
    await b.page.setViewportSize({ width: 1280, height: 520 }) // a short window: the reply and the step's first new block are not on one screen
    for (let k = 0; k < 4; k++) await b.page.click('#stepbar [data-step="prev"]')
    await b.page.waitForFunction(() => !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#ctxwin .cwreply'))
    await b.page.click('#ctxwin') // the keys go to the page, not to a control
    await b.page.keyboard.press('f')
    await b.page.waitForFunction(() => /Step (\d+) \/ \1\b/.test(document.querySelector('#stepbar .sb-no').textContent))
    const at = await b.page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => {
      const w = document.querySelector('#ctxwin'), r = document.querySelector('#ctxwin .cwreply').getBoundingClientRect(), wr = w.getBoundingClientRect()
      const sb = document.querySelector('#stepbar'), top = wr.top + (sb && w.contains(sb) ? sb.getBoundingClientRect().height : 0)
      ok({ reply: r.top, top, bottom: wr.bottom, atEnd: w.scrollTop >= w.scrollHeight - w.clientHeight - 1 })
    })))
    // at the top of the window, or the window scrolled as far as it goes with the reply in view
    assert.ok(at.reply >= at.top - 2 && at.reply < at.bottom && (at.reply <= at.top + 2 || at.atEnd), JSON.stringify(at))
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.3 §未下发态: the load control is unclickable only while its read has not answered — a failed read is an answer. Step 1's body is
// taken off the page (paged_out, the server's own flag), the reader loads it, and that read fails.
test('a failed read of "Load this step" leaves the button usable, never busy', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, chromium: gate.chromium })
  try {
    let fail = false
    const pageOut = (o) => { if (Array.isArray(o)) o.forEach(pageOut); else if (o && typeof o === 'object') { if (o.gi === 0 && 'ts' in o) o.paged_out = true; Object.values(o).forEach(pageOut) } }
    await b.page.route((u) => new URL(u).pathname === '/api/session', async (r) => {
      if (fail) return r.abort()
      const res = await r.fetch(); const j = await res.json(); pageOut(j); await r.fulfill({ response: res, json: j })
    })
    await openBusiest(b)
    await b.page.click('#ctxwin'); await b.page.keyboard.press('Home')
    const btn = '#ctxwin .pobtn'
    await b.page.waitForSelector(`${btn}:not([disabled])`)
    fail = true
    await b.page.click(btn)
    await b.page.waitForSelector(`${btn}[aria-busy="true"]`) // the read is out
    await b.page.waitForFunction((sel) => { const e = document.querySelector(sel); return e && !e.disabled && e.getAttribute('aria-busy') !== 'true' }, btn, { timeout: 10000 })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

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
