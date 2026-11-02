// test/web-v2/browser/seq/probe.mjs — what the sequence harness can only see from inside the page, installed before the board's own
// scripts run (page.addInitScript): live listeners on window / document / other targets (keyed by target, type, listener, capture),
// live intervals, in-flight fetches and the log of every /api · /control fetch (start, end, status, failed / aborted / cut body, an
// answer carrying `pending`, the route (hash before `?`) it was sent from, and for a head answer its sealed packs' tags {n: tag}),
// AbortControllers created / aborted, long tasks, console.error calls, and a per-frame sampler of two reader-visible faults:
//   blank — after #screen first held visible content, a frame where it has no element child or no visible text (1.5 K-29);
//   keep  — a replay desk that was drawn (#ctxwin holds rows) for the route still in the hash, replaced by the never-drawn failure
//           state (replay.mjs renderEmpty: `#ctxwin > .empty`, not the not-listed one) (1.5 K-29).
// window.__seq: { snap(), setHidden(bool), reset() }. Exports only; nothing runs at import.

function pageProbe() {
  if (window.__seq) return
  const now = () => Date.now()
  const CAP = 5000
  const push = (list, x) => { list.push(x); if (list.length > CAP) list.splice(0, list.length - CAP) }
  const S = { fetchLog: [], inflight: 0, intervals: new Set(), ac: { created: 0, aborted: 0 }, longtasks: [], consoleErrors: [], blank: [], keep: [] }

  // ── listeners ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const ET = EventTarget.prototype
  const add = ET.addEventListener, remove = ET.removeEventListener
  const live = new Map() // window | document → Set of keys; other targets only counted
  const other = new WeakMap()
  let otherCount = 0
  const cls = (t) => (t === window ? 'window' : t === document ? 'document' : 'other')
  const keyOf = (type, fn, capture) => ({ type, fn, capture })
  const setFor = (t) => {
    if (cls(t) !== 'other') { if (!live.has(t)) live.set(t, []); return live.get(t) }
    if (!other.has(t)) other.set(t, [])
    return other.get(t)
  }
  const capOf = (o) => (typeof o === 'boolean' ? o : !!(o && o.capture))
  ET.addEventListener = function (type, fn, opts) {
    const r = add.call(this, type, fn, opts)
    if (fn && !(opts && typeof opts === 'object' && opts.once)) {
      const list = setFor(this), capture = capOf(opts)
      if (!list.some((k) => k.type === type && k.fn === fn && k.capture === capture)) {
        const k = keyOf(type, fn, capture)
        list.push(k)
        if (cls(this) === 'other') otherCount++
        const sig = opts && typeof opts === 'object' && opts.signal
        if (sig) add.call(sig, 'abort', () => drop(this, k), { once: true })
      }
    }
    return r
  }
  const drop = (t, k) => { const list = setFor(t), i = list.indexOf(k); if (i >= 0) { list.splice(i, 1); if (cls(t) === 'other') otherCount-- } }
  ET.removeEventListener = function (type, fn, opts) {
    const r = remove.call(this, type, fn, opts)
    const capture = capOf(opts), k = setFor(this).find((x) => x.type === type && x.fn === fn && x.capture === capture)
    if (k) drop(this, k)
    return r
  }

  // ── intervals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const setI = window.setInterval, clearI = window.clearInterval, clearT = window.clearTimeout
  window.setInterval = function (...a) { const id = setI.apply(this, a); S.intervals.add(id); return id }
  window.clearInterval = function (id) { S.intervals.delete(id); return clearI.call(this, id) }
  window.clearTimeout = function (id) { S.intervals.delete(id); return clearT.call(this, id) }

  // ── fetch: in flight, and the log of board reads (a body that never fully arrives is a cut answer, 1.5 K-29) ────────────────
  const of = window.fetch
  const byResponse = new WeakMap()
  // the desk on screen when a read starts (I-pack): a desk only reads while it is attached, and keeps its root when it comes back from the cache
  const desks = new WeakMap(); let nDesk = 0
  const deskNo = () => { const d = document.querySelector('#screen .desk'); if (!d) return null; if (!desks.has(d)) desks.set(d, ++nDesk); return desks.get(d) }
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href)
    const board = /^\/(api|control)\//.test(url.pathname)
    const e = board ? { url: url.pathname + url.search, method: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(), start: now(), end: null, status: null, failed: false, aborted: false, cut: false, pending: false, route: location.hash.split('?')[0], desk: deskNo(), tags: null } : null
    if (e) push(S.fetchLog, e)
    S.inflight++
    let p
    try { p = of.call(this, input, init) } catch (err) { S.inflight--; throw err }
    return p.then((r) => { S.inflight--; if (e) { e.end = now(); e.status = r.status; byResponse.set(r, e) } return r },
      (err) => { S.inflight--; if (e) { e.end = now(); e.status = 0; e.failed = true; e.aborted = !!(err && err.name === 'AbortError') } throw err })
  }
  // an answer carrying `pending` (3.5 §抽取前沿: the server is still extracting) is marked: I-rate's next-read rule depends on it (4.4:52)
  // a head answer's sealed packs are kept as {n: tag} (I-pack)
  const docOf = (m, x) => { try { return m === 'text' ? (x.includes('"pending"') || x.includes('"packs"') ? JSON.parse(x) : null) : m === 'json' ? x : null } catch { return null } }
  for (const m of ['text', 'json', 'arrayBuffer']) {
    const orig = Response.prototype[m]
    Response.prototype[m] = function (...a) {
      const e = byResponse.get(this)
      return orig.apply(this, a).then((x) => {
        if (e) {
          // the board reads every answer as bytes (core/http.mjs readBody): a head answer's bytes are decoded here
          const d = m === 'arrayBuffer' ? (e.url.startsWith('/api/d/head') ? docOf('text', new TextDecoder().decode(x)) : null) : docOf(m, x)
          e.pending = !!d && d.pending != null
          if (d && Array.isArray(d.packs) && e.url.startsWith('/api/d/head')) e.tags = Object.fromEntries(d.packs.map((p) => [p.n, p.tag]))
        }
        return x
      },
        (err) => { if (e) { e.cut = true; e.aborted = !!(err && err.name === 'AbortError') } throw err })
    }
  }

  // ── AbortControllers ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const AC = window.AbortController
  window.AbortController = class extends AC {
    constructor() { super(); S.ac.created++; add.call(this.signal, 'abort', () => { S.ac.aborted++ }, { once: true }) }
  }

  // ── long tasks, console.error ─────────────────────────────────────────────────────────────────────────────────────────────
  // a task of the page's own (a timer, an event, a parse) over 50 ms; code a test runs through page.evaluate is no task and is not seen
  try { new PerformanceObserver((l) => { for (const x of l.getEntries()) push(S.longtasks, { t: performance.timeOrigin + x.startTime, ms: x.duration }) }).observe({ type: 'longtask', buffered: true }) } catch { /* no long-task timing here */ }
  const ce = console.error
  console.error = function (...a) { push(S.consoleErrors, { t: now(), msg: a.map((x) => String(x && x.stack ? x.message : x)).join(' ').slice(0, 300) }); return ce.apply(this, a) }

  // ── hidden ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let forced = null
  const hd = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden'), vd = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
  Object.defineProperty(document, 'hidden', { configurable: true, get() { return forced == null ? hd.get.call(this) : forced } })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return forced == null ? vd.get.call(this) : forced ? 'hidden' : 'visible' } })

  // ── the frame sampler ─────────────────────────────────────────────────────────────────────────────────────────────────────
  let painted = false, drawnKey = null
  const route = () => location.hash.replace(/^#/, '').split('?')[0]
  const visibleText = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) })
    for (let n; (n = w.nextNode());) { const el = n.parentElement; if (el && el.checkVisibility()) return true }
    return false
  }
  const frame = () => {
    const sc = document.getElementById('screen')
    if (sc) {
      const full = !!sc.firstElementChild && visibleText(sc)
      if (full) painted = true
      else if (painted) push(S.blank, { t: now(), hash: location.hash })
      const r = route()
      if (r !== drawnKey) drawnKey = null // another route: the next desk has not been drawn yet
      if (r.startsWith('/replay/')) {
        if (document.querySelector('#ctxwin .cblk')) drawnKey = r
        else if (drawnKey === r && document.querySelector('#ctxwin > .empty:not(#notlisted)')) push(S.keep, { t: now(), hash: location.hash })
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  const count = (t) => (live.get(t) || []).length
  window.__seq = {
    snap: () => ({
      t: now(),
      listeners: { window: count(window), document: count(document), other: otherCount },
      intervals: S.intervals.size,
      inflight: S.inflight,
      ac: { ...S.ac },
      longtasks: S.longtasks.slice(), longtaskMax: S.longtasks.reduce((m, x) => Math.max(m, x.ms), 0),
      consoleErrors: S.consoleErrors.slice(),
      blank: S.blank.slice(), keep: S.keep.slice(),
      fetchLog: S.fetchLog.map((x) => ({ ...x })),
      hidden: document.hidden,
    }),
    setHidden(v) { forced = v ? true : null; document.dispatchEvent(new Event('visibilitychange')) },
    reset() { for (const k of ['fetchLog', 'longtasks', 'consoleErrors', 'blank', 'keep']) S[k].length = 0 },
  }
}

/** Install the probe on `page` before its first navigation (it re-runs on every load). */
export const installProbe = (page) => page.addInitScript(pageProbe)
/** The page's evidence now (see window.__seq.snap above). */
export const snap = (page) => page.evaluate(() => window.__seq.snap())
/** Make document.hidden / visibilityState read `hidden` and dispatch visibilitychange. */
export const setHidden = (page, hidden) => page.evaluate((h) => window.__seq.setHidden(h), hidden)
/** Forget the page's logs (lists only; live counts stay). */
export const resetProbe = (page) => page.evaluate(() => window.__seq.reset())
