// web/src/ui/PageHead.tsx — the page head (1.2 §页头): the screen's name, then the tools zone: the screen's own controls and
// 「Data read at HH:MM:SS」, the time of its last successful read (nothing while the first read is out). Same markup as
// shell/pagehead.mjs pageHeadHtml.
import type { ReactNode } from 'react'
import { READ_AT } from '../../legacy/shell/pagehead.mjs'
import { fmtTime } from '../../legacy/core/fmt.mjs'

export function PageHead({ name, readAt, tools }: { name: string, readAt?: number | Date | null, tools?: ReactNode }) {
  const read = readAt != null ? <span className="readat">{`${READ_AT} ${fmtTime(readAt)}`}</span> : null
  return (
    <header className="pagehead">
      <h1 className="pagename">{name}</h1>
      {tools != null || read ? <span className="tools">{tools}{read}</span> : null}
    </header>
  )
}
