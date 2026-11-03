// screens/settings/ClassPop.tsx — a class row's ⓘ (1.11 §保存什么): what the class is, what 「Log only」 keeps, how much it stored in the
// window, and a link to that traffic. React Aria's popover (D75①, 1.2 §弹出层): it opens on press, Enter or Space only; Esc or a press
// outside closes it and focus returns to the ⓘ. Only text and the link inside.
import { useId } from 'react'
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components'
import { bytes } from '../../../legacy/core/fmt.mjs'
import * as W from '../../../legacy/labels/settings.mjs'

export type PopModel = { desc: string | null, stored: number | null, href: string }

export function ClassPop({ name, pop }: { name: string, pop: PopModel }) {
  const titleId = useId()
  return (
    <DialogTrigger>
      <Button className="popbtn" aria-label={name}>ⓘ</Button>
      <Popover className="pop">
        <Dialog aria-labelledby={titleId}>
          <div className="ph" id={titleId}>{name}</div>
          <div className="pb">
            {pop.desc ? <p>{pop.desc}</p> : null}
            <p>{W.POP_LOG_ONLY}</p>
            {pop.stored != null ? <p>{W.POP_STORED(bytes(pop.stored))}</p> : null}
            <p><a href={pop.href}>{W.POP_TRAFFIC} ›</a></p>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}
