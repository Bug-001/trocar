// test/web-v2/browser/desk-reads.test.mjs — 2.3 #25 on the mounted desk (§读与画 快速拖动), in the real Chrome with the page's clock
// faked and the answer files served from a generated world (desk-world.mjs, the reference server of 3.5 §会话读): a scrub at one
// key per frame sends no `block` read before the playhead has rested 100 ms, at most one is ever in flight, and the read of a step the
// playhead left is aborted; a following desk shows a call that lands, read by Range on the open tail (4.4 live-poll); a failed poll round
// keeps the drawn window (2.3 §读失败); the anchor lane's ledger chain (A32). Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe, withBoard, serveWorld } from './harness.mjs'
import { world } from '../desk-world.mjs'
import { QUERIES } from '../../../src/query/named/index.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const kindOf = (url) => (/\/api\/(block)\b/.exec(new URL(url).pathname) || [])[1] || null

test('2.3 #25: scrubbing the desk reads nothing before a 100 ms rest, keeps ≤ 1 block in flight, aborts the left step\'s read', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium, setup: (page) => page.clock.install() })
  try {
    const { page } = b, w = world(7, { calls: 60 })
    // every block / lane read the page starts, with how many of its kind were out at that moment
    const out = { block: 0 }, log = []
    let hold = false
    const held = []
    page.on('request', (r) => { const k = kindOf(r.url()); if (k) { out[k]++; log.push({ k, r, inFlight: out[k], aborted: false }) } })
    const end = (aborted) => (r) => { const x = log.find((e) => e.r === r); if (x) { out[x.k]--; x.aborted = aborted } }
    page.on('requestfinished', end(false)); page.on('requestfailed', end(true))
    // every sealed pack answered: the loader has brought the whole history (2.3 加载器)
    const files = 2 * w.files(w.now, 8).head.packs.length, got = new Set()
    let historyIn = false
    page.on('response', (r) => { const u = new URL(r.url()); if (/^\/api\/d\/p\d/.test(u.pathname) && r.status() === 200) { got.add(u.pathname); historyIn = got.size === files } })
    await serveWorld(page, w, { pack: 8 })
    await page.route('**/api/block?**', (route) => {
      if (hold) { held.push(route); return }
      const refs = new URL(route.request().url()).searchParams.getAll('ref')
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ blocks: refs.map((ref) => ({ ref, bytes: 'x', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] }) })
    })

    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#stepbar .sb-no')
    await page.waitForFunction(() => !document.querySelector('#ctxwin [aria-busy="true"]'))
    for (const t0 = Date.now(); !historyIn && Date.now() - t0 < 15000;) await page.waitForTimeout(50) // the drag runs over a history all in hand
    assert.ok(files >= 4 && historyIn, `every pack came in (${got.size} of ${files})`)
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
    await page.clock.runFor(32) // rested: the step's own read goes out (its open rows' bodies)
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

