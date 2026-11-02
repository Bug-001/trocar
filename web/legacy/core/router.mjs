// core/router.mjs — URL-hash routing. parseHash / formatHash / documentTitle are pure; history and navigation belong to
// web/src/router.ts (React Router), which takes createUrlWriter from here.
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
//   #/session/<id>                      a link that does not know the project: the session-link screen resolves it and replaces it with the line above
//   #/capture · #/capture/log           采集 (agents) · 采集记录              h=<harness>
//   #/traffic                           流量                                 window=1h|24h|7d|all h class
//   #/traffic/host/<harness>/<host>     one host                             window class ref=<raw_ref>
//   #/settings/storage|prices|appearance  (#/settings alone is storage)      storage: h class
//   #/system/capture|traffic|retention  the prototype's routes, mapped onto the ones above (w → window)
// Anything else is `unknown`: the route is 总览 and carries `unknown:true`, so the shell can say so in a toast. Every harness id in a route
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

// ── URL writer ────────────────────────────────────────────────────────────────────────────────────────────────────
// Scrubbing (← / → held down) and typing in a filter box fire dozens of URL writes a second, and WebKit throws a SecurityError after
// 100 history calls in 30 s. 1.2 §路由: a set when the last write is ≥ `gap` ago writes in the same task, so a lone change is in the URL
// before a reload can start (Chromium's reload takes the URL as it is; the pagehide flush does not reach it). Otherwise ONE timer at
// last write + `gap` writes the newest value: writes stay ≥ `gap` apart and the last value always lands (flush() writes it now, e.g.
// when the page goes away). Clock and scheduler are injectable so a test needs no real clock.
export const WRITE_GAP_MS = 350
export function createUrlWriter({ write, gap = WRITE_GAP_MS, now = () => performance.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  let timer = null, has = false, value, last = -Infinity
  const stop = () => { if (timer != null) { clearTimer(timer); timer = null } }
  const fire = () => { timer = null; if (has) { has = false; last = now(); write(value) } }
  return {
    set(v) {
      value = v; has = true
      if (timer != null) return
      const wait = last + gap - now()
      if (wait <= 0) fire(); else timer = setTimer(fire, wait)
    },
    flush() { stop(); fire() },
    cancel() { stop(); has = false },
    pending() { return has ? { value } : null },
  }
}
