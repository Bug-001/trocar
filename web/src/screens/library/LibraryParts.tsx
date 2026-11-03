// screens/library/LibraryParts.tsx — what the session library draws (1.8 §一行 · §说明行 · §空、载入、读不出): one row (memoized on
// the session object, its highlight and the answer's time, so a poll that changes nothing re-renders nothing), the virtual list's rows
// keyed by the entry key (never the index), the caption row and the states that stand in for the table. All words are labels/library.mjs's;
// the data is model.mjs's.
import { memo, type MouseEvent, type ReactNode } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { fmtStamp, fmtTime, relTime } from '../../../legacy/core/fmt.mjs'
import { formatHash } from '../../../legacy/core/router.mjs'
import { readFailure } from '../../../legacy/core/ui.mjs'
import * as W from '../../../legacy/labels/library.mjs'
import { HALF } from '../../../legacy/core/icons.mjs'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { Svg } from '../../ui/Svg'
import { TechDetails, type TechValue } from '../../ui/TechDetails'
import { rowModel, dayHead, captionFacts as captionFactsJs, emptyBoardState, filteredAgentLine } from './model.mjs'
import type { Failed, Session, SessionsData } from './useSessions'

export type Entry = { key: string, g?: string, s?: Session }
type Pairs = Array<[string, TechValue]>
type Fact = { kind: 'not-all', n: number } | { kind: 'stored', at: string }
const captionFacts = captionFactsJs as (errors: unknown, stored: string | null) => { facts: Fact[], tech: string[] }
const STORAGE = formatHash({ area: 'settings', screen: 'settings-storage' })
const CAPTURE = formatHash({ area: 'capture', screen: 'capture', params: {} })
const pairsCopy = (p: Pairs) => p.map(([k, v]) => `${k}: ${'text' in v ? v.text : ''}`).join('\n')
const Tech = ({ pairs }: { pairs: Pairs }) => <TechDetails pairs={pairs} copy={pairsCopy(pairs)} />
export const failPairs = (r: Failed): Pairs => [
  ...(typeof r.status === 'number' ? [['status', { text: String(r.status) }] as [string, TechValue]] : []),
  ['error', { text: r.error == null || r.error === '' ? '—' : String(r.error) }],
]

// a plain click opens the replay here; a modified one (cmd / ctrl / shift / alt, another button) is left to the browser, and a click
// that ended a drag-select never arrives (core/ui.mjs installUi stops it)
const plain = (e: MouseEvent) => !(e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)

export const Row = memo(function Row({ s, on, now, onOpen }: { s: Session, on: boolean, now: number, onOpen: (s: Session) => void }) {
  const m = rowModel(s, now)
  return (
    <a className={`lrow${on ? ' sel' : ''}${m.dim ? ' dim' : ''}`} href={m.href} data-key={m.key} aria-current={on ? 'true' : undefined}
      onClick={(e) => { if (!plain(e)) return; e.preventDefault(); onOpen(s) }}>
      <span className="lagent">
        <HarnessIcon id={m.harnessId as string} />
        <span className="lhn" title={m.harnessRaw ? `${m.harnessName} · ${m.harnessRaw}` : m.harnessName}>{m.harnessName}</span>
      </span>
      <span className="lmain">
        <span className="lt" title={m.titleTip}>{m.titleText}</span>
        <span className="lsub" title={m.subTip}>{m.marks.map((k) => k.kind === 'inferred'
          ? <span key={k.kind} className="lmark" data-mark={k.kind}><span className="mk mk-inf" title={k.tip}>{k.text}</span></span>
          : <span key={k.kind} className="lmark" data-mark={k.kind} title={k.tip || undefined}>{k.text}</span>)}</span>
      </span>
      <span className="ln" data-mark={m.dim ? 'probe-only' : undefined} title={m.dim ? W.PROBE_ONLY_TIP : W.COL_CALLS}>{m.dim ? W.PROBE_ONLY : m.calls}</span>
      <span className="lw" title={m.whenTip}>{m.when}</span>
    </a>
  )
})

const DayHead = ({ g, now }: { g: string, now: number }) => {
  const h = dayHead(g, now)
  return <div className="lgroup"><span className="lday">{h.word}</span>{h.date ? <span className="ldate">{h.date}</span> : null}</div>
}

