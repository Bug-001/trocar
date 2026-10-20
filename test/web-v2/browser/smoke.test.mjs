// test/web-v2/browser/smoke.test.mjs — the board loads in the real Chrome without a page error (D64⑤), and the browser suite skips
// with a printed reason wherever it cannot run (D38: not silently). Only `npm run test:browser` runs the browser cases.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, shoot } from './harness.mjs'

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
    { env: { ASIGHT_PLAYWRIGHT: '1' }, importer: () => { throw new Error('x') } },
    { env: { ASIGHT_PLAYWRIGHT: '1' }, importer: async () => ({ chromium: { launch: async () => { throw new Error('no chrome') } } }) },
  ]
  for (const c of absent) {
    const r = await probe(c)
    assert.equal(r.ok, false)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
  assert.equal(imported, 0)
  assert.equal(launched, 0)
})
