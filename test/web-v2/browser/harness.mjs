// test/web-v2/browser/harness.mjs — the one browser harness (D64⑤): the real face (test/web-v2/real-face.mjs) on a temp HOME, the
// system Google Chrome through playwright-core (channel:'chrome', no browser download), marks / measures and shots. Exports only:
// node --test runs every .mjs, so nothing here runs at import. The browser suite runs only under `npm run test:browser`
// (ASIGHT_PLAYWRIGHT=1); anywhere else probe() says why it is not ok and the cases skip with that reason.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardHome, serveBoard } from '../real-face.mjs'

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
const CHANNEL = { channel: 'chrome' }

/** { ok:true, chromium } when the browser suite may run here; { ok:false, reason } otherwise (the reason is printed). */
export async function probe({ importer = () => import('playwright-core'), env = process.env } = {}) {
  const no = (reason) => { console.log(`# browser suite skipped: ${reason}`); return { ok: false, reason } }
  if (env.ASIGHT_PLAYWRIGHT !== '1') return no('ASIGHT_PLAYWRIGHT is not 1 (run it with `npm run test:browser`)')
  let chromium
  try { chromium = (await importer()).chromium } catch (e) { return no(`playwright-core is not installed: ${e?.message || e}`) }
  try { await (await chromium.launch(CHANNEL)).close() } catch (e) { return no(`Google Chrome did not launch: ${String(e?.message || e).split('\n')[0]}`) }
  return { ok: true, chromium }
}

/** The board on a fresh temp HOME in a fresh Chrome. `token`: true = the face's token, a string = that token, false = no fragment.
 *  `requests` logs every /api and /control response as {url, status, start (ms epoch the request began), t (ms epoch it answered)}; `errors` collects pageerrors. Always `await stop()`. */
export async function withBoard({ bytes, token = true, width = 1280, theme = 'light', chromium } = {}) {
  chromium ||= (await import('playwright-core')).chromium
  const face = await serveBoard(boardHome({ bytes }))
  const requests = []
  const errors = []
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
      if (/^\/(api|control)\//.test(u.pathname)) requests.push({ url: u.pathname + u.search, status: r.status(), start: r.request().timing().startTime, t: Date.now() })
    })
    const t = token === true ? face.token : token
    await page.goto(`${face.base}/v2/index.html${t ? `#t=${encodeURIComponent(t)}` : ''}`, { waitUntil: 'load' })
  } catch (e) { await stop(); throw e }
  return { url: face.base, page, stop, requests, errors }
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
