// screens/overview/Cards.tsx — the overview's cards (1.7): each draws one card model of model.mjs and nothing else. The markup keeps the
// class names of the legacy overview (web/legacy/css/overview.css styles them): .ovcard · .ovh · .ovsay · .ovsub · .ovlist · .ovitem ·
// .ovtbl / .ovtr. Every list is keyed by the model's stable id (1.2 §点击与选中文字 ③), so a poll never rebuilds a row.
import type { ReactNode } from 'react'
import { Button } from 'react-aria-components'
import { harnessName, UNIDENTIFIED } from '../../../legacy/core/chips.mjs'
import { SWITCH_WORD } from '../../../legacy/labels/capture.mjs'
import { READING } from '../../../legacy/labels/common.mjs'
import * as W from '../../../legacy/labels/overview.mjs'
import { TechDetails, type TechValue } from '../../ui/TechDetails'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { HarnessSwitch, type ControlModel } from '../../ui/HarnessSwitch'
import { InfoButton } from '../../ui/InfoButton'
import type { capCard, itemsCard, startCard } from './model.mjs'

type Link = { text: string, href: string }
type Tip = { text: string, tip: string | null }
type Fail = { line: string, pairs: Array<[string, string]> }
export type Retry = (group: 'health' | 'sessions' | 'slow') => void
export type StatsModel = { kind: 'reading' } | { kind: 'failed', fail: Fail } | {
  kind: 'shown', other: boolean, asOf: string, scope: string, missing: string | null, coverage: string | null, priceFail: Fail | null,
  empty: boolean, sessions: Link, calls: string, cost: Tip, unpriced: Link | null, hit: Tip, disk: Link | null,
  agents: Array<{ id: string, chip: string | null, net: boolean, href: string | null, sessions: unknown, calls: unknown, cost: Tip, hit: Tip, last: string }>,
}
export type RecentModel = { kind: 'reading' } | { kind: 'none' } | { kind: 'failed', fail: Fail } | {
  kind: 'shown', rows: Array<{ id: string, harness: string, inferred: boolean, title: string, titleTip: string, calls: Tip, when: string, href: string }>,
}
export type AgentRowM = { id: string, harness: string, desired: string, control: ControlModel, commands: Array<[string, string]> | null }

// the technical details of `k: v` pairs: a code or a command is mono, the rest plain text; the copy is the pairs as lines
function Tech({ pairs, mono }: { pairs: Array<[string, string]>, mono: (k: string) => boolean }) {
  const shown = pairs.map(([k, v]): [string, TechValue] => [k, mono(k) ? { mono: v } : { text: v }])
  return <TechDetails pairs={shown} copy={pairs.map(([k, v]) => `${k}: ${v}`).join('\n')} />
}
const all = () => true, none = () => false

export const Chip = ({ id }: { id: string }) => <><HarnessIcon id={id} /><span className="ovnm">{harnessName(id)}</span></>
const tipOf = (t: string | null | undefined) => t || undefined

// a card whose first answer has not come yet: its name and 「Reading…」 (1.5 覆盖), never a blank space
export const Reading = ({ cls, title }: { cls: string, title: string }) => (
  <section className={`ovcard ${cls} reading`} aria-label={title} aria-busy="true"><h2 className="ovh">{title}</h2><p className="ovsay">{READING}</p></section>
)

// a card whose read failed before any answer: what and the cause class, Retry for its group, the status and reason in the details
export const Failed = ({ what, fail, group, onRetry }: { what: string, fail: Fail, group: Parameters<Retry>[0], onRetry: Retry }) => (
  <section className="ovcard">
    <h2 className="ovh">{what}</h2>
    <p className="ovsay warn">{fail.line} · <Button className="ghostbtn" data-g={group} onPress={() => onRetry(group)}>{W.RETRY}</Button></p>
    <Tech pairs={fail.pairs} mono={(k) => k === 'status'} />
  </section>
)

export function CapCard({ m }: { m: ReturnType<typeof capCard> }) {
  return (
    <section className="ovcard cap" aria-label={W.CARD.capture}>
      <h2 className="ovh"><span className={`lamp ${m.cls}`} aria-hidden="true" />{W.CARD.capture}</h2>
      <p className={`ovsay ${m.cls}`}>{m.text}</p>
      {m.subs.map((t: string) => <p className="ovsub" key={t}>{t}</p>)}
      <p className="ovgo"><a href="#/capture">{W.GO_CAPTURE}</a></p>
      {m.tech ? <Tech pairs={m.tech as Array<[string, string]>} mono={none} /> : null}
    </section>
  )
}

export function ItemsCard({ m }: { m: ReturnType<typeof itemsCard> }) {
  return (
    <section className="ovcard items" aria-label={W.CARD.items}>
      <h2 className="ovh">{W.CARD.items}<InfoButton label="Failure list window" title={W.FAIL_LIST} body={m.failWindow} /></h2>
      {m.partial ? <p className="ovsub warn ovpart">{m.partial}</p> : null}
      {m.stale ? <p className="ovsub">{m.stale}</p> : null}
      <div className="ovlist">
        {m.rows.map((it) => (
          <a className="ovitem" key={it.id} href={it.href} title={tipOf(it.tip)}>
            {it.chip != null ? <Chip id={it.chip} /> : it.subject ? <span className="ovsubj">{it.subject}</span> : null}
            <span className="ovtx">{it.text}</span><span className="go" aria-hidden="true">›</span>
          </a>
        ))}
        {m.more.map((x) => <a className="ovitem more" key={x.id} href={x.href}>{x.text}</a>)}
        {m.empty ? <p className={m.empty === 'reading' ? 'ovempty reading' : 'ovempty'}>{m.empty === 'reading' ? READING : W.NO_ITEMS}</p> : null}
      </div>
    </section>
  )
}

