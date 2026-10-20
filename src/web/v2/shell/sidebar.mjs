// shell/sidebar.mjs — the left sidebar: navigation only. Five areas, each with its fixed glyph, and the pages of 采集 and
// 设置. It carries no status text, no counts, no colour that encodes state, no lamp, no badge, no news, nothing at the
// bottom (1.2 §侧栏): its text is the fixed label list of labels/shell.mjs in every capture state, and
// the only dynamic things are which item is current and whether the sidebar is the 52px rail.
import { esc } from '../core/fmt.mjs'
import { parseHash } from '../core/router.mjs'
import { icon, BRAND } from '../core/icons.mjs'
import { BRAND as BRAND_TEXT, NAV, NAV_LABEL, RAIL_LABELS } from '../labels/shell.mjs'

// which top-level item a screen belongs to: the replay desk and a session link belong to 会话; a settings page to 设置
const AREA = { overview: 'overview', library: 'library', replay: 'library', 'session-link': 'library', capture: 'capture', 'capture-log': 'capture', traffic: 'traffic', 'traffic-host': 'traffic',
  'settings-storage': 'settings-storage', 'settings-prices': 'settings-storage', 'settings-appearance': 'settings-storage' }
export const areaOf = (route) => AREA[route && route.screen] || null

// Where the 会话 item goes: nowhere when the library is already showing (a click must not wipe its filters), otherwise back to the library as
// it was last left (`libraryHash`, kept current by main.mjs on every library route). Pure.
export function sessionsTabTarget(route, libraryHash) {
  if (route && route.screen === 'library') return null
  const to = parseHash(libraryHash)
  return to.screen === 'library' ? to : { area: 'sessions', screen: 'library', params: {} }
}

// the per-viewer collapse choice: localStorage in try/catch, unreadable storage = no choice (the defaults apply)
const SIDE_KEY = 'trocar.v2.sidebar'
const readPref = (store) => { try { const v = store && store.getItem(SIDE_KEY); return v === '1' || v === '0' ? v : null } catch { return null } }
const writePref = (store, v) => { try { store && store.setItem(SIDE_KEY, v) } catch { /* forget it */ } }

// the rail default when the viewer has not chosen: the replay desk, everywhere else the expanded sidebar (1.2 §侧栏;
// under 1280px css forces the rail whatever this says)
export const railByDefault = (route) => !!(route && (route.screen === 'replay' || route.screen === 'session-link'))

// the sidebar's markup for a route (route null = none current). `rail` only picks which face the collapse button shows —
// labels, sub-pages and fly-outs are all in the DOM either way; css shows one of them. The fly-out (names and sub-page
// links only, no state) is the rail's only way to a sub-page.
export function sidebarHtml(route, { rail = false } = {}) {
  const area = areaOf(route), here = route && route.screen
  const link = (i, cls = '') => {
    const cur = i.sub ? false : i.id === here
    return `<a class="${cls}${cur ? ' on' : ''}" href="${esc(i.href)}" data-id="${esc(i.id)}"${cur ? ' aria-current="page"' : ''}>${esc(i.label)}</a>`
  }
  const item = (i) => {
    const sub = i.sub ? `<ul class="sub">${i.sub.map((s) => `<li>${link(s, 'sub')}</li>`).join('')}</ul>` : ''
    const flySub = i.sub ? `<div class="fsub">${i.sub.map((s) => `<a href="${esc(s.href)}"${s.id === here ? ' aria-current="page"' : ''}>${esc(s.label)}</a>`).join('')}</div>` : ''
    return `<li class="item${i.id === area ? ' open' : ''}">` +
      `<a class="hit" href="${esc(i.href)}" data-id="${esc(i.id)}"${i.id === here && !i.sub ? ' aria-current="page"' : ''}>` +
      `<span class="ico">${icon(i.ic)}</span><span class="lbl">${esc(i.label)}</span></a>` +
      sub + `<div class="fly" hidden><span class="fh">${esc(i.label)}</span>${flySub}</div></li>`
  }
  // the brand is a link to 总览 (1.2 §侧栏); the collapse button sits beside it, and under it in the rail
  return `<div class="brandrow"><a class="brand" href="#/overview">${BRAND}<b>${esc(BRAND_TEXT)}</b></a>` +
    `<button type="button" class="iconbtn" data-rail="toggle" aria-label="${rail ? RAIL_LABELS.out : RAIL_LABELS.in}" aria-expanded="${rail ? 'false' : 'true'}">${icon(rail ? 'rail-out' : 'rail-in')}</button></div>` +
    `<nav aria-label="${esc(NAV_LABEL)}"><ul class="nav">${NAV.map(item).join('')}</ul></nav>`
}

// mountSidebar(el, ctx) → { setRoute(route) }. The 会话 item returns to the library as it was left; the collapse button
// and the per-viewer record (a stored choice beats the per-route default) decide expanded vs rail. Pure re-render.
export function mountSidebar(el, { store, router }) {
  const storeObj = (typeof localStorage !== 'undefined' && localStorage) || null
  const app = (el && el.closest && el.closest('#app')) || el // css keys the rail on #app.rail
  let pref = readPref(storeObj), route = null, rail = false
  const paint = () => {
    rail = pref === '1' ? true : pref === '0' ? false : railByDefault(route)
    app.classList.toggle('rail', rail)
    el.innerHTML = sidebarHtml(route, { rail })
  }
  route = router.current(); paint()
  el.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-id="library"]') : null
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.button) {
      e.preventDefault()
      const to = sessionsTabTarget(router.current(), store.get().libraryHash)
      if (to) router.go(to)
      return
    }
    const btn = e.target && e.target.closest ? e.target.closest('button[data-rail="toggle"]') : null
    if (btn) { rail = !rail; pref = rail ? '1' : '0'; writePref(storeObj, pref); paint() }
  })
  return { setRoute(next) { route = next; paint() } }
}
