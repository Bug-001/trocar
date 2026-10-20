// test/web-v2/browser/harness.mjs — the one browser harness (D64⑤): the real face (test/web-v2/real-face.mjs) on a temp HOME, the
// system Google Chrome through playwright-core (channel:'chrome', no browser download), marks / measures and shots. Exports only:
// node --test runs every .mjs, so nothing here runs at import. The browser suite runs only under `npm run test:browser`
// (TROCAR_PLAYWRIGHT=1); anywhere else probe() says why it is not ok and the cases skip with that reason.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardHome, serveBoard } from '../real-face.mjs'

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
const CHANNEL = { channel: 'chrome' }

/** { ok:true, chromium } when the browser suite may run here; { ok:false, reason } otherwise (the reason is printed). */
export async function probe({ importer = () => import('playwright-core'), env = process.env } = {}) {
  const no = (reason) => { console.log(`# browser suite skipped: ${reason}`); return { ok: false, reason } }
  if (env.TROCAR_PLAYWRIGHT !== '1') return no('TROCAR_PLAYWRIGHT is not 1 (run it with `npm run test:browser`)')
  let chromium
  try { chromium = (await importer()).chromium } catch (e) { return no(`playwright-core is not installed: ${e?.message || e}`) }
  try { await (await chromium.launch(CHANNEL)).close() } catch (e) { return no(`Google Chrome did not launch: ${String(e?.message || e).split('\n')[0]}`) }
  return { ok: true, chromium }
}

/** The board on a fresh temp HOME in a fresh Chrome. `token`: true = the face's token, a string = that token, false = no fragment.
 *  `missing` lists every static file answered ≥ 400 (`<status> <path>`).
 *  `requests` logs every /api and /control response as {url, method, body (the request's post data, or null), status, start (ms epoch the request began), t (ms epoch it answered)}; `errors` collects pageerrors; `get(name, params)` reads the face directly (no page, no request log). Always `await stop()`. */
export async function withBoard({ bytes, token = true, width = 1280, theme = 'light', chromium } = {}) {
  chromium ||= (await import('playwright-core')).chromium
  const face = await serveBoard(boardHome({ bytes }))
  const requests = []
  const errors = []
  const missing = []
  let browser, context, page
  const stop = async () => {
    try { await page?.close() } finally {
      try { await context?.close() } finally {
        try { await browser?.close() } finally { await face.close() }
      }
    }
  }
  try {
    browser = await chromium.launch(CHANNEL)
    context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme })
    page = await context.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('response', (r) => {
      const u = new URL(r.url())
      if (!/^\/(api|control)\//.test(u.pathname) && r.status() >= 400) missing.push(`${r.status()} ${u.pathname}`) // a static file the page asked for and did not get (a /favicon.ico once)
      if (/^\/(api|control)\//.test(u.pathname)) requests.push({ url: u.pathname + u.search, method: r.request().method(), body: r.request().postData(), status: r.status(), start: r.request().timing().startTime, t: Date.now() })
    })
    const t = token === true ? face.token : token
    await page.goto(`${face.base}/${t ? `#t=${encodeURIComponent(t)}` : ''}`, { waitUntil: 'load' })
  } catch (e) { await stop(); throw e }
  return { url: face.base, get: face.get, page, stop, requests, errors, missing }
}

export const mark = (page, name) => page.evaluate((n) => { performance.mark(n) }, name)
/** ms from `startMark` to now, recorded as measure `name`. */
export const measure = (page, name, startMark) => page.evaluate(([n, s]) => performance.measure(n, s).duration, [name, startMark])

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
 *  - `cut`: text cut off by a box that clips it with no ellipsis (a hidden-overflow ancestor that is not a scroll container, horizontally);
 *  - `untitled`: text truncated with an ellipsis whose full text is nowhere on hover (no `title` on it or above it);
 *  - `emptyIcons`: an agent icon box of a known agent that is still empty. Overlays (dialogs, popovers, toasts) float by design and are left out. */
export const layoutFaults = (page, root = '#content') => page.evaluate((root) => {
  const R = document.querySelector(root)
  const out = { overlap: [], cut: [], untitled: [], emptyIcons: [] }
  if (!R) return out
  const shown = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false } return true }
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
      if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue
      const er = e.getBoundingClientRect()
      if (er.width <= 2 || er.height <= 2) break // a box hidden on purpose (a screen-reader-only label)
      if (b.r.right <= er.right + 1 && b.r.left >= er.left - 1) continue
      let ell = false
      for (let x = b.el; x; x = x.parentElement) { if (getComputedStyle(x).textOverflow === 'ellipsis') { ell = true; break } if (x === e) break }
      if (!ell) out.cut.push(`${JSON.stringify(b.t)} in ${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`)
      else if (!b.el.closest('[title]')) out.untitled.push(JSON.stringify(b.t))
      break
    }
  }
  for (const el of R.querySelectorAll('[data-hicon]')) if (el.getAttribute('data-hicon') !== '?' && shown(el) && !el.querySelector('svg')) out.emptyIcons.push(el.getAttribute('data-hicon'))
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])]
  return out
}, root)
