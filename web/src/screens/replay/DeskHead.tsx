// web/src/screens/replay/DeskHead.tsx — the session head (1.2 §会话头 · §会话保真行 · §信息弹出层) in the new desk: it renders
// sessionHeadModel (models.mjs), read on each `head` paint. One row (back · title · chip · project · start · entry · follow · ⓘ), then
// the read-state line (words only, never a control), the fidelity row (only when a fact exists) and the not-refreshed line. The ⓘ's
// rows are worked out when it opens (model.info(), 2.3 归约前沿). The head carries no statistic: every number is behind the ⓘ.
import { Fragment } from 'react'
import { fmtWhen, usd } from '../../../legacy/core/fmt.mjs'
import { mark, readFailure } from '../../../legacy/core/ui.mjs'
import { INFERRED_TIP, SYNTHESIZED, SYNTHESIZED_TIP } from '../../../legacy/labels/library.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { CopyButton } from '../../ui/CopyButton'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { InfoButton } from '../../ui/InfoButton'
import { TechDetails } from '../../ui/TechDetails'
import { sessionHeadModel } from './models.mjs'
import { useDeskModel } from './useDesk'
import type { DeskState, DeskView } from './view'

type Head = NonNullable<ReturnType<typeof sessionHeadModel>>
const headOf = (s: DeskState) => sessionHeadModel(s, { libraryHash: s.ctx && s.ctx.store ? s.ctx.store.get().libraryHash : '' })
const html = (h: string) => ({ __html: h })
const pairsOf = (tech: string[][]) => tech.map(([k, v]) => [k, { text: v }] as [string, { text: string }])
const copyOf = (tech: string[][]) => tech.map(([k, v]) => `${k}: ${v}`).join('\n')

export function DeskHead({ desk }: { desk: DeskView }) {
  const m = useDeskModel(desk, 'head', headOf)
  if (!m) return <div id="deskhead" />
  return (
    <div id="deskhead">
      <Row m={m} s={desk.s} />
      {m.read && <ReadState read={m.read as any} />}
      {m.facts.items.length > 0 && <Facts facts={m.facts} />}
      {m.stale && <Stale stale={m.stale} s={desk.s} />}
    </div>
  )
}

function Row({ m, s }: { m: Head, s: DeskState }) {
  const c = m.chip as any, t = m.title
  return (
    <div className="sesshead">
      <a className="sh-back" href={m.back.href}>{m.back.text}</a>
      <span className="sh-name" title={`${t.sourceTip}\n${W.SESSION_ID} ${t.id}`}>{t.text ?? t.fallback}</span>
      <a className="sh-chip" href={c.href} title={c.name}>
        <HarnessIcon id={c.key} />
        <span className="chipname" title={c.raw || undefined}>{c.name}</span>
        {c.inferred && <span dangerouslySetInnerHTML={html(mark('inf', INFERRED_TIP))} />}
        {c.synthesized && <span className="chipsyn" title={SYNTHESIZED_TIP}>{SYNTHESIZED}</span>}
      </a>
      {c.multi && <span className="sh-multi" title={c.multi.tip}>{c.multi.text}{c.multi.inferred ? ` ${W.GUESS}` : ''}</span>}
      {m.project && <span className="sh-proj" title={m.project.path}>{m.project.word} {m.project.name}</span>}
      {m.start && <time className="sh-start" dateTime={m.start.ts} title={m.start.tip}>{m.start.text}</time>}
      {m.entry && <span className="sh-entry" title={m.entry.tip}>{m.entry.text}</span>}
      <span className="spacer" />
      <button type="button" className={m.follow.on ? 'sh-follow on' : 'sh-follow'} aria-pressed={m.follow.on}
        data-state={m.follow.paused ? 'paused' : undefined} title={m.follow.tip ?? undefined}
        onClick={() => { if (m.follow.on) s.followOff(); else s.followOn() }}>{m.follow.text}</button>
      <span className="sh-info"><InfoButton label={W.SESSION_INFO_LABEL} title={W.SESSION_INFO_LABEL} body={<Info m={m} s={s} />} /></span>
    </div>
  )
}

// 1.2 §会话头 读取状态 · 1.5 K-31 / K-32: one quiet line of words; a stopped fold's code and reason only in the technical details
function ReadState({ read }: { read: { state: string, text: string, n?: number, code?: string | null, reason?: string | null } }) {
  const tech = read.state === 'stopped' ? [[String(read.code ?? ''), String(read.reason ?? '')]] : null
  return <>
    <div className="fidline readstate" data-read-state={read.state} data-behind={read.state === 'behind' ? read.n : undefined}>{read.text}</div>
    {tech && <TechDetails pairs={pairsOf(tech)} copy={copyOf(tech)} />}
  </>
}

// 1.2 §会话保真行: each fact in plain words, · between them; raw values only in the technical details
function Facts({ facts }: { facts: Head['facts'] }) {
  return <>
    <div className="fidline">{facts.items.map((f, i) => (
      <Fragment key={f.kind}>
        {i > 0 && <span className="fidsep">·</span>}
        {f.href ? <a href={f.href} data-fact={f.kind}>{f.text}</a> : <span data-fact={f.kind}>{f.text}</span>}
      </Fragment>
    ))}</div>
    {facts.tech.length > 0 && <TechDetails pairs={pairsOf(facts.tech)} copy={copyOf(facts.tech)} />}
  </>
}

// 1.5 K-29: the last good answer stays; one quiet line says since when it is not refreshed and why, and offers to read again now
function Stale({ stale, s }: { stale: NonNullable<Head['stale']>, s: DeskState }) {
  const f = readFailure(W.THIS_SESSION, stale.r)
  return <>
    <div className="fidline fidstale">{W.notRefreshed(fmtWhen(stale.since), f.line)}<span className="fidsep">·</span>
      <button type="button" className="linkbtn" onClick={() => s.poll?.()}>{W.RETRY}</button></div>
    <div dangerouslySetInnerHTML={html(f.tech)} />
  </>
}

// the ⓘ's body: rendered only while the layer is open, so info() walks the lanes then and not per answer
function Info({ m, s }: { m: Head, s: DeskState }) {
  const rows = m.info() as any[]
  const jump = (j: any) => {
    if (j.lane == null) { s.setPlayhead(j.i, true); return }
    const lane = (s.lanes || []).find((l: any) => l.id === j.lane)
    if (s.anchor && s.anchor.id === j.lane) s.setPlayhead(j.i, true)
    else if (lane) s.openDetail(lane, j.i)
  }
  return <div className="sipb">{rows.map((r) => (
    <div key={r.key} className={r.key === 'truncated' ? 'sir trunc' : r.narrow ? 'sir sir-narrow' : 'sir'} data-row={r.key}>
      {r.key === 'failed' && r.jump ? <button type="button" className="sijump" onClick={() => jump(r.jump)}>{r.text}</button>
        : r.key === 'id' ? <>{r.text} <span className="sirmono">{r.id}</span> <CopyButton text={r.id} label={r.copy} /></> : r.text}
      {r.buckets && <span className="sirsub">{r.buckets.map((b: any) => `${b.word} ${b.usd != null ? usd(b.usd) : '—'}`).join(' · ')}</span>}
      {(r.notes || []).map((n: string) => <span key={n} className="sirsub">{n}</span>)}
      {r.prices && <a href={r.prices.href}>{r.prices.text}</a>}
      {r.key !== 'failed' && r.jump && <button type="button" className="sijump" onClick={() => jump(r.jump)}>{r.jump.text}</button>}
    </div>
  ))}</div>
}
