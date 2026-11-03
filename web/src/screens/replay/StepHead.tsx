// web/src/screens/replay/StepHead.tsx — the step head (2.2) in the new desk. A thin legacy wrapper until it is ported: one empty
// container that stepbar.mjs renders into; the controller wires it (replay.mjs wire()). The paints apply in the controller's order:
// emptied, then the rough page's label, then the drawn step's head.
import { useRef } from 'react'
import { stepBarHtml } from '../../../legacy/replay/stepbar.mjs'
import { roughStepHead } from '../../../legacy/replay/replay.mjs'
import { usePaint } from './useDesk'
import type { DeskView } from './view'

export function StepHead({ desk }: { desk: DeskView }) {
  const el = useRef<HTMLDivElement>(null)
  const node = () => el.current!
  usePaint(desk, 'empty', () => { node().innerHTML = '' })
  usePaint(desk, 'rough', () => { if (roughStepHead(node(), desk.s, desk.roughAt().at)) desk.roughDrawn('step') })
  usePaint(desk, 'step', () => { node().innerHTML = stepBarHtml(desk.s) })
  return <div id="stepbar" ref={el} />
}
