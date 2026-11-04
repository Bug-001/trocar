// test/web-v2/browser/harness.mjs — the one browser harness (D64⑤): the real face (test/web-v2/real-face.mjs) on a temp HOME, the
// system Google Chrome through playwright-core (channel:'chrome', no browser download), marks / measures and shots. Exports only:
// node --test runs every .mjs, so nothing here runs at import. The browser suite runs only under `npm run test:browser`
// (TROCAR_PLAYWRIGHT=1); anywhere else probe() says why it is not ok and the cases skip with that reason.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardHome, serveBoard } from '../real-face.mjs'
import { tmpDir, removeTmp } from '../../helpers/tmp.mjs'
import rm from '../../helpers/rm-tree.cjs'
import { CONTROL_TOKEN_HEADER } from '../../../src/off/token-header.mjs'
import { INTERVAL, TIMER_ROUND } from '../../../web/legacy/core/poll.mjs'

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
const CHANNEL = { channel: 'chrome' }

/** Before `t.close()` runs, every route on what `routed()` lists is dropped with behavior 'ignoreErrors': a handler still awaiting
 *  route.fetch when its page goes would otherwise reject with nobody to await it, an unhandled rejection that fails whichever case runs. */
function closeQuietly(t, routed) {
  const close = t.close.bind(t)
  t.close = async (...a) => {
    for (const x of routed()) { try { await x.unrouteAll({ behavior: 'ignoreErrors' }) } catch { /* already closed */ } }
    return close(...a)
  }
}

/** Chrome on Windows learns whether the account's password is blank by logging on with an empty one (LogonUser, interactive), soon after
 *  start, and caches the answer in the profile's Local State under these two keys; it tries again only once the password changes after
 *  `os_password_last_changed` (Chrome time, µs since 1601). A fresh profile has no cache, so every launch made one failed logon, and the ten
 *  launches of one browser file in ten minutes locked the account out (Security log 4625 then 4740), ssh with it. The cached answer, dated
 *  at the largest value, means no launch ever tries; other systems never read the keys. */
const LOCAL_STATE = { password_manager: { os_password_blank: false, os_password_last_changed: '9223372036854775807' } }

/** The system Chrome (`chromium` is playwright-core's), with a temp directory of its own as TMP / TEMP / TMPDIR and as the parent of its
 *  profile (seeded with LOCAL_STATE): what it leaves there (on Windows a chrome_url_fetcher_* folder) goes once close() has seen Chrome
 *  exit (at 'disconnected' Windows Chrome still holds profile files), never into the run's temp directory, which leak-guard checks; what
 *  is still held then, or a browser never closed, goes when the process exits (tmpDir). Closing the browser, any context or any page of
 *  it first drops the routes on what closes (closeQuietly). */
export async function launchChrome(chromium) {
  const tmp = tmpDir('trocar-chrome-')
  const profile = path.join(tmp, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify(LOCAL_STATE))
  const browser = (await chromium.launchPersistentContext(profile, { ...CHANNEL, env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp } })).browser()
  const close = browser.close.bind(browser)
  browser.close = async (...a) => {
    try { return await close(...a) } finally {
      rm.removeTree(tmp)
      if (!fs.existsSync(tmp)) removeTmp(tmp)
    }
  }
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...a) => {
    const c = await newContext(...a)
    c.on('page', (p) => closeQuietly(p, () => [p]))
    closeQuietly(c, () => [c, ...c.pages()])
    return c
  }
  closeQuietly(browser, () => browser.contexts().flatMap((c) => [c, ...c.pages()]))
  return browser
}

/** { ok:true, chromium } when the browser suite may run here; { ok:false, reason } otherwise (the reason is printed). */
export async function probe({ importer = () => import('playwright-core'), env = process.env } = {}) {
  const no = (reason) => { console.log(`# browser suite skipped: ${reason}`); return { ok: false, reason } }
  if (env.TROCAR_PLAYWRIGHT !== '1') return no('TROCAR_PLAYWRIGHT is not 1 (run it with `npm run test:browser`)')
  let chromium
  try { chromium = (await importer()).chromium } catch (e) { return no(`playwright-core is not installed: ${e?.message || e}`) }
  try { await (await launchChrome(chromium)).close() } catch (e) { return no(`Google Chrome did not launch: ${String(e?.message || e).split('\n')[0]}`) }
  return { ok: true, chromium }
}

