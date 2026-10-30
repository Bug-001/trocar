// test/web-v2/browser/library-stored.test.mjs — 1.8 assertion 17 in real Chrome on the real face (4.4 §存下的答案): the worker gone, a
// stored answer on disk, a new session appended after it → a new browser context opening #/sessions paints the stored list with the
// caption's refreshing fact, then, with no reload, the new session's row comes in, the fact goes and the head gains its read-at time.
// Asserted on ids, data attributes and session ids, never on words. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'
import { boardHome } from '../real-face.mjs'
import { storedFile } from '../../../src/query/stored.mjs'
import { writeSegment } from '../../query/raw-home.mjs'
import fs from 'node:fs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const TIP = 'trocar.token' // core/http.mjs: the tab's token slot (4.4)
const NEW_ID = 'later-session'
const until = async (what, f, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) { const v = await f(); if (v) return v; assert.ok(Date.now() < end, `${what} within ${ms} ms`); await new Promise((d) => setTimeout(d, 50)) }
}

// what the page shows the first moment the refreshing fact is in the caption, and whether the page ever reloaded
function watch() {
  const look = () => {
    const el = document.querySelector('#libcap [data-stored]')
    if (!el || window.__stored) return
    window.__stored = { keys: [...document.querySelectorAll('.lrow[data-key]')].map((a) => a.dataset.key), readAt: !!document.querySelector('#libhead .readat') }
  }
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true })
  try { window.__loads = Number(sessionStorage.getItem('__loads') || 0) + 1; sessionStorage.setItem('__loads', String(window.__loads)) } catch { /* the test's own page */ }
}
const keyId = (k) => k.slice(k.indexOf('::') + 2)

test('1.8 (17): the stored list paints at once with the refreshing fact; the fresh list replaces it with no reload', { skip, timeout: 180_000 }, async () => {
  const home = boardHome()
  const b = await withBoard({ home, chromium: gate.chromium })
  try {
    // the board's own first open writes the stored answer of the page's list
    await b.page.evaluate(() => { location.hash = '#/sessions' })
    await b.page.waitForSelector('.lrow[data-key]', { timeout: 60_000 })
    await until('the stored answer on disk', () => fs.existsSync(storedFile(home.home, 'sessions', { limit: 500 })))
    const before = await b.page.$$eval('.lrow[data-key]', (as) => as.map((a) => a.dataset.key))
    assert.ok(!before.some((k) => keyId(k) === NEW_ID))

    // a new session arrives after it; the worker goes
    const ts = '2099-01-01T00:00:00.000Z'
    writeSegment(home.home, '20990101T000000Z', [JSON.stringify({ ts, endpoint: '/v1/messages', method: 'POST', req_headers: { 'content-type': 'application/json', 'x-claude-code-session-id': NEW_ID }, req_body: '{"model":"m"}', resp: { status: 200, kind: 'json' }, id: 'req_later', ts_request: ts, is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'claude-code' } })])
    b.face.killWorker()
    await until('the worker gone', () => b.face.workers().length === 0)

    // a new context (empty caches) opens the list
    const context = await b.page.context().browser().newContext({ viewport: { width: 1280, height: 900 } })
    try {
      await context.addInitScript(([k, t]) => { try { sessionStorage.setItem(k, t) } catch { /* the test's own page */ } }, [TIP, b.face.token])
      await context.addInitScript(watch)
      const page = await context.newPage(), errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await page.goto(`${b.url}/#/sessions`)
      const first = await (await page.waitForFunction(() => window.__stored, null, { timeout: 15_000 })).jsonValue()
      assert.deepEqual(new Set(first.keys), new Set(before), 'first the stored list: the rows as they were stored')
      assert.equal(first.readAt, false, 'a stored answer is not a read-at time')

      await page.waitForFunction((id) => [...document.querySelectorAll('.lrow[data-key]')].some((a) => a.dataset.key.endsWith('::' + id)), NEW_ID, { timeout: 60_000 })
      assert.equal(await page.$('#libcap [data-stored]'), null, 'the fresh list took the refreshing fact away')
      assert.ok(await page.$('#libhead .readat'), 'the head has its read-at time')
      assert.equal(await page.evaluate(() => window.__loads), 1, 'no reload')
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  } finally { await b.stop() }
})
