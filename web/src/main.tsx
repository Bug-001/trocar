// web/src/main.tsx — boot (1.2 §路由, D75①②): the token leaves the address, the first hash becomes canonical, the page-wide handlers are
// installed once, then React renders the shell: the sidebar and #screen, which holds one screen at a time: a legacy screen (LegacyScreen
// mounts it into its host element) or a React screen (ScreenOutlet). Screens are loaded on demand. There is no site-wide banner: a screen says what is wrong with itself.
import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { configure, bootToken, onForbidden } from '../legacy/core/http.mjs'
import { api } from '../legacy/core/api.mjs'
import { store } from '../legacy/core/store.mjs'
import { formatHash, parseHash, documentTitle } from '../legacy/core/router.mjs'
import { initKeys } from '../legacy/core/keys.mjs'
import { installCopy, copyBtn } from '../legacy/core/dom.mjs'
import { esc } from '../legacy/core/fmt.mjs'
import { watchHarnessIcons } from '../legacy/core/chips.mjs'
import { toast, installUi } from '../legacy/core/ui.mjs'
import { BRAND } from '../legacy/core/icons.mjs'
import { UNKNOWN_ROUTE, FORBIDDEN } from '../legacy/labels/shell.mjs'
import { COMMANDS } from '../legacy/labels/capture.mjs'
import { createBoardRouter } from './router'
import { LegacyScreen, type Route } from './LegacyScreen'
import { ScreenOutlet, lazyScreen, type LazyScreen } from './ScreenOutlet'
import { Sidebar } from './shell/Sidebar'
import { ConfirmProvider } from './ui/Confirm'
import { BoardRouterContext } from './screens/traffic/board-router'

// every screen of every route (core/router.mjs): the legacy ones here, the React ones in REACT_SCREENS
const SCREENS = {
  replay: () => import('../legacy/replay/replay.mjs'),
  'session-link': () => import('../legacy/replay/session-link.mjs'),
  'traffic-host': () => import('../legacy/traffic/host.mjs'),
}
const REACT_SCREENS: Record<string, LazyScreen> = {
  overview: lazyScreen(() => import('./screens/overview/OverviewScreen')),
  capture: lazyScreen(() => import('./screens/capture/CaptureScreen')),
  library: lazyScreen(() => import('./screens/library/LibraryScreen')),
  'capture-log': lazyScreen(() => import('./screens/capture/CaptureLogScreen')),
  'settings-storage': lazyScreen(() => import('./screens/settings/StorageScreen')),
  'settings-prices': lazyScreen(() => import('./screens/settings/PricesScreen')),
  'settings-appearance': lazyScreen(() => import('./screens/settings/AppearanceScreen')),
  traffic: lazyScreen(() => import('./screens/traffic/TrafficScreen')),
}
const PRELOADS = [...Object.values(SCREENS), ...Object.values(REACT_SCREENS).map((s) => s.load)] // the idle preload loads both kinds
const isReact = (r: Route) => !r.unknown && Object.hasOwn(REACT_SCREENS, r.screen)

// the token leaves the address (#t=…) before the router reads the hash (4.4 §每用户口令)
configure({ token: bootToken() })
// the first route: write the canonical hash quietly (an empty hash becomes #/overview). An unknown route is handled by the shell.
const first = parseHash(location.hash)
if (!first.unknown) {
  try { history.replaceState(null, '', formatHash(first)) } catch (e) { console.warn('could not write the canonical hash', e) } // a blocked history API leaves the URL as typed; the board still mounts
}

initKeys()
installUi(document) // the popover / disclosure contract, once for the whole board
installCopy(document.body)
// Esc closes the bottom drawer (the screens fill #detail and toggle .open)
document.addEventListener('v2:escape', () => { document.getElementById('detail')?.classList.remove('open') })
watchHarnessIcons(document.body) // every agent icon box any screen, menu or drawer draws is filled here, once it is in the page

