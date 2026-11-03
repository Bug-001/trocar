// screens/overview/InfoButton.tsx — the ⓘ beside a card's name (1.2 §弹出层): a button that opens a non-modal dialog titled by its
// head line, with the same classes as core/ui.mjs infoButton (.popbtn · .pop · .ph · .pb). Screen-local until the cleanup lifts it.
import { useId, type ReactNode } from 'react'
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components'

export function InfoButton({ label, title, body }: { label: string, title: string, body: ReactNode }) {
  const id = useId()
  return (
    <DialogTrigger>
      <Button className="popbtn" aria-label={label}>ⓘ</Button>
      <Popover placement="bottom start">
        <Dialog className="pop" aria-labelledby={id}>
          <div className="ph" id={id}>{title}</div>
          <div className="pb">{body}</div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}
