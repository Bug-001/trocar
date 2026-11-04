#!/usr/bin/env node
// scripts/board-walk.mjs — walks every screen of a running board in the system Chrome and reports what a reader's hand would find broken (1.12 §5).
//
//   node scripts/board-walk.mjs --board <file> --out <dir> [--session <id>] [--width 1280] [--height 900] [--theme light|dark]
//
// --board: `trocar board --json`'s document, whose `url` has no token and whose `token_file` this script reads itself, so the token never passes
// through the caller; or a one-line address with the token in it (side-board's --url-file).
// Writes <out>/walk.json and one <screen>.png per screen. Exit 0 nothing found, 1 something found, 2 usage or no playwright-core / Chrome.
// Controls are found by ARIA role and generic attributes only, never by class or id, so a rewrite of the board's markup leaves this
// as it is. It judges no content, naming or look: that is the job of whoever reads the screenshots. Read-only: every request but GET is stopped and
// lands in `errors.requests`. What the board shows stays out of the output, as it can be captured text: a control is its role and a number
// (`button#3`), and an error is cut at ERROR_CHARS. The board's token never reaches the output.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launchChrome, layoutFaults } from '../test/web-v2/browser/harness.mjs'
import { CONTROL_TOKEN_HEADER } from '../src/off/token-header.mjs'
import { formatHash } from '../web/legacy/core/router.mjs'
import { SCREEN_NAME } from '../web/legacy/labels/shell.mjs'

const CAP = 40 // actions of one kind on one screen; the rest is counted in `skipped`
const SETTLE_MS = 2000 // after a load: the board polls, so `networkidle` may never come, and the desk's packs take a moment
const TICK_MS = 200 // after one action
const CLICK_MS = 1000 // a control something covers gives up after this and counts as skipped
const ERROR_CHARS = 200 // of one page or console error
const KINDS = ['expand', 'scroll', 'drag']

// each screen's route, from `data` (what the board's documents gave); a route function answering a string says why the screen cannot be walked
const needs = (key, why, make) => (data) => (data[key] ? make(data[key]) : why)
const ROUTES = {
  overview: () => ({}), library: () => ({}), capture: () => ({}), 'capture-log': () => ({}), traffic: () => ({}),
  'settings-storage': () => ({}), 'settings-prices': () => ({}), 'settings-appearance': () => ({}),
  replay: needs('session', 'no session to open', (s) => ({ project: s.project_slug, id: s.session_id })),
  'session-link': needs('session', 'no session to open', (s) => ({ id: s.session_id })),
  'traffic-host': needs('host', 'no host in the traffic document', (h) => ({ harness: h.harness, host: h.host })),
}

// installed in every page before the board's code: what finds controls and reads their state
function pageTools(kinds) {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  const scrolls = (el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)
  const find = {
    [kinds[0]]: () => document.querySelectorAll('[aria-expanded], summary'),
    [kinds[1]]: () => [...document.querySelectorAll('*')].filter(scrolls),
    [kinds[2]]: () => document.querySelectorAll('[role=separator]'),
  }
  const seen = new WeakSet()
  const left = (kind) => [...find[kind]()].filter((el) => !seen.has(el))
  const label = (el) => el.getAttribute('aria-label') || el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) || el.getAttribute('title') || '' // never for the output: it can be captured text
  const numbers = new WeakMap()
  let last = 0
  const id = (el) => {
    if (!numbers.has(el)) numbers.set(el, ++last)
    const role = el.getAttribute('role') || el.localName
    return { role, name: `${role}#${numbers.get(el)}` }
  }
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }
  const inView = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  }
  const anchors = () => [...document.querySelectorAll('[role=heading], h1, h2, h3, h4, h5, h6, button, [role=button]')]
    .filter((el) => (/^h\d$/.test(el.localName) || el.getAttribute('role') === 'heading' || /close|back/i.test(label(el))) && inView(el))
  globalThis.__walk = {
    // the next control of `kind` not yet acted on; one hidden or disabled stays in `left`, so it ends up counted as skipped
    next(kind) {
      const el = left(kind).find((e) => shown(e) && !e.matches(':disabled, [aria-disabled=true]'))
      if (el) seen.add(el)
      return el || null
    },
    left: (kind) => left(kind).length,
    id,
    // what a click may change: never the whole page, which the polls keep changing, only the control and the region it controls or sits
    // in. A control straight under <body> has no region of its own.
    state(el) {
      const parent = el.parentElement === document.body ? el : el.parentElement
      const region = document.getElementById((el.getAttribute('aria-controls') || '').split(' ')[0]) || parent || el
      return JSON.stringify([el.isConnected, el.getAttribute('aria-expanded'), el.closest('details')?.open, region.querySelectorAll('*').length, region.textContent.length])
    },
    // scrolls `el` to its end; → the headings and close / back buttons that were in view and no longer are
    async toEnd(el, ms) {
      const before = anchors()
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
      await new Promise((ok) => setTimeout(ok, ms))
      return before.filter((a) => a.isConnected && !inView(a)).map(id)
    },
    size: (el) => JSON.stringify([box(el), box(el.previousElementSibling), box(el.nextElementSibling), el.getAttribute('aria-valuenow')]),
    span(el) { const r = (el.parentElement || el).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } },
    overflow: () => Math.max(0, document.documentElement.scrollWidth - innerWidth),
  }
}