const isHead = (r) => r.url.startsWith('/api/d/head?')
const tailPart = (r) => (/^\/api\/d\/open\.(\w+)\?/.exec(r.url) || [])[1]
/** → a predicate of the logged requests a timer sent by itself (4.4 §live-poll), not one a reader's action caused: the session list,
 *  status and price reads, and the open session's rounds, tied to the marks the poll engine sets as a timer round starts (core/poll.mjs
 *  TIMER_ROUND): a round's head is the first head read within a third of the period after its mark, and its tails are the first Range
 *  read of each open tail after that head and before the next mark (a read again after a 416, readTail's, too). Any other head or tail
 *  read — one a step change sent, however long after the last round — is not the timer's. */
export async function timerReads(b) {
  const marks = (await b.page.evaluate(() => globalThis.__timerRounds || [])).filter((m) => m.base === INTERVAL.session).map((m) => m.at).sort((x, y) => x - y)
  const byStart = (x, y) => x.start - y.start
  const heads = b.requests.filter(isHead).sort(byStart), tails = b.requests.filter((r) => tailPart(r)).sort(byStart)
  const timer = new Set()
  marks.forEach((m, i) => {
    const h = heads.find((r) => !timer.has(r) && r.start >= m - 50 && r.start <= m + INTERVAL.session / 3)
    if (!h) return
    timer.add(h)
    const end = i + 1 < marks.length ? marks[i + 1] : Infinity, last = {}
    for (const r of tails) {
      if (r.start <= h.start || r.start >= end) continue
      const part = tailPart(r), prev = last[part]
      if (prev === undefined ? r.range != null : prev.status === 416) { timer.add(r); last[part] = r } else last[part] = { status: 0 }
    }
  })
  return (r) => /^\/api\/(sessions|status|pricing)\b/.test(r.url) || timer.has(r)
}

/** The board on a fresh temp HOME in a fresh Chrome. `token`: true = the face's token, a string = that token, false = no fragment.
 *  `missing` lists every static file answered ≥ 400 (`<status> <path>`).
 *  `idleMs`: the face's query worker idles out after that many ms (the service's default when absent).
 *  `setup(page)` runs before the first navigation (routes a case must hold from the first request on).
 *  `home`: a prebuilt {userHome, home} served instead of boardHome({bytes}). `base`: an external board's URL carrying `#t=<token>` — no
 *  face is started (`face` is null) and `get` reads that board with the token header.
 *  `requests` logs every /api (the answer files /api/d/* too) and /control response as {url, method, body (the request's post data, or null), range (its Range header, or null), status, start (ms epoch the request began), t (ms epoch it answered)}; `errors` collects pageerrors; `get(name, params)` reads the face directly (no page, no request log). Always `await stop()`. */
