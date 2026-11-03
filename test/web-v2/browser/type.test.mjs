// test/web-v2/browser/type.test.mjs — 1.5 #16 (D77 ② ⑤) is not vacuous: on the real overview in the real Chrome typeFaults finds nothing,
// and each planted violation is caught as its own fault kind. Every screen runs the same check in screens.test.mjs and the replay desk's
// opened row and popovers in replay-shots.test.mjs. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'
import { typeFaults } from './type-inventory.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason

const PLANTS = [
  ['size', 'font-size:14px', 'Fourteen'],
  ['weight', 'font-weight:500', 'Medium'],
  ['spacing', 'letter-spacing:.05em', 'Spaced'],
  ['case', 'text-transform:uppercase', 'Loud'],
  ['family', 'font-family:Georgia,serif', 'Serif'],
  ['rendered', '', 'ⓘ'], // a glyph the two families do not have: Chrome falls back to a third font
]

test('the overview has no type fault, and each planted violation is its own fault kind (1.5 #16)', { skip, timeout: 120_000 }, async () => {
  const b = await withBoard({ chromium: gate.chromium })
  try {
    const { page } = b
    await page.evaluate(() => { location.hash = '#/overview' })
    await page.waitForSelector('.ovcard .ovitem, .ovcard .ovempty')
    await page.waitForLoadState('networkidle')
    const clean = await typeFaults(page)
    console.log(`# type inventory (overview): ${JSON.stringify(clean.inventory)}`)
    assert.deepEqual(clean.faults, [])
    for (const [kind, css, text] of PLANTS) {
      await page.evaluate(([css, text]) => {
        const s = document.createElement('span')
        s.id = 'planted'; s.style.cssText = `position:fixed;left:300px;top:300px;${css}`; s.textContent = text
        document.querySelector('#app').append(s)
      }, [css, text])
      const kinds = new Set((await typeFaults(page)).faults.map((f) => f.kind))
      assert.ok(kinds.has(kind), `${kind}: ${[...kinds]}`)
      await page.evaluate(() => document.getElementById('planted').remove())
    }
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
