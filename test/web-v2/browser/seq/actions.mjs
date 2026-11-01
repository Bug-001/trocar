// test/web-v2/browser/seq/actions.mjs — everything one sequence step can do, as data plus a runner. A step is `{a, p}`: `a` names a
// row of ACTIONS, `p` is plain JSON drawn at generation time (fractions and choices, never DOM handles), so a sequence serializes,
// replays and shrinks. Targets are resolved when the step runs; one that is absent on the current screen is `{skipped:true}`.
// Reader rows (real:true) are what a reader does with mouse and keys (routes 1.2:83-105, keys 1.2:262-269; the chapter row's ‹ › and
// [ ] 1.3 §章; a deep link to a step that may sit in a sealed pack the loader has not read, 2.3 加载器); world rows (real:false)
// are grow, late growth (rows landing before the tip), a fresh session opened, a worker kill mid-read and arming a route fault. No step ever clicks a control that writes (DENY), and faults.mjs aborts
// any non-GET request anyway. Selectors are ids, classes and data attributes, never wording. Exports only: nothing runs at import.
import { setHidden } from './probe.mjs'
import { mainCount } from './world.mjs'
import { FAULT_KINDS, killWorkerMidRead } from './faults.mjs'

// controls that write (core/harness-switch.mjs switch / Set up; settings/storage.mjs levels) and every button of a modal (a confirm)
export const DENY = '[role=switch],[data-hctl],[data-keep],[data-lvl],[data-class],.v2-modal button,.v2-modal [role=button]'
const FAULT_NAMES = ['d/head', 'd/pack', 'd/open', 'lane', 'block', 'sessions', 'status', 'overview', 'traffic', 'classes', 'pricing', 'segments', 'calls']
const SCREENS = ['#/overview', '#/sessions', '#/capture', '#/capture/log', '#/traffic', '#/settings/storage', '#/settings/prices', '#/settings/appearance']
const TOGGLES = { block: '#ctxwin .cblk[data-bi] > .cbh', reply: '#ctxwin .cblk[data-rp] > .cbh', turn: '#ctxwin .cwturnhd', rail: '#rails [data-toggle], #rails [data-railunfold]', tick: '#rails .tick[data-lane]', rpbar: '#rpbar', details: '#screen details > summary', row: '#screen [aria-expanded][aria-controls]' }
const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Home', 'End', 'step:prev', 'step:next']
const MISC_KEYS = ['?', 'Escape', 'n', 'p']

const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))
const frac = (rng) => Math.round(rng() * 1000) / 1000
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const hashOf = (page) => page.evaluate(() => location.hash)
const SKIP = { skipped: true }

/** Click the element at fraction f of the visible, allowed matches of `sel`, with the mouse at its centre — only when the centre hits
 *  that element (an overlay over it would take the click instead). `fx` (0..1) moves the point across the element's width. */
async function clickIn(page, sel, f, fx = 0.5) {
  const at = await page.evaluate(([sel, f, fx, deny]) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && !e.closest(deny))
    const el = els[Math.min(els.length - 1, Math.floor(f * els.length))]
    if (!el) return null
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const r = el.getBoundingClientRect(), x = r.left + Math.max(1, Math.min(r.width - 1, fx * r.width)), y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return hit && el.contains(hit) && !hit.closest(deny) ? { x, y } : null
  }, [sel, f, fx, DENY])
  if (!at) return SKIP
  await page.mouse.click(at.x, at.y)
}

// 1.2 §点击与选中文字: where a reader drags to select text — inside an open row's body, or over a head's own text
const SELECT_IN = {
  body: '#screen .cexp:not([hidden]), #screen .lx:not([hidden]), #screen .disc-b:not([hidden]), #ctxwin .cblk:not(.collapsed) > .cbc, #detail .dblk.open .dbbody, #screen details[open]',
  head: '#ctxwin .cbh, #ctxwin .cwturnhd, #screen summary, #screen [data-navtoggle], #detail .dbh',
}
// the open / closed state of everything that opens and closes, as one string per element
const FOLDS = '[aria-expanded], details, .cblk, .cwturn, .dblk, .navrow.head, .cwremoved'
/** A real mouse drag across the visible text run at fraction f of `where`'s runs (never in a control or a DENY element), `span` of
 *  its width. Sets ctx.lastDrag = {made: the drag made a new selection, changed: the folds whose state the drag changed}. */