export async function withBoard({ bytes, home, base, idleMs, token = true, width = 1280, height = 900, theme = 'light', chromium, setup } = {}) {
  chromium ||= (await import('playwright-core')).chromium
  const face = base ? null : await serveBoard({ ...(home || boardHome({ bytes })), idleMs })
  const ext = base && new URL(base), extToken = ext && new URLSearchParams(ext.hash.slice(1)).get('t')
  const get = face ? face.get : async (name, params = {}) => {
    const r = await fetch(new URL(`/api/${name}?${new URLSearchParams(params)}`, ext.origin), { headers: { [CONTROL_TOKEN_HEADER]: extToken } })
    const body = await r.text()
    let doc = null
    try { doc = JSON.parse(body) } catch { /* not JSON: doc stays null */ }
    return { status: r.status, doc }
  }
  const requests = []
  const errors = []
  const missing = []
  let browser, context, page
  const stop = async () => {
    try { await page?.close() } finally {
      try { await context?.close() } finally {
        try { await browser?.close() } finally { await face?.close() }
      }
    }
  }
  try {
    browser = await launchChrome(chromium)
    context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
    page = await context.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    // TROCAR_CPU_RATE=<n>: the page's CPU slowed n times (CDP), for report-only runs on a slower machine's footing
    const rate = Number(process.env.TROCAR_CPU_RATE)
    if (rate > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate })
    page.on('response', (r) => {
      const u = new URL(r.url())
      if (!/^\/(api|control)\//.test(u.pathname) && r.status() >= 400) missing.push(`${r.status()} ${u.pathname}`) // a static file the page asked for and did not get (a /favicon.ico once)
      if (/^\/(api|control)\//.test(u.pathname)) requests.push({ url: u.pathname + u.search, method: r.request().method(), body: r.request().postData(), range: r.request().headers().range ?? null, status: r.status(), start: r.request().timing().startTime, t: Date.now() })
    })
    // the poll engine's timer-round marks (timerReads), seen as they are set: the engine drops each from the timeline at once
    await page.addInitScript((name) => {
      globalThis.__timerRounds = []
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === name) globalThis.__timerRounds.push({ at: performance.timeOrigin + e.startTime, base: e.detail && e.detail.base }) }).observe({ type: 'mark' })
    }, TIMER_ROUND)
    await setup?.(page)
    const t = token === true ? face?.token : token
    await page.goto(face ? `${face.base}/${t ? `#t=${encodeURIComponent(t)}` : ''}` : base, { waitUntil: 'load' })
  } catch (e) { await stop(); throw e }
  return { url: face ? face.base : ext.origin, get, face, page, stop, requests, errors, missing }
}

// the build the face serves: the desk-next build under `npm run test:browser -- --desk-next` (scripts/test-browser.mjs), else the default
export const DESK_NEXT = process.env.TROCAR_DESK_NEXT === '1'
export const mark = (page, name) => page.evaluate((n) => { performance.mark(n) }, name)
/** ms from `startMark` to now, recorded as measure `name`. */
export const measure = (page, name, startMark) => page.evaluate(([n, s]) => performance.measure(n, s).duration, [name, startMark])

/** In the page (no closure; also sent as source): the largest stretch (px) of #ctxwin's visible box that no drawn item covers, from the
 *  box's top to the nearer of its bottom and the last item's bottom (empty space below a short window is no gap), and one
 *  --cblk-pitch in px: { gap, pitch }. Drawn items are the window's units (2.3 §读与画, 1.4 白名单) and the legacy desk's group
 *  placeholder (rule 4 旧台, a drawn stand-in). A gap is a stretch taller than one pitch (row margins are smaller). No #ctxwin: an
 *  infinite gap. */
export function gapInPage() {
  const W = document.querySelector('#ctxwin')
  const probe = document.body.appendChild(document.createElement('div'))
  probe.style.cssText = 'position:absolute;visibility:hidden;height:var(--cblk-pitch)'
  const pitch = probe.offsetHeight
  probe.remove()
  if (!W) return { gap: Infinity, pitch }
  const box = W.getBoundingClientRect(), top = box.top + W.clientTop, bottom = top + W.clientHeight
  const sel = ['.cwfline', '.cwwin', '.cwsec', '.cwfoldall', '.chline', '.cwremoved', '.cwturn > .cwturnhd', '.cblk', '.cwreply', '.cwbusy',
    '.cwframe', '.cwnoreq', '.cwunparsed', '.empty', '.cwgroup[aria-busy]'].join(', ')
  const rs = [...W.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0)
  const end = Math.min(bottom, Math.max(top, ...rs.map((r) => r.bottom)))
  let at = top, gap = 0
  for (const r of rs.filter((r) => r.bottom > top && r.top < end).sort((a, b) => a.top - b.top)) {
    if (r.top > at) gap = Math.max(gap, r.top - at)
    at = Math.max(at, r.bottom)
  }
  return { gap: Math.max(gap, end - at), pitch }
}
export const windowGap = (page) => page.evaluate(gapInPage)

