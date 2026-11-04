// test/web-v2/browser/step-perf.test.mjs — a step change on the replay desk (D64② · 1.2 §键盘), on the real face in the real
// Chrome: a step change sends no request, the step bar and the brush show a focus ring, and the ms are printed against BOARD_LINES (never asserted,
// D64⑥: acceptance numbers come from the test machines, not this one). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld, stats, timed, timerReads } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { INTERVAL } from '../../../web/legacy/core/poll.mjs'
import { BOARD_LINES } from '../perf-lines.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const BYTES = 5e6
const samples = { stepClick: [], stepKey: [], longReply: [] }

const stepNo = async (page) => (await page.textContent('#stepbar .sb-no')).match(/(\d+)\s*\/\s*(\d+)/).slice(1).map(Number)

// open a session from the library by a real click; `id` = that session, or the first row
async function openSession(page, id) {
  await page.evaluate(() => { location.hash = '#/sessions' })
  await page.waitForSelector('.lrow')
  const all = page.locator('.pagehead a', { hasText: 'All' }).first()
  if (await all.count()) { await all.click(); await page.waitForSelector('.lrow') }
  const row = id ? page.locator(`.lrow[href*="/${encodeURIComponent(id)}"]`).first() : page.locator('.lrow').first()
  await row.click()
  await page.waitForSelector('#stepbar .sb-no')
  await page.waitForFunction(() => !document.querySelector('#ctxwin .cwload'))
  await page.waitForLoadState('networkidle')
}

// one step change by a click on the step bar or by ←/→, bouncing between the first and the last step; null when there is one step
async function stepOnce(page, by, bounce) {
  const [n, m] = await stepNo(page)
  if (m === 1) return null
  if (n === 1) bounce.dir = 1
  if (n === m) bounce.dir = -1
  const prev = await page.textContent('#stepbar .sb-no')
  const act = by === 'click'
    ? () => page.click(`#stepbar .sbbtn[data-step="${bounce.dir < 0 ? 'prev' : 'next'}"]`)
    : () => page.keyboard.press(bounce.dir < 0 ? 'ArrowLeft' : 'ArrowRight')
  return timed(page, 'step', prev, act)
}
const isHead = (r) => r.url.startsWith('/api/d/head?')

