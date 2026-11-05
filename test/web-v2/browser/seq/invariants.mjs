// test/web-v2/browser/seq/invariants.mjs — the closed set of invariants a sequence run is held to:
// check(ctx) turns one moment's evidence (the page, the probe's snapshot,
// the request log, the reader's actions, armed fault windows) into violations. Every bound lives in LIMITS with its spec pointer;
// PENDING ids are measured and reported, never failed. Selectors are the board's ids / classes / data attributes, never wording.
// Exports only; nothing runs at import.
import { snap as probeSnap } from './probe.mjs'
import { WRITE_GAP_MS } from '../../../../web/legacy/core/router.mjs'
import { BOARD_LINES } from '../../perf-lines.mjs'

export const IDS = Object.freeze(['I-pageerror', 'I-console', 'I-blank', 'I-keep', 'I-stack', 'I-hscroll', 'I-rate', 'I-write', 'I-leak',
  'I-mem', 'I-heap', 'I-follow', 'I-hold', 'I-url', 'I-cjk', 'I-longtask', 'I-loadstep', 'I-chapter', 'I-pack', 'I-memcap', 'I-select', 'I-review', 'I-order'])

export const PENDING = new Map([
  ['I-memcap', 'the page heap stays under memCapBytes (80 MB)'],
])

/** Invariants judged against a bound a loaded box can cross through noise alone (a task's 50 ms, the follow deadline, the heap's
 *  growth ratio): a run that meets one is reproduced once and saved whole, never shrunk (runner findOne). I-mem (the element count)
 *  is exact and is shrunk. */
export const TIMING = new Set(['I-longtask', 'I-follow', 'I-heap'])

export const LIMITS = Object.freeze({
  consoleGraceMs: 2000, // an armed fault window's console.error tail (invariant I-console)
  // the desk's poll round (4.4 live-poll): the head and a Range read of each open tail, 1.5 s
  interval: Object.freeze({ status: 5000, sessions: 15000, session: 1500, 'd/head': 1500, 'd/open.main': 1500, 'd/open.rest': 1500 }), // spec/01-trocar-rfc/4.4-server.md:45-52
  intervalOther: 30000, // 4.4:52 「其余 … 每 30 s」
  backoffCapMs: 30000, // 1.5 K-29 (spec/01-trocar-rfc/1.5-states-aesthetics.md:61): doubling, capped at 30 s
  sessionDurFactor: 3, // 4.4:51 the timer's next read waits ≥ 3 × the last read's duration
  rateSlack: 0.8, // timer jitter: a gap of 0.8 × the expected interval still passes (invariant I-rate)
  actionWindowMs: Object.freeze([-200, 500]), // a read within this of a reader action is the reader's read (4.4:51)
  returnReadMs: 2000, // the one read on becoming visible again (4.4:49-51)
  openReadMs: 10000, // a screen's opening reads after a route change, chained behind its first answers (4.4 「打开时」)
  leakSlack: 2, // a one-time lazy global wiring (core/dom.mjs wireKeys on the first dialog) is no leak; a per-visit one passes it by the 4th visit
  settleMs: 3000, // how long check waits for in-flight fetches to settle before I-leak counts them
  memRatio: 1.5, memSlackBytes: 10 * 2 ** 20, // invariants I-mem (elements) and I-heap
  memCapBytes: 80 * 2 ** 20, // pending: no spec line sets this cap yet
  followMs: 15000, // spec/01-trocar-rfc/1.4-central-board.md:71-73 · 4.4:51
  longtaskMs: 50, // D64 ②: no task of the page's own over 50 ms after a step inside the open session starts (2.3 #27)
  loaderMax: 3, // spec/01-trocar-rfc/2.3-context-window.md:186 加载器: at most 3 of the desk's loader reads on their way at once
  chapterSettleMs: 1000, // the chapter row and the step bar are drawn by one paint; a check that lands between two frames looks again
})

const STACK = [/^\s*at \S.*:\d+:\d+\)?\s*$/m, /FATAL ERROR/, /<--- Last few GCs --->/, /\b(?:node|v8)::\w/]
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/
// where the board draws captured bytes, not its own words: verbatim bodies (<pre>, blocks.mjs), block rows (tag + preview) and
// outline entries. A stack the session itself holds (a tool_result's trace) is content; I-stack reads only what is left.
const CAPTURED = 'pre, .cblk, .navsub'

