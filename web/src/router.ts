// web/src/router.ts — the board's router (1.2 §路由, D75①): React Router's hash router owns history and navigation, with one splat route;
// the URL grammar stays parseHash / formatHash (web/legacy/core/router.mjs), no second route table. `legacy` is the ctx.router the
// screens not yet ported get: current / go / setParams / onRoute with the semantics of the legacy window wrapper, over
// router.navigate / router.subscribe.
//   · current() is the route the app is on, at once: a replace that still waits behind the writer's gap is already current.
//   · replace writes go through createUrlWriter (WRITE_GAP_MS); the same value is not written; a push first lands the pending replace
//     on the entry it leaves; Back / Forward drops the pending value (it belongs to the entry the reader left); pagehide /
//     beforeunload write it now.
//   · subscribers are told synchronously on go / setParams, and on a POP; one change is delivered once (by href); a route moved while
//     subscribers are being told is the last one any of them hears.
//   · router.navigate is async, but for this loader-less route it reaches no await: the history write is done when it returns, so a
//     lone replace is in the URL in the same task (before a reload can start).
//   · a history call that throws (WebKit's 100 calls in 30 s) never throws out of go: the route has changed, only the URL lags.
import type { ReactNode } from 'react'
import { createHashRouter } from 'react-router'
import { createUrlWriter, documentTitle, formatHash, parseHash } from '../legacy/core/router.mjs'

type Route = ReturnType<typeof parseHash>
type Params = Record<string, string | number | null | undefined>

export function createBoardRouter(element: ReactNode) {
  const router = createHashRouter([{ path: '*', element }])
  const subs = new Set<(r: Route) => void>()
  let hash = location.hash // the hash the app is on, ahead of the URL while a write waits
  let lastHref = location.href // the href the URL is on, or is about to be on once the write in flight lands
  let warned = false

  const hrefOf = (h: string) => location.href.split('#')[0] + h
  const navigate = (h: string, replace: boolean) => {
    lastHref = hrefOf(h)
    router.navigate(h.slice(1) || '/', { replace }).catch((e: unknown) => {
      if (!warned) { warned = true; console.warn('history write failed: the address bar may lag behind the board', e) }
    })
  }
  const writer = createUrlWriter({ write: (h: string) => navigate(h, true) })
  const current = (): Route => parseHash(hash)
  // a subscriber that moves the route while it is told (a screen naming its step as it mounts) announces the newer route to every
  // subscriber itself; the older announcement stops there, so nobody is told a stale route after a newer one
  let told = 0
  const emit = () => {
    const mine = ++told, r = current()
    for (const fn of [...subs]) { if (mine !== told) return; fn(r) }
  }

  const unsubscribe = router.subscribe((state) => {
    if (state.historyAction !== 'POP' || location.href === lastHref) return
    writer.cancel()
    hash = location.hash; lastHref = location.href
    emit()
  })
  const flush = () => writer.flush()
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)

  function go(route: Route, { replace = false }: { replace?: boolean } = {}) {
    const h = formatHash(route)
    const same = h === hash
    hash = h
    if (replace || same) { if (!same) writer.set(h) } // every write counts toward WebKit's limit
    else { writer.flush(); navigate(h, false) }
    emit()
  }
  function setParams(patch: Params, { replace = true }: { replace?: boolean } = {}) {
    const r = current()
    const params: Record<string, string> = { ...r.params }
    for (const [k, v] of Object.entries(patch || {})) {
      if (v == null || v === '') delete params[k]
      else params[k] = String(v)
    }
    go({ ...r, params } as Route, { replace })
  }
  function onRoute(fn: (r: Route) => void) {
    subs.add(fn)
    return () => { subs.delete(fn) }
  }
  function dispose() {
    unsubscribe()
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', flush)
    router.dispose()
  }

  return { router, legacy: { current, go, setParams, onRoute, formatHash, parseHash, documentTitle }, dispose }
}
