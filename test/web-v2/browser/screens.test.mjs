// test/web-v2/browser/screens.test.mjs — every screen on the real face in the real Chrome (1.2 #20 · D64⑤): real clicks and keys,
// each screen's first data element and zero page errors, K-30 with no token, and D64's lines measured and printed (never asserted
// relaxed, D64⑥). Shots: every screen × 1280 / 1024 × light / dark. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, stats, shoot, layoutFaults, timed, timerReads } from './harness.mjs'
import { typeFaults } from './type-inventory.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { COMMANDS } from '../../../web/legacy/labels/capture.mjs'
import { THEME_DARK, THEME_LIGHT } from '../../../web/legacy/labels/settings.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6
const samples = { sessionOpen: [], stepClick: [], stepKey: [], button: [] }

// a sidebar link: a top-level item is clicked, a sub-item is reached through its flyout (hover the parent, then click)
async function nav(page, href) {
  const link = page.locator(`#sidebar a[href="${href}"]`)
  for (let i = 0; i < await link.count(); i++) if (await link.nth(i).isVisible()) return link.nth(i).click()
  await page.locator('#sidebar .item', { has: page.locator(`a[href="${href}"]`) }).first().hover()
  return page.locator(`#sidebar .fsub a[href="${href}"]`).click()
}

// a screen fills the window and scrolls inside (shell.css: `.page` scrolls, the replay splits); the document itself never scrolls,
// so a page opened from a scrolled one is not half off the top, and the replay's landing scroll stays inside the desk
const fitsWindow = async (page, name) =>
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && scrollY === 0), `${name}: the document scrolls`)

