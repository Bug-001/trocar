// screens/capture/AgentRow.tsx — one agent's row of the capture table (1.9 §每个 agent 一行, §展开, §开关): the head line (gutter, the
// name as the Disclosure trigger, the desired state where no control is drawn, the status sentence, the last capture / failure links,
// the one control) and the expansion (why and what to do, what trocar changed for it, the technical details and the diagnostics copy).
// Only the name button opens or folds the row (1.2 §点击与选中文字 ②); its open state is the page's, keyed by the row's stable id.
// The markup keeps the class names the capture CSS and the browser checks know (.crow, .crow-t, .gut, .cap-nm, .stt, .last, .ctl, .cexp).
import { Fragment, type ReactNode } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { TechDetails, type TechValue } from '../../ui/TechDetails'
import { CopyButton } from '../../ui/CopyButton'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { HarnessSwitch, type ControlModel } from '../../ui/HarnessSwitch'

export type Pair = { k: string, v: TechValue }
type Part = { text: string } | { mono: string }
type Link = { href?: string, text: string, title?: string }
export type AgentRowModel = {
  id: string, name: string, gut: string | null, sentence: { text: string, cls: string, dim: boolean }, desired: string, control: ControlModel,
  last: Link | null, fail: Link | null, defaultOpen: boolean,
  why: { lines: string[], tail: string } | null,
  changes: { lines: Array<{ path: string, parts: Part[] }>, removal: string } | null,
  tech: Pair[], copy: string, diag: string,
}
export type DoneFn = (out: unknown) => void

// shared by the page's rows ───────────────────────────────────────────────────────────────────────────────────────
export const Parts = ({ parts }: { parts: Part[] }) =>
  <>{parts.map((p, i) => <Fragment key={i}>{'mono' in p ? <span className="mono">{p.mono}</span> : p.text}</Fragment>)}</>

// bad / warn lamps, the ok dot, or nothing (1.5: a normal state lights nothing, an unknown one neither)
export const Gut = ({ gut }: { gut: string | null }) => (
  <span className="gut">{gut === 'ok' ? <span className="capdot" aria-hidden="true" /> : gut ? <span className={`lamp ${gut}`} aria-hidden="true" /> : null}</span>
)

// the leading state word carries the severity colour (up to the first ':' or ' · '); the rest of the sentence stays ink
export function Lead({ text, cls }: { text: string, cls: string }) {
  if (cls !== 'bad' && cls !== 'warn') return <>{text}</>
  const m = /^(.*?)(?::| · )/.exec(text)
  const head = m ? m[1] : text
  return <><span className="sw">{head}</span>{text.slice(head.length)}</>
}

export const techPairs = (pairs: Pair[]): Array<[string, TechValue]> => pairs.map(({ k, v }) => [k, v])

// a row of the table: the Disclosure whose trigger is the name button; `gut` and `rest` are the rest of the head line, plain markup
export function CapRow({ id, caprow, label, open, onOpen, gut, rest, children }: {
  id: string, caprow: string, label: ReactNode, open: boolean, onOpen: (open: boolean) => void, gut: ReactNode, rest: ReactNode, children: ReactNode,
}) {
  return (
    <Disclosure className="crow" data-h={id} isExpanded={open} onExpandedChange={onOpen}>
      <div className="crow-t">
        {gut}
        <Button slot="trigger" className="nm cap-nm" data-caprow={caprow}>
          <span className="chev" aria-hidden="true">{open ? '▾' : '▸'}</span>{label}
        </Button>
        {rest}
      </div>
      <DisclosurePanel className="cexp">{children}</DisclosurePanel>
    </Disclosure>
  )
}

export function AgentRow({ row, open, onOpen, onDone }: { row: AgentRowModel, open: boolean, onOpen: (open: boolean) => void, onDone: DoneFn }) {
  const s = row.sentence
  const link = (l: Link) => <a href={l.href} title={l.title}>{`${l.text} ›`}</a>
  return (
    <CapRow id={row.id} caprow={`cap-${row.id}`} open={open} onOpen={onOpen}
      label={<><HarnessIcon id={row.id} /><span className="chipname">{row.name}</span></>}
      gut={<Gut gut={row.gut} />}
      rest={<>
          <span className="des">{row.desired}</span>
          <span className={`stt stt-${s.cls}${s.dim ? ' dim' : ''}`}><p className="lead"><Lead text={s.text} cls={s.cls} /></p></span>
          <span className="last">{row.last ? (row.last.href ? link(row.last) : <span>{row.last.text}</span>) : null}{row.fail ? link(row.fail) : null}</span>
          <span className="ctl"><HarnessSwitch model={row.control} name={row.name} onDone={onDone} /></span>
        </>}>
      {row.why || row.changes ? (
        <dl className="exp">
          {row.why ? <>
            <dt>Why, and what to do</dt>
            <dd>{row.why.lines.map((l, i) => <p key={i}>{l}</p>)}<p className="fine">{row.why.tail}</p></dd>
          </> : null}
          {row.changes ? <>
            <dt>Changed for it by trocar</dt>
            <dd>
              {row.changes.lines.map((l, i) => <Fragment key={i}><p><span className="mono">{l.path}</span></p><p><Parts parts={l.parts} /></p></Fragment>)}
              <p className="fine">{row.changes.removal}</p>
            </dd>
          </> : null}
        </dl>
      ) : null}
      <div className="exp-tech">
        <TechDetails pairs={techPairs(row.tech)} copy={row.copy} />
        <div className="capcopy"><CopyButton text={row.diag} label="Copy diagnostics" /></div>
      </div>
    </CapRow>
  )
}