export function StatsCard({ m, onRetry }: { m: StatsModel, onRetry: Retry }) {
  if (m.kind === 'reading') return <Reading cls="stats" title={W.CARD.stats} />
  if (m.kind === 'failed') return <Failed what="Stats" fail={m.fail} group="slow" onRetry={onRetry} />
  const t = W.TBL
  let body: ReactNode = <p className="ovsay">{W.EMPTY_WINDOW}</p>
  if (!m.empty) body = <>
    <p className="ovsay">
      <a href={m.sessions.href}>{m.sessions.text} ›</a> · {m.calls} · <span className="ovcost" title={m.cost.tip || undefined}>{m.cost.text}</span>
      {m.unpriced ? <> · <a href={m.unpriced.href}>{m.unpriced.text} ›</a></> : null}
      {' · '}{W.HIT_LABEL} <span className="ovhit" title={tipOf(m.hit.tip)}>{m.hit.text}</span>
    </p>
    {m.agents.length ? <div className="hscroll"><div className="ovtbl" role="table">
      <div className="ovtrh" role="row"><span>{t.agent}</span><span className="n">{t.sessions}</span><span className="n">{t.calls}</span><span className="n">{t.cost}</span><span className="n">{t.hit}</span><span className="n">{t.last}</span></div>
      {m.agents.map((g) => {
        const inner = <>
          <span className="ovag">{g.chip == null ? <span className="ovsubj">{UNIDENTIFIED}</span> : <Chip id={g.chip} />}</span>
          {g.net ? <span className="ovnet">{W.NET_ONLY}</span> : <>
            <span className="n">{String(g.sessions)}</span><span className="n">{String(g.calls)}</span>
            <span className="n" title={tipOf(g.cost.tip)}>{g.cost.text}</span><span className="n" title={tipOf(g.hit.tip)}>{g.hit.text}</span>
            <span className="n">{g.last}</span>
          </>}
        </>
        const cls = g.net ? 'ovtr nocall' : 'ovtr'
        return g.href ? <a className={cls} role="row" href={g.href} key={g.id}>{inner}</a> : <div className={cls} role="row" key={g.id}>{inner}</div>
      })}
    </div></div> : null}
  </>
  return (
    <section className={m.other ? 'ovcard stats reading' : 'ovcard stats'} aria-busy={m.other || undefined} aria-label={W.CARD.stats}>
      <h2 className="ovh">{W.CARD.stats}</h2>
      {m.other ? <p className="ovsub">{READING}</p> : null}
      <p className="ovsub">{m.asOf} · {m.scope}</p>
      {m.missing ? <p className="ovsub warn">{m.missing}</p> : null}
      {m.coverage ? <p className="ovsub warn ovcov">{m.coverage}</p> : null}
      {m.priceFail ? <><p className="ovsub warn">{m.priceFail.line}</p><Tech pairs={m.priceFail.pairs} mono={(k) => k === 'status'} /></> : null}
      {body}
      {m.disk ? <p className="ovsub">{m.disk.text} · <a href={m.disk.href}>{W.SEE_STORAGE}</a></p> : null}
    </section>
  )
}

export function RecentCard({ m, onRetry }: { m: RecentModel, onRetry: Retry }) {
  if (m.kind === 'reading') return <Reading cls="recent" title={W.CARD.recent} />
  if (m.kind === 'failed') return <Failed what="Session list" fail={m.fail} group="sessions" onRetry={onRetry} />
  if (m.kind === 'none') return null // no session at all is the first-use page
  return (
    <section className="ovcard recent" aria-label={W.CARD.recent}>
      <h2 className="ovh">{W.CARD.recent}</h2>
      <div className="ovlist">{m.rows.map((r) => (
        <a className="ovitem" key={r.id} href={r.href}>
          <HarnessIcon id={r.harness} />
          <span className="ovnm">{harnessName(r.harness)}{r.inferred ? <> <span className="ovmark" title="agent inferred from the request headers">(inferred)</span></> : null}</span>
          <span className="ovtx" title={r.titleTip}>{r.title}</span>
          <span className="ovnum">{r.calls.tip ? <span title={r.calls.tip}>{r.calls.text}</span> : r.calls.text}</span>
          <span className="ovwhen">{r.when}</span>
        </a>
      ))}</div>
      <p className="ovgo"><a href="#/sessions">{W.ALL_SESSIONS}</a></p>
    </section>
  )
}

// first use (1.7 §首次使用): the start card, and the agents zone of one row per agent with its one control
export function StartCard({ m }: { m: ReturnType<typeof startCard> }) {
  return (
    <section className="ovcard start" aria-label={W.CARD.start}>
      <h2 className="ovh">{W.CARD.start}</h2>
      {m.rows.map(([k, v]) => <p className="ovsay" key={k}><b>{k}</b>{v}</p>)}
      {m.install ? <Tech pairs={[['install command', m.install]]} mono={all} /> : null}
    </section>
  )
}

export function AgentsCard({ rows, onDone }: { rows: AgentRowM[], onDone: (out: unknown) => void }) {
  if (!rows.length) return null
  return (
    <section className="ovcard agents" aria-label={W.CARD.agents}>
      <h2 className="ovh">{W.CARD.agents}</h2>
      {rows.map((r) => (
        <div className="ovitem ovagent" key={r.id} data-h={r.harness}>
          <Chip id={r.harness} />
          <span className="ovtx">{(SWITCH_WORD as Record<string, string>)[r.desired] || ''}</span>
          <HarnessSwitch model={r.control} name={harnessName(r.harness)} onDone={onDone} />
          {r.commands ? <Tech pairs={r.commands} mono={all} /> : null}
        </div>
      ))}
    </section>
  )
}
