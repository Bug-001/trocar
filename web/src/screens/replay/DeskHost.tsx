// web/src/screens/replay/DeskHost.tsx — the new desk's host (1.2 §路由「离开再回来」, D71③, D75①): the replay routes over the shared
// controller (replay.mjs deskRoutes, openDesk) with the React view (view.ts). Every desk the session cache holds is one <Activity>
// subtree whose frame is drawn by a portal into the desk's own root; only the desk being read is visible, and only its root hangs in
// the page (the controller attaches and detaches it). A hidden subtree keeps its nodes and state, and its effects are torn down.
//   · Routes reach the desk inside the call that announced them, never through React state, as LegacyScreen does: a desk's own URL
//     write comes back through update() before that write returns, and no older route reaches it afterwards.
//   · The list of desks and the visible one are React state, applied in the announcing call (flushSync) when the route crosses to or
//     from another screen's owner, so no frame shows #screen empty; otherwise as a plain update.
//   · A desk the cache evicts is disposed by the controller; its view's dispose removes it here, which unmounts its subtree.
//   · The desk is a screen to core's layers (1.2 §键盘「层随屏走」): entering it names a signal (core/dom.mjs setScreenSignal), leaving
//     aborts it, so a `?` key list or a pinned popover opened on the desk closes with it. Another session on the desk is the same screen.
import { Activity, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { deskRoutes, keyOf } from '../../../legacy/replay/replay.mjs'
import { setScreenSignal, releaseScreenSignal } from '../../../legacy/core/dom.mjs'
import type { Route } from '../../LegacyScreen'
import { DeskFrame } from './DeskFrame'
import { reactView, during, type DeskState, type DeskView, type Els } from './view'

type Facade = { current(): Route, onRoute(fn: (r: Route) => void): () => void }
type Opts = NonNullable<Parameters<typeof deskRoutes>[2]>
export type DeskProps = {
  router: Facade, ctx: object, host: RefObject<HTMLDivElement | null>, isDesk: (r: Route) => boolean,
  // where the desks are kept and how one is opened (deskRoutes' own defaults: the session cache, openDesk)
  cache?: Opts['cache'], open?: Opts['open'],
}

export default function DeskHost({ router, ctx, host, isDesk, cache, open }: DeskProps) {
  const [st, setSt] = useState<{ desks: DeskView[], visible: string | null }>({ desks: [], visible: null })
  useLayoutEffect(() => {
    const desks = new Map<string, DeskView>()
    let visible: string | null = null, shown = false, wasDesk = false, live = false // live: false while the effect itself runs
    const publish = (sync: boolean) => {
      const next = { desks: [...desks.values()], visible }
      if (sync) flushSync(() => setSt(next)); else setSt(next)
    }
    const makeView = (s: DeskState, framed: (E: Els) => void) => {
      const v = reactView(s, framed, () => { desks.delete(v.key); publish(false) })
      desks.set(v.key, v)
      return v
    }
    const routes = deskRoutes(ctx, makeView, { cache, open })
    let ac: AbortController | null = null
    const leave = () => { routes.leave(); ac!.abort(); releaseScreenSignal(ac!.signal); ac = null }
    const on = (r: Route) => {
      if (r.unknown) return // the shell turns it into 总览 first
      const desk = isDesk(r), crossing = live && desk !== wasDesk
      wasDesk = desk
      if (desk) {
        visible = keyOf(r)
        if (shown) routes.update(r); else { shown = true; ac = new AbortController(); setScreenSignal(ac.signal); routes.show(host.current!, r) } // shown first: the desk's own URL write while it attaches is an update
      } else {
        visible = null
        if (shown) { shown = false; leave() }
      }
      publish(crossing)
    }
    const off = router.onRoute(on)
    during(() => on(router.current())) // the controller's paints inside this effect are not flushed (view.ts)
    live = true
    return () => { off(); if (shown) during(leave) }
  }, [router, ctx, host, isDesk, cache, open])
  return <>
    {st.desks.map((d) => (
      <Activity key={d.key} mode={d.key === st.visible ? 'visible' : 'hidden'}>{createPortal(<DeskFrame desk={d} />, d.root)}</Activity>
    ))}
  </>
}
