// web/src/ui/Confirm.tsx — the confirm dialog (4.4 先计划后确认, 1.9 §开关): the question, the impact, one line per thing trocar will
// change, then Cancel (the default focus, so Enter alone never confirms) and the confirm button. Esc and the scrim are Cancel; focus
// returns to the control that asked as the dialog closes, in the same task (React Aria's own restore waits a frame, and a key pressed
// in it would reach the page body). useConfirm() → ask(opts) → Promise<boolean>; a second ask while one is open cancels the first, and so does
// the provider unmounting with its screen (1.2 §键盘「层随屏走」: Cancel, so nothing carrying `confirm` is sent).
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button, Dialog, Modal, ModalOverlay } from 'react-aria-components'

export type AskOptions = { q: string, impact?: string, lines?: string[], confirmLabel: string, cancelLabel?: string }
type Ask = (opts: AskOptions) => Promise<boolean>

const ConfirmContext = createContext<Ask | null>(null)

export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext)
  if (!ask) throw new Error('useConfirm needs a ConfirmProvider above it')
  return ask
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<AskOptions | null>(null)
  const pending = useRef<((ok: boolean) => void) | null>(null)
  const asker = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => () => { const resolve = pending.current; pending.current = null; resolve?.(false) }, [])
  const ask = useCallback<Ask>((o) => new Promise<boolean>((resolve) => {
    pending.current?.(false)
    pending.current = resolve
    const a = document.activeElement // a second ask from inside the open dialog keeps the first one's asker
    if (!a?.closest('[data-confirm-back]')) asker.current = a instanceof HTMLElement && a !== document.body ? a : null
    setOpts(o)
  }), [])
  const done = (ok: boolean) => {
    const resolve = pending.current
    pending.current = null
    flushSync(() => setOpts(null)) // the dialog is gone when this returns, so the asker can take the focus now
    const back = asker.current
    asker.current = null
    if (back && back.isConnected && document.activeElement === document.body) back.focus()
    resolve?.(ok)
  }
  const { q, impact = '', lines = [], confirmLabel = '', cancelLabel = 'Cancel' } = opts ?? { q: '', confirmLabel: '' }
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <ModalOverlay className="v2-modal-back" data-confirm-back="" isDismissable isOpen={opts != null} onOpenChange={(open) => { if (!open) done(false) }}>
        <Modal>
          <Dialog className="v2-modal dialog" aria-labelledby={titleId}>
            <div className="mtitle q" id={titleId}>{q}</div>
            {impact ? <div className="impact">{impact}</div> : null}
            {lines.length ? <div className="mbody">{lines.map((l, i) => <p key={i}>{l}</p>)}</div> : null}
            <div className="mactions">
              <Button className="mbtn" data-confirm="cancel" autoFocus onPress={() => done(false)}>{cancelLabel}</Button>
              <Button className="mbtn primary" data-confirm="ok" onPress={() => done(true)}>{confirmLabel}</Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </ConfirmContext.Provider>
  )
}
