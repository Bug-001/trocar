// core/router.mjs — URL-hash routing. parseHash / formatHash / documentTitle are pure; the window wrapper below touches `window` and
// `history` only when called, never at import time (so Node tests import this file).
//
// Route = { area, screen, params, project?, id?, harness?, host?, unknown? }
//   area    which sidebar area the route belongs to: overview | sessions | replay | capture | traffic | settings
//   screen  which screen mounts: overview | library | replay | session-link | capture | capture-log | traffic | traffic-host |
//           settings-storage | settings-prices | settings-appearance
//   params  the query of the hash, key → string (an empty value is the same as an absent one)
//
//   #/overview                          总览 (also '' and '#/')              window=24h|7d|all
//   #/sessions                          the session library                  h=<harness> (repeatable) project window q
//   #/replay/<project>/<id>             the replay desk                      step=N (1-based) call=<record id>
//   #/session/<id>                      a link that does not know the project: main.mjs resolves it and replaces it with the line above
//   #/capture · #/capture/log           采集 (agents) · 采集记录              h=<harness>
//   #/traffic                           流量                                 window=1h|24h|7d|all h class
//   #/traffic/host/<harness>/<host>     one host                             window class ref=<raw_ref>
//   #/settings/storage|prices|appearance  (#/settings alone is storage)      storage: h class
//   #/system/capture|traffic|retention  the prototype's routes, mapped onto the ones above (w → window)
// Anything else is `unknown`: the route is 总览 and carries `unknown:true`, so main.mjs can say so in a toast. Every harness id in a route
// (the path segment, and each value of `h`) is the read-side id after harnessKey().
import { harnessKey } from './chips.mjs'
import { SCREEN_NAME, TITLE_SUFFIX } from '../labels/shell.mjs'

const dec = (s) => { try { return decodeURIComponent(s) } catch { return s } }

function parseQuery(q) {
  const params = {}
  if (!q) return params
  for (const pair of q.split('&')) {
    if (!pair) continue
    const i = pair.indexOf('=')
    const k = dec(i < 0 ? pair : pair.slice(0, i))
    const v = i < 0 ? '' : dec(pair.slice(i + 1))
    if (!k || v === '') continue
    // `h` may repeat (h=cc&h=codex): the values join into the comma list the library already writes
    params[k] = k === 'h' && params.h ? `${params.h},${v}` : v
  }
  if (params.h) params.h = [...new Set(params.h.split(',').filter(Boolean).map(harnessKey))].join(',')
  return params
}

const SCREEN_AREA = { overview: 'overview', library: 'sessions', replay: 'replay', 'session-link': 'replay', capture: 'capture', 'capture-log': 'capture', traffic: 'traffic', 'traffic-host': 'traffic',
  'settings-storage': 'settings', 'settings-prices': 'settings', 'settings-appearance': 'settings' }
const route = (screen, params, more) => ({ area: SCREEN_AREA[screen], screen, ...more, params })
const OVERVIEW = (params = {}) => route('overview', params)
const UNKNOWN = () => ({ ...OVERVIEW(), unknown: true })
const SETTINGS = { storage: 'settings-storage', prices: 'settings-prices', appearance: 'settings-appearance' }

export function parseHash(hash) {
  let h = String(hash || '')
  if (h.startsWith('#')) h = h.slice(1)
  const qi = h.indexOf('?')
  const pathPart = qi < 0 ? h : h.slice(0, qi)
  const params = parseQuery(qi < 0 ? '' : h.slice(qi + 1))
  const segs = pathPart.split('/').filter(Boolean).map(dec)

  if (segs.length === 0) return OVERVIEW(params)
  switch (segs[0]) {
    case 'overview': return segs.length === 1 ? OVERVIEW(params) : UNKNOWN()
    case 'sessions': return segs.length === 1 ? route('library', params) : UNKNOWN()
    case 'replay': return segs.length === 3 ? route('replay', params, { project: segs[1], id: segs[2] }) : UNKNOWN() // a replay link without a session is junk
    case 'session': return segs.length === 2 ? route('session-link', params, { id: segs[1] }) : UNKNOWN()
    case 'capture':
      if (segs.length === 1) return route('capture', params)
      return segs.length === 2 && segs[1] === 'log' ? route('capture-log', params) : UNKNOWN()
    case 'traffic':
      if (segs.length === 1) return route('traffic', params)
      return segs.length === 4 && segs[1] === 'host' ? route('traffic-host', params, { harness: harnessKey(segs[2]), host: segs[3] }) : UNKNOWN()
    case 'settings':
      if (segs.length === 1) return route('settings-storage', params)
      return segs.length === 2 && Object.prototype.hasOwnProperty.call(SETTINGS, segs[1]) ? route(SETTINGS[segs[1]], params) : UNKNOWN()
    case 'system': { // the prototype's routes: kept so an old link still lands somewhere sensible
      const { w, ...rest } = params, p = w ? { ...rest, window: w } : rest
      if (segs[1] === 'traffic') return route('traffic', p)
      if (segs[1] === 'retention') return route('settings-storage', p)
      return route('capture', p)
    }
    default: return UNKNOWN()
  }
}

