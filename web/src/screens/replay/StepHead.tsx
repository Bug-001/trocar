// web/src/screens/replay/StepHead.tsx — the step head (2.2 §步头) in the new desk: it renders stepHeadModel (models.mjs), recomputed on
// each `step`, `rough` and `empty` paint (the model reads the state: an emptied desk has none, a rough page has its label, a drawn
// step its head). One row: ‹ [N / M over model · time] › · ◐ · Compare ▾ · three read-outs (Context / Cache / Estimate), each an
// InfoButton whose face is two lines, the name over the value; their rows are worked out when the layer opens. The rough page's
// head reports itself drawn (view.roughDrawn) in a layout effect; it marks nothing itself.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { kf } from '../../../legacy/core/fmt.mjs'
import { mark } from '../../../legacy/core/ui.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { Chev } from '../../ui/Chev'
import { InfoButton } from '../../ui/InfoButton'
import { stepHeadModel } from './models.mjs'
import { useDeskVersion } from './useDesk'
import type { DeskState, DeskView } from './view'

type Drawn = Extract<NonNullable<ReturnType<typeof stepHeadModel>>, { rough: false }>
type Row = { key: string, text?: string, [k: string]: any }
const html = (h: string) => ({ __html: h })
// a read-out's value line: the model's label without the name it may lead with (the face already says the name above it)
const valueOf = (word: string, label: string) => (label.toLowerCase().startsWith(word.toLowerCase()) ? label.slice(word.length).trim() : label)

export function StepHead({ desk }: { desk: DeskView }) {
  const vs = useDeskVersion(desk, 'step'), vr = useDeskVersion(desk, 'rough'), ve = useDeskVersion(desk, 'empty')
  const m = useMemo(() => { void vs; void vr; void ve; return stepHeadModel(desk.s) }, [desk, vs, vr, ve])
  // the rough page's step head is drawn (or has nothing to draw: a tier-0 head) once a rough paint lands and no step is drawn
  useLayoutEffect(() => { if (vr > 0 && (!m || m.rough)) desk.roughDrawn('step') }, [desk, vr, m])
  if (!m) return <div id="stepbar" />
  if (m.rough) {
    return <div id="stepbar"><span className="sb-nav"><b className="sb-at" data-n={m.n} data-m={m.m} title={m.label}><No n={m.n} m={m.m} /></b></span></div>
  }
  return <Drawn m={m} s={desk.s} />
}

const No = ({ n, m }: { n: number, m: number }) => <><span className="sb-n">{n}</span> <span className="sb-m">/ {m}</span></>

function Drawn({ m, s }: { m: Drawn, s: DeskState }) {
  const no = (m.n ?? m.k)!
  const go = (d: number) => s.setPlayhead(s.playhead + d, true)
  return (
    <div id="stepbar">
      <span className="sb-nav">
        <button type="button" className="sbbtn" data-step="prev" aria-label={W.STEP_PREV} title={W.STEP_PREV} onClick={() => go(-1)}>‹</button>
        <span className="sb-id">
          <span className="sb-line">
            {m.laneWord && <span className="sb-lane">{m.laneWord} ·</span>}
            <b className="sb-no" data-n={no} title={m.label}><No n={no} m={m.m} /></b>
          </span>
          <span className="sb-meta">
            <span className="sb-model" title={m.model ?? undefined} style={{ '--mn': Math.min(8, (m.model || '—').length) } as CSSProperties}>{m.model || '—'}</span>
            <span className="sb-sep">·</span>
            <span className="sb-time" title={m.ts ?? undefined}>{m.time}</span>
          </span>
        </span>
        <button type="button" className="sbbtn" data-step="next" aria-label={W.STEP_NEXT} title={W.STEP_NEXT} onClick={() => go(1)}>›</button>
      </span>
      {m.half && <span className="sb-fid" dangerouslySetInnerHTML={html(mark('part', m.half.tip ?? undefined))} />}
      {m.compare && <Compare c={m.compare} n={no} s={s} />}
      <span className="sb-reads">
        <InfoButton className="sb-ro" label={W.COMP_POPOVER_LABEL} title={W.COMP_TITLE} body={<CompBody m={m} />}
          trigger={<Face word={m.ctx.word} value={m.ctx.value == null ? '—' : kf(m.ctx.value)} comp={m.ctx.comp} />} />
        <InfoButton className="sb-ro" label={W.CACHE_POPOVER_LABEL} title={W.CACHE_TITLE} body={<CacheBody m={m} s={s} />}
          trigger={<Face word={m.cache.word} value={valueOf(m.cache.word, m.cache.label)} />} />
        <InfoButton className="sb-ro" label={W.COST_POPOVER_LABEL} title={W.COST_TITLE} body={<Rows rows={m.costRows() as Row[]} />}
          trigger={<Face word={m.cost.word} value={m.cost.label} />} />
      </span>
    </div>
  )
}

