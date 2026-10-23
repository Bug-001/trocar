// test/web-v2/browser/desk-reads.test.mjs — 2.3 #25 on the mounted desk (§读与画 快速拖动), in the real Chrome with the page's clock
// faked and the session reads answered from a generated world (desk-world.mjs, the reference server of 3.5 §会话读): a scrub at one
// key per frame sends no `block` or `lane` read before the playhead has rested 100 ms, at most one read of each kind is ever in
// flight, and the read of a step the playhead left is aborted. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { QUERIES } from '../../../src/query/named/index.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const kindOf = (url) => (/\/api\/(block|lane)\b/.exec(new URL(url).pathname) || [])[1] || null

// the board's session reads answered from world `w` (the face itself answers everything else)
async function serveWorld(page, w) {
  const json = (route, doc) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
  await page.route('**/api/session?**', (route) => { const q = new URL(route.request().url()).searchParams; json(route, q.has('since') ? w.since(q.get('since')) : w.full()) })
  await page.route('**/api/lane?**', (route) => { const q = new URL(route.request().url()).searchParams; json(route, w.lane(q.get('lane'), { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, ledger: q.get('ledger') ?? undefined })) })
}

test('2.3 #25: scrubbing the desk reads nothing before a 100 ms rest, keeps ≤ 1 lane and ≤ 1 block in flight, aborts the left step\'s read', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium, setup: (page) => page.clock.install() })
  try {
    const { page } = b, w = world(7, { calls: 60 })
    // every block / lane read the page starts, with how many of its kind were out at that moment
    const out = { block: 0, lane: 0 }, log = []
    let hold = false
    const held = []
    page.on('request', (r) => { const k = kindOf(r.url()); if (k) { out[k]++; log.push({ k, r, inFlight: out[k], aborted: false }) } })
    const end = (aborted) => (r) => { const x = log.find((e) => e.r === r); if (x) { out[x.k]--; x.aborted = aborted } }
    page.on('requestfinished', end(false)); page.on('requestfailed', end(true))
    await serveWorld(page, w)
    await page.route('**/api/block?**', (route) => {
      if (hold) { held.push(route); return }
      const refs = new URL(route.request().url()).searchParams.getAll('ref')
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: refs.map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) })
    })
    await page.route('**/api/lane?**', (route) => { if (hold) held.push(route); else route.fallback() })

    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    await page.waitForFunction(() => !document.querySelector('#ctxwin [aria-busy="true"]'))
    await page.waitForLoadState('networkidle')
    // from here the page's time moves only when the test moves it
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
    await page.waitForLoadState('networkidle')
    const n = await page.evaluate(() => +((document.querySelector('#stepbar .sb-no').textContent.match(/\/\s*(\d+)/) || [])[1]))
    assert.ok(n >= 6, `the world's main lane has steps to scrub (${n})`)

    const mark = log.length
    for (let i = 0; i < Math.min(n - 2, 12); i++) { await page.keyboard.press('ArrowLeft'); await page.clock.runFor(16) }
    await page.clock.runFor(84) // the last key is 100 ms back less one frame: not rested yet
    await page.waitForTimeout(300) // real time for any read the page started to reach the request log
    assert.deepEqual(log.slice(mark).map((e) => e.r.url()), [], 'no step read while the playhead moves')

    hold = true
    await page.clock.runFor(32) // rested: the step's own reads go out (its lane, or its open rows' bodies)
    await page.waitForTimeout(300)
    const rested = log.slice(mark)
    assert.ok(rested.length > 0, 'the rested step reads what it lacks')
    // the reader moves on while that read is out: it is aborted
    await page.keyboard.press('ArrowLeft'); await page.clock.runFor(16)
    await page.waitForTimeout(300)
    assert.ok(rested.every((e) => e.aborted), `the left step's reads were aborted: ${rested.map((e) => `${e.k} ${e.aborted}`)}`)
    hold = false
    for (const r of held) await r.fallback().catch(() => {}) // an aborted request has nothing to continue
    await page.clock.runFor(200)
    await page.waitForTimeout(300)
    for (const e of log) assert.ok(e.inFlight <= 1, `a second ${e.k} read went out while one was in flight`)
    // 3.5 · 1.6 C.5: a step read names only its query's parameters (the real server refuses any other: `block` takes --ref alone)
    assert.ok(log.some((e) => e.k === 'block'), 'the rested steps read some bodies')
    const extra = log.flatMap((e) => [...new Set(new URL(e.r.url()).searchParams.keys())].filter((k) => !QUERIES[e.k].params.includes(k)).map((k) => `${e.k} ${k}`))
    assert.deepEqual([...new Set(extra)], [])
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.3 §读失败 · K-29 on the mounted desk: a lane read that fails never turns drawn steps into empty frames, and says why in place
test('2.3 §读失败: a worker restart whose lane re-read fails keeps the drawn window and says so in the header; the next poll re-reads', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(11, { calls: 30 })
    let restarted = false, laneDown = false
    await serveWorld(page, w)
    // after the restart every `since` is answered in full (the worker does not know the mark), and lane reads fail while down
    await page.route('**/api/session?**', (route) => (restarted && new URL(route.request().url()).searchParams.has('since')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(w.full()) }) : route.fallback()))
    await page.route('**/api/lane?**', (route) => (laneDown ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the worker exited' }) }) : route.fallback()))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#ctxwin .cblk', { state: 'attached' })
    const rows = await page.locator('#ctxwin .cblk').count()
    restarted = true; laneDown = true
    await page.waitForSelector('#deskhead .fidstale', { timeout: 15000 })
    assert.equal(await page.locator('#ctxwin [aria-busy="true"], #ctxwin [data-fail]').count(), 0, 'no empty frame, no failure over drawn steps')
    assert.equal(await page.locator('#ctxwin .cblk').count(), rows, 'the drawn rows stay')
    laneDown = false
    await page.waitForSelector('#deskhead .fidstale', { state: 'detached', timeout: 20000 })
    assert.equal(await page.locator('#ctxwin .cblk').count(), rows)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

test('2.3 §读失败: a step whose lane never arrived says it could not be read, with Retry and the reason, never empty frames', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(11, { calls: 30 })
    let laneDown = true
    await serveWorld(page, w)
    await page.route('**/api/lane?**', (route) => (laneDown ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the worker exited' }) }) : route.fallback()))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#ctxwin [data-fail="lane"]', { timeout: 15000 })
    assert.equal(await page.locator('#ctxwin [aria-busy="true"]').count(), 0, 'the failure is not drawn as busy frames')
    assert.ok(await page.locator('#ctxwin [data-fail="lane"] [data-retry]').count(), 'Retry is in place')
    assert.match(await page.locator('#ctxwin [data-fail="lane"]').innerHTML(), /the worker exited/, 'the reason is in its technical details')
    laneDown = false
    await page.click('#ctxwin [data-fail="lane"] [data-retry]')
    await page.waitForSelector('#ctxwin .cblk', { state: 'attached', timeout: 15000 })
    assert.equal(await page.locator('#ctxwin [data-fail]').count(), 0)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// A32 · 3.5 §手里车道的页 (E4): after the first paint the anchor lane's ledger is read along its `ledger_next` chain, in the one
// lane slot, before any older (`to`) page of that lane; each read names the previous answer's cursor, none is read twice
test('A32: the anchor lane reads its ledger chain to the end before any older page, one lane read in flight, no cursor twice', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(7, { calls: 60 })
    const main = w.full().lanes.find((h) => h.kind === 'main').lane
    // the anchor's whole ledger in key order, one entry per page after the tail's first
    const L = w.ledgerAt(main), all = [...L.resources.map((e) => ['resources', e]), ...L.seen.map((e) => ['seen', e])]
    assert.ok(all.length >= 3, `the world's main lane has a ledger to chain (${all.length})`)
    const page1 = (from, at) => ({ resources: from.slice(at, at + 1).filter(([l]) => l === 'resources').map(([, e]) => e), seen: from.slice(at, at + 1).filter(([l]) => l === 'seen').map(([, e]) => e) })
    const next = (i) => (i < all.length ? `c${i}` : null)
    const log = []
    let out = 0, most = 0
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/lane') { out++; most = Math.max(most, out); log.push(new URL(r.url()).searchParams) } })
    const end = (r) => { if (new URL(r.url()).pathname === '/api/lane') out-- }
    page.on('requestfinished', end); page.on('requestfailed', end)
    await serveWorld(page, w)
    const json = (route, doc) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
    await page.route('**/api/lane?**', (route) => {
      const q = new URL(route.request().url()).searchParams
      if (q.get('lane') !== main) return route.fallback()
      const c = q.get('ledger')
      if (c != null && /^c\d+$/.test(c)) { const i = +c.slice(1); return json(route, { ...w.lane(main, {}), steps: [], defs: [], events: [], prev: null, next: null, ...page1(all, i), ledger_next: next(i + 1) }) }
      if (c != null || q.has('from') || q.has('to')) return route.fallback()
      return json(route, { ...w.lane(main, {}), ...page1(all, 0), ledger_next: next(1) })
    })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#ctxwin .cblk', { state: 'attached' })
    const mine = () => log.filter((q) => q.get('lane') === main)
    const t0 = Date.now()
    while (Date.now() - t0 < 15000 && !mine().some((q) => q.has('to'))) await page.waitForTimeout(100)
    const seq = mine()
    const tail = seq.findIndex((q) => !q.has('from') && !q.has('to') && !q.has('ledger'))
    const firstTo = seq.findIndex((q) => q.has('to'))
    const ledgers = seq.map((q, i) => [i, q.get('ledger')]).filter(([, c]) => c != null)
    assert.ok(tail >= 0, 'the anchor lane was read')
    assert.ok(firstTo >= 0, 'the world\'s main lane has older pages, read once the chain ends')
    // the chain the tail opened, all of it before the first older page (an older page's own ledger_next is chained after it)
    const chain = ledgers.filter(([i]) => i < firstTo)
    assert.deepEqual(chain.map(([, c]) => c), all.slice(1).map((_, i) => `c${i + 1}`), 'each ledger read names the previous answer\'s ledger_next, to the end')
    assert.ok(chain.every(([i]) => i > tail), 'after the tail read')
    assert.equal(new Set(ledgers.map(([, c]) => c)).size, ledgers.length, 'no cursor read twice')
    assert.ok(most <= 1, `${most} lane reads were in flight at once`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
