// web/src/screens/replay/useDesk.ts — a component reads one area of the desk (view.ts): it re-renders when the controller paints that
// area, and its model is computed once per paint. `fn` must be stable (a module-level function): it is part of the memo's key.
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Area, DeskState, DeskView } from './view'

export const useDeskVersion = (desk: DeskView, area: Area) => useSyncExternalStore(desk.subscribe, () => desk.version(area))

export function useDeskModel<T>(desk: DeskView, area: Area, fn: (s: DeskState) => T): T {
  const v = useDeskVersion(desk, area)
  return useMemo(() => { void v; return fn(desk.s) }, [desk, fn, v]) // v: the paint the model is computed for
}

// A thin legacy wrapper's paint: `paint` runs after the commit that follows each paint of `area`, once per paint. A subtree an
// <Activity> hid and shows again re-runs its effects; a paint already applied is not applied twice.
export function usePaint(desk: DeskView, area: Area, paint: () => void) {
  const v = useDeskVersion(desk, area)
  const done = useRef(0)
  useLayoutEffect(() => {
    if (done.current === v) return
    done.current = v
    paint()
  }, [v, paint])
}
