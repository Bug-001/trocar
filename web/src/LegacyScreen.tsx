// web/src/LegacyScreen.tsx — mounts the screens not yet ported (web/legacy) inside the React shell, one at a time (1.2 §路由, D75②).
// A screen module exports mount(el, ctx) → {update(route), unmount()}. mount() is not handed the route: the screen reads its starting
// state from ctx.router.current(). update(route) is called when the route changes WITHIN the mounted screen (new params, another
// session, the screen's own URL writes); a different screen is a fresh mount. `el` is a stable element React renders with no children:
// only this host writes into it.
import { useLayoutEffect, type RefObject } from 'react'
import { api, scoped } from '../legacy/core/api.mjs'
import { setScreenKeys } from '../legacy/core/keys.mjs'
import { setScreenSignal } from '../legacy/core/dom.mjs'
import { esc } from '../legacy/core/fmt.mjs'
import { safeMount, screenErrorHtml } from '../legacy/shell/safemount.mjs'
import { READING } from '../legacy/labels/common.mjs'
import type { parseHash } from '../legacy/core/router.mjs'

export type Route = ReturnType<typeof parseHash>
type Instance = { update(route: Route): void, unmount(): void }
export type Screens = Record<string, () => Promise<unknown>>

// createScreenHost(el, ctx, screens) → { show(route), dispose() }: the legacy boot's show(), with no window state of its own
export function createScreenHost(el: HTMLElement, ctx: object, screens: Screens) {
  let cur: { screen: string, inst: Instance | null, ac: AbortController } | null = null // inst is null while its mount() runs
  let seq = 0 // a screen loads asynchronously; a newer route (or dispose) cancels an older load
  let shut = false
  let preloaded = false

  function unmountCurrent() {
    if (!cur) return
    try { if (cur.inst) cur.inst.unmount() } catch (e) { console.error('unmount failed', e) }
    cur.ac.abort() // after unmount(): the screen's pollers are stopped, so an aborted answer writes nothing (1.2 #22); its layers close (1.2 §键盘)
    cur = null
    setScreenSignal(null)
    setScreenKeys(null)
    el.replaceChildren()
  }
  // after the first screen settles, load every other screen module once, so a later screen change does not wait on the network
  function preload() {
    if (preloaded) return
    preloaded = true
    const idle = globalThis.requestIdleCallback || ((f: () => void) => setTimeout(f, 1500))
    idle(() => { for (const load of Object.values(screens)) load().catch(() => {}) })
  }

  async function show(route: Route) {
    if (shut) return
    const mine = ++seq
    if (cur && cur.screen === route.screen) {
      try { if (cur.inst) cur.inst.update(route) } catch (e) { console.error('update failed', e) } // during mount(): its own URL write, which it already shows
      return
    }
    unmountCurrent()
    el.innerHTML = `<div class="page"><p class="screenwait">${esc(READING)}</p></div>` // never a blank area while the module loads
    let mod
    try { mod = await screens[route.screen]() } catch (e) {
      if (mine !== seq) return
      el.innerHTML = screenErrorHtml(String((e as Error)?.message || e))
      preload()
      return
    }
    if (mine !== seq) return // a newer route took over while this screen was loading
    // `cur` is set before mount() runs: a URL the screen writes while it mounts (the desk naming the step it shows) reaches update(), never
    // a second mount. A mount() that throws leaves no residue (no key handler, an emptied screen) and the screen says why.
    const ac = new AbortController(), box: NonNullable<typeof cur> = { screen: route.screen, inst: null, ac }
    cur = box
    setScreenSignal(ac.signal) // every layer core opens from here on is this screen's (1.2 §键盘「层随屏走」)
    const inst = safeMount(mod, el, { ...ctx, signal: ac.signal, api: scoped(api, ac.signal) }, { clearKeys: () => setScreenKeys(null) }) as Instance | null
    if (cur !== box) { if (inst) { try { inst.unmount() } catch (e) { console.error('unmount failed', e) } } ac.abort() } // another screen took over while it mounted
    else if (inst) box.inst = inst
    else { cur = null; setScreenSignal(null); ac.abort() }
    preload()
  }

  function dispose() { shut = true; seq++; unmountCurrent() }
  return { show, dispose }
}

// The component form: the host lives as long as the element. It takes every route the facade announces at once, inside the call that
// announced it, as the legacy boot did: a screen's own URL write comes back through update() before that write returns, and a route
// is never handed over late, after a newer one is already current (a deferred, stale route turns a desk's follow back on). An
// unknown route is skipped: the shell turns it into 总览 first.
type Facade = { current(): Route, onRoute(fn: (r: Route) => void): () => void }
export function LegacyScreen({ el, router, ctx, screens }: { el: RefObject<HTMLDivElement | null>, router: Facade, ctx: object, screens: Screens }) {
  useLayoutEffect(() => {
    const h = createScreenHost(el.current!, ctx, screens)
    const show = (r: Route) => { if (!r.unknown) h.show(r) }
    const off = router.onRoute(show)
    show(router.current())
    return () => { off(); h.dispose() }
  }, [el, router, ctx, screens])
  return null
}
