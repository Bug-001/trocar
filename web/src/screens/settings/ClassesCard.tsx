// screens/settings/ClassesCard.tsx — the 保存什么 card (1.11 §保存什么): the captions, one row per class with its one level control (or
// the level as text when no control can work, 1.5 K-25), the total, the last change and the technical details. Rows are keyed by class id
// and drawn in the order the screen hands over (§组件状态); the selected level is always the server's `keep`, never a guess.
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { bytes } from '../../../legacy/core/fmt.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { TechDetails } from '../../ui/TechDetails'
import { ClassPop, type PopModel } from './ClassPop'
import { techOf, type Pairs } from './DiskCard'
import { flatText } from './storage-model.mjs'

export type Row = {
  id: string | null, key: string, name: string, keep: string, inTable: boolean, rules: string[], fallback: boolean,
  calls: number | null, bytes: number | null, share: number | null, hl: boolean, pop: PopModel | null, cmd: string | null,
}
export type CardModel = {
  notes: Array<{ code: string, text: string }>, editable: boolean, rows: Row[], total: { calls: number | null, bytes: number | null },
  last: { name: string, keep: string | null, source: string | null, sourceWord: string, ts: string, stamp: string, when: string } | null,
  tech: Pairs,
}
export type Receipt = { kind: string, text: string, tech?: string, keep: string }
type Change = (cls: string, keep: string) => void

const KEEPS = Object.keys(W.KEEP_NAME) as Array<keyof typeof W.KEEP_NAME>
const keepName = (k: string) => (W.KEEP_NAME as Record<string, string>)[k] ?? k

function Level({ r, busy, onChange }: { r: Row & { id: string }, busy: boolean, onChange: Change }) {
  return (
    <ToggleButtonGroup className="seg live lvl" data-lvl={r.id} aria-label={W.LEVEL_OF(r.name)}
      render={(props) => <div {...props} aria-busy={busy || undefined} />}
      selectionMode="single" disallowEmptySelection selectedKeys={[r.keep]}
      onSelectionChange={(keys: Set<Key>) => { const k = [...keys][0]; if (k != null && k !== r.keep) onChange(r.id, String(k)) }}>
      {KEEPS.map((k) => (
        <ToggleButton key={k} id={k} data-class={r.id} data-keep={k} className={({ isSelected }) => (isSelected ? 'on' : '')}>{W.KEEP_NAME[k]}</ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

function ReceiptLine({ rc, cls, onChange }: { rc: Receipt, cls: string, onChange: Change }) {
  return (
    <div className="crcpt" data-receipt={rc.kind}>
      {rc.text}
      {rc.kind === 'offline' ? <> · <button type="button" className="linkbtn" onClick={() => onChange(cls, rc.keep)}>{W.RETRY}</button></> : null}
      {rc.tech ? <TechDetails pairs={[[W.TECH_ANSWER, { text: rc.tech }]]} copy={`${W.TECH_ANSWER}: ${rc.tech}`} /> : null}
    </div>
  )
}

export function ClassesCard({ card, order, busy, receipts, onChange }:
  { card: CardModel, order: string[], busy: ReadonlySet<string>, receipts: ReadonlyMap<string, Receipt>, onChange: Change }) {
  const byKey = new Map(card.rows.map((r) => [r.key, r]))
  const rows = order.map((k) => byKey.get(k)).filter((r): r is Row => r != null)
  const { total, last } = card
  return (
    <div className="scard">
      <h2>{W.CARD_CLASSES}</h2>
      {card.notes.map((n) => <p key={n.code} className="cap" data-note={n.code}>{n.text}</p>)}
      <div className="hscroll"><table className="ptable ctable">
        <thead><tr><th className="k">{W.COL_CLASS}</th><th>{W.COL_KEEP}</th><th className="rules">{W.COL_RULES}</th><th className="n">{W.COL_CALLS}</th>
          <th className="n">{W.COL_STORED}</th><th aria-label={W.COL_INFO}></th></tr></thead>
        <tbody>{rows.map((r) => {
          const id = r.id, rc = id != null ? receipts.get(id) : undefined, isBusy = id != null && busy.has(id)
          return (
            <tr key={r.key} id={`class-${id ?? ''}`} data-class={id ?? ''} {...(r.hl ? { className: 'hl', 'data-hl': 'true' } : {})}>
              <td className="k">{r.name}</td>
              <td className="lv">
                {!r.inTable || id == null ? '—'
                  : card.editable ? <Level r={{ ...r, id }} busy={isBusy} onChange={onChange} />
                    : <span className="lvtext">{keepName(r.keep)}</span>}
                {isBusy ? <span className="cap busy">{W.CHANGING}</span> : null}
                {rc && id != null ? <ReceiptLine rc={rc} cls={id} onChange={onChange} /> : null}
              </td>
              <td className="rules">{r.fallback ? <div className="rclip">{W.RULES_FALLBACK}</div>
                : <div className="rclip mono" title={r.rules.join('\n')}>{r.rules.join(' · ')}</div>}</td>
              <td className="n" data-n="calls">{r.calls ?? '—'}</td>
              <td className="n" data-n="bytes" data-bytes={r.bytes ?? ''}>{r.bytes != null ? bytes(r.bytes) + (r.share != null ? ` · ${r.share}%` : '') : '—'}</td>
              <td className="i">{r.pop ? <ClassPop name={r.name} pop={r.pop} /> : null}</td>
            </tr>
          )
        })}</tbody>
        <tfoot><tr data-total="true"><td className="k">{W.TOTAL}</td><td></td><td className="rules"></td>
          <td className="n" data-n="calls">{total.calls ?? '—'}</td>
          <td className="n" data-n="bytes" data-bytes={total.bytes ?? ''}>{total.bytes != null ? bytes(total.bytes) : '—'}</td><td></td></tr></tfoot>
      </table></div>
      {last
        ? <p className="cap lastchg" data-source={last.source ?? ''}>{`${W.LAST_CHANGE}: ${last.name} ${last.keep ? keepName(last.keep) : ''} · ${last.sourceWord} · `}
          <time dateTime={last.ts} title={last.stamp}>{last.when}</time></p>
        : <p className="cap lastchg" data-empty="no-change">{W.NO_CHANGE}</p>}
      <TechDetails pairs={techOf(card.tech)} copy={flatText(card.tech)} />
    </div>
  )
}
