// screens/capture/ChangesBlock.tsx — the changes trocar made on this computer that are no harness's (1.9 §trocar 在这台电脑上做的改动):
// information only, no undo. It opens by default while the install left something pending or its record cannot be read; after the
// reader toggles it, it follows the reader.
import { Fragment } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { TechDetails } from '../../ui/TechDetails'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { Parts, techPairs, type Pair } from './AgentRow'
import { Chev } from '../../ui/Chev'

type Part = { text: string } | { mono: string }
export type ChangesModel = {
  title: string, open: boolean, lines: Array<{ path: string, parts: Part[] }>, pendingLead: string | null,
  pending: Array<{ path: string, harness: string | null, name: string | null, result: string }>,
  manifestError: string | null, tech: Pair[] | null,
}

const plain = (v: Pair['v']): string => ('parts' in v ? v.parts.map(plain).join('') : 'mono' in v ? v.mono : v.text)

export function ChangesBlock({ ch, open, onOpen }: { ch: ChangesModel, open: boolean, onOpen: (open: boolean) => void }) {
  return (
    <section className="cblock" aria-label="Changes trocar made on this computer">
      <Disclosure className="disc" isExpanded={open} onExpandedChange={onOpen}>
        <Button slot="trigger" className="disc-t"><Chev /><b>{ch.title}</b></Button>
        <DisclosurePanel className="disc-b">
          {ch.lines.map((l, i) => <Fragment key={i}><p><span className="mono">{l.path}</span></p><p><Parts parts={l.parts} /></p></Fragment>)}
          {ch.pendingLead ? <p>{ch.pendingLead}</p> : null}
          {ch.pending.map((x, i) => (
            <p key={i}>
              <span className="mono">{x.path}</span>
              {x.harness != null ? <>{' '}<HarnessIcon id={x.harness} /><span className="chipname">{x.name}</span></> : null}
              {' '}<span className="fine">{x.result}</span>
            </p>
          ))}
          {ch.manifestError ? <p>{ch.manifestError}</p> : null}
          {ch.tech ? <TechDetails pairs={techPairs(ch.tech)} copy={ch.tech.map(({ k, v }) => `${k}: ${plain(v)}`).join('\n')} /> : null}
        </DisclosurePanel>
      </Disclosure>
    </section>
  )
}
