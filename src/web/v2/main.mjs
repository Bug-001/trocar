// main.mjs — boot: keys and copy buttons, the sidebar, and the router that mounts one screen at a time. Screens are loaded on demand; each
// exports mount(el, ctx) → {update(route), unmount()}. mount() is not handed the route: a screen reads its starting state from
// ctx.router.current(). update(route) is called only when the route changes WITHIN the mounted screen (new params, another session); a
// different screen is a fresh mount. There is no site-wide banner: a screen says what is wrong with itself.
import { api, scoped } from './core/api.mjs'
import { configure, bootToken, onForbidden } from './core/http.mjs'
import { store } from './core/store.mjs'
import * as router from './core/router.mjs'
import { initKeys, setScreenKeys } from './core/keys.mjs'
import { installCopy, copyBtn, $, setScreenSignal } from './core/dom.mjs'
import { esc } from './core/fmt.mjs'
import { watchHarnessIcons } from './core/chips.mjs'
import { toast, installUi } from './core/ui.mjs'
import { mountSidebar } from './shell/sidebar.mjs'
import { safeMount, screenErrorHtml } from './shell/safemount.mjs'
import { UNKNOWN_ROUTE, FORBIDDEN } from './labels/shell.mjs'
import { COMMANDS } from './labels/capture.mjs'
import { READING } from './labels/common.mjs'
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

let cur = null // { screen, inst, ac } — the mounted screen (inst null while its mount() runs); ac aborts its reads once it is gone (1.2 #22)
let shut = false // K-30 latched: no screen mounts again
let seq = 0 // a screen loads asynchronously; a newer route cancels an older load

function unmountCurrent() {
  if (!cur) return
  try { if (cur.inst) cur.inst.unmount() } catch (e) { console.error('unmount failed', e) }
  cur.ac.abort() // after unmount(): the screen's pollers are stopped, so an aborted answer writes nothing; its layers close (1.2 §键盘)
  cur = null
  setScreenSignal(null)
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
    try { if (cur.inst) cur.inst.update(route) } catch (e) { console.error('update failed', e) } // during mount(): its own URL write, which it already shows
    return
  }
  unmountCurrent()
  screenEl.innerHTML = `<div class="page"><p class="screenwait">${esc(READING)}</p></div>` // never a blank area while the module loads
  let mod
  try { mod = await SCREENS[route.screen]() } catch (e) {
    if (mine !== seq) return
    screenEl.innerHTML = screenErrorHtml(String((e && e.message) || e))
    return
  }
  if (mine !== seq) return // a newer route took over while this screen was loading
  // a mount() that throws leaves no residue (no key handler, an emptied screen) and the screen says why
  // `cur` is set before mount() runs: a URL the screen writes while it mounts (the desk naming the step it shows) reaches update(), never a second mount
  const ac = new AbortController(), box = { screen: route.screen, inst: null, ac }
  cur = box
  setScreenSignal(ac.signal) // every layer core opens from here on is this screen's (1.2 §键盘「层随屏走」)
  const inst = safeMount(mod, screenEl, { ...ctx, signal: ac.signal, api: scoped(api, ac.signal) }, { clearKeys: () => setScreenKeys(null) })
  if (cur !== box) { if (inst) { try { inst.unmount() } catch (e) { console.error('unmount failed', e) } } ac.abort() } // another screen took over while it mounted
  else if (inst) box.inst = inst
  else { cur = null; setScreenSignal(null); ac.abort() }
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
// after the first screen settles, load every other screen module once, so a later screen change does not wait on the network
show(first).finally(() => (globalThis.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => { for (const l of Object.values(SCREENS)) l().catch(() => {}) }))