/** ms from the input `act` makes (its first pointerdown / keydown, marked by a listener armed and awaited before it, so the input can
 *  never outrun it) until `cond` holds and that frame has painted: 'replay' (a session's window drawn), 'step' (the step head no longer
 *  reads `arg` and the window is drawn), 'n' (the step head's number, data-n, is no longer `arg` and the window is drawn), 'sel'
 *  (selector `arg` matches), 'reply' (below). 'step', 'n' and 'reply' also wait for the visible box to be filled, in the same frame: no gap over one pitch
 *  (gapInPage; D64② a step counts once it is completely drawn). Rejects after 10 s. */
export async function timed(page, cond, arg, act) {
  await page.evaluate(() => {
    performance.clearMarks('in')
    const arm = () => { performance.mark('in'); removeEventListener('pointerdown', arm, true); removeEventListener('keydown', arm, true) }
    addEventListener('pointerdown', arm, true); addEventListener('keydown', arm, true)
  })
  await act()
  return page.evaluate(`(${([cond, a], gapOf) => new Promise((resolve, reject) => {
    const q = (s) => document.querySelector(s)
    const filled = () => { const g = gapOf(); return g.gap <= g.pitch }
    const holds = {
      replay: () => location.hash.startsWith('#/replay/') && !!q('#stepbar .sb-no') && !!q('#ctxwin') && !q('#ctxwin .cwload'),
      step: () => !!q('#stepbar .sb-no') && q('#stepbar .sb-no').textContent !== a && !q('#ctxwin .cwload') && filled(),
      n: () => !!q('#stepbar .sb-no') && +q('#stepbar .sb-no').dataset.n !== a && !q('#ctxwin .cwload') && filled(),
      sel: () => !!q(a),
      // a step's reply wholly drawn: the step head moved (a[0], as 'step'), the visible box is filled, and a table of the reply holds a[1]
      reply: () => !!q('#stepbar .sb-no') && q('#stepbar .sb-no').textContent !== a[0] && !q('#ctxwin .cwload') && filled()
        && [...document.querySelectorAll('#ctxwin .cwreply .md-table')].some((t) => t.textContent.includes(a[1])),
    }[cond]
    const t0 = performance.now()
    const tick = () => {
      if (performance.getEntriesByName('in').length && holds()) return setTimeout(() => resolve(performance.measure('m', 'in').duration), 0)
      if (performance.now() - t0 > 10000) return reject(new Error(`not drawn in 10 s: ${cond} ${a ?? ''} (input seen: ${performance.getEntriesByName('in').length > 0})`))
      requestAnimationFrame(tick)
    }
    tick()
  })})(${JSON.stringify([cond, arg])}, ${gapInPage})`)
}

/** The board's reads answered from desk-world `w` (desk-world.mjs, 3.5 §会话读's reference server) at the mark w.marks[k], k starting at
 *  `from` (default the last): the answer files /api/d/head (ETag, 304 on If-None-Match), /api/d/p<n>.<part> (`pack` members a pack) and
 *  /api/d/open.<part> (append-only: each read appends the lines of the open span that changed since the last one, `g` for a rid that
 *  left it; one generation tag per n; `Range: bytes=N-` → 206 or 416, an If-Range of another tag → 200, as 4.4 §答案文件), and `lane` (the ledger) and `block`. `grow` > 0: a session still being read
 *  for the first time (3.5 §归约前沿) — each head read moves k on by `grow` members, and every head before the last mark carries
 *  `pending: {done, total}`. `paced`: a head read moves k on only while a move granted by more(n) is left, so the growth follows
 *  the test's steps rather than the board's poll timer. `latency`: every answer waits that many ms first. → { left(), more(n) }: the
 *  members not reached yet; grant n more moves. */
