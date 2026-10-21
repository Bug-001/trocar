// test/web-v2/browser/seq/invariants.mjs — the closed set of invariants a sequence run is held to (plan
// for frontend sequence runs): check(ctx) turns one moment's evidence (the page, the probe's snapshot,
// the request log, the reader's actions, armed fault windows) into violations. Every bound lives in LIMITS with its spec pointer;
// PENDING ids are measured and reported, never failed. Selectors are the board's ids / classes / data attributes, never wording.
// Exports only; nothing runs at import.
import { snap as probeSnap } from './probe.mjs'

export const IDS = Object.freeze(['I-pageerror', 'I-console', 'I-blank', 'I-keep', 'I-stack', 'I-hscroll', 'I-rate', 'I-write', 'I-leak',
  'I-mem', 'I-follow', 'I-hold', 'I-url', 'I-cjk', 'I-longtask', 'I-loadstep', 'I-memcap'])

export const PENDING = new Map([
  ['I-longtask', 'no task of the page over 50 ms (D64 ②)'],
  ['I-loadstep', 'no "Load this step" control and no step whose content is missing from the page'],
  ['I-memcap', 'the page heap stays under memCapBytes (80 MB)'],
])

export const LIMITS = Object.freeze({
  consoleGraceMs: 2000, // an armed fault window's console.error tail (plan §Invariants I-console)
  interval: Object.freeze({ status: 5000, sessions: 3000, session: 1500 }), // spec/01-trocar-rfc/4.4-server.md:45-52
  intervalOther: 30000, // 4.4:52 「其余 … 每 30 s」
  backoffCapMs: 30000, // 1.5 K-29 (spec/01-trocar-rfc/1.5-states-aesthetics.md:76): doubling, capped at 30 s
  sessionDurFactor: 3, // 4.4:51 the timer's next read waits ≥ 3 × the last read's duration
  rateSlack: 0.8, // timer jitter: a gap of 0.8 × the expected interval still passes (plan §Invariants I-rate)
  actionWindowMs: Object.freeze([-200, 500]), // a read within this of a reader action is the reader's read (4.4:51)
  returnReadMs: 2000, // the one read on becoming visible again (4.4:49-51)
  openReadMs: 10000, // a screen's opening reads after a route change, chained behind its first answers (4.4 「打开时」)
  leakSlack: 2, // a one-time lazy global wiring (core/dom.mjs wireKeys on the first dialog) is no leak; a per-visit one passes it by the 4th visit
  settleMs: 3000, // how long check waits for in-flight fetches to settle before I-leak counts them
  memRatio: 1.5, memSlackBytes: 10 * 2 ** 20, // plan §Invariants I-mem
  memCapBytes: 80 * 2 ** 20, // pending: no spec line sets this cap yet
  followMs: 15000, // spec/01-trocar-rfc/1.4-central-board.md:71-73 · 4.4:51
  longtaskMs: 50, // pending: D64 ② · plan …prefix-reads-and-cells.md §3.7
})

const STACK = [/^\s*at \S.*:\d+:\d+\)?\s*$/m, /FATAL ERROR/, /<--- Last few GCs --->/, /\b(?:node|v8)::\w/]
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/

