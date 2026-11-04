// web/src/screens/replay/view.ts — the new desk's view (1.2 §涉及源文件: one controller, openDesk(ctx, route, view), two desks). The
// controller calls the same slots as on the legacy view; here each R1 area is a version channel the components read on commit
// (useDesk.ts), so a paint needs no element and may come before the frame exists. The slots this file owns:
//   · els(): the containers the legacy areas still draw, null until DeskFrame's first layout effect hands them over (framed); the
//     controller treats null as not drawn yet, as a detached desk, and redraws once they are there
//   · resexp: the resource list's element, made here and hung under no component: the Resources panel adopts it while it is the
//     current tab, so a tab change never invalidates what the controller holds and wired once
//   · nav(): the sidebar's area. s.rawPanelGone names this desk for the controller: no outline column, no raw panel
//   · capacity(): the bars the lane can draw, set by the scope (setCapacity), which refits the window when it changes
//   · roughDrawn(part): the step head and the scope report the rough page; 'desk-rough' is marked once, when both have
//   · window(d?): the context window (replay.mjs header: s.win), drawn by Window.tsx. The bump is flushed at once (flushSync), so the
//     controller's next line sees the window drawn, except while a React lifecycle runs (`during`): flushSync there logs an error
//   · reveal(t): the function the window registered (setRevealer), null without one; cellRoots(): none, every cell is Cell.tsx's
// `during(f)` runs f as part of a React lifecycle (a render, an effect): the controller calls the hosts make from their effects go
// through it (DeskHost's routes, this view's framed and setCapacity).
import { flushSync } from 'react-dom'
import { keyOf } from '../../../legacy/replay/replay.mjs'

let depth = 0
export function during<T>(f: () => T): T { depth++; try { return f() } finally { depth-- } }

export const AREAS = ['head', 'step', 'saw', 'overview', 'cur', 'problems', 'review', 'frame', 'rough', 'empty', 'window', 'nav'] as const
export type Area = typeof AREAS[number]
// the controller's state (replay.mjs openDesk `s`): plain JS, read by the legacy renderers and the models
export type DeskState = any
// the containers the legacy areas draw and the controller wires; the session head, the step head, the scope and the context window are
// React's (no #deskhead, #stepbar, #ctxwin; saw is null)
export type Els = Record<'rails' | 'resexp', HTMLElement> & { saw: HTMLElement | null, detail: HTMLElement | null }
export type DeskView = ReturnType<typeof reactView>
// replay.mjs header: {fi, open?, flash?} | {anchor, flash?} → the element brought into view, or null
export type Reveal = { fi: number, open?: boolean, flash?: number } | { anchor: string, flash?: number }
export type Revealer = (t: Reveal) => HTMLElement | null

// makeView's shape (replay.mjs deskRoutes): `framed` is the controller's; `gone` runs when the controller disposes the desk
export function reactView(s: DeskState, framed: (E: Els) => void, gone: () => void) {
  s.rawPanelGone = true
  s.railsFolded = false // the rails' fold row is the legacy desk's; the narrow scope is css here (1.2 §窄屏)
  const root = document.createElement('div')
  root.className = 'desk next'
  const resexp = document.createElement('div')
  resexp.id = 'resexp'
  const v = Object.fromEntries(AREAS.map((a) => [a, 0])) as Record<Area, number>
  const subs = new Set<() => void>()
  let E: Els | null = null, K = Infinity, marked = false, revealer: Revealer | null = null
  const reported = new Set<'step' | 'scope'>()
  const bump = (a: Area) => { v[a]++; for (const f of [...subs]) f() }
  return {
    root, s, resexp, key: keyOf(s) as string,
    // the components' side
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
    version: (a: Area) => v[a],
    framed(els: Els) { if (E) return; E = els; during(() => framed(els)) },
    setCapacity(k: number) { if (k === K) return; K = k; during(() => s.refit?.()) },
    setRevealer(f: Revealer | null) { revealer = f },
    roughDrawn(part: 'step' | 'scope') {
      reported.add(part)
      if (marked || reported.size < 2) return
      marked = true
      if (typeof performance !== 'undefined') performance.mark('desk-rough')
    },
    // the controller's side
    els: () => E,
    head: () => bump('head'),
    step: () => bump('step'),
    saw: () => bump('saw'),
    overview: () => bump('overview'),
    cur: () => bump('cur'),
    problems: () => bump('problems'),
    review: () => bump('review'),
    frame: () => bump('frame'),
    rough: () => bump('rough'),
    empty: () => bump('empty'),
    nav: () => bump('nav'),
    window(d?: object) { if (d) s.win = d; if (depth) bump('window'); else flushSync(() => bump('window')) },
    reveal: (t: Reveal) => (revealer ? revealer(t) : null),
    cellRoots: () => [],
    capacity: () => K,
    dispose: gone,
  }
}