export async function serveWorld(page, w, { from = w.marks.length - 1, grow = 0, latency = 0, pack = 32, paced = false } = {}) {
  const last = w.marks.length - 1
  let k = Math.min(from, last), at = null, f = null, granted = paced ? 0 : Infinity
  // every answer: `latency` ms, then the one fulfill of what `fn` makes of the request, returned to Playwright. Routes dropped while it
  // waited (stop's closeQuietly) leave Playwright to continue the request itself; the late fulfill then rejects ("Route is already
  // handled!") and Playwright ignores it for a route dropped with 'ignoreErrors'. Any other failure fails the case; a fulfill left
  // floating would instead fail whichever case is stopping. A request the page gave up on takes the fulfill without error.
  const answer = (pattern, fn) => page.route(pattern, async (route) => { await new Promise((r) => setTimeout(r, latency)); return route.fulfill(fn(route.request())) })
  const json = (doc) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
  const now = () => { if (at !== k) { at = k; f = w.files(w.marks[k], pack); if (k < last) f.head = { ...f.head, pending: { done: k + 1, total: last + 1 } } } return f }
  const tails = new Map() // part → {n, text, last: Map(id → its lines' JSON)}
  function tail(part) {
    const { head, docHead, open } = now(), n = head.open.n
    let t = tails.get(part)
    if (!t || t.n !== n) tails.set(part, t = { n, text: JSON.stringify(docHead({ tail: { n, part, s0: head.open.s0 } })) + '\n', last: new Map() })
    const seen = new Set()
    for (const [id, lines] of open(part)) {
      const j = lines.map((x) => JSON.stringify(x) + '\n').join('')
      seen.add(id)
      if (t.last.get(id) !== j) { t.text += j; t.last.set(id, j) }
    }
    for (const id of [...t.last.keys()]) if (!seen.has(id)) { t.last.delete(id); if (!id.startsWith('l:')) t.text += JSON.stringify({ g: id }) + '\n' }
    return Buffer.from(t.text)
  }
  await answer('**/api/d/**', (req) => {
    const name = new URL(req.url()).pathname.slice('/api/d/'.length)
    if (name === 'head') {
      if (at != null && granted > 0) { granted--; k = Math.min(last, k + grow) }
      const body = JSON.stringify(now().head), etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
      if (req.headers()['if-none-match'] === etag) return { status: 304, headers: { etag } }
      return { status: 200, contentType: 'application/json', headers: { etag }, body }
    }
    const pk = /^p(\d+)\.(main|rest)$/.exec(name), op = /^open\.(main|rest)$/.exec(name)
    if (pk) { const text = now().pack(+pk[1], pk[2]); return text == null ? json({ error: 'no such pack' }) : { status: 200, contentType: 'application/x-ndjson', body: text } }
    if (!op) return { status: 404, contentType: 'application/json', body: '{"error":"unknown endpoint"}' }
    const buf = tail(op[1]), etag = `"${op[1]}-${tails.get(op[1]).n}"`, ir = req.headers()['if-range']
    const r = ir == null || ir === etag ? /^bytes=(\d+)-$/.exec(req.headers().range || '') : null
    if (!r) return { status: 200, contentType: 'application/x-ndjson', headers: { etag }, body: buf }
    const from = +r[1]
    if (from >= buf.length) return { status: 416, headers: { etag, 'content-range': `bytes */${buf.length}` }, body: '' }
    return { status: 206, contentType: 'application/x-ndjson', headers: { etag, 'content-range': `bytes ${from}-${buf.length - 1}/${buf.length}` }, body: buf.subarray(from) }
  })
  await answer('**/api/lane?**', (req) => { const q = new URL(req.url()).searchParams; return json(w.lane(q.get('lane'), { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, ledger: q.get('ledger') ?? undefined }, w.marks[k])) })
  // 3.5 §会话读 `block`: one item per asked ref, its bytes made from the ref (the shape of session-read-contract.json `block_multi`)
  await answer('**/api/block?**', (req) => {
    const refs = new URL(req.url()).searchParams.getAll('ref')
    return json({ schema: 2, command: 'block', ok: true, errors: [], blocks: refs.map((ref) => ({ ref, bytes: blockBytes(ref), view: blockView(ref, w.replyRefs.has(ref)), encoding: 'utf8', fidelity: 'verbatim', truncated: false })) })
  })
  return { left: () => last - k, more: (n = 1) => { granted += n } }
}
/** Stamp every fetch on the page's own clock (for a `setup` or before the first navigation): globalThis.__fetches gets {url
 *  (path + query), t0 (ms epoch the page called fetch), t1 (ms epoch its body was read, or the fetch failed; null until then)}.
 *  What the page did, not when the events reached the test, so a busy renderer or a late CDP event shifts nothing. */