// 1.4 §D64: a step change sends no request; the open session's live-poll round (4.4 §live-poll) is the timer's, not a step change's. Where
// the timer stands when the steps begin depends on how long the opening round took (a next round 1.5 s or 3x that duration after it), so
// the steps go on until a round has begun among them and four more follow it: every machine checks the same thing
test('D64②: 20 step changes by click and 20 by ←/→ send no request; a live-poll round among them is the timer\'s', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  try {
    await openSession(b.page, null)
    const t0 = Date.now(), bounce = { dir: -1 }
    for (const [kind, by] of [['stepClick', 'click'], ['stepKey', 'key']]) {
      for (let i = 0; i < 20; i++) { const ms = await stepOnce(b.page, by, bounce); if (ms == null) break; samples[kind].push(ms) }
    }
    const round = () => b.requests.some((r) => r.start >= t0 && isHead(r))
    for (const until = Date.now() + 20 * INTERVAL.session; !round() && Date.now() < until;) await stepOnce(b.page, 'key', bounce)
    for (let i = 0; i < 4; i++) await stepOnce(b.page, 'click', bounce)
    await b.page.waitForLoadState('networkidle')
    const during = b.requests.filter((r) => r.start >= t0), timerRead = await timerReads(b)
    console.log(`# requests while stepping: ${during.length}, of them the timers': ${during.filter(timerRead).length}`)
    assert.ok(samples.stepClick.length > 0 && samples.stepKey.length > 0, 'the session has more than one step')
    assert.ok(during.some(isHead), 'a live-poll round began among the step changes')
    // the heads are the timer's rounds: each at least the poll period after the one before it (the opening round's included)
    const heads = b.requests.filter(isHead).map((r) => r.start)
    for (let i = 1; i < heads.length; i++) assert.ok(heads[i] - heads[i - 1] >= INTERVAL.session - 50, `head ${i} came ${Math.round(heads[i] - heads[i - 1])} ms after the one before it`)
    assert.deepEqual(during.filter((r) => !timerRead(r)).map((r) => r.url), [])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('1.2 §键盘: Tab reaches the step bar and the brush, and each shows an outline', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  try {
    await openSession(b.page, null)
    const seen = new Set()
    for (let i = 0; i < 200 && seen.size < 2; i++) {
      await b.page.keyboard.press('Tab')
      const hit = await b.page.evaluate(() => {
        const a = document.activeElement
        const where = a && a.closest('#stepbar') ? 'stepbar' : a && a.id === 'ovbrush' ? 'brush' : null
        return where && { where, outline: getComputedStyle(a).outlineStyle }
      })
      if (hit && !seen.has(hit.where)) { assert.notEqual(hit.outline, 'none', `${hit.where} has a focus ring`); seen.add(hit.where) }
    }
    assert.deepEqual([...seen].sort(), ['brush', 'stepbar'])
  } finally { await b.stop() }
})

// 1.2 §键盘: `?` opens the desk's key list, a layer of the desk; Back to the library leaves the desk, and no dialog stays over the library
test('1.2 §键盘: the ? key list closes when the desk is left for another screen', { skip }, async () => {
  const b = await withBoard({ bytes: BYTES, chromium: gate.chromium })
  try {
    await openSession(b.page, null)
    await b.page.keyboard.press('?')
    await b.page.waitForSelector('[role=dialog][aria-modal=true]')
    await b.page.goBack()
    await b.page.waitForSelector('.lrow')
    assert.equal(await b.page.locator('[role=dialog][aria-modal=true]').count(), 0)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.3 #43's reply: 20,000 characters, one slice of the cell, ending in a table that holds `word`
function longReply(word) {
  const row = (i) => `| ${i} | 第 ${i} 行的说明 | \`value-${i}\` |`
  const section = (i) => [`## Section ${i}`, 'A paragraph with **bold** words, a [link](https://example.com/a) and `code`. 这一段说明这一步做了什么，以及为什么这样做。',
    '- first point\n- second point\n  - a nested point\n- third point', '```js\nconst value = compute(input)\nif (!value) throw new Error(\'no value\')\nreturn value\n```',
    `| n | what | key |\n|---|---|---|\n${[1, 2, 3].map(row).join('\n')}`].join('\n\n') + '\n\n'
  let text = ''
  for (let i = 1; text.length < 19600; i++) text += section(i)
  return `${text}| end |\n|---|\n| ${word} |\n`
}

// D64②: a step is counted once it is completely drawn. The reader has rested on the step before, so the prefetch brought this one's body
// (2.3 §正文预取), and every long reply is another text: each step pays its own parse, in both directions but the last few
test('2.3 #43 · D64②: ←/→ onto a step whose reply is 20,000 characters of markdown draws it whole within the line', { skip }, async () => {
  const w = world(5, { calls: 120, page: 200 })
  const main = w.full().lanes.find((l) => l.kind === 'main').lane, doc = w.lane(main), refOf = new Map(doc.defs.map((d) => [d.bid, d.ref]))
  const failed = new Set(w.full(w.now, { limit: 0 }).calls.filter((c) => c.status !== 200).map((c) => c.rid))
  const word = new Map(), text = new Map() // step number → the word its reply ends in; ref → that reply
  doc.steps.forEach((st, i) => {
    const ref = refOf.get(st.reply[0])
    if (!ref || failed.has(st.rid)) return
    word.set(i + 1, `reply-of-step-${i + 1}`)
    text.set(ref, longReply(word.get(i + 1)))
  })
  assert.ok(word.size >= 8, 'the world has steps with a reply')
  for (const t of text.values()) assert.ok(t.length > 19500 && t.length <= 20000, `the reply is ${t.length} characters`)
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b
    await serveWorld(page, w)
    await page.route('**/api/block?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 2, command: 'block', ok: true, errors: [],
      blocks: new URL(route.request().url()).searchParams.getAll('ref').map((ref) => { const t = text.get(ref) ?? `body of ${ref}`
        return { ref, bytes: t, view: { r: { as: 'markdown', f: { body: ['text'] } }, body: { text: t } }, encoding: 'utf8', fidelity: 'verbatim', truncated: false } }) }) }))
    await page.evaluate(() => { location.hash = '#/replay/p/S?step=1' })
    await page.waitForSelector('#stepbar .sb-no')
    const go = async (key, n) => {
      await page.waitForTimeout(150) // the rest
      await page.waitForLoadState('networkidle')
      const prev = await page.textContent('#stepbar .sb-no'), press = () => page.keyboard.press(key)
      if (word.has(n)) samples.longReply.push(await timed(page, 'reply', [prev, word.get(n)], press))
      else await timed(page, 'step', prev, press)
    }
    for (let n = 2; n <= doc.steps.length; n++) await go('ArrowRight', n)
    for (let n = doc.steps.length - 1; n >= 1; n--) await go('ArrowLeft', n)
    assert.deepEqual(b.errors, [])
    const { p95 } = stats(samples.longReply)
    assert.ok(p95 <= BOARD_LINES.stepClick, `a long reply's step change p95 ${p95.toFixed(1)} ms over the ${BOARD_LINES.stepClick} ms line`)
  } finally { await b.stop() }
})

// D64④⑥: p50 and p95 next to the line, printed; this run is a baseline — acceptance numbers come from the test machines, not from it (PR 6)
test.after(() => {
  for (const [k, v] of Object.entries(samples)) {
    if (!v.length) continue
    const { p50, p95 } = stats(v)
    console.log(`# D64 ${k}: n=${v.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${Math.max(...v).toFixed(1)} ms line=${BOARD_LINES.stepClick} ms ${p95 <= BOARD_LINES.stepClick ? 'within' : 'OVER'}`)
  }
})
