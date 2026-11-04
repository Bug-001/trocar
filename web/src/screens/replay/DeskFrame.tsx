// web/src/screens/replay/DeskFrame.tsx — the new desk's frame (1.2 §回放台布局), drawn into the desk's own root (DeskHost's portal): the
// session head, then the main area beside the right sidebar. The main area stacks the scope (#saw, with #rails in it) over the reading
// column #midcol, which holds only the step head and the context window (1.4 中栏). The two boundaries are react-resizable-panels'
// (D80①); neither Group has an id: the library keeps mounted groups in a module-level table by id, and two cached desks would collide.
// Until the reader moves it the scope's boundary follows the content; a move, or a stored layout, stops that. Its first layout effect
// hands the controller what it still draws into (view.framed), once.
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, useGroupRef, usePanelRef } from 'react-resizable-panels'
import { SCOPE_SPLIT_TIP, SIDE_SPLIT_TIP } from '../../../legacy/labels/replay.mjs'
import { DeskHead } from './DeskHead'
import { Scope } from './Scope'
import { Sidebar } from './Sidebar'
import { StepHead } from './StepHead'
import { useSplit } from './useSplit'
import { Window } from './Window'
import type { DeskView } from './view'

const SIDE_PX = 352 // 1.2 §回放台布局

export function DeskFrame({ desk }: { desk: DeskView }) {
  const wide = true as boolean
  const side = useSplit('trocar.v2.split.side'), scope = useSplit('trocar.v2.split.scope'), { held } = scope
  const sideGroup = useGroupRef(), sidePanel = usePanelRef(), scopePanel = usePanelRef()
  const col = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [folded, setFolded] = useState(false), open = useRef(SIDE_PX) // open: the width the sidebar was collapsed from

  useLayoutEffect(() => {
    const $ = (sel: string) => desk.root.querySelector<HTMLElement>(sel)!
    desk.framed({ rails: $('#rails'), resexp: desk.resexp, saw: null, detail: document.getElementById('detail') })
  }, [desk])

  // the scope is as tall as its content, up to half the column less the step head (1.2 §上下文窗的高度)
  const fit = useCallback(() => {
    const h = col.current!.clientHeight
    if (h && !held()) scopePanel.current?.resize(Math.min(content.current!.offsetHeight, h / 2 - desk.root.querySelector<HTMLElement>('#stepbar')!.offsetHeight))
  }, [desk, held, scopePanel])
  useLayoutEffect(() => {
    const ro = new ResizeObserver(fit)
    for (const el of [content.current!, col.current!, desk.root.querySelector('#stepbar')!]) ro.observe(el)
    return () => ro.disconnect()
  }, [desk, fit])

  const fold = () => {
    const p = sidePanel.current!
    if (p.isCollapsed()) p.resize(open.current) // not expand(): after a reload it knows no width but the minimum
    else { open.current = p.getSize().inPixels; p.collapse() }
    side.keep(sideGroup.current!.getLayout()) // the button is no drag, yet the collapsed state is remembered like one
  }
  return <>
    <DeskHead desk={desk} />
    <Group className="deskpanes" groupRef={sideGroup} defaultLayout={side.defaultLayout} onLayoutChanged={side.onLayoutChanged}>
      <Panel id="desk-main" minSize={480}>
        <Group orientation="vertical" className="deskcol" elementRef={col} defaultLayout={scope.defaultLayout} onLayoutChanged={scope.onLayoutChanged}>
          <Panel id="desk-scope" panelRef={scopePanel} minSize={48} maxSize="75%"><div ref={content} className="scopefit"><Scope desk={desk} /></div></Panel>
          <Separator disableDoubleClick title={SCOPE_SPLIT_TIP} aria-label={SCOPE_SPLIT_TIP} onDoubleClick={() => { scope.forget(); fit() }} />
          <Panel id="desk-read" minSize="25%"><div id="midcol"><StepHead desk={desk} /><Window desk={desk} /></div></Panel>
        </Group>
      </Panel>
      {wide ? <>
        <Separator disableDoubleClick title={SIDE_SPLIT_TIP} aria-label={SIDE_SPLIT_TIP} onDoubleClick={() => { side.forget(); sidePanel.current?.resize(SIDE_PX) }} />
        <Panel id="desk-side" panelRef={sidePanel} collapsible collapsedSize={40} defaultSize={SIDE_PX} minSize={220} maxSize={720} groupResizeBehavior="preserve-pixel-size"
          onResize={() => setFolded(!!sidePanel.current?.isCollapsed())}>
          <Sidebar desk={desk} folded={folded} onFold={fold} />
        </Panel>
      </> : null}
    </Group>
    {wide ? null : <Sidebar desk={desk} bottom />}
  </>
}