/** Acts on each control of `kind` until none is left or CAP are done; `act` answers false when the control could not be acted on. */
async function each(page, kind, item, act) {
  let blocked = 0
  while (item.did[kind] < CAP) {
    const el = (await page.evaluateHandle((k) => globalThis.__walk.next(k), kind)).asElement()
    if (!el) break
    if (await act(el)) item.did[kind]++
    else blocked++
  }
  item.skipped[kind] = blocked + await page.evaluate((k) => globalThis.__walk.left(k), kind)
}

const clicked = (page, item) => async (el) => {
  const state = () => el.evaluate((e) => globalThis.__walk.state(e))
  const who = await el.evaluate((e) => globalThis.__walk.id(e)), before = await state()
  try { await el.click({ timeout: CLICK_MS }) } catch { return false }
  await page.waitForTimeout(TICK_MS)
  if (await state() === before) item.dead.push(who)
  // a popover left open would eat the next click (a click outside only closes it) and make that control look dead
  await page.keyboard.press('Escape')
  await page.waitForTimeout(TICK_MS)
  return true
}

const scrolled = (item) => async (el) => {
  item.lost.push(...await el.evaluate((e, ms) => globalThis.__walk.toEnd(e, ms), TICK_MS))
  return true
}

// a separator moves along the axis it does not run on; it counts as live when either end changed a size
const dragged = (page, item) => async (el) => {
  const size = () => el.evaluate((e) => globalThis.__walk.size(e))
  const who = await el.evaluate((e) => globalThis.__walk.id(e)), before = await size()
  try { await el.scrollIntoViewIfNeeded({ timeout: CLICK_MS }) } catch { return false }
  const span = await el.evaluate((e) => globalThis.__walk.span(e))
  let moved = false
  for (const end of ['start', 'end']) {
    const b = await el.boundingBox()
    if (!b) return true // the drag rebuilt it: something happened
    const x = b.x + b.width / 2, y = b.y + b.height / 2, across = b.height >= b.width
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(across ? span[end === 'start' ? 'left' : 'right'] : x, across ? y : span[end === 'start' ? 'top' : 'bottom'], { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(TICK_MS)
    moved ||= await size() !== before
  }
  if (!moved) item.dead.push(who)
  return true
}

const blank = (screen) => ({
  screen, shot: null, did: { expand: 0, scroll: 0, drag: 0 }, skipped: { expand: 0, scroll: 0, drag: 0 }, dead: [], lost: [], overflow: 0, layout: null,
  errors: { page: [], console: [], requests: [] },
})

async function walkScreen(context, origin, item, hash, out, clip) {
  const page = await context.newPage()
  const seen = { page: new Set(), console: new Set(), requests: new Set() }
  page.on('pageerror', (e) => seen.page.add(clip(String(e))))
  // Chrome's own line for a failed load only repeats what `requests` holds
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) seen.console.add(clip(m.text())) })
  // 416 to a Range read means no bytes past that offset yet: how the board asks a growing file for more, not a failure
  page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 416 && r.request().headers().range)) seen.requests.add(`${r.status()} ${r.request().method()} ${r.url()}`) })
  // an abort is the board dropping a read it no longer needs, or this page closing: not a failure
  page.on('requestfailed', (r) => { const why = r.failure()?.errorText; if (why !== 'net::ERR_ABORTED') seen.requests.add(`${why} ${r.method()} ${r.url()}`) })
  try {
    await page.addInitScript(pageTools, KINDS)
    await page.goto(`${origin}/${hash}`, { waitUntil: 'load' })
    await page.waitForTimeout(SETTLE_MS)
    await each(page, 'expand', item, clicked(page, item))
    item.shot = `${item.screen}.png`
    await page.screenshot({ path: path.join(out, item.shot) })
    item.layout = await layoutFaults(page, 'body')
    await each(page, 'scroll', item, scrolled(item))
    await each(page, 'drag', item, dragged(page, item))
    item.overflow = await page.evaluate(() => globalThis.__walk.overflow())
  } catch (e) {
    item.skipped.reason = String(e?.message || e).split('\n')[0]
  } finally {
    for (const k of Object.keys(seen)) item.errors[k] = [...seen[k]]
    await page.close()
  }
}

