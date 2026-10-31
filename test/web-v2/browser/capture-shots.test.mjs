// test/web-v2/browser/capture-shots.test.mjs — the 采集 page in real Chrome against a REAL daemon-hosted board (1.9 §开关, 4.4 先计划后确认):
// the world is test/server/control-harness.e2e.test.mjs's (a model world with codex installed, the board port recorded, a live daemon whose
// query worker carries the on/off OS fakes). Clicking codex's switch shows the plan with focus on Cancel; Esc sends no confirm and HOME does
// not change; confirming sends exactly one confirm, shows aria-busy, then the receipt. ?h= of an agent with no row is a toast, the head
// unchanged. Shots: capture, capture-not-installed, capture-control-off at 1280 / 1024 × light / dark. Sandbox HOMEs only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { probe, shoot, layoutFaults } from './harness.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'
import { modelWorld } from '../../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf } from '../../helpers/model-daemon.mjs'
import { workerFork } from '../../helpers/worker-fork.mjs'
import { depsFile } from '../../helpers/board-world.mjs'
import { snapshot } from '../../query/raw-home.mjs'
import { renderWrapper } from '../../../src/collector/arch/darwin/wrapper.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const platform = 'darwin'
const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }

async function withDaemonBoard(run) {
  const w = await modelWorld({ os: platform, commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const port = await boardPortOf(w.dir)
  const deps = depsFile(w, platform)
  await withScratchCwd(platform, async () => {
    const box = await liveUnit({ w, platform, parts: { helper: HELPER }, daemon: { fork: (h) => workerFork(h, deps) } })
    box.unit.start(); await box.starting
    const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
    try { await run({ w, base: `http://127.0.0.1:${port}`, token }) } finally { await box.stop() }
  })
}

async function open(chromium, { base, token }, { width = 1280, theme = 'light' } = {}) {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme })
  const page = await context.newPage()
  const posts = [], errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() }) })
  await page.goto(`${base}/#t=${encodeURIComponent(token)}`, { waitUntil: 'load' })
  await page.evaluate(() => { location.hash = '#/capture' })
  await page.waitForSelector('.crow[data-h="codex"]', { timeout: 30000 })
  return { page, posts, errors, close: () => browser.close() }
}
const confirms = (posts) => posts.filter((p) => p.body && 'confirm' in JSON.parse(p.body))

test('the switch: plan dialog with focus on Cancel; Esc sends no confirm and HOME is unchanged; confirm → one confirm POST, busy, then the receipt; ?h= with no row → a toast', { skip, timeout: 240_000 }, async () => {
  await withDaemonBoard(async (ctx) => {
    const b = await open(gate.chromium, ctx)
    try {
      const sw = '.crow[data-h="codex"] [data-hctl="switch"]'
      await b.page.waitForSelector(sw, { timeout: 15000 })
      const home0 = snapshot(ctx.w.home)
      await b.page.click(sw)
      await b.page.waitForSelector('[data-confirm-back] [role="dialog"]', { timeout: 30000 })
      const dlg = await b.page.evaluate(() => ({ lines: [...document.querySelectorAll('[data-confirm-back] .mbody p')].map((p) => p.textContent), active: document.activeElement && document.activeElement.dataset.confirm }))
      assert.equal(dlg.active, 'cancel')
      assert.ok(dlg.lines.some((l) => l.includes(ctx.w.home)), JSON.stringify(dlg.lines)) // the plan's paths, under the world's HOME
      await b.page.keyboard.press('Escape')
      await b.page.waitForSelector('[data-confirm-back]', { state: 'detached' })
      await b.page.waitForFunction((s) => !document.querySelector(s).hasAttribute('aria-busy'), sw)
      assert.equal(confirms(b.posts).length, 0)
      assert.deepEqual(snapshot(ctx.w.home), home0, 'a cancel writes nothing')

      await b.page.evaluate((s) => {
        window.__busySeen = false
        new MutationObserver(() => { const e = document.querySelector(s); if (e && e.getAttribute('aria-busy') === 'true') window.__busySeen = true }).observe(document.body, { subtree: true, attributes: true, childList: true })
      }, sw)
      await b.page.click(sw)
      await b.page.waitForSelector('[data-confirm="ok"]', { timeout: 30000 })
      const answered = b.page.waitForResponse((r) => r.request().method() === 'POST' && r.request().postData() && 'confirm' in JSON.parse(r.request().postData()), { timeout: 120000 })
      const t0 = Date.now()
      await b.page.click('[data-confirm="ok"]')
      const res = await answered
      assert.equal(res.status(), 200)
      await b.page.waitForSelector('.crow[data-h="codex"] .hrcpt', { timeout: 30000 })
      console.log(`# press-to-receipt ${Date.now() - t0} ms (line ${BOARD_LINES.button} ms, print only)`)
      assert.equal(confirms(b.posts).length, 1)
      assert.equal(await b.page.evaluate(() => window.__busySeen), true)
      assert.equal(await b.page.evaluate(() => document.activeElement && document.activeElement.closest('[data-confirm-back]')), null)

      // ?h= of an agent with no row: a toast, the page head unchanged
      const head0 = await b.page.locator('#caphead').innerHTML()
      const noRow = await b.page.evaluate(() => ['hermes', 'zcode', 'kimi', 'dsh'].find((h) => !document.querySelector(`.crow[data-h="${h}"]`)))
      await b.page.evaluate((h) => { location.hash = `#/capture?h=${h}` }, noRow)
      await b.page.waitForSelector('#toasts .toast', { timeout: 15000 })
      assert.equal((await b.page.locator('#caphead').innerHTML()).replace(/\d\d:\d\d:\d\d/g, ''), head0.replace(/\d\d:\d\d:\d\d/g, ''))
      assert.deepEqual(b.errors, [])
    } finally { await b.close() }
  })
})