const screenOf = (hash) => (hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'overview')
const routeOf = (hash) => hash.replace(/^#/, '').split('?')[0] || '/'
const paramsOf = (hash) => new URLSearchParams(hash.split('?')[1] || '')
const nameOf = (url) => { const p = url.split('?')[0]; return p.startsWith('/api/') ? p.slice(5) : p.slice(1) }
const failedRead = (e) => e.failed || e.cut || e.status === 0 || e.status >= 500
const baselines = new WeakMap() // page → Map(route → first-visit counts)
const cdps = new WeakMap()
const visits = new WeakMap() // page → {route, t}: when the route on screen was entered

async function heapUsed(page) {
  let s = cdps.get(page)
  if (!s) { s = await page.context().newCDPSession(page); cdps.set(page, s) }
  await s.send('HeapProfiler.collectGarbage')
  return (await s.send('Runtime.getHeapUsage')).usedSize
}

// the replay desk as the reader sees it: the step counter's two numbers and the window's request-row heads
const viewOf = (page) => page.evaluate(() => {
  const no = document.querySelector('#stepbar .sb-no')
  const m = no && /(\d+)\s*\/\s*(\d+)/.exec(no.textContent)
  return {
    hash: location.hash,
    step: m ? +m[1] : null, of: m ? +m[2] : null,
    heads: [...document.querySelectorAll('#ctxwin .cblk[data-bi]')].map((e) => `${e.dataset.bi}:${e.dataset.sec || ''}`),
    reply: !!document.querySelector('#ctxwin .cwreply'),
    loadStep: !!document.querySelector('[data-load-step], [data-state="missed"], .pobadge'),
    text: (document.querySelector('#content') || document.body).innerText,
    bodyText: document.body.innerText,
    sideways: document.documentElement.scrollWidth > innerWidth,
    dom: document.getElementsByTagName('*').length,
  }
})

/** I-rate over the probe's fetch log (see LIMITS for every bound). → [detail] */
function rateFaults(log, { actions = [], hidden = [] } = {}) {
  const out = []
  const [lo, hi] = LIMITS.actionWindowMs
  const byReader = (t) => actions.some((a) => t >= a.t + lo && t <= a.t + hi)
  const hiddenAt = (t) => hidden.some((h) => t > h.from && (h.to == null || t < h.to))
  const returnRead = new Set()
  for (const h of hidden) if (h.to != null) {
    const seen = new Set()
    for (const e of log) if (e.start >= h.to && e.start <= h.to + LIMITS.returnReadMs && !seen.has(nameOf(e.url))) { seen.add(nameOf(e.url)); returnRead.add(e) }
  }
  // a route change opens a screen: its first read of each name within openReadMs is the opening read (4.4 「打开时」)
  const opened = new Set()
  const sorted = [...log].filter((x) => x.method === 'GET').sort((a, b) => a.start - b.start)
  for (const a of actions) if (a.a === 'hashchange' || a.a === 'popstate') {
    const seen = new Set()
    for (const e of sorted) if (e.start >= a.t + LIMITS.actionWindowMs[0] && e.start <= a.t + LIMITS.openReadMs && !seen.has(nameOf(e.url))) { seen.add(nameOf(e.url)); opened.add(e) }
  }
  const last = new Map() // name → {start, dur, fails}
  for (const e of sorted) {
    const name = nameOf(e.url)
    if (byReader(e.start) || returnRead.has(e) || opened.has(e)) { last.delete(name); continue }
    if (hiddenAt(e.start)) out.push(`${name} read at ${e.start} while hidden`)
    const p = last.get(name)
    if (p) {
      const base = LIMITS.interval[name] || LIMITS.intervalOther
      let want = Math.min(base * 2 ** p.fails, LIMITS.backoffCapMs)
      if (name === 'session' && !p.fails) want = Math.max(want, LIMITS.sessionDurFactor * p.dur)
      const gap = e.start - p.start
      if (gap < LIMITS.rateSlack * want) out.push(`${name}: ${gap} ms after the last timer read, expected ≥ ${Math.round(LIMITS.rateSlack * want)} ms`)
    }
    const fails = failedRead(e) ? (p ? p.fails : 0) + 1 : 0
    last.set(name, { start: e.start, dur: (e.end ?? e.start) - e.start, fails })
  }
  return out
}

/**
 * check(ctx) → { violations:[{id, sig, detail}], pending:[{id, value, pointer}], view }.
 * ctx: { page, requests, errors, actions:[{t,a}], faults:[{name, kind, from, to}], hidden:[{from,to}], follow, grownAt (ms of the last
 * growth, or null), truth() → the main-lane count, real, prev (the `view` of the previous check), baseline (Map, optional: per-route
 * first-visit counts; default one per page) }. Call it when the page has settled.
 */
export async function check(ctx) {
  const { page, requests = [], errors = [], actions = [], faults = [], hidden = [], follow = false, grownAt = null, truth, real = false, prev = null } = ctx
  const base = ctx.baseline || baselines.get(page) || (baselines.set(page, new Map()), baselines.get(page))
  let s = await probeSnap(page)
  const v = await viewOf(page)
  const screen = screenOf(v.hash), route = routeOf(v.hash)
  const violations = [], pending = []
  const bad = (id, detail) => violations.push({ id, sig: `${id}:${screen}`, detail })

  if (errors.length) bad('I-pageerror', errors.slice(0, 3).join(' | '))
  const armed = (t) => faults.some((f) => t >= f.from && t <= (f.to ?? Infinity) + LIMITS.consoleGraceMs)
  const loose = s.consoleErrors.filter((c) => !armed(c.t))
  if (loose.length) bad('I-console', loose.slice(0, 3).map((c) => c.msg).join(' | '))
  if (s.blank.length) bad('I-blank', `${s.blank.length} blank frame(s), first at ${s.blank[0].hash}`)
  if (s.keep.length) bad('I-keep', `${s.keep.length} frame(s) of the never-drawn state over a drawn desk, first at ${s.keep[0].hash}`)
  const st = STACK.find((re) => re.test(v.text))
  if (st) bad('I-stack', `rendered text matches ${st}`)
  if (v.sideways) bad('I-hscroll', 'the document scrolls sideways')
  const rate = rateFaults(s.fetchLog, { actions, hidden })
  if (rate.length) bad('I-rate', rate.slice(0, 3).join(' | '))
  const writes = [...requests, ...s.fetchLog].filter((r) => r.method && r.method !== 'GET')
  if (writes.length) bad('I-write', writes.slice(0, 3).map((r) => `${r.method} ${r.url}`).join(' | '))

  // I-leak / I-mem: the route's first visit is its baseline; a later visit may not hold more
  const deadline = Date.now() + LIMITS.settleMs
  let first = base.get(route)
  // the world grew since the baseline: what the route draws grew with the data, so the baseline is taken again (not a leak)
  if (first && grownAt != null && grownAt > first.at) { base.delete(route); first = undefined }
  while (first && s.inflight > first.inflight && Date.now() < deadline) { await page.waitForTimeout(100); s = await probeSnap(page) }
  const now = { window: s.listeners.window, document: s.listeners.document, intervals: s.intervals, inflight: s.inflight, dom: v.dom, heap: await heapUsed(page), at: Date.now() }
  // a visit with a failed read drew a failure state; one with reads in flight, or hidden for a while (reads paused, 4.4), has not
  // drawn yet: no baseline (a later clean visit is)
  let visit = visits.get(page)
  if (!visit || visit.route !== route) visits.set(page, visit = { route, t: prev?.t ?? 0 })
  const clean = s.inflight === 0 && !hidden.some((h) => (h.to ?? Infinity) >= visit.t) && !s.fetchLog.some((e) => e.start >= visit.t && failedRead(e) && !e.aborted) // and nothing still on its way
  if (!first) { if (clean) base.set(route, now) }
  else if (!prev || routeOf(prev.hash) !== route) { // a revisit (the route was just entered again); within one visit an open overlay may hold more
    const more = ['window', 'document', 'intervals', 'inflight'].filter((k) => now[k] > first[k] + LIMITS.leakSlack)
    if (more.length) bad('I-leak', more.map((k) => `${k} ${first[k]} → ${now[k]}`).join(', '))
    const grew = []
    if (now.dom > LIMITS.memRatio * first.dom) grew.push(`elements ${first.dom} → ${now.dom}`)
    // a first visit's heap is a cold page's (no store, no caches yet): the heap's baseline is the route's first revisit
    if (first.warm == null) first.warm = now.heap
    else if (now.heap > LIMITS.memRatio * first.warm + LIMITS.memSlackBytes) grew.push(`heap ${first.warm} → ${now.heap}`)
    if (grew.length) bad('I-mem', grew.join(', '))
  }
  if (now.heap > LIMITS.memCapBytes) pending.push({ id: 'I-memcap', value: now.heap, pointer: PENDING.get('I-memcap') })

  // I-follow / I-hold / I-url: the replay desk
  const desk = screen === 'replay' && v.step != null
  // a hidden tab reads nothing (4.4:49-51): following is held to the growth only from the later of the growth and the return
  const shownAt = Math.max(grownAt ?? 0, ...hidden.map((h) => h.to ?? Infinity))
  if (desk && follow && grownAt != null && truth && shownAt !== Infinity) {
    let w = v, m = await truth()
    while (!(w.step === m && w.of === m && w.reply) && Date.now() < shownAt + LIMITS.followMs) {
      await page.waitForTimeout(250); w = await viewOf(page); m = await truth()
    }
    if (!(w.step === m && w.of === m && w.reply)) bad('I-follow', `following: shows ${w.step} / ${w.of}${w.reply ? '' : ' without the reply'}, the server has ${m}`)
  }
  if (desk && !follow && prev && prev.step != null && grownAt != null && grownAt >= prev.t && !actions.some((a) => a.t > prev.t) && routeOf(prev.hash) === route) {
    if (v.step !== prev.step || v.heads.join() !== prev.heads.join()) bad('I-hold', `step ${prev.step} → ${v.step}, ${prev.heads.length} → ${v.heads.length} row heads`)
  }
  const qs = paramsOf(v.hash)
  if (desk && qs.has('step') && !qs.has('call') && +qs.get('step') !== v.step) bad('I-url', `step=${qs.get('step')} while step ${v.step} is shown`)
  if (!real && CJK.test(v.bodyText)) bad('I-cjk', `CJK in the page: ${JSON.stringify(v.bodyText.match(CJK)[0])}`)

  if (s.longtaskMax > LIMITS.longtaskMs) pending.push({ id: 'I-longtask', value: s.longtaskMax, pointer: PENDING.get('I-longtask') })
  if (v.loadStep) pending.push({ id: 'I-loadstep', value: true, pointer: PENDING.get('I-loadstep') })
  return { violations, pending, view: { t: Date.now(), hash: v.hash, step: v.step, heads: v.heads } }
}