export function formatHash(r) {
  const x = r || OVERVIEW()
  const e = encodeURIComponent
  let p
  switch (x.screen) {
    case 'library': p = '#/sessions'; break
    case 'replay': p = x.project && x.id ? `#/replay/${e(x.project)}/${e(x.id)}` : '#/overview'; break
    case 'session-link': p = x.id ? `#/session/${e(x.id)}` : '#/overview'; break
    case 'capture': p = '#/capture'; break
    case 'capture-log': p = '#/capture/log'; break
    case 'traffic': p = '#/traffic'; break
    case 'traffic-host': p = x.harness && x.host ? `#/traffic/host/${e(x.harness)}/${e(x.host)}` : '#/traffic'; break
    case 'settings-storage': p = '#/settings/storage'; break
    case 'settings-prices': p = '#/settings/prices'; break
    case 'settings-appearance': p = '#/settings/appearance'; break
    default: p = '#/overview'
  }
  const params = x.params || {}
  const q = Object.keys(params).sort()
    .filter((k) => params[k] != null && String(params[k]) !== '')
    .map((k) => `${e(k)}=${e(String(params[k]))}`)
    .join('&')
  return q ? `${p}?${q}` : p
}

// the document title of a route: the screen's name and the product's, no statistic (a host page also names its host, which is an identity)
export function documentTitle(r) {
  const name = SCREEN_NAME[r && r.screen] || SCREEN_NAME.overview
  return (r && r.screen === 'traffic-host' && r.host ? `${name} · ${r.host}` : name) + TITLE_SUFFIX
}

// ── trailing writer ───────────────────────────────────────────────────────────────────────────────────────────────
// Scrubbing (← / → held down) and typing in a filter box fire dozens of URL writes a second. Safari throws a SecurityError after
// ~100 history calls in 30 s and Chromium silently drops the excess, so the URL could end on a stale step. Replace-writes are
// therefore debounced into ONE trailing write; the last value always lands (flush() writes it now, e.g. when the page goes away).
// The scheduler is injectable so a test needs no real clock.
export const REPLACE_DELAY_MS = 120
export function createTrailingWriter({ write, delay = REPLACE_DELAY_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  let timer = null, has = false, value
  const stop = () => { if (timer != null) { clearTimer(timer); timer = null } }
  const fire = () => { timer = null; if (has) { has = false; write(value) } }
  return {
    set(v) { value = v; has = true; stop(); timer = setTimer(fire, delay) },
    flush() { stop(); fire() },
    cancel() { stop(); has = false },
    pending() { return has ? { value } : null },
  }
}

// ── thin window wrapper ───────────────────────────────────────────────────────────────────────────────────────────
const subs = new Set()
let wired = false
let lastHref = null
let warned = false
// the hash the app is on while a replace-write is still waiting: current() and the next setParams() must read THIS, not a stale location.hash
let effective = null

// a rate-limited or blocked history API must never throw out of a navigation: the app's own route is already right, only the URL lags
function historyWrite(kind, h) {
  try { history[kind](null, '', h); return true } catch (e) {
    if (!warned) { warned = true; console.warn('history.' + kind + ' failed — the address bar may lag behind the board', e) }
    return false
  }
}
const writer = createTrailingWriter({
  write(h) { effective = null; historyWrite('replaceState', h); lastHref = location.href },
})

function emit() {
  const r = current()
  for (const fn of [...subs]) fn(r)
}
// a back / forward step across two hashes fires both popstate and hashchange; the href check delivers it once. A replace that was still
// waiting belongs to the entry the reader just left: writing it now would overwrite the entry they landed on.
function onWindowChange() {
  if (location.href === lastHref) return
  writer.cancel(); effective = null
  lastHref = location.href
  emit()
}
function wire() {
  if (wired || typeof window === 'undefined') return
  wired = true
  lastHref = location.href
  window.addEventListener('hashchange', onWindowChange)
  window.addEventListener('popstate', onWindowChange)
  // the last value always lands: a reload, a close or a navigation away must not lose the step the reader was on
  window.addEventListener('pagehide', () => writer.flush())
  window.addEventListener('beforeunload', () => writer.flush())
}

export function current() { return parseHash(effective != null ? effective : location.hash) }

// push (or replace) the route in history, then tell subscribers. pushState does not fire hashchange, so we dispatch.
// A replace is coalesced (see above); a push first lands the pending replace on the entry it leaves, so the way back is exact.
export function go(route, { replace = false } = {}) {
  wire()
  const h = formatHash(route)
  const same = (effective != null ? effective : location.hash) === h
  if (replace || same) { effective = h; writer.set(h) }
  else {
    writer.flush(); effective = null
    if (!historyWrite('pushState', h)) location.hash = h // blocked: a plain hash change still makes the entry and the URL
    lastHref = location.href
  }
  emit()
}

// merge `patch` into the current route's params; null or '' deletes a key. Replaces history by default (scrubbing,
// typing in a filter box: not a navigation).
export function setParams(patch, { replace = true } = {}) {
  const r = current()
  const params = { ...r.params }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === '') delete params[k]
    else params[k] = String(v)
  }
  go({ ...r, params }, { replace })
}

export function onRoute(fn) {
  wire()
  subs.add(fn)
  return () => { subs.delete(fn) }
}
