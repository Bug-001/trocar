// web/src/screens/replay/DeskHead.tsx — the session head (1.2 §会话头) in the new desk. A thin legacy wrapper until it is ported: one
// empty container that header.mjs renders into on each `head` paint; the controller wires it (replay.mjs wire()).
import { useRef } from 'react'
import { renderSessionHead } from '../../../legacy/replay/header.mjs'
import { usePaint } from './useDesk'
import type { DeskView } from './view'

export function DeskHead({ desk }: { desk: DeskView }) {
  const el = useRef<HTMLDivElement>(null)
  usePaint(desk, 'head', () => renderSessionHead(el.current, desk.s))
  return <div id="deskhead" ref={el} />
}