async function selectDrag(ctx, p) {
  const { page } = ctx
  const at = await page.evaluate(([sel, folds, f, span, deny]) => {
    const runs = []
    for (const root of document.querySelectorAll(sel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.data.trim().length < 4 || n.parentElement.closest(`a, button, input, textarea, select, [contenteditable], ${deny}`)) continue
        const r = document.createRange(); r.selectNodeContents(n)
        const b = r.getBoundingClientRect()
        if (b.width >= 20 && b.height > 0) runs.push([n, b])
      }
    }
    const pickd = runs[Math.min(runs.length - 1, Math.floor(f * runs.length))]
    if (!pickd) return null
    pickd[0].parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const r = document.createRange(); r.selectNodeContents(pickd[0])
    const b = r.getBoundingClientRect(), y = b.top + b.height / 2
    const hit = document.elementFromPoint(b.left + 1, y)
    if (!hit || !hit.contains(pickd[0].parentElement) && !pickd[0].parentElement.contains(hit)) return null
    const state = (e) => [e.getAttribute('aria-expanded'), e.open, e.classList.contains('collapsed'), e.classList.contains('open')].join()
    const s = document.getSelection()
    window.__seqFolds = new Map([...document.querySelectorAll(folds)].map((e) => [e, state(e)]))
    window.__seqSelKey = s.isCollapsed ? '' : [s.anchorOffset, s.focusOffset, String(s)].join()
    window.__seqFoldState = state
    return { x0: b.left + 1, x1: b.left + Math.max(8, span * (b.width - 2)), y }
  }, [SELECT_IN[p.where], FOLDS, p.f, p.span, DENY])
  if (!at) return SKIP
  await page.mouse.move(at.x0, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x1, at.y, { steps: 5 })
  await page.mouse.up()
  ctx.lastDrag = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const s = document.getSelection(), key = s.isCollapsed ? '' : [s.anchorOffset, s.focusOffset, String(s)].join()
    const changed = [...window.__seqFolds].filter(([e, was]) => e.isConnected && window.__seqFoldState(e) !== was)
      .map(([e, was]) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${was} → ${window.__seqFoldState(e)}`)
    done({ made: !s.isCollapsed && key !== window.__seqSelKey, changed })
  }))))
}

/** Press keys with no write control focused (Space / Enter never; arrows on a segmented control would move its choice). */
async function press(page, key) {
  await page.evaluate((deny) => { const a = document.activeElement; if (a && a.closest && a.closest(deny)) a.blur() }, DENY)
  await page.keyboard.press(key)
}

/** The board's session rows (server order), cached for a few seconds per ctx. */
async function library(ctx) {
  if (ctx._lib && Date.now() - ctx._lib.t < 5000) return ctx._lib.rows
  const { status, doc } = await ctx.b.get('sessions')
  const rows = status === 200 && doc && Array.isArray(doc.sessions) ? doc.sessions : []
  ctx._lib = { t: Date.now(), rows }
  return rows
}
const deskOf = (hash) => { const m = /^#\/replay\/[^/]+\/([^/?]+)/.exec(hash); return m ? decodeURIComponent(m[1]) : null }
const deskHash = (row) => `#/replay/${encodeURIComponent(row.project_slug)}/${encodeURIComponent(row.session_id)}`
const rowAt = (rows, f) => rows[Math.min(rows.length - 1, Math.floor(f * rows.length))]

async function openSession(ctx, { via, f }) {
  if (via === 'row') {
    if (!(await hashOf(ctx.page)).startsWith('#/sessions')) { await go(ctx.page, '#/sessions'); await ctx.page.waitForSelector('#screen a.lrow', { timeout: 5000 }).catch(() => {}) }
    return clickIn(ctx.page, '#screen a.lrow', f)
  }
  const rows = await library(ctx)
  const row = rows.length && rowAt(rows, f)
  if (!row) return SKIP
  await go(ctx.page, via === 'short' ? `#/session/${encodeURIComponent(row.session_id)}` : deskHash(row))
}

async function deepLink(ctx, p) {
  if (p.kind === 'route') return go(ctx.page, `#/${p.junk}/${p.junk}`)
  const rows = await library(ctx)
  const row = rows.length && rowAt(rows, p.f)
  if (!row) return SKIP
  if (p.kind === 'session') return go(ctx.page, `#/replay/${encodeURIComponent(row.project_slug)}/${p.junk}`)
  let step = p.step
  if (typeof step === 'number' && step > 0 && step < 1) {
    step = Math.max(1, Math.round(step * ((await mainCount(ctx.b.get, row.session_id).catch(() => 0)) || 1)))
  } else if (step === 'past') step = 1_000_000
  return go(ctx.page, `${deskHash(row)}?step=${encodeURIComponent(String(step))}`)
}

// a step of the desk on screen (else of the session at fraction f of the library) at fraction `at` of its main lane, by the router
async function stepLink(ctx, { f, at }) {
  const rows = await library(ctx), here = deskOf(await hashOf(ctx.page))
  const row = rows.find((x) => x.session_id === here) || (rows.length && rowAt(rows, f))
  if (!row) return SKIP
  const m = (await mainCount(ctx.b.get, row.session_id).catch(() => 0)) || 1
  await go(ctx.page, `${deskHash(row)}?step=${Math.max(1, Math.ceil(at * m))}`)
}

async function hostPage(ctx, { f }) {
  const sel = '#screen a[href^="#/traffic/host/"]'
  if (!(await ctx.page.$(sel))) { await go(ctx.page, '#/traffic'); await ctx.page.waitForSelector(sel, { timeout: 5000 }).catch(() => {}) }
  return clickIn(ctx.page, sel, f)
}

async function hide(ctx, hidden) {
  const h = ctx.hidden || (ctx.hidden = [])
  const open = h.find((x) => x.to == null)
  if (hidden && !open) h.push({ from: Date.now(), to: null })
  if (!hidden && open) open.to = Date.now()
  await setHidden(ctx.page, hidden)
}

const reader = (a, w, gen, run) => ({ a, w, real: true, gen, run })
const world = (a, w, gen, run) => ({ a, w, real: false, gen, run })

export const ACTIONS = [
  reader('screen', 12, (r) => ({ hash: pick(r, SCREENS) }), (ctx, p) => go(ctx.page, p.hash)),
  reader('host', 2, (r) => ({ f: frac(r) }), hostPage),
  reader('open', 10, (r) => ({ via: pick(r, ['row', 'link', 'short']), f: frac(r) }), openSession),
  reader('nav', 12, (r) => ({ key: pick(r, NAV_KEYS) }), (ctx, p) =>
    p.key.startsWith('step:') ? clickIn(ctx.page, `#stepbar [data-step="${p.key.slice(5)}"]`, 0) : press(ctx.page, p.key)),
  reader('chapterPrev', 3, (r) => ({ via: pick(r, ['click', 'key']) }), (ctx, p) => (p.via === 'key' ? press(ctx.page, '[') : clickIn(ctx.page, '#chapPrev', 0))),
  reader('chapterNext', 3, (r) => ({ via: pick(r, ['click', 'key']) }), (ctx, p) => (p.via === 'key' ? press(ctx.page, ']') : clickIn(ctx.page, '#chapNext', 0))),
  reader('stepLink', 3, (r) => ({ f: frac(r), at: frac(r) }), stepLink),
  reader('saw', 6, (r) => ({ x: frac(r) }), (ctx, p) => clickIn(ctx.page, '#saw', 0, p.x)),
  reader('follow', 5, (r) => ({ via: pick(r, ['key', 'chip']) }), (ctx, p) =>
    p.via === 'key' ? press(ctx.page, 'f') : clickIn(ctx.page, '[data-follow]', 0)),
  reader('toggle', 11, (r) => ({ what: pick(r, Object.keys(TOGGLES)), f: frac(r) }), (ctx, p) => clickIn(ctx.page, TOGGLES[p.what], p.f)),
  reader('select', 6, (r) => ({ where: pick(r, ['body', 'head']), f: frac(r), span: frac(r) }), selectDrag),
  reader('key', 6, (r) => ({ key: pick(r, MISC_KEYS) }), (ctx, p) => press(ctx.page, p.key)),
  reader('deeplink', 5, (r) => {
    const kind = pick(r, ['step', 'step', 'session', 'route'])
    return { kind, f: frac(r), step: pick(r, [frac(r) || 0.5, 0, 'past', -3, 'abc']), junk: `x${Math.floor(r() * 1e9).toString(36)}` }
  }, deepLink),
  reader('history', 4, (r) => ({ go: pick(r, ['back', 'forward', 'reload']) }), async (ctx, p) => {
    if (p.go === 'reload') return ctx.page.reload({ waitUntil: 'load' })
    await ctx.page.evaluate((d) => (d === 'back' ? history.back() : history.forward()), p.go)
  }),
  reader('resize', 3, (r) => ({ width: pick(r, [390, 768, 1280, 1440]) }), (ctx, p) => ctx.page.setViewportSize({ width: p.width, height: p.width < 768 ? 844 : 900 })),
  reader('theme', 2, (r) => ({ scheme: pick(r, ['light', 'dark']) }), (ctx, p) => ctx.page.emulateMedia({ colorScheme: p.scheme })),
  reader('hidden', 3, (r) => ({ hidden: r() < 0.5 }), (ctx, p) => hide(ctx, p.hidden)),
  reader('repeat', 3, (r, w) => ({ step: genFrom(r, w, ACTIONS.filter((x) => x.real && !COMPOUND.has(x.a))), times: int(r, 5, 20) }), async (ctx, p) => {
    let ran = 0
    for (let k = 0; k < p.times; k++) if (!(await act(ctx, p.step)).skipped) ran++
    return ran ? undefined : SKIP
  }),
  reader('switchInFlight', 2, (r) => ({ a: frac(r), b: frac(r), ms: int(r, 1000, 8000) }), async (ctx, p) => {
    const rows = await library(ctx)
    if (rows.length < 2) return SKIP
    const A = rowAt(rows, p.a), B = rows[(rows.indexOf(A) + 1 + Math.floor(p.b * (rows.length - 1))) % rows.length]
    ctx.faults.arm({ kind: 'latency', name: 'd/head', n: 1, ms: p.ms })
    await go(ctx.page, deskHash(A))
    await go(ctx.page, deskHash(B))
  }),
  world('grow', 8, (r) => ({ k: int(r, 1, 3) }), (ctx, p) => { ctx.lastGrow = ctx.world.grow(p.k); ctx.grownAt = Date.now() }),
  world('late', 4, (r) => ({ k: int(r, 1, 3) }), (ctx, p) => { ctx.lastGrow = ctx.world.late(p.k); ctx.grownAt = Date.now() }),
  // a session no read has touched yet, opened at once: its first open meets the server still extracting it (3.5 §抽取前沿)
  world('fresh', 2, (r) => ({ n: int(r, 8, 40) }), async (ctx, p) => {
    const id = ctx.world.fresh(p.n)
    ctx.grownAt = Date.now(); ctx._lib = null
    const row = (await library(ctx)).find((x) => x.session_id === id)
    if (!row) return SKIP
    await go(ctx.page, deskHash(row))
  }),
  // a shrink answers an open tail's Range read: it is armed on d/open only
  world('fault', 5, (r) => { const kind = pick(r, FAULT_KINDS), name = pick(r, FAULT_NAMES); return { kind, name: kind === 'shrink' ? 'd/open' : name, n: int(r, 1, 3), ms: int(r, 0, 20000) } }, (ctx, p) => ctx.faults.arm(p)),
  world('kill', 2, () => ({}), async (ctx) => {
    // on the desk the kill lands in an answer-file read (/api/d/*); elsewhere in whichever read comes next (the worker answers every name)
    const desk = (await hashOf(ctx.page)).startsWith('#/replay/'), from = Date.now()
    const r = await killWorkerMidRead(ctx.b, { name: desk ? 'd' : null })
    if (!r.skipped) ctx.faults.log.push({ name: desk ? 'd' : '*', kind: 'kill', from, to: Date.now() })
    return r.skipped ? SKIP : undefined
  }),
]
const COMPOUND = new Set(['repeat', 'switchInFlight', 'history'])
const BY = new Map(ACTIONS.map((x) => [x.a, x]))

function genFrom(rng, w, rows) {
  const total = rows.reduce((s, x) => s + x.w, 0)
  let t = rng() * total
  const row = rows.find((x) => (t -= x.w) < 0) || rows[rows.length - 1]
  return { a: row.a, p: row.gen(rng, w) }
}

/** One step drawn from the weighted table; `real` keeps to reader rows (an external board has no world to grow or worker to kill). */
export const genStep = (rng, w, { real = false } = {}) => genFrom(rng, w, real ? ACTIONS.filter((x) => x.real) : ACTIONS)

// run one step with no settle; a reader step that did something is appended to ctx.actions as {t, a} (I-rate's reader window)
async function act(ctx, step) {
  const row = BY.get(step.a)
  if (!row) throw new Error(`unknown action ${step.a}`)
  const t = Date.now()
  const out = (await row.run(ctx, step.p)) || {}
  if (row.real && !out.skipped && step.a !== 'repeat') (ctx.actions || (ctx.actions = [])).push({ t, a: step.a })
  return out
}

/** Run one step, let the page paint, and keep ctx.follow equal to the follow chip's aria-pressed (false off the desk). → {skipped?} */
export async function runStep(ctx, step) {
  const out = await act(ctx, step)
  await ctx.page.waitForTimeout(120)
  await ctx.page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))))
  ctx.follow = await ctx.page.evaluate(() => document.querySelector('[data-follow]')?.getAttribute('aria-pressed') === 'true')
  return out.skipped ? { skipped: true } : {}
}
