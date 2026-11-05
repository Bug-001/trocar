// web/src/screens/replay/CallDetails.tsx — the window's two items after the reply (2.6 §A): what capturing changed, always in view, and the
// folded Call details. Each row with bytes is a .cblk, so the window's v and c keys reach its cell; the row asks for its bytes when it opens,
// and again when a step comes back with it open, since the step's own reads do not cover these refs.
import { useEffect, useId, type ReactNode } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { kf } from '../../../legacy/core/fmt.mjs'
import { discChev } from '../../../legacy/core/icons.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { cellOf } from '../../../legacy/replay/cell.mjs'
import { Chev } from '../../ui/Chev'
import { Svg } from '../../ui/Svg'
import { TechDetails } from '../../ui/TechDetails'
import { Cell } from './Cell'
import { scalarShown } from './call-details.mjs'

type Item = { [k: string]: any }
type Acts = { api: any, ask: (b: any) => void, fail: (b: any) => any, details: (key: string) => void }

export const Impact = ({ it }: { it: Item }) => <div className="cwimpact">{it.lines.map((l: Item) => <div key={l.key}>{l.text}</div>)}</div>

function Part({ x, label, literal = false, none, acts }: { x: Item, label: string, literal?: boolean, none: string, acts: Acts }) {
  const id = useId(), b = { text_ref: x.ref, chars: x.chars }
  useEffect(() => { if (x.open) acts.ask({ text_ref: x.ref }) }, [x.open, x.ref, acts])
  const name = <span className={literal ? 'cbrole mono' : 'cbrole'}>{label}</span>
  const value: ReactNode = scalarShown(x.value) ? <span className="cdval mono">{String(x.value)}</span> : null
  if (!x.ref) return <div className="cdline">{name}{value ?? <span className="cbchars" title={x.why || x.note || undefined}>{none}</span>}</div>
  return (
    <div className={`cblk${x.open ? '' : ' collapsed'}`}>
      <div className="cbh" onClick={() => acts.details('cd:' + x.ref)}>
        <button type="button" className="cbtog" aria-expanded={x.open} aria-controls={id}><Svg html={discChev(x.open)} />{name}</button>
        {value ?? (typeof x.chars === 'number' ? <span className="cbchars">{`${kf(x.chars)} ${W.CHARS_WORD}`}</span> : null)}
      </div>
      <div className="cbc" id={id} hidden={!x.open}>{x.open ? <Cell cell={cellOf(b)} fail={acts.fail(b)} api={acts.api} /> : null}</div>
    </div>
  )
}

const keyOf = (x: Item, i: number) => `${x.ref ?? x.key ?? ''}#${i}`

export function Details({ it, acts }: { it: Item, acts: Acts }) {
  const ws = it.transport === 'ws'
  return (
    <Disclosure className="disc cwdetails" isExpanded={it.open} onExpandedChange={() => acts.details('cd')}>
      <Button slot="trigger" className="disc-t"><Chev /><b>{W.CALL_DETAILS}</b></Button>
      <DisclosurePanel className="disc-b">{it.open ? <>
        <div className="cdgrp">{W.REQ_PARAMS}</div>
        {it.unparsed ? <div className="cdnote">{W.UNPARSED_PARAMS}</div>
          : !it.params.length ? <div className="cdnote">{W.NO_PARAMS}</div>
            : it.params.map((x: Item, i: number) => <Part key={keyOf(x, i)} x={x} label={x.key} literal none={W.NO_BYTES} acts={acts} />)}
        {it.raw.map((x: Item, i: number) => <Part key={keyOf(x, i)} x={x} label={ws ? W.rawReplyNth(i + 1) : W.RAW_REPLY} none={W.NO_RAW_REPLY} acts={acts} />)}
        {it.extra.length ? <div className="cdgrp">{W.EXTRA_MSGS(it.extra.length)}</div> : null}
        {it.extra.map((x: Item, i: number) => <Part key={keyOf(x, i)} x={x} label={x.key} literal none={W.NO_BYTES} acts={acts} />)}
        {it.transport ? <div className="cdnote">{ws ? W.TRANSPORT_WS : W.TRANSPORT_HTTP}</div> : null}
        <TechDetails pairs={it.tech.map(([k, v]: [string, string]) => [k, { text: v }])} copy={it.tech.map(([k, v]: [string, string]) => `${k}: ${v}`).join('\n')} />
      </> : null}</DisclosurePanel>
    </Disclosure>
  )
}