// each screen, how it is reached, and the first element it draws from data (or its empty state)
async function driveEveryScreen(b, { width, theme }) {
  const { page } = b
  const first = async (name, sel, act) => {
    const ms = await timed(page, 'sel', sel, act)
    samples.button.push(ms)
    await page.waitForLoadState('networkidle')
    await page.mouse.move(width - 8, 880) // off the sidebar: no fly-out stays over the content (1.2 §侧栏: shown on hover / focus only)
    assert.equal(await page.locator('#sidebar .fly:visible').count(), 0, `${name}: a sidebar fly-out covers the content`)
    const clash = await page.evaluate(() => { // headings never sit on one another (a class shared across screens' css once did this)
      const hs = [...document.querySelectorAll('#content h1, #content h2, #content h3')].map((e) => [e.textContent, e.getBoundingClientRect()]).filter(([, r]) => r.width && r.height)
      const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      return hs.flatMap(([t, r], i) => hs.slice(i + 1).filter(([, q]) => over(r, q)).map(([u]) => `${t} × ${u}`))
    })
    assert.deepEqual(clash, [], `${name}: headings overlap`)
    // 1.5: nothing drawn on top of anything else, no text cut off unsaid, every agent icon filled — on every screen, from its own data
    assert.deepEqual(await layoutFaults(page), { overlap: [], cut: [], untitled: [], emptyIcons: [] }, `${name}: layout`)
    await fitsWindow(page, name)
    assert.ok(await page.locator(sel).count() > 0, `${name}: ${sel} at ${await page.evaluate(() => location.hash)} after ${ms} ms`)
    if (width === 1280 && theme === 'light') { const T = await typeFaults(page); console.log(`# type inventory (${name}): ${JSON.stringify(T.inventory)}`); assert.deepEqual(T.faults, [], name) } // 1.5 #16: two families, five sizes, two weights
    await shoot(page, name, { width, theme })
  }
  await page.waitForSelector('#sidebar a')
  await nav(page, '#/sessions'); await page.waitForSelector('.lrow')
  await first('overview', '.ovcard .ovitem, .ovcard .ovempty', () => nav(page, '#/overview'))
  await first('library', '.lrow', () => nav(page, '#/sessions'))
  await page.locator('#libhead').getByRole('radio', { name: 'All' }).click()
  await page.waitForSelector('.lrow')

  // session open: click a row → its step head and context window drawn (D64①); five different rows
  const rows = await page.locator('.lrow').count()
  for (let i = 0; i < Math.min(5, rows); i++) {
    const row = page.locator('.lrow').nth(rows - 1 - i) // from the bottom: the library is scrolled when the row is clicked
    samples.sessionOpen.push(await timed(page, 'replay', null, () => row.click()))
    await fitsWindow(page, `session ${i + 1}`)
    if (i < 4) { await page.goBack(); await page.waitForSelector('.lrow') }
  }
  await page.waitForLoadState('networkidle')
  await shoot(page, 'replay', { width, theme })
  assert.deepEqual(await layoutFaults(page), { overlap: [], cut: [], untitled: [], emptyIcons: [] }, 'replay: layout')

  // step change ×20 by click, ×20 by arrow key (D64②); bounce between the first and the last step
  const pos = async () => (await page.textContent('#stepbar .sb-no')).match(/(\d+)\s*\/\s*(\d+)/).slice(1).map(Number)
  const tStep = Date.now()
  for (const [kind, by] of [['stepClick', 'click'], ['stepKey', 'key']]) {
    let dir = -1
    for (let i = 0; i < 20; i++) {
      const [n, m] = await pos()
      if (n === 1) dir = 1
      if (n === m) dir = -1
      const prev = await page.textContent('#stepbar .sb-no')
      const act = by === 'click'
        ? () => page.click(`#stepbar .sbbtn[data-step="${dir < 0 ? 'prev' : 'next'}"]`)
        : () => page.keyboard.press(dir < 0 ? 'ArrowLeft' : 'ArrowRight')
      samples[kind].push(await timed(page, 'step', prev, act))
    }
  }
  const timerRead = await timerReads(b)
  const during = b.requests.filter((r) => r.start >= tStep && !timerRead(r)).map((r) => r.url) // a timer's read is not a step change (1.4 §D64)
  console.log(`# ${width} ${theme}: requests during 40 step changes: ${during.length}${during.length ? ' · ' + [...new Set(during)].join(' ') : ''}`)
  await shoot(page, 'replay-step', { width, theme })

  await first('capture', '#caphead .readat', () => nav(page, '#/capture'))
  await first('capture-log', '.crows .lr, .crows .caplog-none', () => nav(page, '#/capture/log'))
  await nav(page, '#/traffic')
  await first('traffic', '.traf a[href^="#/traffic/host/"]', () => page.locator('.pagehead').getByRole('link', { name: /^all$/i }).first().click())
  await first('host', '#hlist [role="listitem"] a', () => page.locator('.traf').getByRole('link').and(page.locator('[href^="#/traffic/host/"]')).first().click())
  await first('request', '#hdetail .rqd', () => page.getByRole('list', { name: 'Requests' }).getByRole('link').first().click())
  await first('storage', '#screen [role="radiogroup"]', () => nav(page, '#/settings/storage'))
  await first('prices', '#screen .ptable tbody tr', () => nav(page, '#/settings/prices'))
  await first('appearance', '[role="radio"][data-theme-choice]', () => nav(page, '#/settings/appearance'))
  const other = theme === 'dark' ? 'light' : 'dark'
  samples.button.push(await timed(page, 'sel', `html[data-theme="${other}"]`, () => page.getByRole('radio', { name: other === 'dark' ? THEME_DARK : THEME_LIGHT }).click()))
  await shoot(page, 'appearance-switched', { width, theme })
}

for (const width of [1280, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`every screen draws its data with no page error at ${width} in ${theme}`, { skip }, async () => {
      const b = await withBoard({ bytes: BYTES, width, theme, chromium: gate.chromium })
      try {
        await driveEveryScreen(b, { width, theme })
        assert.deepEqual(b.errors, [])
        assert.deepEqual(b.missing, [], 'every static file the page asks for is served (no /favicon.ico 404)')
      } finally { await b.stop() }
    })
  }
}