/** What tells one bug from another of the same `<id>:<screen>`: the detail's first item with every number (and hex run holding a
 *  digit) as `#`, whitespace folded. Saved with an open regression; a violation is known only when its sig AND this match. */
export const fingerprint = (detail) => String(detail).split(' | ')[0].replace(/[0-9a-f]*\d[0-9a-f]*/gi, '#').replace(/\s+/g, ' ').trim().slice(0, 160)

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

// the replay desk as the reader sees it: the step counter's two numbers, the 跟随最新 chip and the window's request-row heads
const viewOf = (page) => page.evaluate((sel) => {
  const no = document.querySelector('#stepbar .sb-no')
  const m = no && /(\d+)\s*\/\s*(\d+)/.exec(no.textContent)
  return {
    hash: location.hash,
    step: m ? +m[1] : null, of: m ? +m[2] : null, follow: document.querySelector('.sh-follow')?.getAttribute('aria-pressed') === 'true',
    heads: [...document.querySelectorAll('#ctxwin .cblk[data-bi]')].map((e) => `${e.dataset.bi}:${e.dataset.sec || ''}`),
    reply: !!document.querySelector('#ctxwin .cwreply'),
    // a load control (2.3 #10 · 1.2 读取状态): any [data-load-step]; on the desk, any control inside an aria-busy frame or the
    // read-state line ([data-read-state])
    loadStep: ((ctl) => {
      const desk = /^#\/?replay\//.test(location.hash)
      const el = document.querySelector(['[data-load-step]', ...(desk ? [`[aria-busy="true"] ${ctl}`, `[data-read-state] ${ctl}`] : [])].join(', '))
      return el && `${el.tagName.toLowerCase()} ${el.matches('[data-load-step]') ? '[data-load-step]' : el.closest('[data-read-state]') ? 'in [data-read-state]' : 'in [aria-busy="true"]'}`
    })(':is(button, a, [role=button], [tabindex])'),
    // the rendered text with the captured blocks invisible for this one synchronous read: innerText skips visibility:hidden, which
    // changes no box (no layout shift, no scroll clamped) and no frame is drawn in between
    own: ((root) => {
      if (!document.getElementById('seq-own')) document.head.append(Object.assign(document.createElement('style'), { id: 'seq-own', textContent: `[data-seq-own] :is(${sel}), [data-seq-own] :is(${sel}) * { visibility: hidden !important }` }))
      root.setAttribute('data-seq-own', '')
      try { return root.innerText } finally { root.removeAttribute('data-seq-own') }
    })(document.querySelector('#content') || document.body),
    bodyText: document.body.innerText,
    // the chapter row (1.3 §章): the label's global span [s0, s1); the playhead's step (1-based data-n, the real or the rough step
    // label); the drawn window's first and last step (1-based, the axis ends)
    chapter: ((l) => l && { s0: +l.dataset.s0, s1: +l.dataset.s1 })(document.querySelector('#chapnav .chaplabel')),
    at: ((e) => (e ? +e.dataset.n : null))(document.querySelector('#stepbar .sb-no[data-n], #stepbar .sb-at[data-n]')),
    win: ['#sawstart', '#sawend'].map((id) => +((/\d+/.exec(document.querySelector(id)?.textContent || '') || [])[0] ?? NaN)),
    // the review range on the main track (2.1 #5): is the bracket drawn with a width, and which drawn bars are .reviewed
    review: ((br) => ({ bracket: !!br && getComputedStyle(br).display !== 'none' && br.getBoundingClientRect().width > 0,
      bars: [...document.querySelectorAll('#sawrow .bar')].map((b) => b.classList.contains('reviewed')) }))(document.querySelector('#reviewbracket')),
    // the window's request rows in DOM order (I-order): data-bi, and the top of each row that has a box (null: none)
    order: [...document.querySelectorAll('#ctxwin .cblk[data-bi]')].map((e) => [+e.dataset.bi, e.getClientRects().length ? e.getBoundingClientRect().top : null]),
    sideways: document.documentElement.scrollWidth > innerWidth,
    dom: document.getElementsByTagName('*').length,
  }
}, CAPTURED)