// the tab icon: the brand mark (core/icons.mjs BRAND) in the theme's own colours — an icon file cannot read CSS variables, so the
// tokens are resolved here and the mark is serialized into the <link rel="icon"> index.html holds (no icon file, no colour literal)
;(() => {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]'), t = document.createElement('template')
  if (!link || typeof XMLSerializer === 'undefined') return
  t.innerHTML = BRAND
  const svg = t.content.firstElementChild!, cs = getComputedStyle(document.documentElement)
  for (const el of [svg, ...svg.querySelectorAll('*')]) for (const a of ['fill', 'stroke']) {
    const m = /^var\((--[\w-]+)\)$/.exec(el.getAttribute(a) || '')
    if (m) el.setAttribute(a, cs.getPropertyValue(m[1]).trim())
  }
  link.href = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
})()

const OVERVIEW = { area: 'overview', screen: 'overview', params: {} } as Route
const sameRoute = (a: Route, b: Route) => !!a.unknown === !!b.unknown && formatHash(a) === formatHash(b)

// the splat route's element: the route is the facade's current(), refreshed on every change it announces
function Shell() {
  const router = useContext(BoardRouterContext)!
  const [route, setRoute] = useState<Route>(router.current)
  const [ctx] = useState(() => ({ api, store, router, toast }))
  const screenEl = useRef<HTMLDivElement>(null)
  const shown = useRef(route)
  useLayoutEffect(() => {
    let live = false // false while the effect itself runs: flushSync is never called inside a lifecycle
    const on = (r: Route) => {
      // an unknown route is 总览: say so in a toast, and rewrite the address to where the reader really is
      if (r.unknown) { toast(UNKNOWN_ROUTE); router.go(OVERVIEW, { replace: true }); return }
      document.title = documentTitle(r)
      // the library's hash is kept current on EVERY library route (typing a filter included), so the 会话 item from another screen
      // restores exactly what was on screen; set() is silent when nothing changed
      if (r.screen === 'library') store.set({ libraryHash: formatHash(r) })
      // between a legacy and a React screen, the legacy host has just been cleared (or filled) inside this same announcement: the React
      // side paints now too, so no frame shows #screen empty
      const crossing = live && isReact(r) !== isReact(shown.current)
      shown.current = r
      const apply = () => setRoute((prev: Route) => (sameRoute(prev, r) ? prev : r))
      if (crossing) flushSync(apply); else apply()
    }
    const off = router.onRoute(on)
    on(router.current())
    live = true
    return off
  }, [router])
  return <>
    <aside id="sidebar"><Sidebar route={route} router={router} store={store} /></aside>
    <div id="content"><div id="screen">
      <div className="screenhost" ref={screenEl} style={{ display: 'contents' }} />
      {isReact(route) ? <ScreenOutlet screen={REACT_SCREENS[route.screen]} name={route.screen} route={route} router={router} /> : null}
    </div></div>
    <LegacyScreen el={screenEl} router={router} ctx={ctx} screens={SCREENS} preloads={PRELOADS} />
  </>
}

const board = createBoardRouter(<Shell />)
const root = createRoot(document.getElementById('app')!)
// no StrictMode: a legacy mount() is not idempotent
root.render(
  <QueryClientProvider client={new QueryClient()}>
    <ConfirmProvider>
      <BoardRouterContext.Provider value={board.legacy}><RouterProvider router={board.router} /></BoardRouterContext.Provider>
    </ConfirmProvider>
  </QueryClientProvider>,
)

// K-30 (1.5): a 403 replaces the whole page (sidebar included) with one sentence and the copyable command; nothing else is drawn
// and nothing polls (core/http.mjs answers every later read without a request)
onForbidden(() => {
  root.unmount() // the screen unmounts with it, and a screen still loading is dropped
  board.dispose()
  document.body.innerHTML = `<main class="forbidden"><p>${esc(FORBIDDEN)}</p><p><code>${esc(COMMANDS.board)}</code> ${copyBtn(COMMANDS.board)}</p></main>`
})