// 4.4 live-poll · 1.2「跟随最新」: a call that lands is read by Range on the open tail (never the whole file again) and the following desk shows it
test('4.4 live-poll: a following desk shows each new call after it lands, read by Range on the open tail', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(11, { calls: 30 }), main = w.files(w.now, 8).head.axis, steps = (k) => w.files(w.marks[k], 8).head.steps
    // from a mark with a few main steps still to come; each head read moves the world on by one member
    let from = w.marks.length - 1
    while (from > 0 && steps(from - 1) >= steps(w.marks.length - 1) - 3) from--
    from--
    assert.ok(main && steps(from) < steps(w.marks.length - 1), 'the world grows its main lane after the start mark')
    const growth = await serveWorld(page, w, { from, grow: 1 })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    const total = () => page.evaluate(() => +((document.querySelector('#stepbar .sb-no')?.textContent.match(/\/\s*(\d+)/) || [])[1] || 0))
    await page.waitForSelector('#stepbar .sb-no')
    const first = await total()
    for (const t0 = Date.now(); growth.left() > 0 && Date.now() - t0 < 30000;) await page.waitForTimeout(100)
    await page.waitForFunction((n) => +((document.querySelector('#stepbar .sb-no')?.textContent.match(/(\d+)\s*\/\s*(\d+)/) || [])[1] || 0) === n, steps(w.marks.length - 1), { timeout: 10000 })
    const shown = await page.evaluate(() => document.querySelector('#stepbar .sb-no').textContent)
    assert.ok(first < (await total()), `the step count grew from ${first} (${shown})`)
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('step')), null, 'still following')
    const tails = b.requests.filter((r) => r.url.startsWith('/api/d/open.main?'))
    assert.ok(tails.filter((r) => r.status === 206).length > 0, 'new lines came by Range (206)')
    assert.ok(tails.slice(1).every((r) => r.range != null), 'after the first read every tail read is a Range read')
    // 2.3 加载器 · A32: the anchor lane grew, so its ledger moves on by `lane --from <the tip it stood at>` (its steps came from the tail);
    // each such read starts from a different tip, and there are no more of them than head answers that brought the lane new steps
    const froms = b.requests.filter((r) => r.url.startsWith('/api/lane?')).map((r) => new URLSearchParams(r.url.split('?')[1]))
      .filter((q) => q.get('lane') === main && q.get('from') != null).map((q) => q.get('from'))
    const grew = b.requests.filter((r) => r.url.startsWith('/api/d/head?') && r.status === 200).length - 1
    assert.ok(froms.length >= 1, 'the grown anchor lane\'s ledger is read on by `lane --from`')
    assert.equal(new Set(froms).size, froms.length, `no tip read on twice: ${froms}`)
    assert.ok(froms.length <= grew, `${froms.length} ledger reads for ${grew} head answers that grew the session`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 4.4 §答案文件 代标签: the worker renamed a new render of open.main in (its axis lane changed, a rebuilt fold log) whose line boundary
// falls at exactly the offset the desk holds; the desk's If-Range read gets the whole new file, so none of the old render stays
test('4.4 §答案文件: a tail replaced by a render with a line boundary at the held offset leaves the desk holding the new file only', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(11, { calls: 30 }), f = w.files(w.now, 32), n = f.head.open.n
    const line = (x) => JSON.stringify(x) + '\n', main = f.head.axis
    const T = line(f.docHead({ tail: { n, part: 'main', s0: f.head.open.s0 } })) + f.open('main').flatMap(([, ls]) => ls).map(line).join('')
    // the old render: the new one's lines and one more main step (a keyframe copied under a rid the new render does not have)
    const steps = f.open('main').filter(([id]) => !id.startsWith('l:')).map(([, ls]) => ls)
    const key = steps.find((ls) => ls.some((x) => x.s && x.s.lane === main && x.s.parent == null))
    const lastTs = Math.max(...steps.map((ls) => Date.parse(ls[0].c.ts))), last = Math.max(...steps.flatMap((ls) => ls.filter((x) => x.s && x.s.lane === main).map((x) => x.s.i)))
    const { cacheBreak, ...row } = key[0].c, ks = key.find((x) => x.s).s
    let X = line({ c: { ...row, rid: 'old-render', ts: new Date(lastTs + 1000).toISOString() } }) + line({ s: { ...ks, rid: 'old-render', i: last + 1, events: [] } })
    // the new render past T: one line the desk already holds, so the two files are the same length and the new one ends on a line there
    let Y = T.split('\n').at(-2) + '\n'
    const pad = (t, k) => t.slice(0, -1) + ' '.repeat(k - t.length) + '\n', L = Math.max(X.length, Y.length)
    X = pad(X, L); Y = pad(Y, L)
    const files = { A: T + X, B: T + Y }
    assert.equal(files.A.length, files.B.length)
    let cur = 'A'
    await serveWorld(page, w, { pack: 32 })
    await page.route('**/api/d/open.main?**', (route) => {
      const req = route.request(), buf = Buffer.from(files[cur]), etag = `"${cur}"`, ir = req.headers()['if-range']
      const r = ir == null || ir === etag ? /^bytes=(\d+)-$/.exec(req.headers().range || '') : null
      if (!r) return route.fulfill({ status: 200, contentType: 'application/x-ndjson', headers: { etag }, body: buf })
      if (+r[1] >= buf.length) return route.fulfill({ status: 416, headers: { etag, 'content-range': `bytes */${buf.length}` }, body: '' })
      route.fulfill({ status: 206, contentType: 'application/x-ndjson', headers: { etag, 'content-range': `bytes ${r[1]}-${buf.length - 1}/${buf.length}` }, body: buf.subarray(+r[1]) })
    })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    // the following desk's playhead is on the anchor lane's newest step: its number (data-n) names how many steps the desk holds
    const at = () => page.evaluate(() => +(document.querySelector('#stepbar .sb-no')?.dataset.n || 0))
    await page.waitForFunction((m) => +(document.querySelector('#stepbar .sb-no')?.dataset.n || 0) === m, f.head.steps + 1, { timeout: 10000 })
      .catch(async (e) => { throw new Error(`the old render's extra step is not followed: ${await at()} for ${f.head.steps + 1} (${e.message})`) })
    const before = b.requests.length
    cur = 'B'
    // two poll rounds past the replace
    for (const t0 = Date.now(); b.requests.slice(before).filter((r) => r.url.startsWith('/api/d/open.main?')).length < 2 && Date.now() - t0 < 10000;) await page.waitForTimeout(100)
    await page.waitForTimeout(300)
    assert.equal(await at(), f.head.steps, 'the old render\'s step is gone: the desk holds the new file\'s steps only')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// 2.3 §读失败 · K-29 on the mounted desk: a poll round whose tail reads fail never turns drawn steps into empty frames, and says why in place
test('2.3 §读失败: a poll round whose tail reads fail keeps the drawn window and says so in the header; the next round reads on', { skip }, async () => {
  const b = await withBoard({ bytes: 1e5, chromium: gate.chromium })
  try {
    const { page } = b, w = world(11, { calls: 30 })
    let down = false
    await serveWorld(page, w)
    await page.route('**/api/d/open.**', (route) => (down ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the worker exited' }) }) : route.fallback()))
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#ctxwin .cblk', { state: 'attached' })
    const rows = await page.locator('#ctxwin .cblk').count()
    down = true
    await page.waitForSelector('#deskhead .fidstale', { timeout: 15000 })
    assert.equal(await page.locator('#ctxwin [aria-busy="true"], #ctxwin [data-fail]').count(), 0, 'no empty frame, no failure over drawn steps')
    assert.equal(await page.locator('#ctxwin .cblk').count(), rows, 'the drawn rows stay')
    down = false
    await page.waitForSelector('#deskhead .fidstale', { state: 'detached', timeout: 20000 })
    assert.equal(await page.locator('#ctxwin .cblk').count(), rows)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})

// A32 · 3.5 §手里车道的页 (E4): once the anchor lane is in hand its ledger is read — a `lane --to <its first step>` page (no step, the
// ledger at mark in its room), then along its `ledger_next` chain; each read names the previous answer's cursor, none is read twice, and
// once the counts are exact no 2.4 count goes back to the busy box
test('A32: the anchor lane reads its ledger chain to the end, one lane read in flight, no cursor twice', { skip }, async () => {
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
      if (c != null || !q.has('to')) return route.fallback()
      return json(route, { ...w.lane(main, { to: q.get('to') }), ...page1(all, 0), ledger_next: next(1) })
    })
    // once the chain has ended and the explorer drew no busy box, any busy box in it again is counted
    await page.evaluate(() => {
      window.__busyAgain = 0
      const busy = () => !!document.querySelector('#resexp [aria-busy="true"]')
      new MutationObserver(() => { if (window.__exact && busy()) window.__busyAgain++; else if (window.__chainEnd && !busy() && document.querySelector('#resexp .resz')) window.__exact = true })
        .observe(document.body, { subtree: true, childList: true, attributes: true })
    })
    page.on('requestfinished', (r) => { const q = new URL(r.url()).searchParams; if (q.get('lane') === main && q.get('ledger') === `c${all.length - 1}`) page.evaluate(() => { window.__chainEnd = true }).catch(() => {}) })
    await page.evaluate(() => { location.hash = '#/replay/p/S' })
    await page.waitForSelector('#ctxwin .cblk', { state: 'attached' })
    const mine = () => log.filter((q) => q.get('lane') === main)
    const t0 = Date.now()
    while (Date.now() - t0 < 30000 && !(await page.evaluate(() => window.__chainEnd === true))) await page.waitForTimeout(100)
    await page.waitForTimeout(500)
    const seq = mine()
    const start = seq.findIndex((q) => q.get('to') === main), ledgers = seq.map((q, i) => [i, q.get('ledger')]).filter(([, c]) => c != null)
    assert.ok(start >= 0, 'the ledger opens with the anchor lane\'s --to <its first step> page')
    assert.deepEqual(ledgers.map(([, c]) => c), all.slice(1).map((_, i) => `c${i + 1}`), 'each ledger read names the previous answer\'s ledger_next, to the end')
    assert.ok(ledgers.every(([i]) => i > start), 'after the opening page')
    assert.equal(new Set(ledgers.map(([, c]) => c)).size, ledgers.length, `no cursor read twice: ${ledgers.map(([, c]) => c)}`)
    assert.equal(await page.evaluate(() => window.__exact === true), true, 'the explorer\'s counts became exact')
    assert.equal(await page.evaluate(() => window.__busyAgain), 0, 'no count went back to the busy box')
    assert.ok(most <= 1, `${most} lane reads were in flight at once`)
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