export function VRows({ v, entries, sel, now, onOpen }:
  { v: Virtualizer<HTMLDivElement, Element>, entries: Entry[], sel: string | null, now: number, onOpen: (s: Session) => void }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: v.getTotalSize() }}>
      {v.getVirtualItems().map((it) => {
        const e = entries[it.index]
        if (!e) return null
        return (
          <div key={it.key as string} className="vrow" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: it.size, transform: `translateY(${it.start}px)` }}>
            {e.s ? <Row s={e.s} on={e.key === sel} now={now} onOpen={onOpen} /> : <DayHead g={e.g!} now={now} />}
          </div>
        )
      })}
    </div>
  )
}

// the caption row: only what changes how far the list can be trusted; bookkeeping rides in 技术细节. A failed read with an older list
// on screen says so here; without one the failure replaces the table (ReadFailState), so nothing is drawn twice.
export function Caption({ data, err, listAt, now, onRetry }:
  { data: SessionsData | null, err: Failed | null, listAt: number, now: number, onRetry: () => void }) {
  if (err && !data) return null
  const cf = captionFacts(data?.errors, data?.stored ?? null)
  const parts: ReactNode[] = cf.facts.map((x) => x.kind === 'stored'
    ? <span key="stored" data-stored={x.at} title={fmtStamp(x.at)}>{W.capStored(relTime(x.at, now))}</span>
    : <a key="not-all" href={STORAGE} title={W.CAP_NOT_ALL_TIP}><Svg html={HALF} />{`${W.capNotAllRead(x.n)} ›`}</a>)
  if (err) parts.push(<span key="fail">{`${readFailure(W.SESSION_LIST, err).line} · `}
    <button type="button" className="linkbtn" onClick={onRetry}>{W.RETRY}</button>{` · ${W.capOldList(fmtTime(listAt))}`}</span>)
  const tech: Pairs = [...cf.tech.map((t, i) => [String(i + 1), { text: t }] as [string, TechValue]), ...(err ? failPairs(err) : [])]
  if (!parts.length && !tech.length) return null
  return (
    <div className="libcap" id="libcap">
      {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} className="capsep" aria-hidden="true">·</span>, p] : [p]))}
      {tech.length ? <Tech pairs={tech} /> : null}
    </div>
  )
}

// ── the states that stand in for the table ───────────────────────────────────────────────────────────────────────────
type Shot = Parameters<typeof emptyBoardState>[0]
const asOf = (t: number | null | undefined) => (t != null ? ` · ${W.AS_OF} ${fmtTime(t)}` : '')
const Empty = ({ children }: { children: ReactNode }) => <div className="libempty">{children}</div>

export const LoadingState = () => <Empty>{W.LOADING}</Empty>

// the read failed and there is no older list: the failure IS the content, never worded as 「还没有会话」
export const ReadFailState = ({ err, onRetry }: { err: Failed, onRetry: () => void }) => (
  <Empty>{readFailure(W.SESSION_LIST, err).line}<br />
    <button type="button" className="linkbtn" onClick={onRetry}>{W.RETRY}</button><Tech pairs={failPairs(err)} /></Empty>
)

// the empty board: 还没有会话, then the capture service's own sentence (read once) with 「截至」, then the way out
export function NoSessionsState({ shot }: { shot: Shot }) {
  const c = emptyBoardState(shot)
  return (
    <Empty>{W.NO_SESSIONS}<br />
      <span className="dimline">{c.line ? c.line + asOf(c.asOf) : ''}</span> <a href={CAPTURE}>{`${W.GO_CAPTURE} ›`}</a>
      {c.tech ? <Tech pairs={c.tech.map(([k, v]) => [k, { text: v }] as [string, TechValue])} /> : null}
    </Empty>
  )
}

// filters emptied a non-empty board; with exactly one agent picked, the line asks whether it is even captured
export function FilteredState({ shot, h, onClear }: { shot: Shot, h: string[], onClear: () => void }) {
  const a = h.length === 1 ? filteredAgentLine(shot, h[0]) : null
  return (
    <Empty>
      {a && a.service ? <><span className="dimline">{a.line + asOf(a.asOf)}</span><br /></> : null}
      {a && !a.service ? <><span className="dimline">{`${a.line} · `}<a href={a.href}>{`${W.GO_CAPTURE} ›`}</a></span><br /></> : null}
      {W.FILTERED_EMPTY}<br />
      <button type="button" className="linkbtn" onClick={onClear}>{W.CLEAR_FILTERS}</button>
    </Empty>
  )
}
