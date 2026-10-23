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
    assert.equal(await b.page.$eval(head, (e) => e.tabIndex), 0)
    const shut = () => b.page.$eval(head, (e) => e.parentElement.classList.contains('collapsed'))
    const before = await shut()
    await b.page.focus(head); await b.page.keyboard.press('Enter')
    assert.equal(await shut(), !before)
    await b.page.focus(head); await b.page.keyboard.press('Enter')
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
    // the anchor lane's tail page (no from / to / ledger) gives the ledger six long files, read at its first step and evicted at
    // the one before its last (3.5 §会话读 `resources`: segments by rid); the playhead opens on the last step, so each is gone
    const main = await mainOf(b, (await byCalls(b))[0])
    await editAnswers(b, '/api/lane', (j, q) => {
      if (q.get('lane') !== main || q.has('from') || q.has('to') || q.has('ledger') || !(j.steps && j.steps.length >= 3)) return
      const rids = j.steps.map((st) => st.rid)
      j.resources = [...(j.resources || []), ...Array.from({ length: 6 }, (_, i) => ({ kind: 'file', label: `/private/tmp/a/rather/long/working/directory/for/the/project/src/web/module-${i}/server-side-file-${i}.mjs`, segments: [{ enter: rids[0], evict: rids[rids.length - 2] }], loads: [] }))]
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
// left panel is wide; it wraps inside its row and is never drawn past the panel's edge. The real answers, with the system blocks so marked.
test('System prompt: the "changes every call" pill stays inside the left panel', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    // every `lane` answer marks the system blocks its add ops bring in volatile (3.5 §会话读: the position `attrs` of add ops;
    // copies carry theirs), as the board is told of a block that changes every call
    // the busiest session whose main lane's tail page holds a system block (some generated sessions send none)
    let row = null
    for (const r of await byCalls(b)) if ((await b.get('lane', { id: r.session_id, lane: await mainOf(b, r) })).doc.defs.some((d) => d.sec === 'system')) { row = r; break }
    assert.ok(row, 'a session with a system block')
    const sec = new Map() // bid → sec, over every answer so far (a def is sent once per lane)
    await editAnswers(b, '/api/lane', (j) => {
      for (const d of j.defs || []) sec.set(d.bid, d.sec)
      for (const st of j.steps || []) {
        let pos = 0
        for (const op of st.ops || []) {
          if (op[0] === 0) { pos += op[2]; continue }
          op.slice(1).forEach((bid, i) => { if (sec.get(bid) === 'system') st.attrs = { ...st.attrs, [pos + i]: { ...(st.attrs || {})[pos + i], volatile: true } } })
          pos += op.length - 1
        }
      }
    })
    await openSession(b, row)
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

// D70 §4.4 (2.3 · cell.mjs): a cell's own mode belongs to the session it was set in. Flip an open block's cell away from the desk
// default, open another session and come back: the same bid opens in the desk default again.
test('A20: a cell flipped to the other mode, another session, back → the same bid opens in the desk default', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ bytes: BYTES, width: 1440, chromium: gate.chromium })
  try {
    const [A, B] = await byCalls(b)
    assert.ok(A && B, 'two sessions')
    await openSession(b, A)
    // open visible collapsed rows until one draws a cell with its mode buttons; its mode then is the desk default (no override yet)
    const row = (bi) => `#ctxwin .cblk[data-bi="${bi}"]`
    const open = (bi) => b.page.locator(`${row(bi)} > .cbh`).first().click()
    const visible = () => b.page.evaluate(() => [...document.querySelectorAll('#ctxwin .cblk.collapsed[data-bi]')].filter((e) => e.getClientRects().length).map((e) => e.dataset.bi))
    let bi = null, cell = null
    for (const x of (await visible()).slice(0, 20)) {
      await open(x)
      cell = await b.page.waitForSelector(`${row(x)} .cell[data-bid] [data-cellmode]`, { timeout: 5000 })
        .then(() => b.page.$eval(`${row(x)} .cell[data-bid]`, (c) => ({ bid: c.dataset.bid, mode: c.dataset.mode })), () => null)
      if (cell) { bi = x; break }
    }
    assert.ok(cell, 'an opened row drew a cell')
    const desk = cell.mode, other = desk === 'raw' ? 'read' : 'raw', sel = `#ctxwin .cell[data-bid="${cell.bid}"]`
    await b.page.locator(`${row(bi)} .cell [data-cellmode="${other}"]`).first().click()
    await b.page.waitForSelector(`${sel}[data-mode="${other}"]`, { timeout: 10000 })
    await openSession(b, B)
    await openSession(b, A)
    if (!(await b.page.$(sel))) await open(bi) // the open rows belong to the session too: open the same row again
    await b.page.waitForSelector(sel, { timeout: 10000 })
    assert.equal(await b.page.$eval(sel, (e) => e.dataset.mode), desk, 'the same bid opens in the desk default')
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
    await b.page.route((u) => new URL(u).pathname === '/api/session', (r) => { reads++; return r.fulfill({ status: 500, json: { error: reason } }) })
    const rows = (await b.get('sessions')).doc.sessions.filter((x) => x.calls > 0)
    await b.page.evaluate((h) => { location.hash = h }, `#/replay/${encodeURIComponent(rows[0].project_slug)}/${encodeURIComponent(rows[0].session_id)}`)
    await b.page.waitForSelector('#ctxwin .empty [data-retry]')
    const seen = await b.page.evaluate(() => document.querySelector('#ctxwin').innerText)
    assert.doesNotMatch(seen, /FATAL|node::|SIGABRT/, 'the visible body carries no reason text')
    const hidden = await b.page.evaluate(() => [...document.querySelectorAll('#ctxwin .disc-b[hidden]')].map((e) => e.textContent).join(' '))
    assert.ok(hidden.includes('FATAL ERROR: Reached heap limit'), 'the reason is in the collapsed technical details')
    await shoot(b.page, 'replay-read-failed', { width: 1280, theme: 'light' })
    const before = reads
    await Promise.all([b.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session'), b.page.click('#ctxwin [data-retry]')])
    assert.ok(reads > before, 'Retry reads the session again')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
