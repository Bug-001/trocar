// test/web-v2/browser/smoke.test.mjs — the board loads in the real Chrome without a page error (D64⑤), and the browser suite skips
// with a printed reason wherever it cannot run (D38: not silently). Only `npm run test:browser` runs the browser cases.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { probe, withBoard, shoot, launchChrome, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'

const gate = await probe()

for (const width of [1280, 1024]) {
  for (const theme of ['light', 'dark']) {
    test(`the board loads with no page error at ${width} in ${theme}`, { skip: gate.ok ? false : gate.reason }, async () => {
      const b = await withBoard({ width, theme, chromium: gate.chromium })
      try {
        await b.page.waitForFunction(() => document.querySelector('#sidebar')?.children.length > 0, null, { timeout: 10000 })
        await b.page.waitForLoadState('networkidle')
        await shoot(b.page, 'home', { width, theme })
        assert.deepEqual(b.errors, [])
      } finally { await b.stop() }
    })
  }
}

test('the suite skips with a reason when it is not asked for, or playwright-core or Chrome is absent', async () => {
  let launched = 0
  let imported = 0
  const absent = [
    { env: {}, importer: () => { imported++; return { chromium: { launch: async () => { launched++ } } } } },
    { env: { TROCAR_PLAYWRIGHT: '1' }, importer: () => { throw new Error('x') } },
    { env: { TROCAR_PLAYWRIGHT: '1' }, importer: async () => ({ chromium: { launch: async () => { throw new Error('no chrome') } } }) },
  ]
  for (const c of absent) {
    const r = await probe(c)
    assert.equal(r.ok, false)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
  assert.equal(imported, 0)
  assert.equal(launched, 0)
})

// A route handler still awaiting route.fetch when its page, its context or the browser closes rejects with nobody to await it: an
// unhandled rejection that failed whichever case was running (a Windows run, capture-shots: "route.fetch: Request context disposed" on
// a status poll in flight at close). Every close of what launchChrome hands out leaves no such rejection.
test('closing a page, a context or the browser while a route handler awaits route.fetch leaves no unhandled rejection', { skip: gate.ok ? false : gate.reason, timeout: 60_000 }, async () => {
  const held = [], waiting = []
  const server = http.createServer((req, res) => {
    if (req.url !== '/slow') return res.end('<!doctype html><title>t</title>')
    held.push(res); for (const w of waiting.splice(0)) w() // never answered: the handler's route.fetch is in flight until the close
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const rejections = [], onRejection = (e) => rejections.push(String(e))
  process.on('unhandledRejection', onRejection)
  const browser = await launchChrome(gate.chromium)
  try {
    const inFlight = async (context, at) => {
      const page = await context.newPage()
      await page.goto(`${base}/`)
      const reached = new Promise((r) => waiting.push(r))
      await (at === 'page' ? page : context).route('**/slow', async (r) => { const res = await r.fetch(); await r.fulfill({ response: res }) })
      await page.evaluate(() => { fetch('/slow').catch(() => {}) })
      await reached
      return page
    }
    const a = await browser.newContext()
    await (await inFlight(a, 'page')).close()
    await a.close()
    const b = await browser.newContext()
    await inFlight(b, 'context')
    await b.close()
    await inFlight(await browser.newContext(), 'page')
    await inFlight(await browser.newContext(), 'context')
    await browser.close()
    await new Promise((r) => setTimeout(r, 500)) // a rejection the closes caused is raised well within this
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
    await browser.close()
    for (const res of held) res.destroy()
    await new Promise((r) => server.close(r))
  }
})

// serveWorld's answers wait `latency` ms before they fulfill: routes dropped meanwhile (stop's closeQuietly) make Playwright continue
// the request itself, so the late fulfill rejects ("Route is already handled!"). A handler that hands that rejection back to Playwright
// has it ignored; one that let it float failed whichever case was stopping (desk-pending, desk-load).
test('dropping the routes while serveWorld answers wait leaves no unhandled rejection', { skip: gate.ok ? false : gate.reason, timeout: 60_000 }, async () => {
  const rejections = [], onRejection = (e) => rejections.push(String(e))
  process.on('unhandledRejection', onRejection)
  try {
    const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
    try {
      await serveWorld(b.page, world(1, { calls: 400, page: 100 }), { latency: 1000 })
      const lane = b.page.waitForRequest('**/api/lane?**', { timeout: 20_000 })
      await b.page.evaluate(() => { location.hash = '#/replay/p/S' })
      await lane // a lane read is out, its answer waiting
      await b.page.unrouteAll({ behavior: 'ignoreErrors' }) // stop's first step (closeQuietly), with the page kept open while the answers wake
      await new Promise((r) => setTimeout(r, 1500))
    } finally { await b.stop() }
    assert.deepEqual(rejections, [])
  } finally { process.off('unhandledRejection', onRejection) }
})
