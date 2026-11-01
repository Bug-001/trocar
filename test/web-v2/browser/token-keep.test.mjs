// test/web-v2/browser/token-keep.test.mjs — the board's address can be bookmarked (D66①, 4.4 §每用户口令): after one `#t=` boot a new
// page at the bare address (as browser history or a bookmark opens it) reads the board; a wrong token is dropped on its 403 (1.5 K-30).
// Asserted on the /api statuses, the address and the latched page's class, never on words. Browser suite only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

// a new page in the same browser profile at `url`: the statuses of its /api answers once the board has settled
async function open(context, url) {
  const page = await context.newPage(), statuses = [], errors = []
  page.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) statuses.push(r.status()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('main.forbidden') || document.querySelector('#sidebar')?.children.length > 0, null, { timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  return { page, statuses, errors, forbidden: await page.locator('main.forbidden').count() }
}

test('D66① after a #t= boot, a new page at the bare address reads the board, and no address carries the token', { skip }, async () => {
  const b = await withBoard({ chromium: gate.chromium })
  try {
    await b.page.waitForFunction(() => document.querySelector('#sidebar')?.children.length > 0, null, { timeout: 15_000 })
    assert.equal(new URL(b.page.url()).hash.includes(b.face.token), false)
    const context = b.page.context()
    await b.page.close() // the tab that booted is gone
    for (const route of ['/', '/#/overview', '/#/sessions']) {
      const p = await open(context, b.url + route)
      try {
        assert.equal(p.forbidden, 0, route)
        assert.ok(p.statuses.length > 0 && p.statuses.every((s) => s !== 403), `${route}: ${p.statuses}`)
        assert.deepEqual(p.errors, [])
      } finally { await p.page.close() }
    }
  } finally { await b.stop() }
})

test('K-30 a wrong token is dropped on its 403: the page latches, and the next bare open has no token to send', { skip }, async () => {
  const b = await withBoard({ token: 'not-the-token', chromium: gate.chromium })
  try {
    await b.page.waitForSelector('main.forbidden', { timeout: 15_000 })
    assert.equal(await b.page.evaluate(() => localStorage.getItem('trocar.token')), null)
    const p = await open(b.page.context(), b.url + '/#/overview')
    try { assert.equal(p.forbidden, 1) } finally { await p.page.close() }
  } finally { await b.stop() }
})
