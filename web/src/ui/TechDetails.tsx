// web/src/ui/TechDetails.tsx — 技术细节 (1.5 §数据规则): the collapsed well where codes, pids, paths and field names live, with a copy
// button. Closed until the reader opens it; only the head toggles it. A value is {text} (plain), {mono} (a code or path) or {parts}
// (a run of both).
import { Fragment, type ReactNode } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { CopyButton } from './CopyButton'
import { Chev } from './Chev'

type Part = { text: string } | { mono: string }
export type TechValue = Part | { parts: Part[] }

const part = (p: Part) => ('mono' in p ? <span className="mono">{p.mono}</span> : p.text)

export function TechDetails({ pairs, copy, title = 'Technical details', extra }:
  { pairs: Array<[string, TechValue]>, copy: string, title?: string, extra?: ReactNode }) {
  return (
    <Disclosure className="disc">
      <Button slot="trigger" className="disc-t"><Chev /><b>{title}</b></Button>
      <DisclosurePanel className="disc-b">
        <div className="tech">{pairs.map(([k, v], i) => (
          <Fragment key={`${i}:${k}`}>
            <span className="k">{k}</span>
            <span className="v">{'parts' in v ? v.parts.map((p, j) => <Fragment key={j}>{part(p)}</Fragment>) : part(v)}</span>
          </Fragment>
        ))}</div>
        <CopyButton text={copy} />
        {extra}
      </DisclosurePanel>
    </Disclosure>
  )
}