// a read-out's face: the name, then the value (and, for the context, a 44 × 8 composition bar in CT_ORDER, an estimate)
function Face({ word, value, comp }: { word: string, value: string, comp?: Array<[string, number]> | null }) {
  return <>
    <span className="ro-name">{word}</span>
    <span className="ro-val">{value}{comp && <span className="ro-bar" aria-hidden="true">{comp.map(([k, f]) => <span key={k} className={`ct-${k}`} style={{ flexGrow: f }} />)}</span>}</span>
  </>
}

const Busy = () => <div className="pp-busy" aria-busy="true" />
// a popover's rows: one line each, in the model's order; a row whose lane is not held is a sized empty line, no words
function Rows({ rows, extra }: { rows: Row[], extra?: (r: Row) => ReactNode }) {
  return <>{rows.map((r) => (r.busy ? <Busy key={r.key} /> : (
    <div key={r.key} className={`pp-row pp-${r.key}`}>
      {extra?.(r) ?? (r.href ? <a href={r.href}>{r.text}</a> : r.text)}
    </div>
  )))}</>
}

// the layer's body is rendered only while it is open, so the rows are worked out then (compRows: 'busy' while the lane is not held)
function CompBody({ m }: { m: Drawn }) {
  const rows = m.compRows() as Row[] | 'busy'
  if (rows === 'busy') return <Busy />
  return <Rows rows={rows} extra={(r) => (r.key === 'segs'
    ? r.items.map((x: Row, i: number) => <span key={x.key}>{i > 0 && ' · '}<span className="ppseg" title={x.tip}>{x.text}</span></span>)
    : undefined)} />
}

function CacheBody({ m, s }: { m: Drawn, s: DeskState }) {
  return <Rows rows={m.cacheRows() as Row[]} extra={(r) => {
    if (r.key === 'sentence') return <>{r.text}{r.struct && <> <span dangerouslySetInnerHTML={html(mark('struct', r.structTip))} /></>}</>
    if (r.key === 'usage') return <>{r.items.map((x: Row, i: number) => <span key={x.key}>{i > 0 && ' · '}{x.word} <span title={x.tip ?? undefined}>{x.text}</span></span>)} {r.unit}</>
    if (r.key === 'jump') return <button type="button" className="jumpbtn" onClick={() => s.queueJump({ kind: 'anchor', id: 'cachebrk' })}>{r.text}</button>
    return undefined
  }} />
}

// 对比 (2.2 §「对比」按钮): a menu button (click / Enter / Space / ↓, never hover). The default item, or 「pick a step…」, which opens a
// small dialog with the step-number field; the choice calls s.setDiff, × goes back to the default
function Compare({ c, n, s }: { c: NonNullable<Drawn['compare']>, n: number, s: DeskState }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [host, setHost] = useState<HTMLSpanElement | null>(null) // the layers sit inside the step head, as InfoButton's do
  const [pick, setPick] = useState(false)
  const [bad, setBad] = useState<string | null>(null)
  const def = c.cacheRefK != null && c.cacheRefK !== n - 1 ? W.compareDefaultAt(c.cacheRefK) : W.COMPARE_DEFAULT
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const v = parseInt(String(new FormData(e.currentTarget).get('step')), 10)
    const base = (s.anchor && s.anchor.base) || 0, M = s.anchor ? s.anchor.calls.length + base : 0 // step numbers count the rows not held yet
    if (Number.isFinite(v) && v > base && v <= M && v - 1 - base !== s.playhead) { setPick(false); setBad(null); s.setDiff(v - 1 - base) }
    else setBad(W.COMPARE_RANGE(M))
  }
  return (
    <span className="sb-cmp">
      <MenuTrigger>
        <Button ref={btn} className="popbtn sb-cmpbtn">{c.sel != null ? W.compareAt(c.sel).replace(/\s*×$/, '') : W.COMPARE} <Chev /></Button>
        <Popover className="pop menu" placement="bottom start" UNSTABLE_portalContainer={host ?? undefined}>
          <Menu aria-label={W.COMPARE} onAction={(k) => { if (k === 'pick') setPick(true); else s.setDiff(null) }}>
            <MenuItem id="default">{def}</MenuItem>
            <MenuItem id="pick">{W.COMPARE_PICK}</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      {c.sel != null && <button type="button" className="cmpx" aria-label={W.CMP_RESET} title={W.CMP_RESET} onClick={() => s.setDiff(null)}>×</button>}
      <span ref={setHost} />
      <Popover triggerRef={btn} isOpen={pick && host != null} UNSTABLE_portalContainer={host ?? undefined} onOpenChange={(o) => { setPick(o); if (!o) setBad(null) }} className="pop" placement="bottom start">
        <Dialog aria-label={W.COMPARE_PICK} className="cmpick">
          <form onSubmit={submit}>
            <label>{W.COMPARE_WITH} <input type="number" name="step" min={1} max={c.M} step={1} autoFocus aria-invalid={bad ? true : undefined} title={bad ?? undefined} /> {W.COMPARE_WITH2}</label>
            {' '}<Button type="submit">{W.COMPARE_OK}</Button>
          </form>
        </Dialog>
      </Popover>
    </span>
  )
}
