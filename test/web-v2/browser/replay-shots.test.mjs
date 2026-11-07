// test/web-v2/browser/replay-shots.test.mjs — the replay desk's layout at 1440 / 1280 / 1024 / 800 × light / dark on the real face
// (1.2 §会话头让位次序, §回放台 B 布局 上下文窗的高度, §窄屏): no head or step-bar part clipped, every ellipsis carries a title,
// the window holds at least half the available height, the document never scrolls sideways, and the narrow table holds at
// every width. Shots: the replay, the cost view, a few-step session, Files read, a failed first read, the narrow layout and
// the bottom sheet. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot, layoutFaults } from './harness.mjs'
import { typeFaults } from './type-inventory.mjs'
import { CACHE_POPOVER_LABEL } from '../../../web/legacy/labels/replay.mjs'
import { CT_ORDER } from '../../../web/legacy/replay/analysis.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6

// open session row `r` and wait for its step bar and window
async function openSession(b, r) {
  await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(r.project_slug)}/${encodeURIComponent(r.session_id)}`)
  await b.page.waitForFunction((id) => location.hash.includes(encodeURIComponent(id)) && !!document.querySelector('#stepbar .sb-no') && !!document.querySelector('#ctxwin') && !document.querySelector('#ctxwin .cwload'), r.session_id, { timeout: 15000 })
  await b.page.waitForLoadState('networkidle')
}
// the sessions with calls, most calls first
const byCalls = async (b) => (await b.get('sessions')).doc.sessions.filter((x) => x.calls > 0).sort((x, y) => (y.calls || 0) - (x.calls || 0))
// the session with the most calls: the busiest step head and window the face has (`fewest`: the one with the fewest calls)
async function openBusiest(b, fewest = false) {
  const rows = await byCalls(b)
  await openSession(b, fewest ? rows.at(-1) : rows[0])
}

// a session row's main lane key (the anchor lane: 3.5 §会话读 车道头 `kind`)
const mainOf = async (b, r) => (await b.get('session', { id: r.session_id })).doc.lanes.find((l) => l.kind === 'main')?.lane
// a JSON answer of `path` passed through `edit(doc, params)` (a 304 or a non-JSON answer goes through as it is)
const editAnswers = (b, path, edit) => b.page.route((u) => new URL(u).pathname === path, async (r) => {
  const res = await r.fetch()
  if (res.status() !== 200 || !/json/.test(res.headers()['content-type'] || '')) return r.fulfill({ response: res })
  const j = await res.json(); edit(j, new URL(r.request().url()).searchParams)
  await r.fulfill({ response: res, json: j })
})

// the desk's pack and tail files (4.4 §答案文件) passed line by line through `edit(line)`; a tail is asked whole (its Range dropped):
// the edited bytes are not the server's, so no offset into them is ever asked
const editFiles = (b, edit) => b.page.route((u) => /^\/api\/d\/(p\d+|open)\./.test(new URL(u).pathname), async (r) => {
  const { range, ...headers } = r.request().headers()
  const res = await r.fetch({ headers })
  if (res.status() !== 200) return r.fulfill({ response: res })
  const lines = (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  for (const line of lines) edit(line)
  await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l) + '\n').join('') })
})

// every step's composition carries every content type at an equal share (1.3 §排布: the gutter lists each, two-digit shares, the
// most it can ever be asked to hold); the rows are the `c` lines of the pack and tail files
const everyType = (b) => editFiles(b, (line) => { if (line.c && line.c.comp) for (const k of CT_ORDER) line.c.comp[k] = 1 })

// every measured fact in one page pass
const layout = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const kids = (sel) => [...document.querySelectorAll(`${sel} *`)].filter((e) => e.getClientRects().length && !e.closest('.pop'))
  // an ellipsis with its full text on hover is the designed give-way (1.2 §让位次序, 2.2 §步头放不下: the model name first), not a clip
  const clipped = [...kids('#deskhead'), ...kids('#stepbar')].filter((e) => e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).display !== 'inline' && !(getComputedStyle(e).textOverflow === 'ellipsis' && e.closest('[title]')))
    .map((e) => `${e.tagName}.${e.className} ${e.scrollWidth}>${e.clientWidth}`)
  const untitled = [...document.querySelectorAll('#content *')].filter((e) => e.getClientRects().length && getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 0.5 && !e.closest('[title]'))
    .map((e) => `${e.tagName}.${e.className}: ${e.textContent.slice(0, 40)}`)
  const h = (s) => { const e = q(s); return e && e.getClientRects().length ? e.getBoundingClientRect().height : 0 }
  return {
    clipped, untitled,
    ctxwin: h('#ctxwin'),
    avail: innerHeight - h('#deskhead') - h('.deskside.bottom'), // the head + its fidelity row; the bottom row only where it is drawn
    hscroll: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
  }
})

for (const width of [1440, 1280, 1024, 800]) {
  for (const theme of ['light', 'dark']) {
    test(`the replay desk fits at ${width} in ${theme}: nothing clipped, the window holds half the height, no side scroll`, { skip }, async () => {
      const b = await withBoard({ bytes: BYTES, width, theme, chromium: gate.chromium })
      try {
        await everyType(b)
        await openBusiest(b)
        const L = await layout(b.page)
        const F = await layoutFaults(b.page) // the side panel's rows included: a resource's life text wraps, never cut (1.5)
        const bad = [
          ...F.overlap.map((x) => `drawn on one another: ${x}`), ...F.cut.map((x) => `cut off: ${x}`), ...F.untitled.map((x) => `ellipsis without a title: ${x}`), ...F.emptyIcons.map((x) => `empty icon: ${x}`), // every finding at once: one run shows the whole picture
          ...L.clipped.map((x) => `clipped (M6): ${x}`),
          ...L.untitled.map((x) => `ellipsis without a title: ${x}`),
          ...(L.ctxwin >= 0.5 * L.avail ? [] : [`#ctxwin ${L.ctxwin}px < half of the available ${L.avail}px`]),
          ...(L.hscroll ? ['the document scrolls sideways'] : []),
        ]
        await shoot(b.page, 'replay-desk', { width, theme })
        if (width === 1280 && theme === 'light') { // 1.5 #16 on the desk: a block row opened, then the cache popover, then the session info
          const { page } = b
          await page.locator('#ctxwin .cblk.collapsed[data-bi] > .cbh').first().click()
          await page.waitForSelector('#ctxwin .cblk[data-bi]:not(.collapsed) > .cbc')
          const type = []
          for (const btn of [`#stepbar .popbtn[aria-label="${CACHE_POPOVER_LABEL}"]`, '#deskhead .sh-info .popbtn']) {
            await page.click(btn)
            await page.waitForSelector(`${btn}[aria-expanded="true"]`)
            type.push(...(await typeFaults(page)).faults)
          }
          await page.keyboard.press('Escape')
          assert.deepEqual(type, [], 'replay: type')
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

// 1.2 §上下文窗的高度 at a short 1280 × 800 viewport, every step carrying every content type: the step bar stays one row
// (2.2 §步头放不下: at 1280 the model name shrinks, nothing wraps) and #ctxwin keeps half the available height. 1.3 §窗内步少时收窄: in the session with the
// fewest steps every detail lane is at most (bars in the window) × the bar cap wide; the whole-session strip keeps the full width.
test('at 1280 × 800 the step bar is one row, the window holds half the height, and a few-step session narrows its lanes', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, height: 800, chromium: gate.chromium })
  try {
    await everyType(b)
    await openBusiest(b)
    const L = await layout(b.page)
    // 1.3 §排布: a step with every content type keeps the main track's row; no gutter glyph is cut (the desk lists each share)
    // every type is accounted for: the shares drawn plus the "+N more" line's N (1.3 §排布)
    const g = await b.page.evaluate(() => {
      const vis = (e) => !e.hidden && e.getClientRects().length > 0, more = document.querySelector('#sawgut .gmore')
      return { drawn: [...document.querySelectorAll('#sawgut .gshare')].filter(vis).length, all: document.querySelectorAll('#sawgut .gshare').length, more: more && vis(more) ? Number(more.dataset.n) : 0 }
    })
    assert.ok(g.all === 0 || g.all === CT_ORDER.length, `${g.all} shares in the gutter`)
    assert.equal(g.drawn + g.more, g.all, `${g.drawn} drawn + ${g.more} more`)
    assert.deepEqual((await layoutFaults(b.page, '#saw')).cut, [])
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
      const cs = getComputedStyle(document.querySelector('#saw'))
      const cap = parseFloat(cs.getPropertyValue('--barcap')), n = +cs.getPropertyValue('--nbars')
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
    await b.page.waitForFunction(() => /(\d+) \/ \1\b/.test(document.querySelector('#stepbar .sb-no').textContent))
    const at = await b.page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => {
      const w = document.querySelector('#ctxwin'), r = document.querySelector('#ctxwin .cwreply').getBoundingClientRect(), wr = w.getBoundingClientRect()
      const sb = document.querySelector('#stepbar'), top = wr.top + (sb && w.contains(sb) ? sb.getBoundingClientRect().height : 0)
      ok({ reply: r.top, top, bottom: wr.bottom, atEnd: w.scrollTop >= w.scrollHeight - w.clientHeight - 1, own: !!document.elementFromPoint(r.left + 24, r.top + 8)?.closest('.cwreply') })
    })))
    // at the top of the window, or the window scrolled as far as it goes with the reply in view
    assert.ok(at.reply >= at.top - 2 && at.reply < at.bottom && (at.reply <= at.top + 2 || at.atEnd) && at.own, JSON.stringify(at))
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.3 §这一步的回复 (acceptance #13, browser): a reply row has the request row's frame — the head's font, size and side padding are the
// last request row's — and its head is reached by Tab and flipped by Enter, like a request row's.
test('a reply row has the request row\'s head frame and opens by keyboard', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    await openBusiest(b) // the last step; back to the latest one whose reply has parts (a demo step may carry only a stop reason)
    const head = '#ctxwin .cwreply .cblk > .cbh'
    const no = () => b.page.$eval('#stepbar .sb-no', (e) => e.textContent)
    while (!(await b.page.$(head))) {
      const was = await no()
      assert.doesNotMatch(was, /^Step 1 \//, 'no step of the busiest session has a reply row')
      await b.page.click('#stepbar [data-step="prev"]')
      await b.page.waitForFunction((w) => document.querySelector('#stepbar .sb-no').textContent !== w && !document.querySelector('#ctxwin .cwload') && !!document.querySelector('#ctxwin .cwreply'), was)
    }
    const frame = (sel, i) => b.page.$$eval(sel, (hs, i) => { const s = getComputedStyle(hs.at(i)); return [s.fontFamily, s.fontSize, s.paddingLeft, s.paddingRight] }, i)
    assert.deepEqual(await frame(head, 0), await frame('#ctxwin .cblk[data-bi] > .cbh', -1)) // the first reply row against the last request row
    const control = `${head} .cbtog` // the desk's head holds a button (2.3 §block 卡)
    assert.equal(await b.page.$eval(control, (e) => e.tabIndex), 0)
    const shut = () => b.page.$eval(head, (e) => e.parentElement.classList.contains('collapsed'))
    const before = await shut()
    await b.page.focus(control); await b.page.keyboard.press('Enter')
    assert.equal(await shut(), !before)
    await b.page.focus(control); await b.page.keyboard.press('Enter')
    assert.equal(await shut(), before)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.4 · 1.5: a 「Files read」 row with a long path and a long life sentence (read at step N · removed by compaction at step M — the main
// Mac's shape) shows the whole sentence, wrapped under the name, and the name truncated with its full text on hover. The real answers,
// with the anchor lane's `lane` answer given such files.
test('Files read: a long path and a long life sentence are never cut — the life wraps, the name has its full text on hover', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    // the page that opens the anchor lane's ledger (`--to` its first step) gives it six long files, read at the tail page's first
    // step and evicted at the one before its last (3.5 §会话读 `resources`: segments by rid); the playhead opens on the last step, so each is gone
    const row = (await byCalls(b))[0], main = await mainOf(b, row)
    const rids = (await b.get('lane', { id: row.session_id, lane: main })).doc.steps.map((st) => st.rid)
    assert.ok(rids.length >= 3, 'the anchor lane has steps to read and evict at')
    await editAnswers(b, '/api/lane', (j, q) => {
      if (q.get('lane') !== main || !q.has('to')) return
      j.resources = [...(j.resources || []), ...Array.from({ length: 6 }, (_, i) => ({ kind: 'file', label: `/private/tmp/a/rather/long/working/directory/for/the/project/src/web/module-${i}/server-side-file-${i}.mjs`, segments: [{ enter: rids[0], evict: rids[rids.length - 2] }], loads: [] }))]
    })
    await openBusiest(b)
    await b.page.locator('.deskside [role=tab]').nth(1).click() // the list is the sidebar's Resources tab (1.2 §回放台布局)
    await b.page.waitForSelector('.navsub.dead .navlife', { timeout: 15000 })
    const F = await layoutFaults(b.page)
    assert.deepEqual({ overlap: F.overlap, cut: F.cut, untitled: F.untitled }, { overlap: [], cut: [], untitled: [] })
    await shoot(b.page, 'replay-files-read', { width: 1440, theme: 'light' })
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 1.5 K-29 · D58: a session that never loaded and whose read failed says ONE sentence and offers Retry; the reason — a worker's
// crash with V8's native stack — is only in the collapsed technical details, never in the body.
test('a session whose first read failed: one sentence and Retry; the reason only in the collapsed technical details', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1280, chromium: gate.chromium })
  try {
    const reason = 'the query worker exited (signal SIGABRT): FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory · 1: 0x10446 node::OOMErrorHandler(char const*) [/bin/node]'
    let reads = 0
    await b.page.route((u) => new URL(u).pathname === '/api/d/head', (r) => { reads++; return r.fulfill({ status: 500, json: { error: reason } }) })
    const rows = (await b.get('sessions')).doc.sessions.filter((x) => x.calls > 0)
    await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(rows[0].project_slug)}/${encodeURIComponent(rows[0].session_id)}`)
    await b.page.waitForSelector('#ctxwin .empty [data-retry]')
    const seen = await b.page.evaluate(() => document.querySelector('#ctxwin').innerText)
    assert.doesNotMatch(seen, /FATAL|node::|SIGABRT/, 'the visible body carries no reason text')
    const hidden = await b.page.evaluate(() => [...document.querySelectorAll('#ctxwin .disc-b[hidden]')].map((e) => e.textContent).join(' '))
    assert.ok(hidden.includes('FATAL ERROR: Reached heap limit'), 'the reason is in the collapsed technical details')
    await shoot(b.page, 'replay-read-failed', { width: 1280, theme: 'light' })
    const before = reads
    await Promise.all([b.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/d/head'), b.page.click('#ctxwin [data-retry]')])
    assert.ok(reads > before, 'Retry reads the session\'s head again')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 1.2 #8 §窄屏 on one open desk, resized in place: at each width the sidebar or the bottom row is there, what the narrower widths take
// away is gone, #ctxwin holds half the available height, and nothing scrolls sideways. A tab raises the panel, Escape lowers it, and
// crossing 1200 px and back leaves the side boundary's stored layout as the reader left it.
test('1.2 #8: the narrow table holds at every width, the bottom panel rises and falls, and the side boundary survives the crossing', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, height: 900, chromium: gate.chromium })
  const { page } = b
  const resize = async (width, height) => {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => new Promise((ok) => { // the scope refits through ResizeObservers: settled = ten frames with the window's height unchanged
      let was = -1, same = 0
      const tick = () => {
        const h = document.querySelector('#ctxwin').getBoundingClientRect().height
        same = h === was ? same + 1 : 0; was = h
        if (same < 10) requestAnimationFrame(tick); else ok()
      }
      tick()
    }))
  }
  const facts = () => page.evaluate(() => {
    const shown = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0)
    const el = document.documentElement
    return { sideways: el.scrollWidth - el.clientWidth, side: shown('[data-testid=desk-side]'), row: shown('.deskside.bottom'), panel: shown('.deskside.bottom .sidepanel'),
      gut: shown('#saw .tgut, #rails .tgut'), detail: shown('#saw .sdetail'), legend: shown('#saw .sawlegend'), whole: shown('#saw .tkrow-ovw') }
  })
  const current = () => page.evaluate(() => { const a = document.activeElement; return a.getAttribute('role') === 'tab' && a.getAttribute('aria-selected') === 'true' })
  const tabs = page.locator('.deskside.bottom [role=tab]')
  try {
    await openBusiest(b)
    for (const [width, height] of [[1440, 900], [1280, 900], [1024, 900], [800, 900], [500, 900], [1280, 800]]) {
      await resize(width, height)
      const at = `${width} × ${height}`, L = await layout(page), F = await facts()
      assert.ok(L.ctxwin >= 0.5 * L.avail, `${at}: #ctxwin ${L.ctxwin}px < half of the available ${L.avail}px`)
      assert.ok(F.sideways <= 0, `${at}: ${F.sideways}px sideways`)
      assert.equal(F.side, width >= 1200, `${at}: the sidebar`)
      assert.equal(F.row, width < 1200 && width >= 600, `${at}: the bottom row`)
      assert.equal(F.gut, width >= 900, `${at}: the lane names`)
      assert.equal(F.detail, width >= 600, `${at}: the detail rows`)
      assert.equal(F.legend, width >= 600, `${at}: the legend`)
      assert.equal(F.whole, true, `${at}: the whole-session row`)
      await shoot(page, 'replay-narrow', { width, theme: 'light' })
      if (!F.row) continue
      await tabs.nth(1).click()
      assert.equal((await facts()).panel, true, `${at}: a tab raises its panel`)
      assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', `${at}: and selects itself`)
      const half = await page.evaluate(() => document.querySelector('.deskside.bottom .sidepanel').offsetHeight / document.querySelector('.desk.next').offsetHeight)
      assert.ok(Math.abs(half - 0.5) < 0.01, `${at}: the panel is ${half} of the desk`)
      assert.ok((await facts()).sideways <= 0, `${at}: the raised panel scrolls sideways`)
      await shoot(page, 'replay-sheet', { width, theme: 'light' })
      await tabs.nth(0).click()
      assert.equal((await facts()).panel, true, `${at}: another tab keeps the panel up`)
      await tabs.nth(0).click()
      assert.equal((await facts()).panel, false, `${at}: the current tab lowers it`)
      await tabs.nth(1).click()
      await page.keyboard.press('Escape')
      assert.equal((await facts()).panel, false, `${at}: Escape lowers it`)
      assert.ok(await current(), `${at}: the focus is back on the current tab`)
    }
    await resize(1440, 900)
    await page.locator('.deskpanes > [data-separator]').focus()
    await page.keyboard.press('ArrowLeft')
    const kept = await page.evaluate(() => [localStorage.getItem('trocar.v2.split.side'), document.querySelector('#desk-side').getBoundingClientRect().width])
    assert.ok(kept[0], 'the keyboard move stored the layout')
    await resize(1000, 900)
    await resize(1440, 900)
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('trocar.v2.split.side'), document.querySelector('#desk-side').getBoundingClientRect().width]), kept)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