test('shots: healthy, not installed and control off at 1280 / 1024 × light / dark', { skip, timeout: 240_000 }, async () => {
  await withDaemonBoard(async (ctx) => {
    for (const width of [1280, 1024]) for (const theme of ['light', 'dark']) {
      const b = await open(gate.chromium, ctx, { width, theme })
      try {
        await b.page.waitForSelector('.crow[data-h="codex"] [data-hctl]', { timeout: 15000 })
        await shoot(b.page, 'capture', { width, theme })
        // not installed: the real answer with health.state not-installed → no control anywhere
        await b.page.route('**/api/status*', async (r) => { const res = await r.fetch(); const j = await res.json(); j.health = { state: 'not-installed' }; await r.fulfill({ response: res, json: j }) })
        await b.page.waitForFunction(() => document.querySelectorAll('[data-hctl]').length === 0, null, { timeout: 20000 })
        await shoot(b.page, 'capture-not-installed', { width, theme })
        await b.page.unroute('**/api/status*')
        // control off: the daemon runs as root → the control plane answers root:true (4.4); a reload reads it again
        await b.page.route('**/control/status', (r) => r.fulfill({ json: { control: false, user: 'root', root: true, harnesses: [] } }))
        await b.page.reload({ waitUntil: 'load' })
        await b.page.waitForSelector('.crow[data-h="codex"]', { timeout: 30000 })
        assert.equal(await b.page.locator('[data-hctl]').count(), 0)
        await shoot(b.page, 'capture-control-off', { width, theme })
        assert.deepEqual(b.errors, [])
      } finally { await b.close() }
    }
  })
})

