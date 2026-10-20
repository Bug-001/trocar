// main.mjs — boot: keys and copy buttons, the sidebar, and the router that mounts one screen at a time. Screens are loaded on demand; each
// exports mount(el, ctx) → {update(route), unmount()}. mount() is not handed the route: a screen reads its starting state from
// ctx.router.current(). update(route) is called only when the route changes WITHIN the mounted screen (new params, another session); a
// different screen is a fresh mount. There is no site-wide banner: a screen says what is wrong with itself.
import { api } from './core/api.mjs'
import { configure, bootToken, onForbidden } from './core/http.mjs'
import { store } from './core/store.mjs'
import * as router from './core/router.mjs'
import { initKeys, setScreenKeys } from './core/keys.mjs'
import { installCopy, copyBtn, $ } from './core/dom.mjs'
import { esc } from './core/fmt.mjs'
import { watchHarnessIcons } from './core/chips.mjs'
import { toast, installUi } from './core/ui.mjs'
import { mountSidebar } from './shell/sidebar.mjs'
import { safeMount, screenErrorHtml } from './shell/safemount.mjs'
import { UNKNOWN_ROUTE, FORBIDDEN } from './labels/shell.mjs'
import { COMMANDS } from './labels/capture.mjs'
import { BRAND } from './core/icons.mjs'

// every screen of every route (core/router.mjs); the ones whose content belongs to a later task are their page head until then
const SCREENS = {
  overview: () => import('./overview/overview.mjs'),
  library: () => import('./library/library.mjs'),
  replay: () => import('./replay/replay.mjs'),
  'session-link': () => import('./replay/session-link.mjs'),
  capture: () => import('./capture/capture.mjs'),
  'capture-log': () => import('./capture/capture-log.mjs'),
  traffic: () => import('./traffic/traffic.mjs'),
  'traffic-host': () => import('./traffic/host.mjs'),
  'settings-storage': () => import('./settings/storage.mjs'),
  'settings-prices': () => import('./settings/prices.mjs'),
  'settings-appearance': () => import('./settings/appearance.mjs'),
}

// the token leaves the address (#t=…) before the router reads the hash (4.4 §每用户口令)
configure({ token: bootToken() })

initKeys()
installUi(document) // the popover / disclosure contract, once for the whole board
installCopy(document.body)
// Esc closes the bottom drawer (the screens fill #detail and toggle .open)
document.addEventListener('v2:escape', () => { const d = $('#detail'); if (d) d.classList.remove('open') })

const screenEl = $('#screen')
const ctx = { api, store, router, toast }
const sidebar = mountSidebar($('#sidebar'), ctx)
watchHarnessIcons(document.body) // every agent icon box any screen, menu or drawer draws is filled here, once it is in the page

// the tab icon: the brand mark (core/icons.mjs BRAND) in the theme's own colours — an icon file cannot read CSS variables, so the
// tokens are resolved here and the mark is serialized into the <link rel="icon"> index.html holds (no icon file, no colour literal)
;(() => {
  const link = document.querySelector('link[rel="icon"]'), t = document.createElement('template')
  if (!link || typeof XMLSerializer === 'undefined') return
  t.innerHTML = BRAND
  const svg = t.content.firstElementChild, cs = getComputedStyle(document.documentElement)
  for (const el of [svg, ...svg.querySelectorAll('*')]) for (const a of ['fill', 'stroke']) {
    const m = /^var\((--[\w-]+)\)$/.exec(el.getAttribute(a) || '')
    if (m) el.setAttribute(a, cs.getPropertyValue(m[1]).trim())
  }
  link.href = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
})()

let cur = null // { screen, inst } — the mounted screen
let shut = false // K-30 latched: no screen mounts again
let seq = 0 // a screen loads asynchronously; a newer route cancels an older load

function unmountCurrent() {
  if (!cur) return
  try { cur.inst.unmount() } catch (e) { console.error('unmount failed', e) }
  cur = null
  setScreenKeys(null)
  screenEl.replaceChildren()
}

async function show(route) {
  if (shut) return
  const mine = ++seq
  // an unknown route is 总览: say so in a toast, and rewrite the address to where the reader really is
  if (route.unknown) { toast(UNKNOWN_ROUTE); router.go({ area: 'overview', screen: 'overview', params: {} }, { replace: true }); return }
  document.title = router.documentTitle(route)
  sidebar.setRoute(route)
  // the library's hash is kept current on EVERY library route (typing a filter included), so the 会话 item from another screen restores
  // exactly what was on screen; set() is silent when nothing changed
  if (route.screen === 'library') store.set({ libraryHash: router.formatHash(route) })
  if (cur && cur.screen === route.screen) {
    try { cur.inst.update(route) } catch (e) { console.error('update failed', e) }
    return
  }
  unmountCurrent()
  let mod
  try { mod = await SCREENS[route.screen]() } catch (e) {
    if (mine !== seq) return
    screenEl.innerHTML = screenErrorHtml(String((e && e.message) || e))
    return
  }
  if (mine !== seq) return // a newer route took over while this screen was loading
  // a mount() that throws leaves no residue (no key handler, an emptied screen) and the screen says why
  const inst = safeMount(mod, screenEl, ctx, { clearKeys: () => setScreenKeys(null) })
  if (inst) cur = { screen: route.screen, inst }
}

// the first route: write the canonical hash quietly (an empty hash becomes #/overview), then mount. An unknown route is handled by show().
const first = router.current()
if (!first.unknown) {
  try { history.replaceState(null, '', router.formatHash(first)) } catch (e) { console.warn('could not write the canonical hash', e) } // a blocked history API leaves the URL as typed; the board still mounts
}
// K-30 (1.5): a 403 replaces the whole page (sidebar included) with one sentence and the copyable command; nothing else is drawn
// and nothing polls (core/http.mjs answers every later read without a request)
onForbidden(() => {
  shut = true; seq++ // a screen still loading is dropped, and no route mounts again
  unmountCurrent()
  document.body.innerHTML = `<main class="forbidden"><p>${esc(FORBIDDEN)}</p><p><code>${esc(COMMANDS.board)}</code> ${copyBtn(COMMANDS.board)}</p></main>`
})
router.onRoute(show)
show(first)