export const stampFetches = (page) => page.addInitScript(() => {
  const log = globalThis.__fetches = [], at = () => performance.timeOrigin + performance.now(), end = (e) => { if (e && e.t1 == null) e.t1 = at() }
  const fetch0 = globalThis.fetch
  globalThis.fetch = function (input, init) {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href), e = { url: u.pathname + u.search, t0: at(), t1: null }
    log.push(e)
    return fetch0.call(this, input, init).then((r) => { stamps.set(r, e); return r }, (err) => { end(e); throw err })
  }
  const stamps = new WeakMap()
  for (const m of ['text', 'json', 'arrayBuffer']) {
    const f = Response.prototype[m]
    Response.prototype[m] = function () { const e = stamps.get(this); return f.call(this).finally(() => end(e)) }
  }
})

/** `skip` (the suite's own reason, or false), else why WebKit cannot run: only an executable already installed, never downloaded. */
export async function webkitGate(skip) {
  if (skip) return skip
  try {
    const { webkit } = await import('playwright-core')
    const exe = webkit.executablePath()
    return exe && fs.existsSync(exe) ? false : 'the WebKit executable is not installed (not downloaded here)'
  } catch (e) { return `WebKit unavailable: ${String(e?.message || e).split('\n')[0]}` }
}

/** The bytes serveWorld answers for a `block` ref. */
export const blockBytes = (ref) => `body of ${ref}`
/** The `view` serveWorld answers with them (3.5 §会话读 `block`): markdown holding those bytes, several top-level blocks for a reply. */
const blockView = (ref, reply) => ({ r: { as: 'markdown', f: { body: ['text'] } },
  body: { text: reply ? `## Result\n\n${blockBytes(ref)}\n\n- first\n- second\n\nThe last paragraph.\n` : blockBytes(ref) } })

/** Nearest-rank p50 / p95 of a list of ms. */
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  const at = (p) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
  return { p50: at(50), p95: at(95) }
}

/** test/web-v2/browser/shots/<name>-<theme>-<width>.png (name by screen, never by harness). Returns the path. */
export async function shoot(page, name, { width, theme }) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, `${name}-${theme}-${width}.png`)
  await page.screenshot({ path: file })
  return file
}

/** What a reader would see as broken layout under `root` (1.5 · D64⑤), measured on the painted page — never a count or a wording:
 *  - `overlap`: two pieces of text, or text and a control (a switch, an input), drawn on one another — the boxes intersect by more than 2 px
 *    both ways (a disclosure title under a copy button, a cell note running into the next column, a date over a switch);
 *  - `cut`: text cut off by a box that clips it with no ellipsis (a hidden-overflow ancestor that is not a scroll container, horizontally),
 *    or a line whose glyph box (ascent to descent) sticks out above or below such a box: a line box too short for its font;
 *  - `untitled`: text truncated with an ellipsis whose full text is nowhere on hover (no `title` on it or above it);
 *  - `emptyIcons`: an agent icon box of a known agent with no <img>, or whose image failed to decode (K-11: a file that fails to load
 *    leaves an empty box). The board draws the <img> with the screen; its file answers later, so each box gets ICON_WAIT_MS for its image
 *    to finish loading before it is judged (a slow machine answers the file after the screen's data). Overlays (dialogs, popovers, toasts)
 *    float by design and are left out. */
