// screens/traffic/board-router.ts — the board router's facade (web/src/router.ts `legacy`: current / go / setParams / onRoute) handed
// to React screens through context, so a screen writes the route the same way the legacy screens do (1.10 §组件与状态 路由写).
import { createContext, useContext } from 'react'
import type { createBoardRouter } from '../../router'

export type BoardRouter = ReturnType<typeof createBoardRouter>['legacy']
export const BoardRouterContext = createContext<BoardRouter | null>(null)

/** The facade the shell provides; a screen drawn outside the shell is a wiring fault, said at once. */
export function useBoardRouter(): BoardRouter {
  const r = useContext(BoardRouterContext)
  if (!r) throw new Error('useBoardRouter: no BoardRouterContext provider above this screen')
  return r
}