// a poll round's follow-up reads (4.4 live-poll): one `lane --from` (the anchor lane's ledger) per round that brought anchor-lane
// steps, one `block` read per followed new call
const DELTA_PACED = new Set(['lane', 'block'])
// what I-rate paces: a name, the answer files (`d/head`, `d/open.<part>`) of each session apart, and for `lane` each lane of each session apart; null = not paced: the desk's loader — the sealed packs
// (`d/p<n>.<part>`), a lane's ledger (`ledger=`, and the `to=` page that opens it), 2.3 加载器 · 3.5 §手里车道的页 — and
// the later pages of one `sessions` read (`after=`, C.5) read one cursor after another by design
const rateKey = (url) => {
  const name = nameOf(url), q = new URLSearchParams(url.split('?')[1] || '')
  if ((name === 'sessions' && q.has('after')) || (name === 'session' && q.has('before')) || /^d\/p\d/.test(name)) return null
  if (/^d\//.test(name)) return `${name} ${q.get('id')}`
  if (name !== 'lane') return name
  if (q.has('ledger') || q.has('to')) return null
  return `lane ${q.get('id')} ${q.get('lane')}`
}

/** I-rate over the probe's fetch log (see LIMITS for every bound; the session rule is 4.4:52, live-poll). → [detail] */
function rateFaults(log, { actions = [], hidden = [] } = {}) {
  const out = []
  const [lo, hi] = LIMITS.actionWindowMs
  // a page load is no reader action (a goto, a background tab's open): its reads are judged as the load's opening below
  const byReader = (t) => actions.some((a) => a.a !== 'load' && t >= a.t + lo && t <= a.t + hi)
  const hiddenAt = (t) => hidden.some((h) => t > h.from && (h.to == null || t < h.to))
  const sorted = [...log].filter((x) => x.method === 'GET').sort((a, b) => a.start - b.start)
  // the first read of each key in a window is the screen's own: on becoming visible again (4.4:49-51) and on opening (4.4 「打开时」: a load,
  // a hashchange, a popstate). A load's are kept apart: a page can load in a hidden tab, so its opening reads are judged hidden below
  const exempt = new Set(), loadExempt = new Set()
  const firstIn = (from, to, set = exempt) => { const seen = new Set(); for (const e of sorted) if (e.start >= from && e.start <= to && !seen.has(rateKey(e.url))) { seen.add(rateKey(e.url)); set.add(e) } }
  for (const h of hidden) if (h.to != null) firstIn(h.to, h.to + LIMITS.returnReadMs)
  for (const a of actions) if (a.a === 'hashchange' || a.a === 'popstate') firstIn(a.t + lo, a.t + LIMITS.openReadMs)
  for (const a of actions) if (a.a === 'load') firstIn(a.t + lo, a.t + LIMITS.openReadMs, loadExempt)
  const last = new Map() // key → {start, dur, fails, pending, recovered}
  let sessionAt = -Infinity // the start of the latest poll round (its head read, or a `session` read), whatever caused it
  for (const e of sorted) {
    const name = nameOf(e.url), key = rateKey(e.url), p = last.get(key)
    const since = sessionAt, failed = failedRead(e)
    if (name === 'session' || name === 'd/head') sessionAt = e.start
    if (key == null) continue
    // the reader's read (and a screen it opened) starts the timer's chain over. Input reaching a hidden page is the harness's emulation:
    // such reads are the reader's, not the hidden tab's
    if (byReader(e.start) || exempt.has(e)) { last.delete(key); continue }
    // a hidden tab reads nothing by itself (1.7 「页面不可见时全部停」), a load's opening reads included. A read on becoming visible again
    // starts at or after the return: not hidden
    if (hiddenAt(e.start)) out.push(`${name} read at ${e.start} while hidden`)
    if (loadExempt.has(e)) { last.delete(key); continue }
    // an open tail read again in its own poll round (no head read since) is the round's whole read after a Range answer that was not
    // the file's lines or a 416 (4.4 §答案文件, replay.mjs readTail): once per round
    if (p && /^d\/open/.test(name) && since <= p.start && !p.chained) { last.set(key, { ...p, chained: true }); continue }
    last.set(key, { start: e.start, dur: (e.end ?? e.start) - e.start, fails: failed ? (p ? p.fails : 0) + 1 : 0, pending: !!e.pending, recovered: !failed && !!p && p.fails > 0 })
    if (!p) continue
    const base = DELTA_PACED.has(name) ? LIMITS.interval.session : LIMITS.interval[name] || LIMITS.intervalOther
    if (DELTA_PACED.has(name) && !p.fails) {
      if (since <= p.start) out.push(`${key}: read again with no session delta in between`)
      continue
    }
    // after k failures in a row: interval × 2^(k-1), ≤ 30 s; after a success: the interval, and for `session` (4.4 live-poll) 3 × that read's
    // duration unless it answered `pending` or ended a back-off
    let want = p.fails ? Math.min(base * 2 ** (p.fails - 1), LIMITS.backoffCapMs) : base
    if ((name === 'session' || name === 'd/head') && !p.fails && !p.pending && !p.recovered) want = Math.max(want, LIMITS.sessionDurFactor * p.dur)
    const gap = e.start - p.start
    if (gap < LIMITS.rateSlack * want) out.push(`${key}: ${gap} ms after the last timer read, expected ≥ ${Math.round(LIMITS.rateSlack * want)} ms`)
  }
  return out
}

// the desk's loader reads (2.3 加载器): the sealed packs, a lane's ledger chain (`ledger=` / `to=`), block bodies
const loaderRead = (url) => { const name = nameOf(url), q = new URLSearchParams(url.split('?')[1] || ''); return /^d\/p\d/.test(name) || name === 'block' || (name === 'lane' && (q.has('ledger') || q.has('to'))) }

/** I-pack over the probe's fetch log: within one desk (a desk taken back from the session cache is the same desk; one built after its
 *  session left the cache, 1.2 §路由, is a new one and reads its packs again), a pack file is read again at
 *  the same head tag only after a read of that pack failed; at most LIMITS.loaderMax loader reads are on their way at once. → [detail] */
function packFaults(log) {
  const out = [], sorted = log.filter((x) => x.method === 'GET').sort((a, b) => a.start - b.start)
  const heads = sorted.filter((e) => e.tags && e.end != null).sort((a, b) => a.end - b.end)
  const tagAt = (id, n, t) => { let tag; for (const h of heads) if (h.end <= t && new URLSearchParams(h.url.split('?')[1]).get('id') === id) tag = h.tags[n]; return tag }
  const held = new Map() // `<desk> <id> <n> <part>` → the tag it was read at
  for (const e of sorted) {
    const m = /^d\/p(\d+)\.(\w+)$/.exec(nameOf(e.url))
    if (m) {
      const id = new URLSearchParams(e.url.split('?')[1]).get('id'), pack = `${e.desk ?? e.route} ${id} ${m[1]}`, key = `${pack} ${m[2]}`, tag = tagAt(id, m[1], e.start)
      if (failedRead(e) || e.aborted || (e.end != null && e.status !== 200)) { for (const k of [...held.keys()]) if (k.startsWith(`${pack} `)) held.delete(k); continue }
      if (held.has(key) && held.get(key) === tag) out.push(`${nameOf(e.url)} read again at tag ${tag}`)
      if (e.end != null) held.set(key, tag)
    }
    if (loaderRead(e.url)) {
      const on = sorted.filter((x) => x.route === e.route && loaderRead(x.url) && x.start <= e.start && (x.end == null || x.end > e.start)).length
      if (on > LIMITS.loaderMax) out.push(`${on} loader reads on their way at once`)
    }
  }
  return out
}

/**
 * check(ctx) → { violations:[{id, sig, fp, detail}], pending:[{id, value, pointer}], view }.
 * ctx: { page, requests, errors, actions:[{t,a}], faults:[{name, kind, from, to}], hidden:[{from,to}], follow, grownAt (ms of the last
 * growth, or null), truth() → the main-lane count, real, prev (the `view` of the previous check), baseline (Map, optional: per-route
 * first-visit counts; default one per page), drag ({made, changed} of a select step just run, else null), stepAt (the step's start on
 * the page's clock, performance.timeOrigin + now(); default: judge every long task) }. Call it when the page has settled.
 */
export async function check(ctx) {
  const { page, requests = [], errors = [], actions = [], faults = [], hidden = [], follow = false, grownAt = null, truth, real = false, prev = null, drag = null } = ctx
  const base = ctx.baseline || baselines.get(page) || (baselines.set(page, new Map()), baselines.get(page))
  let s = await probeSnap(page)
  const v = await viewOf(page)
  const screen = screenOf(v.hash), route = routeOf(v.hash)
  const violations = [], pending = []
  const bad = (id, detail) => violations.push({ id, sig: `${id}:${screen}`, fp: fingerprint(detail), detail })

  // 1.2 §点击与选中文字: a drag that selected text opened or closed nothing
  if (drag?.made && drag.changed.length) bad('I-select', drag.changed.slice(0, 3).join(' | '))
  if (errors.length) bad('I-pageerror', errors.slice(0, 3).join(' | '))
  const armed = (t) => faults.some((f) => t >= f.from && t <= (f.to ?? Infinity) + LIMITS.consoleGraceMs)
  const loose = s.consoleErrors.filter((c) => !armed(c.t))
  if (loose.length) bad('I-console', loose.slice(0, 3).map((c) => c.msg).join(' | '))
  if (s.blank.length) bad('I-blank', `${s.blank.length} blank frame(s), first at ${s.blank[0].hash}`)
  if (s.keep.length) bad('I-keep', `${s.keep.length} frame(s) of the never-drawn state over a drawn desk, first at ${s.keep[0].hash}`)
  const st = STACK.find((re) => re.test(v.own))
  if (st) { const i = st.exec(v.own).index; bad('I-stack', `${v.own.slice(v.own.lastIndexOf('\n', i) + 1).trimStart().split('\n')[0].slice(0, 200)} (matches ${st})`) }
  if (v.sideways) bad('I-hscroll', 'the document scrolls sideways')
  const rate = rateFaults(s.fetchLog, { actions, hidden })
  if (rate.length) bad('I-rate', rate.slice(0, 3).join(' | '))
  const writes = [...requests, ...s.fetchLog].filter((r) => r.method && r.method !== 'GET')
  if (writes.length) bad('I-write', writes.slice(0, 3).map((r) => `${r.method} ${r.url}`).join(' | '))

  // I-leak / I-mem / I-heap: the route's first visit is its baseline; a later visit may not hold more
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
  // a desk whose session the server is still extracting (its head answered `pending`, 3.5 §抽取前沿) or whose head has not answered
  // yet has drawn only part of the session: the packs come once the head lists them, so it is not a baseline either
  const head = s.fetchLog.findLast((e) => e.route === `#${route}` && e.url.startsWith('/api/d/head') && e.end != null && e.status !== 304)
  const clean = s.inflight === 0 && !hidden.some((h) => (h.to ?? Infinity) >= visit.t) && !s.fetchLog.some((e) => e.start >= visit.t && failedRead(e) && !e.aborted) // and nothing still on its way
    && (screen !== 'replay' || (!!head && !head.pending))
  if (!first) { if (clean) base.set(route, now) }
  else if (!prev || routeOf(prev.hash) !== route) { // a revisit (the route was just entered again); within one visit an open overlay may hold more
    const more = ['window', 'document', 'intervals', 'inflight'].filter((k) => now[k] > first[k] + LIMITS.leakSlack)
    if (more.length) bad('I-leak', more.map((k) => `${k} ${first[k]} → ${now[k]}`).join(', '))
    if (now.dom > LIMITS.memRatio * first.dom) bad('I-mem', `elements ${first.dom} → ${now.dom}`)
    // a first visit's heap is a cold page's (no store, no caches yet): the heap's baseline is the route's first revisit
    if (first.warm == null) first.warm = now.heap
    else if (now.heap > LIMITS.memRatio * first.warm + LIMITS.memSlackBytes) bad('I-heap', `heap ${first.warm} → ${now.heap}`)
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
  // I-url (1.2 §路由): `step=` names the shown step, and on the desk no step (and no call) ⇔ following. The URL may land up to
  // WRITE_GAP_MS after the view (the writer's bound for a burst; a lone change is immediate)
  const urlOff = (x) => {
    const qs = paramsOf(x.hash)
    if (qs.has('call')) return null
    if (qs.has('step') && +qs.get('step') !== x.step) return `step=${qs.get('step')} while step ${x.step} is shown`
    if (!qs.has('step') !== x.follow) return x.follow ? `step=${qs.get('step')} while following` : 'no step while not following'
    return null
  }
  if (desk && urlOff(v)) {
    let x = v
    for (const t0 = Date.now(); urlOff(x) && x.step != null && Date.now() - t0 < WRITE_GAP_MS;) { await page.waitForTimeout(50); x = await viewOf(page) }
    if (x.step != null && urlOff(x)) bad('I-url', urlOff(x))
  }
  if (!real && CJK.test(v.bodyText)) bad('I-cjk', `CJK in the page: ${JSON.stringify(v.bodyText.match(CJK)[0])}`)

  // I-chapter (1.3 §章): the playhead's step lies in the chapter the label names, and so does the drawn window
  const chapterOff = (x) => {
    if (screen !== 'replay' || !x.chapter || x.at == null || x.win.some(Number.isNaN)) return null
    const { s0, s1 } = x.chapter, g = x.at - 1, [a, b] = x.win.map((n) => n - 1)
    if (!(s0 <= g && g < s1)) return `step ${g} outside its chapter [${s0}, ${s1})`
    if (!(s0 <= a && b < s1)) return `window [${a}, ${b}] outside the chapter [${s0}, ${s1})`
    return null
  }
  if (chapterOff(v)) {
    let x = v
    for (const t0 = Date.now(); chapterOff(x) && Date.now() - t0 < LIMITS.chapterSettleMs;) { await page.waitForTimeout(100); x = await viewOf(page) }
    if (chapterOff(x)) bad('I-chapter', chapterOff(x))
  }
  // I-review (2.1 #5 · 1.3 §跨轨联动): the bracket is drawn with a width iff some bar is .reviewed, and the .reviewed bars are a prefix
  // of the drawn bars (the review range is [lo, k))
  const rv = v.review, some = rv.bars.includes(true), prefix = rv.bars.indexOf(false) < 0 || !rv.bars.slice(rv.bars.indexOf(false)).includes(true)
  if (rv.bracket !== some) bad('I-review', `the review bracket is ${rv.bracket ? '' : 'not '}drawn and ${some ? 'some' : 'no'} bar is reviewed`)
  if (!prefix) bad('I-review', 'the reviewed bars are not a prefix of the drawn bars')
  // I-order (2.3 rule 4 · D75④): the window's request rows stand in list order, in the DOM and on screen — data-bi strictly
  // increasing in DOM order, and each row with a box below the one before (virtualized items never swap or overlap)
  const ord = v.order.findIndex(([bi], i) => i > 0 && !(bi > v.order[i - 1][0]))
  if (ord > 0) bad('I-order', `row data-bi ${v.order[ord][0]} after ${v.order[ord - 1][0]} in the DOM`)
  const boxed = v.order.filter(([, y]) => y != null), up = boxed.findIndex(([, y], i) => i > 0 && !(y > boxed[i - 1][1]))
  if (up > 0) bad('I-order', `row data-bi ${boxed[up][0]} at ${boxed[up][1]} px is not below row ${boxed[up - 1][0]} at ${boxed[up - 1][1]} px`)
  const pk = packFaults(s.fetchLog)
  if (pk.length) bad('I-pack', pk.slice(0, 3).join(' | '))

  // I-longtask (2.3 #27): a task that starts after the step starts; a step that made this document is its boot, none of it judged.
  // 50 ms holds a step that starts and ends in the same session on the desk (D64 ②); a step that opens or switches a session, changes
  // screen, or presses a button on another screen is held to 0.5 s (D64 ①③). A caller that names no stepHash gets the 50 ms line.
  const from = ctx.stepAt == null ? -Infinity : s.origin >= ctx.stepAt ? Infinity : ctx.stepAt
  const inSession = ctx.stepHash == null || (screen === 'replay' && routeOf(ctx.stepHash) === route)
  const line = inSession ? LIMITS.longtaskMs : screen === 'replay' ? BOARD_LINES.sessionOpen : BOARD_LINES.button
  const long = s.longtasks.filter((x) => x.t >= from).reduce((m, x) => Math.max(m, x.ms), 0)
  if (long > line) bad('I-longtask', `a long task of ${Math.round(long)} ms`)
  if (v.loadStep) bad('I-loadstep', `a load control: ${v.loadStep}`)
  return { violations, pending, view: { t: Date.now(), hash: v.hash, step: v.step, heads: v.heads } }
}
