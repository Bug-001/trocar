// ui/InfoButton.tsx — the ⓘ beside a name on a React screen, on the 1.2 §弹出层 contract that core/ui.mjs installUi keeps for the
// legacy screens: hover opens after TIP_MS, focus at once, a press opens and pins; Esc (focus back to the button), a click outside,
// another ⓘ opening, or (hover-opened) the pointer leaving both button and layer closes. The layer is a React Aria Popover kept
// non-modal (no inert outside, no scroll lock, no focus taken) holding a role="dialog" titled by its head line, with the classes of
// core/ui.mjs infoButton (.popbtn · .pop · .ph · .pb). The layer is portalled into a host right after the button, not to the end of
// body, so its links come next in the Tab order, as popover() puts the legacy layer in the DOM.
// Every React screen uses this one; the legacy screens keep core/ui.mjs.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Popover } from 'react-aria-components'
import { TIP_MS } from '../../legacy/core/ui.mjs'
import { icon } from '../../legacy/core/icons.mjs'
import { Svg } from './Svg'

type How = 'hover' | 'focus' | 'pinned'
let current: { close: () => void } | null = null // one popover at a time

export function InfoButton({ label, title, body }: { label: string, title: string, body: ReactNode }) {
  const id = useId()
  const btn = useRef<HTMLButtonElement>(null), layer = useRef<HTMLDivElement>(null)
  const [how, setHow] = useState<How | null>(null)
  const [host, setHost] = useState<HTMLSpanElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const backTo = useRef(false) // the focus Esc gives back is the close finishing, not an open
  const [self] = useState(() => { const me = { close: () => { clearTimeout(timer.current); setHow(null); if (current === me) current = null } }; return me })
  const show = (h: How) => {
    if (current && current !== self) current.close()
    current = self
    setHow((o) => (o === 'pinned' ? o : h))
  }
  const inside = (t: EventTarget | null) => t instanceof Node && !!(btn.current?.contains(t) || layer.current?.contains(t))
  const left = (e: { relatedTarget: EventTarget | null }) => { clearTimeout(timer.current); if (how === 'hover' && !inside(e.relatedTarget)) self.close() }

  useEffect(() => {
    if (!how) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); self.close()
      backTo.current = true; btn.current?.focus(); backTo.current = false
    }
    const click = (e: MouseEvent) => { if (!inside(e.target)) self.close() }
    document.addEventListener('keydown', key); document.addEventListener('click', click)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('click', click) }
  }, [how, self])
  useEffect(() => () => self.close(), [self])

  return (
    <>
      <Button ref={btn} className="popbtn" aria-label={label} aria-expanded={how != null} aria-controls={`${id}-pop`}
        onPress={() => show('pinned')}
        onFocus={() => { if (!backTo.current) show('focus') }}
        onMouseEnter={() => { clearTimeout(timer.current); timer.current = setTimeout(() => show('hover'), TIP_MS) }}
        onMouseLeave={left}><Svg html={icon('info')} /></Button>
      <span ref={setHost} />
      <Popover triggerRef={btn} isOpen={how != null && host != null} onOpenChange={(o) => { if (!o) self.close() }} isNonModal
        placement="bottom start" containerPadding={8} UNSTABLE_portalContainer={host ?? undefined}>
        <div ref={layer} id={`${id}-pop`} className="pop" role="dialog" aria-labelledby={id} onMouseLeave={left}>
          <div className="ph" id={id}>{title}</div>
          <div className="pb">{body}</div>
        </div>
      </Popover>
    </>
  )
}
