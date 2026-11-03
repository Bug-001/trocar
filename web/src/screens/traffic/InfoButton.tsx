// screens/traffic/InfoButton.tsx — an ⓘ that opens a short text in a popover (1.2 §弹出层): a React Aria dialog titled by its heading,
// not modal; opened by click, Enter or Space, closed by Esc or a click outside. Text only.
import { Button, Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components'

export function InfoButton({ label, title, body }: { label: string, title: string, body: string }) {
  return (
    <DialogTrigger>
      <Button className="popbtn" aria-label={label}>ⓘ</Button>
      <Popover className="pop">
        <Dialog><Heading slot="title" className="ph">{title}</Heading><div className="pb">{body}</div></Dialog>
      </Popover>
    </DialogTrigger>
  )
}
