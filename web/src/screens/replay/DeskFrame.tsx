// web/src/screens/replay/DeskFrame.tsx — the new desk's frame (1.2 §回放台 B 布局), drawn into the desk's own root (DeskHost's portal):
// the same ids and containers as replay.mjs SKELETON. The left page holds the scope (#saw, with #rails in it) and <main> = the outline
// #ctxnav · the boundary #maindiv · the middle column, which holds only the step head and the context window (1.4 中栏); the right page
// holds the resources and the raw panel. The containers the legacy areas draw (#ctxwin #ctxnav #resexp #rawpanel, #rails inside the
// scope, and #rpbar's text, the fold line resources.mjs writes) are rendered empty: React never renders children, classes or styles inside them. What this frame renders from the desk's state
// (decision 12, one owner per element): #leftpage's `railopen` (rails open, s.railsFolded) and the right page's `open`; the bars the
// window draws (--nbars, which the detail lanes narrow to) are the scope's (Scope.tsx, from its model's window). The boundaries are wired by layout.mjs initLayout() (the
// controller's wire()). Its first layout effect hands the controller the legacy containers (view.framed), once.
import { useLayoutEffect } from 'react'
import { MAINDIV_TIP, DIVIDER_TIP, RPBAR_TIP } from '../../../legacy/labels/replay.mjs'
import { useDeskModel } from './useDesk'
import { DeskHead } from './DeskHead'
import { StepHead } from './StepHead'
import { Scope } from './Scope'
import type { DeskState, DeskView, Els } from './view'

const railsOpen = (s: DeskState) => !s.railsFolded
const rightOpen = (s: DeskState) => !!s.rpOpen

export function DeskFrame({ desk }: { desk: DeskView }) {
  const rails = useDeskModel(desk, 'frame', railsOpen)
  const rp = useDeskModel(desk, 'frame', rightOpen)
  useLayoutEffect(() => {
    const $ = (sel: string) => desk.root.querySelector<HTMLElement>(sel)!
    const ids = ['rails', 'ctxwin', 'ctxnav', 'resexp', 'rawpanel'] as const
    // no `saw`: the scope is React's (Scope.tsx draws and wires it), so the controller's wire() leaves it alone
    desk.framed({ ...Object.fromEntries(ids.map((id) => [id, $('#' + id)])), saw: null, detail: document.getElementById('detail') } as Els)
  }, [desk])
  return <>
    <DeskHead desk={desk} />
    <div id="pages">
      <div id="leftpage" className={rails ? 'railopen' : undefined}>
        <Scope desk={desk} />
        <main>
          <div id="ctxnav" />
          <div id="maindiv" title={MAINDIV_TIP} />
          <div id="midcol"><StepHead desk={desk} /><div id="ctxwin" /></div>
        </main>
      </div>
      <div id="divider" title={DIVIDER_TIP} />
      <div id="rightpage" className={rp ? 'open' : undefined}>
        {/* the text is resources.mjs's (the fold line, from the file count); React renders no children here */}
        <div id="rpbar" role="button" tabIndex={0} aria-expanded={rp} title={RPBAR_TIP} />
        <div id="rpbody"><div id="resexp" /><div id="rawpanel" /></div>
      </div>
    </div>
  </>
}
