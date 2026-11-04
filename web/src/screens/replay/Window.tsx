// web/src/screens/replay/Window.tsx — the new desk's context window (2.3; 1.4 中栏): its own #ctxwin, painted on every paint of the
// 'window' area (view.ts) from s.win by the legacy painter (replay.mjs paintWindow), with the legacy window's listeners (wireWindow) and
// jumps (revealIn, registered as the view's revealer). The window's cells are wired with the desk's (view.cellRoots).
import { useCallback, useLayoutEffect, useRef } from 'react'
import { paintWindow, wireWindow, revealIn } from '../../../legacy/replay/replay.mjs'
import { usePaint } from './useDesk'
import type { DeskView } from './view'

export function Window({ desk }: { desk: DeskView }) {
  const ref = useRef<HTMLDivElement>(null)
  const paint = useCallback(() => { paintWindow(ref.current!, desk.s) }, [desk])
  usePaint(desk, 'window', paint)
  useLayoutEffect(() => {
    const off = wireWindow(ref.current!, desk.s)
    desk.setRevealer((t) => revealIn(desk.root, desk.s, t))
    return () => { off(); desk.setRevealer(null) }
  }, [desk])
  return <div id="ctxwin" ref={ref} />
}