// 1.2 #22: leaving a screen aborts its reads still in flight, and the content area reads "Reading…" (never blank) while the next
// screen's module loads. Overview's /api reads and the library module are held at the network, so both windows stay open to look at.
test('a screen change aborts the old screen\'s reads and the content is never blank while the next one loads', { skip }, async () => {
  let holdApi = true, releaseLib
  const libHeld = new Promise((r) => { releaseLib = r })
  const held = new Set()
  const b = await withBoard({
    bytes: 0, chromium: gate.chromium,
    setup: async (page) => {
      await page.route(/\/api\//, async (route) => {
        if (!holdApi) return route.continue()
        held.add(route.request())
        await new Promise(() => {}) // never answered: only an abort from the page ends it
      })
      await page.route(/\/assets\/LibraryScreen\.js$/, async (route) => { await libHeld; route.continue().catch(() => {}) })
    },
  })
  try {
    const { page } = b
    const aborted = new Set()
    page.on('requestfailed', (r) => { if (/net::ERR_ABORTED/.test(r.failure()?.errorText || '')) aborted.add(r) })
    await page.waitForFunction(() => location.hash === '#/overview')
    // the overview has mounted (not the shell's "Reading…" while its module loads) and its reads reached the route
    await page.waitForFunction(() => !!document.querySelector('#screen .page') && !document.querySelector('#screen .screenwait'), null, { timeout: 10000 }).catch(() => {})
    for (const t = Date.now(); !held.size && Date.now() - t < 10000; ) await page.waitForTimeout(50)
    const overviewReads = [...held]
    assert.ok(overviewReads.length > 0, 'overview sent no /api read to hold')
    await page.evaluate(() => { // every mutation batch of #screen is checked before the frame paints
      const el = document.querySelector('#screen')
      globalThis.__blank = 0
      new MutationObserver(() => { if (!el.children.length) globalThis.__blank++ }).observe(el, { childList: true, subtree: true })
    })
    holdApi = false
    await page.evaluate(() => { location.hash = '#/sessions' })
    await page.waitForSelector('#screen .screenwait') // the library module is still held
    await expectAborted(page, aborted, overviewReads)
    releaseLib()
    await page.waitForFunction(() => !document.querySelector('#screen .screenwait') && document.querySelector('#screen').children.length > 0) // the library mounted
    assert.equal(await page.evaluate(() => globalThis.__blank), 0, '#screen was blank between the two screens')
    assert.deepEqual(b.errors, [])
  } finally { releaseLib(); await b.stop() }
})

// a read held on the old screen ends as an abort from the page (net::ERR_ABORTED) within 5 s of the change (the sidebar's own reads
// may be held too and are not the screen's, so one abort of the held set is the evidence)
async function expectAborted(page, aborted, reads) {
  for (let t = Date.now(); Date.now() - t < 5000 && !reads.some((r) => aborted.has(r)); ) await page.waitForTimeout(50)
  assert.ok(reads.some((r) => aborted.has(r)), `none of the ${reads.length} held overview reads was aborted: ${reads.map((r) => new URL(r.url()).pathname).join(' ')}`)
}

test('K-30: with no token the page names `trocar board`, draws no navigation and sends nothing after the first 403', { skip }, async () => {
  // the page's own sends, each marked with whether a 403 had reached the page before it (this wrapper's then runs before core/http.mjs sees
  // the answer). The network's request stamps cannot say this: reads asked in one task before any answer were once stamped after the
  // test process logged a 403 under load, though the page could not yet have known it.
  const setup = (page) => page.addInitScript(() => {
    const sent = globalThis.__sent = [], real = globalThis.fetch
    let denied = false
    globalThis.fetch = function (url, init) {
      sent.push({ url: String(url), denied })
      return real.call(this, url, init).then((r) => { if (r.status === 403) denied = true; return r })
    }
  })
  const b = await withBoard({ bytes: 0, token: false, chromium: gate.chromium, setup })
  try {
    await b.page.waitForSelector('main.forbidden')
    await b.page.waitForTimeout(4000) // longer than two of the shortest poll (`session`, 1.5 s): a poll that survived the 403 would show here
    assert.ok((await b.page.textContent('body')).includes(COMMANDS.board))
    const code = b.page.locator('main.forbidden code') // the command reads as one line (a desk-only grid rule once squeezed it to 6 px)
    assert.equal(await code.evaluate((e) => e.getClientRects().length), 1)
    assert.equal(await b.page.locator('#sidebar a, #sidebar nav').count(), 0)
    assert.ok(b.requests.some((r) => r.status === 403))
    const sent = await b.page.evaluate(() => globalThis.__sent)
    assert.ok(sent.length > 0)
    assert.deepEqual(sent.filter((s) => s.denied).map((s) => s.url), [])
    assert.deepEqual(b.errors, [])
    await shoot(b.page, 'forbidden', { width: 1280, theme: 'light' })
  } finally { await b.stop() }
})

// D64④⑥: p50 and p95 next to the line, printed; this run is a baseline — acceptance numbers come from the test machines, not from it (PR 6)
test.after(() => {
  const line = { sessionOpen: BOARD_LINES.sessionOpen, stepClick: BOARD_LINES.stepClick, stepKey: BOARD_LINES.stepClick, button: BOARD_LINES.button }
  for (const [k, v] of Object.entries(samples)) {
    if (!v.length) continue
    const { p50, p95 } = stats(v)
    console.log(`# D64 ${k}: n=${v.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms line=${line[k]} ms ${p95 <= line[k] ? 'within' : 'OVER'}`)
  }
})
