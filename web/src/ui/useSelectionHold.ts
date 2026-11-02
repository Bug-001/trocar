// web/src/ui/useSelectionHold.ts — a reader selecting text is never interrupted by a repaint (1.2 §点击与选中文字, 1.9). While the document's
// selection is not collapsed and one of its ends lies inside the zone, `shown` stays the value last shown; it adopts the latest value
// the moment the selection leaves the zone (selectionchange), at the next value with no selection inside, or when release() is called.
// → { shown, ref, release }: put `ref` on the zone's element.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

const subscribe = (fn: () => void) => {
  document.addEventListener('selectionchange', fn)
  return () => document.removeEventListener('selectionchange', fn)
}

const selectionInside = (zone: Element | null) => {
  const s = zone && typeof document.getSelection === 'function' ? document.getSelection() : null
  return !!s && !s.isCollapsed && (zone!.contains(s.anchorNode) || zone!.contains(s.focusNode))
}

export function useSelectionHold<T>(value: T) {
  const [zone, ref] = useState<Element | null>(null)
  const held = useSyncExternalStore(subscribe, () => selectionInside(zone), () => false)
  const [shown, setShown] = useState(value)
  if (!held && !Object.is(shown, value)) setShown(value) // adjust while rendering: nothing selected here, show the latest
  const latest = useRef(value)
  useLayoutEffect(() => { latest.current = value })
  const release = useCallback(() => setShown(() => latest.current), [])
  return { shown: held ? shown : value, ref, release }
}
