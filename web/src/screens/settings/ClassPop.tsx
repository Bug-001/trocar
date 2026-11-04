// screens/settings/ClassPop.tsx — a class row's ⓘ (1.11 §一行的弹出层): what the class is, what 「Log only」 keeps, how much it stored in
// the window, and a link to that traffic. The layer is ui/InfoButton, on the 1.2 §弹出层 contract; only text and the link inside.
import { bytes } from '../../../legacy/core/fmt.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { InfoButton } from '../../ui/InfoButton'

export type PopModel = { desc: string | null, stored: number | null, href: string }

export function ClassPop({ name, pop }: { name: string, pop: PopModel }) {
  return (
    <InfoButton label={name} title={name} body={<>
      {pop.desc ? <p>{pop.desc}</p> : null}
      <p>{W.POP_LOG_ONLY}</p>
      {pop.stored != null ? <p>{W.POP_STORED(bytes(pop.stored))}</p> : null}
      <p><a href={pop.href}>{W.POP_TRAFFIC} ›</a></p>
    </>} />
  )
}