const found = (s) => !!(s.skipped.reason || s.dead.length || s.lost.length || s.overflow || Object.values(s.layout || {}).some((v) => v.length) || Object.values(s.errors).some((v) => v.length))

/** What the routes need from the board's documents: the session (--session, or the one with the most calls) and the first traffic host. */
async function readData(origin, token, session) {
  const get = async (name, query) => {
    const r = await fetch(`${origin}/api/${name}?${new URLSearchParams(query)}`, { headers: { [CONTROL_TOKEN_HEADER]: token } })
    return r.ok ? r.json() : {}
  }
  const sessions = (await get('sessions', { limit: 500 })).sessions || []
  const picked = session ? sessions.find((s) => s.session_id === session) : sessions.reduce((a, s) => ((s.calls || 0) > (a?.calls || 0) ? s : a), null)
  return { session: picked, host: ((await get('traffic', {})).hosts || [])[0] }
}

function usage(message) {
  console.error(`board-walk: ${message}`)
  process.exit(2)
}

function readOptions() {
  let values
  try {
    ({ values } = parseArgs({ options: { board: { type: 'string' }, out: { type: 'string' }, session: { type: 'string' }, width: { type: 'string', default: '1280' }, height: { type: 'string', default: '900' }, theme: { type: 'string', default: 'light' } } }))
  } catch (e) { usage(e.message) }
  const width = Number(values.width), height = Number(values.height)
  if (!values.board || !values.out) usage('--board <file> and --out <dir> are required')
  if (!(width > 0 && height > 0)) usage('--width and --height take a positive number')
  if (!['light', 'dark'].includes(values.theme)) usage('--theme takes light or dark')
  let text
  try { text = fs.readFileSync(values.board, 'utf8').trim() } catch { usage('--board file cannot be read') }
  let doc = null
  try { doc = JSON.parse(text) } catch { /* not JSON: the one-line form */ }
  let url
  try { url = new URL(doc ? doc.url : text.split('\n')[0]) } catch { usage('--board file holds no address') }
  let token = new URLSearchParams(url.hash.slice(1)).get('t')
  if (!token && doc?.token_file) try { token = fs.readFileSync(doc.token_file, 'utf8').trim() } catch { usage('the token_file in --board cannot be read') }
  if (!token) usage('--board gives no token: neither in its address nor in a token_file')
  return { ...values, width, height, address: `${url.origin}/#t=${encodeURIComponent(token)}`, origin: url.origin, token }
}

async function main() {
  const o = readOptions()
  const secrets = [o.address, o.origin, encodeURIComponent(o.token), o.token]
  const redact = (s) => secrets.reduce((x, k) => x.split(k).join('<board>'), s)
  const clip = (s) => redact(s).slice(0, ERROR_CHARS) // in this order: half a token is past what redact can find
  let browser
  try {
    const { chromium } = await import('playwright-core')
    browser = await launchChrome(chromium)
  } catch { usage('needs playwright-core and Google Chrome: run `npm install` in this clone, and install Chrome') }
  const screens = []
  try {
    fs.mkdirSync(o.out, { recursive: true })
    const context = await browser.newContext({ viewport: { width: o.width, height: o.height }, colorScheme: o.theme })
    await context.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort('blockedbyclient')))
    const boot = await context.newPage() // the board keeps the token for its origin, so each screen after this opens at the bare address
    await boot.goto(o.address, { waitUntil: 'load' })
    await boot.waitForTimeout(TICK_MS)
    await boot.close()
    const data = await readData(o.origin, o.token, o.session)
    for (const screen of Object.keys(SCREEN_NAME)) {
      const item = blank(screen), route = ROUTES[screen] ? ROUTES[screen](data) : 'no route for this screen in board-walk'
      screens.push(item)
      if (typeof route === 'string') item.skipped.reason = route
      else await walkScreen(context, o.origin, item, formatHash({ screen, ...route }), o.out, clip)
    }
  } finally { await browser.close() }
  const doc = { ok: !screens.some(found), viewport: { width: o.width, height: o.height, theme: o.theme }, screens }
  const clean = JSON.parse(JSON.stringify(doc), (_, v) => (typeof v === 'string' ? redact(v) : v))
  fs.writeFileSync(path.join(o.out, 'walk.json'), `${JSON.stringify(clean, null, 2)}\n`)
  console.log(`${screens.length} screens walked, ${screens.filter(found).length} with findings`)
  process.exitCode = doc.ok ? 0 : 1
}

await main()