// 1.9 · 1.5: an expanded problem row — the restart sentence, its why, the changed files, 技术细节 with its copy button, and on the right both
// 最近采到 and 最近失败 — draws nothing on top of anything else at 1440 / 1280 / 1024 / 390, nor does its Capture log row (a macOS machine's Z-Code row once put 「Copy
// diagnostics」 over 「Technical details」, and ran 「captured just now ›latest failure …」 into the switch). The real answer, with codex made
// that row.
test('an expanded problem row: nothing drawn on one another, the two right-hand facts apart and clear of the switch', { skip, timeout: 240_000 }, async () => {
  await withDaemonBoard(async (ctx) => {
    for (const width of [1440, 1280, 1024, 390]) {
      const b = await open(gate.chromium, ctx, { width })
      try {
        const now = new Date().toISOString()
        await b.page.route((u) => new URL(u).pathname === '/api/status', async (r) => {
          const res = await r.fetch(), j = await res.json()
          j.harnesses.codex = { ...j.harnesses.codex, desired: 'on', captured: false, reason: 'config-after-start', why: [] }
          j.topology = { ...(j.topology || {}), codex: { at: now, captured: false, reason: 'config-after-start', findings: ['config-after-start'] } }
          j.failures = { ...(j.failures || {}), groups: [{ level: 'problem', where: 'engine', code: 'trust-rejected', count: 3, first_ts: now, last_ts: now, harness: 'codex', reason: 'r' }, { level: 'problem', where: 'engine', code: 'trust-rejected', count: 1, first_ts: now, last_ts: now, harness: 'claude-code', reason: 'r' }] }
          j.changed = [...(j.changed || []), { harness: 'codex', path: `${ctx.w.home}/.codex/a/rather/long/path/to/a/config/file/config.toml`, what: 'toml-key network.proxy' }]
          await r.fulfill({ response: res, json: j })
        })
        await b.page.route((u) => new URL(u).pathname === '/api/overview', async (r) => {
          const res = await r.fetch(), j = await res.json()
          j.harnesses = [{ harness: 'codex', last_ts: now }]
          await r.fulfill({ response: res, json: j })
        })
        await b.page.reload({ waitUntil: 'load' })
        await b.page.waitForSelector('.crow[data-h="codex"] .cexp:not([hidden]) .exp-tech, .crow[data-h="codex"] .cexp:not([hidden]) .disc', { timeout: 30000 })
        await b.page.waitForSelector('.crow[data-h="codex"] .last a[href^="#/sessions"]', { timeout: 30000 })
        assert.deepEqual(await layoutFaults(b.page), { overlap: [], cut: [], untitled: [], emptyIcons: [] }, `capture ${width}`)
        await shoot(b.page, 'capture-problem-row', { width, theme: 'light' })
        // the same failure as a Capture log row: time, agent, sentence and count apart at every width (a phone once ran 「Claude Code」 into 「×1」)
        await b.page.evaluate(() => { location.hash = '#/capture/log' })
        await b.page.waitForSelector('.crows .lr:not(.h)', { timeout: 30000 })
        assert.deepEqual(await layoutFaults(b.page), { overlap: [], cut: [], untitled: [], emptyIcons: [] }, `capture log ${width}`)
        assert.ok(await b.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `capture log ${width}: no sideways scroll`)
        assert.deepEqual(b.errors, [])
      } finally { await b.close() }
    }
  })
})

// 1.9 #13: the shell hands every screen the same element, so a second visit must not leave the first visit's row handler on it
// (two handlers toggled the same row: one click opened and closed it). Capture and Capture log both, after a round trip via Overview.
test('after leaving and coming back, one click on a row head toggles that row (capture and capture log)', { skip, timeout: 240_000 }, async () => {
  await withDaemonBoard(async (ctx) => {
    const b = await open(gate.chromium, ctx)
    try {
      const now = new Date().toISOString()
      await b.page.route((u) => new URL(u).pathname === '/api/status', async (r) => {
        const res = await r.fetch(), j = await res.json()
        j.failures = { ...(j.failures || {}), groups: [{ level: 'problem', where: 'engine', code: 'trust-rejected', count: 1, first_ts: now, last_ts: now, harness: 'codex', reason: 'r' }] }
        await r.fulfill({ response: res, json: j })
      })
      for (const [hash, head] of [['#/capture', '.crow [data-caprow]'], ['#/capture/log', '.crows .lr:not(.h) [data-lrow]']]) {
        for (const h of [hash, '#/overview', hash]) {
          await b.page.evaluate((x) => { location.hash = x }, h)
          if (h !== '#/overview') await b.page.waitForSelector(head, { timeout: 30000 })
        }
        const before = await b.page.locator(head).first().getAttribute('aria-expanded')
        await b.page.locator(head).first().click()
        const after = await b.page.evaluate((s) => { const e = document.querySelector(s); const p = document.getElementById(e.getAttribute('aria-controls')); return { exp: e.getAttribute('aria-expanded'), hidden: p.hasAttribute('hidden') } }, head)
        assert.equal(after.exp, String(before !== 'true'), hash)
        assert.equal(after.hidden, before === 'true', hash)
      }
      assert.deepEqual(b.errors, [])
    } finally { await b.close() }
  })
})
