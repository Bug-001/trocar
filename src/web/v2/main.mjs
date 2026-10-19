// main.mjs — boot: keys and copy buttons, the sidebar, and the router that mounts one screen at a time. Screens are loaded on demand; each
// exports mount(el, ctx) → {update(route), unmount()}. mount() is not handed the route: a screen reads its starting state from
// ctx.router.current(). update(route) is called only when the route changes WITHIN the mounted screen (new params, another session); a
// different screen is a fresh mount. There is no site-wide banner: a screen says what is wrong with itself.
import { api } from './core/api.mjs'
import { configure, bootToken } from './core/http.mjs'
import { store } from './core/store.mjs'
import * as router from './core/router.mjs'
import { initKeys, setScreenKeys } from './core/keys.mjs'
import { installCopy, $ } from './core/dom.mjs'
import { ensureHarnessIcons } from './core/chips.mjs'
import { toast, installUi } from './core/ui.mjs'
import { mountSidebar } from './shell/sidebar.mjs'
import { safeMount, screenErrorHtml } from './shell/safemount.mjs'
import { UNKNOWN_ROUTE } from './labels/shell.mjs'

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

let cur = null // { screen, inst } — the mounted screen
let seq = 0 // a screen loads asynchronously; a newer route cancels an older load

function unmountCurrent() {
  if (!cur) return
  try { cur.inst.unmount() } catch (e) { console.error('unmount failed', e) }
  cur = null
  setScreenKeys(null)
  screenEl.replaceChildren()
}

async function show(route) {
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
    ensureHarnessIcons(document) // rows may carry new harness icons
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
  ensureHarnessIcons(document) // fill the 16px boxes the screen just drew
  if (inst) cur = { screen: route.screen, inst }
}

// the first route: write the canonical hash quietly (an empty hash becomes #/overview), then mount. An unknown route is handled by show().
const first = router.current()
if (!first.unknown) {
  try { history.replaceState(null, '', router.formatHash(first)) } catch (e) { console.warn('could not write the canonical hash', e) } // a blocked history API leaves the URL as typed; the board still mounts
}
router.onRoute(show)
show(first)
