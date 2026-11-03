// web/src/screens/replay/view.ts — the new desk's view (1.2 §涉及源文件: one controller, openDesk(ctx, route, view), two desks). The
// controller calls the same slots as on the legacy view; here each R1 area is a version channel the components read on commit
// (useDesk.ts), so a paint needs no element and may come before the frame exists. The slots this file owns:
//   · els(): the legacy-hosted containers, null until DeskFrame's first layout effect hands them over (framed); the controller treats
//     null as not drawn yet, as a detached desk, and redraws once they are there
//   · capacity(): the bars the lane can draw, set by the scope (setCapacity), which refits the window when it changes
//   · roughDrawn(part): the step head and the scope report the rough page; 'desk-rough' is marked once, when both have
import { keyOf } from '../../../legacy/replay/replay.mjs'

export const AREAS = ['head', 'step', 'saw', 'overview', 'cur', 'problems', 'review', 'frame', 'rough', 'empty'] as const
export type Area = typeof AREAS[number]
// the controller's state (replay.mjs openDesk `s`): plain JS, read by the legacy renderers and the models
export type DeskState = any
// the containers the legacy areas draw and the controller wires; the session head and the step head are React's (no #deskhead, #stepbar)
export type Els = Record<'saw' | 'rails' | 'ctxwin' | 'ctxnav' | 'resexp' | 'rawpanel', HTMLElement> & { detail: HTMLElement | null }
export type DeskView = ReturnType<typeof reactView>

// makeView's shape (replay.mjs deskRoutes): `framed` is the controller's; `gone` runs when the controller disposes the desk
export function reactView(s: DeskState, framed: (E: Els) => void, gone: () => void) {
  const root = document.createElement('div')
  root.className = 'desk next'
  const v = Object.fromEntries(AREAS.map((a) => [a, 0])) as Record<Area, number>
  const subs = new Set<() => void>()
  let E: Els | null = null, K = Infinity, rough = { at: 0, K: Infinity }, emptyMsg = '', marked = false
  const reported = new Set<'step' | 'scope'>()
  const bump = (a: Area) => { v[a]++; for (const f of [...subs]) f() }
  return {
    root, s, key: keyOf(s) as string,
    // the components' side
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
    version: (a: Area) => v[a],
    roughAt: () => rough,
    emptyMsg: () => emptyMsg,
    framed(els: Els) { if (E) return; E = els; framed(els) },
    setCapacity(k: number) { if (k === K) return; K = k; s.refit?.() },
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
    rough(at: number, k: number) { rough = { at, K: k }; bump('rough') },
    empty(msg: string) { emptyMsg = msg; bump('empty') },
    capacity: () => K,
    dispose: gone,
  }
}
