// web/src/screens/replay/Scope.tsx — the scope (1.3: the trace rows, the whole-session strip, the rails between the prompts row and the
// whole-session row) in the new desk. A thin legacy wrapper until it is ported: one empty container that timeline.mjs renders into, its
// rows the legacy skeleton's with #rails moved in; the controller wires it (replay.mjs wire()). Its lane capacity is measured here on
// mount and on every resize of the bars row. The paints apply in the controller's order: emptied, rough, then the drawn areas.
import { useLayoutEffect, useRef } from 'react'
import { SKELETON, emptyScope, laneCapacity, paintReview } from '../../../legacy/replay/replay.mjs'
import { renderSaw, renderOverview, markCurrent, repositionBrush, renderProblemNav, renderRough } from '../../../legacy/replay/timeline.mjs'
import { usePaint } from './useDesk'
import type { DeskView } from './view'

// the legacy skeleton's scope rows, #rails after the prompts row and before the whole-session row
function scopeRows() {
  const t = document.createElement('template')
  t.innerHTML = SKELETON
  const saw = t.content.querySelector('#saw')!
  saw.querySelector('.tkrow-ovw')!.before(t.content.querySelector('#rails')!)
  return saw.innerHTML
}

export function Scope({ desk }: { desk: DeskView }) {
  const el = useRef<HTMLDivElement>(null)
  const node = () => el.current!
  useLayoutEffect(() => {
    const saw = el.current!
    if (!saw.hasChildNodes()) saw.innerHTML = scopeRows() // once: a shown-again subtree keeps what was drawn
    const fit = () => desk.setCapacity(laneCapacity(saw))
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    ro?.observe(saw.querySelector('#sawrow')!.closest('.tkrow')!)
    return () => ro?.disconnect()
  }, [desk])
  usePaint(desk, 'empty', () => emptyScope(node()))
  usePaint(desk, 'rough', () => { const r = desk.roughAt(); renderRough(node(), desk.s, r.at, r.K); desk.roughDrawn('scope') })
  usePaint(desk, 'saw', () => renderSaw(node(), desk.s))
  usePaint(desk, 'overview', () => renderOverview(node(), desk.s))
  usePaint(desk, 'problems', () => renderProblemNav(node(), desk.s))
  usePaint(desk, 'cur', () => { markCurrent(node(), desk.s); repositionBrush(node(), desk.s) })
  usePaint(desk, 'review', () => paintReview(node(), desk.s))
  return <div id="saw" ref={el} />
}