const ICON_WAIT_MS = 10_000
export const layoutFaults = (page, root = '#content') => page.evaluate(async ({ root, iconWaitMs }) => {
  const R = document.querySelector(root)
  const out = { overlap: [], cut: [], untitled: [], emptyIcons: [] }
  if (!R) return out
  const shown = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false } return true }
  // a known agent's box holds its <img>; `loading` = no <img> yet or one still loading, `empty` = no <img> or one that failed to decode
  const known = () => [...R.querySelectorAll('[data-hicon]')].filter((el) => el.getAttribute('data-hicon') !== '?' && shown(el))
  const loading = () => known().filter((el) => { const img = el.querySelector('img'); return !img || !img.complete })
  const empty = () => known().filter((el) => { const img = el.querySelector('img'); return !img || (img.complete && img.naturalWidth === 0) })
  for (const t0 = Date.now(); loading().length && Date.now() - t0 < iconWaitMs;) await new Promise((ok) => setTimeout(ok, 50))
  const floating = (el) => !!el.closest('[role="dialog"], [data-confirm-back], .pop, .popover, .fly, #toasts')
  // the part of a box the reader can see: inside every ancestor that clips (any overflow but visible) and inside the window
  const seen = (el, r) => {
    let x = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, innerWidth), bottom: Math.min(r.bottom, innerHeight) }
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const q = e.getBoundingClientRect()
      x = { left: Math.max(x.left, q.left), top: Math.max(x.top, q.top), right: Math.min(x.right, q.right), bottom: Math.min(x.bottom, q.bottom) }
    }
    return x.right - x.left > 1 && x.bottom - x.top > 1 ? x : null
  }
  // a layer that covers scrolled content by design (a sticky head, a fixed bar): what sits under it is not drawn on it
  const layered = (el, stop) => { for (let e = el; e && e !== stop; e = e.parentElement) if (/sticky|fixed/.test(getComputedStyle(e).position)) return true; return false }
  const boxes = []
  const walk = document.createTreeWalker(R, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) })
  for (let n; (n = walk.nextNode());) {
    const el = n.parentElement
    if (!el || floating(el) || !shown(el)) continue
    const rg = document.createRange(); rg.selectNodeContents(n)
    for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1) boxes.push({ el, r, v: seen(el, r), t: n.nodeValue.trim().slice(0, 48) })
  }
  for (const el of R.querySelectorAll('[role="switch"], input, select, textarea')) {
    if (floating(el) || !shown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 1 && r.height > 1) boxes.push({ el, r, v: seen(el, r), t: `<${el.getAttribute('role') || el.tagName.toLowerCase()}>`, control: true })
  }
  const vis = boxes.filter((b) => b.v).sort((a, b) => a.v.top - b.v.top)
  const cross = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length && vis[j].v.top < vis[i].v.bottom; j++) {
    const a = vis[i], b = vis[j]
    if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el) || !cross(a.v, b.v)) continue
    let common = a.el.parentElement; while (common && !common.contains(b.el)) common = common.parentElement
    if (layered(a.el, common) || layered(b.el, common)) continue
    out.overlap.push(`${JSON.stringify(a.t)} × ${JSON.stringify(b.t)}`)
  }
  for (const b of boxes) {
    if (b.control) continue
    for (let e = b.el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e)
      const clips = (o) => o === 'hidden' || o === 'clip'
      if (!clips(cs.overflowX) && !clips(cs.overflowY)) continue
      const er = e.getBoundingClientRect()
      if (er.width <= 2 || er.height <= 2) break // a box hidden on purpose (a screen-reader-only label)
      // a line whose glyph box sticks out above or below the box that clips it: its ascenders or descenders are cut, and no ellipsis helps
      if (clips(cs.overflowY) && b.r.bottom > er.top && b.r.top < er.bottom && (b.r.top < er.top - 1 || b.r.bottom > er.bottom + 1)) {
        out.cut.push(`${JSON.stringify(b.t)} in ${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} (top or bottom)`); break
      }
      if (!clips(cs.overflowX) || (b.r.right <= er.right + 1 && b.r.left >= er.left - 1)) continue
      let ell = false
      for (let x = b.el; x; x = x.parentElement) { if (getComputedStyle(x).textOverflow === 'ellipsis') { ell = true; break } if (x === e) break }
      if (!ell) out.cut.push(`${JSON.stringify(b.t)} in ${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`)
      else if (!b.el.closest('[title]')) out.untitled.push(JSON.stringify(b.t))
      break
    }
  }
  out.emptyIcons = empty().map((el) => el.getAttribute('data-hicon'))
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])]
  return out
}, { root, iconWaitMs: ICON_WAIT_MS })
