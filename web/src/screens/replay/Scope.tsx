// web/src/screens/replay/Scope.tsx — the scope (1.3) in the new desk, drawn from models.mjs : scopeModel(s, K). Top to bottom (1.3 §排布):
// the legend row · the chapter row (a header on the bars' grid, not a track: replay.css .chaprow) · the axis with the playhead's step tag · the problem lane · the main track · the cache trace · the
// prompts lane · #rails (rails.mjs draws it; React renders it empty and never touches what is inside) · the whole-session overview and its
// brush. Every track is a .tkrow (.tgut + .tlane) on one --gut; one --cursor line runs through the detail rows.
// What changes on a step move is only what the playhead touches: bars, trace cells and problem marks are memoized and keyed by the row's
// rid (D75④), so a move re-renders the two bars whose .cur flips and the cursor. The bars row's grid column reports the lane's capacity
// (view.setCapacity); the rough page reports itself drawn (view.roughDrawn). The brush is a port of timeline.mjs : wireTimeline.
import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { SKELETON, laneCapacity } from '../../../legacy/replay/replay.mjs'
import { BAR_KEYS, chapterHere, problemJump } from '../../../legacy/replay/timeline.mjs'
import { L } from '../../../legacy/core/labels.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { scopeModel } from './models.mjs'
import { useDeskVersion } from './useDesk'
import type { Area, DeskState, DeskView } from './view'

type Bar = { rid?: string, i: number, col: number, h: number, segs: Array<[string, number]> | null, hatched: boolean, fail: boolean, compact: boolean, cur: boolean, reviewed: boolean, tip: string }
type Cell = { rid: string, col: number, state: string, tip: string }
type Item = { rid: string, i: number, col: number, kind: 'flag' | 'x' | 'compact', h: number | null, tip: string, aria: string }
type Mark = { x: number, v: number, failed: boolean }

const BAR_PX = 80, FLAG_PX = 14 // the main track's tallest bar; the tallest flag (h ∝ √ ≈ extra cost)
const READS: Area[] = ['saw', 'overview', 'cur', 'problems', 'review', 'rough', 'empty'] // the areas the scope draws
const BACKDROP: Area[] = ['overview', 'rough', 'empty'] // the paints that rebuild the overview's backdrop (the brush moves on any)
// the controller's state is plain JS the renderers share: a gesture writes its flags through here, not on a value React tracks
const put = (s: DeskState, k: string, v: unknown) => { s[k] = v }
const pct = (f: number) => `${(f * 100).toFixed(3)}%`

// the row names the legacy skeleton carries and the labels do not (one source until the legacy desk retires)
let words: { ctx: string, ovw: string, ovwTip: string, cacheTip: string } | null = null
function skel() {
  if (words) return words
  const t = document.createElement('template')
  t.innerHTML = SKELETON
  const g = t.content.querySelector('.tkrow-ovw .tgut')!, c = t.content.querySelector('.cachelegend')!
  return (words = { ctx: t.content.querySelector('#sawgut')!.textContent!, ovw: g.textContent!, ovwTip: g.getAttribute('title') || '', cacheTip: c.getAttribute('title') || '' })
}

// the playhead's step tag on the axis: the step's own global number (1.2 §编号)
function tagOf(s: DeskState, m: any) {
  const b = m.cursor.col != null ? m.bars[m.cursor.col] : null
  if (!b) return null
  if (m.rough) return W.axisNo(true, b.i + 1)
  const a = s.anchor
  return W.axisNo(a.kind === 'main', (a.no ? a.no(b.i) : b.i) + 1)
}

// a named step on its way to a desk that drew (a chapter jump, Home): its chapter's bars come from the head until it lands
// (replay.mjs namedRows; landing clears initialStep)
const named = (s: DeskState) => s.initialStep != null && s.playRid != null && !!s.desk?.head?.tier && !!s.desk.head.steps

function useScope(desk: DeskView) {
  const key = useSyncExternalStore(desk.subscribe, () => READS.map((a) => desk.version(a)).join('.'))
  const ov = useSyncExternalStore(desk.subscribe, () => BACKDROP.map((a) => desk.version(a)).join('.'))
  const K = desk.capacity()
  const m = useMemo(() => {
    void key // the paint the model is computed for
    const st = named(desk.s) ? { ...desk.s, playRid: null } : desk.s
    const m: any = scopeModel(st, K) // the model's JSDoc shapes; the fields read below are its own
    return m && { ...m, tag: tagOf(st, m) }
  }, [desk, key, K])
  return { m, ov }
}

const sameSegs = (a: Bar['segs'], b: Bar['segs']) => a === b || (!!a && !!b && a.length === b.length && a.every((x, j) => x[0] === b[j][0] && x[1] === b[j][1]))
const sameBar = (p: { b: Bar, cost: boolean, rough: boolean }, n: { b: Bar, cost: boolean, rough: boolean }) => p.cost === n.cost && p.rough === n.rough &&
  (['i', 'h', 'hatched', 'fail', 'compact', 'cur', 'reviewed', 'tip'] as const).every((k) => p.b[k] === n.b[k]) && sameSegs(p.b.segs, n.b.segs)

const BarView = memo(function BarView({ b, cost, rough }: { b: Bar, cost: boolean, rough: boolean }) {
  const H = b.h * BAR_PX // a hatched cost bar is 0 high: its stripe says the estimate cannot be made
  const cls = ['bar', cost && 'cost', b.fail && 'err', b.compact && 'compact', b.cur && 'cur', b.reviewed && 'reviewed'].filter(Boolean).join(' ')
  const at = rough ? { 'data-step': b.i } : { 'data-i': b.i }
  return <div className={cls} {...at} style={{ height: `${H.toFixed(2)}px` }} title={b.tip}>
    {b.fail ? null : b.hatched ? <span className="ct-unloaded" style={{ height: `${Math.max(6, H).toFixed(2)}px` }} />
      : cost || !b.segs ? null : b.segs.map(([k, f]) => f * H < 0.4 ? null : <span key={k} className={`ct-${k}`} style={{ height: `${(f * H).toFixed(2)}px` }} />)}
  </div>
}, sameBar)

const TraceCell = memo(function TraceCell({ c, i }: { c: Cell, i: number }) {
  return <div className={`cbar ${c.state}`} data-i={i} role="img" title={c.tip} aria-label={c.tip} />
}, (p, n) => p.i === n.i && p.c.state === n.c.state && p.c.tip === n.c.tip)

// the cache trace as one path per line style: a tier is a level, no usage a dashed middle line, uncertain its own style, failed a gap
const LEVEL: Record<string, number> = { high: 2, mid: 5, low: 8, none: 5, unk: 5 }
function tracePaths(cells: Cell[]) {
  const d: Record<'tier' | 'none' | 'unk', string> = { tier: '', none: '', unk: '' }
  let prev: string | null = null
  cells.forEach((c, x) => {
    const k = c.state === 'fail' ? null : c.state === 'none' || c.state === 'unk' ? c.state : 'tier'
    if (k) d[k as 'tier'] += `${k === 'tier' && prev === 'tier' ? 'V' : `M${x} `}${LEVEL[c.state]}H${x + 1}`
    prev = k
  })
  return d
}

const ProblemMark = memo(function ProblemMark({ p }: { p: Item }) {
  if (p.kind === 'x') return <button type="button" className="pxmark" data-i={p.i} title={p.tip} aria-label={p.aria}>×</button>
  if (p.kind === 'compact') return <button type="button" className={`pcompact${p.tip.startsWith(`${W.COMPACT_WORD} · `) ? ' inf' : ''}`} data-i={p.i} title={p.tip} aria-label={p.aria} />
  return <button type="button" className="pflag" data-i={p.i} style={{ height: `${Math.max(4, Math.round((p.h ?? 0) * FLAG_PX))}px` }} title={p.tip} aria-label={p.aria} />
}, (p, n) => p.p.i === n.p.i && p.p.kind === n.p.kind && p.p.h === n.p.h && p.p.tip === n.p.tip)

// rebuilt only when `k` changes: on the paints in BACKDROP, never during a drag (k = '' then)
const Backdrop = memo(function Backdrop({ ov }: { ov: { mode: string, marks: Mark[] }, k: string }) {
  if (ov.mode === 'bars') return <div className="ovbars">{ov.marks.map((k, i) => <div key={i} className={`ovbar${k.failed ? ' err' : ''}`} style={{ height: `${Math.max(1, Math.round(k.v * 20))}px` }} />)}</div>
  return <svg className="ovsvg" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
    <polyline points={ov.marks.map((k) => `${(k.x * 100).toFixed(2)},${(22 - Math.max(0.5, k.v * 20)).toFixed(2)}`).join(' ')} />
  </svg>
}, (p, n) => p.k === n.k)

export function Scope({ desk }: { desk: DeskView }) {
  const el = useRef<HTMLDivElement>(null)
  const { m, ov } = useScope(desk)
  const s = desk.s
  const vRough = useDeskVersion(desk, 'rough')
  const [drag, setDrag] = useState(false)
  const g = useRef({ mode: '', x: 0, lo: 0, hi: 0 })

  // the lane's capacity: measured on the bars row's grid column, on mount and on every resize
  useLayoutEffect(() => {
    const saw = el.current!
    const fit = () => desk.setCapacity(laneCapacity(saw))
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    ro?.observe(saw.querySelector('#sawrow')!.closest('.tkrow')!)
    return () => ro?.disconnect()
  }, [desk])
  useLayoutEffect(() => { if (vRough) desk.roughDrawn('scope') }, [desk, vRough])
  // the step tag sits over the axis: an end label it would be drawn on is hidden while it is there
  useLayoutEffect(() => {
    const saw = el.current!, tag = saw.querySelector('.axtag'), r = tag?.getBoundingClientRect()
    for (const id of ['#sawstart', '#sawend']) {
      const e = saw.querySelector<HTMLElement>(id)!, q = e.getBoundingClientRect()
      e.toggleAttribute('data-covered', !!r && r.width > 0 && q.width > 0 && r.left < q.right + 4 && q.left < r.right + 4)
    }
  }, [m])

  const cost = s.sawView === 'cost', rough = !!m?.rough, bars: Bar[] = m ? m.bars : [], n = Math.max(1, bars.length)
  const keyAt = (col: number) => bars[col]?.rid ?? `s${bars[col]?.i}`
  const f = m && m.cursor.col != null ? (m.cursor.col + 0.5) / n : null

  // the brush (1.3 §overview+detail): drag the body = pan inside the playhead's chapter, drag a grip = zoom, double-click = all
  const N = () => (s.anchor ? s.anchor.calls.length : 1)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    const t = e.target as Element, mode = t.classList.contains('ovh-l') ? 'l' : t.classList.contains('ovh-r') ? 'r' : t.closest('.ovbrush') ? 'pan' : ''
    if (!mode || !s.anchor) return
    g.current = { mode, x: e.clientX, lo: s.view.lo, hi: s.view.hi }
    put(s, 'brushDragging', true); setDrag(true)
    try { t.setPointerCapture(e.pointerId) } catch { /* no capture: the drag still works while the pointer stays over the strip */ }
    e.stopPropagation(); e.preventDefault()
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const { mode, x, lo, hi } = g.current
    if (!mode) return
    const d = Math.round(((e.clientX - x) / Math.max(1, e.currentTarget.getBoundingClientRect().width)) * N())
    if (mode === 'pan') { const { c0, c1 } = chapterHere(s), dd = Math.max(c0 - lo, Math.min(c1 - hi, d)); s.setView(lo + dd, hi + dd, false) } // never across a chapter's edge
    else if (mode === 'l') s.setView(Math.min(hi - 1, lo + d), hi, false)
    else s.setView(lo, Math.max(lo + 1, hi + d), false)
  }
  const up = () => { if (!g.current.mode) return; g.current.mode = ''; put(s, 'brushDragging', false); setDrag(false) }
  const all = (e: MouseEvent) => { if ((e.target as Element).closest('.ovbrush') && s.anchor) { e.preventDefault(); s.setView(0, N(), true) } }

  // a bar, a flag, a × or a compaction mark moves the playhead to its step (the rough page's bars are no control)
  const pick = (e: MouseEvent) => {
    const t = (e.target as Element).closest('#sawrow [data-i], #probrow [data-i]') as HTMLElement | null
    if (t && !rough) s.setPlayhead(+t.dataset.i!, true)
  }
  const probGo = (dir: number) => {
    if (!s.anchor) return
    const j = problemJump(s.anchor.calls, s.problems || [], s.playhead, dir)
    if (j) s.jumpTo(j.t, j.jump) // lands on the 变化线 when that problem step has one; a failed step just moves the playhead
  }
  const setView = (v: 'ctx' | 'cost') => { if (s.sawView !== v) { put(s, 'sawView', v); desk.saw() } }

  const w = skel(), lg = m?.legend, ch = m?.chapters, pr = m?.problems, ovm = m?.overview, items = new Map<number, Item>((pr?.items || []).map((p: Item) => [p.col, p]))
  const ticks = new Map<number, any>((m?.asks?.ticks || []).map((t: any) => [t.col, t]))
  const paths = tracePaths(m ? m.trace : [])
  const gutName = cost ? W.VIEW_COST : !m || rough || s.anchor?.kind === 'main' ? w.ctx : W.laneWord(s.anchor.kind)
  return <div id="saw" ref={el}>
    <div className="sawlegend">
      <span id="viewswitch">{m && !rough ? (['ctx', 'cost'] as const).map((v) => <button key={v} type="button" className={`segbtn${(v === 'cost') === cost ? ' on' : ''}`} data-view={v} aria-pressed={(v === 'cost') === cost} onClick={() => setView(v)}>{v === 'cost' ? W.VIEW_COST : W.VIEW_CTX}</button>) : null}</span>
      <span id="complegend">{lg ? cost && !rough ? <span>{W.COST_LEGEND}</span> : <><span>{lg.estimate}</span><span className="barlegend">{(BAR_KEYS as Array<[string, string]>).map(([c, word]) => <span key={c}><i className={`ct-${c}`} />{word}</span>)}</span></> : null}</span>
      {lg ? <span className="cachelegend" title={w.cacheTip}><i className="tracekey" aria-hidden="true" />{lg.cache[0]} · <i className="tracekey unk" aria-hidden="true" />{lg.cache[1]}</span> : null}
      <span id="viewrange">{lg?.rangeText || ''}</span>
      {lg?.sampled ? <span className="sampled" title={W.SAMPLED_TIP}>{L.SAMPLED}</span> : null}
      <span id="nomain" style={m?.noMain ? undefined : { display: 'none' }} title={m?.noMain || undefined}>{m?.noMain || ''}</span>
    </div>
    <div className="sdetail" onClick={pick}>
      <div className="chaprow"><div className="tgut" /><div className="chapnav" id="chapnav">{ch ? <>
        <button type="button" className="pgbtn chapbtn" id="chapPrev" disabled={ch.prev == null} title={ch.prevTip} aria-label={ch.prevTip} onClick={() => ch.prev != null && s.chapterGo(ch.prev)}>‹</button>
        <span className="chaplabel" data-part={ch.k} data-of={ch.n} data-s0={ch.a - 1} data-s1={ch.b} data-inferred={String(ch.inferred)}>{ch.label}</span>
        <button type="button" className="pgbtn chapbtn" id="chapNext" disabled={ch.next == null} title={ch.nextTip} aria-label={ch.nextTip} onClick={() => ch.next != null && s.chapterGo(ch.next)}>›</button>
      </> : null}</div></div>
      <div className="tkrow tkrow-axis"><div className="tgut" /><div className="tlane"><div className="sawaxis">
        <span id="sawstart">{m?.axis?.start || ''}</span>
        {f != null && m!.tag ? <span className="axtag" style={{ left: pct(f) }}>{m!.tag}</span> : null}
        <span id="sawend">{m?.axis?.end || ''}</span>
      </div></div></div>
      <div className="tkrow tkrow-problem"><div className="tgut tgut-prob" id="probnav">{pr ? <>{pr.name}{pr.n ? <>
        {' '}<button type="button" className="pgbtn" id="probPrev" aria-label={W.PROBLEM_PREV} title={W.PROBLEM_PREV} onClick={() => probGo(-1)}>‹</button>
        <button type="button" className="pgbtn" id="probNext" aria-label={W.PROBLEM_NEXT} title={W.PROBLEM_NEXT} onClick={() => probGo(1)}>›</button></> : null}</> : W.PROBLEM_ROW}</div>
        <div className="tlane"><div className="probrow" id="probrow">{pr ? bars.map((b, col) => { const p = items.get(col); return p ? <ProblemMark key={keyAt(col)} p={p} /> : <span key={keyAt(col)} className="pcell" /> }) : null}</div></div></div>
      <div className="tkrow tkrow-bars"><div className="tgut tgut-ctx" id="sawgut">{gutName} <b title={m?.peak.tip || undefined}>{m?.peak.text || ''}</b>
        {!cost && m?.gutter.length ? <span className="gshares">{m.gutter.map((x: { ct: string, share: string }) => <span key={x.ct} className="gshare"><i className={`ct-${x.ct}`} />{x.share}</span>)}</span> : null}</div>
        <div className="tlane"><div className="sawrow" id="sawrow">
          <div id="reviewbracket" style={m?.review ? { display: 'block', width: pct(m.review.width) } : { display: 'none' }} title={m?.review?.tip}><span className="rbend" aria-hidden="true">{W.GUESS}</span></div>
          {bars.map((b, col) => <BarView key={keyAt(col)} b={b} cost={cost && !rough} rough={rough} />)}
        </div></div></div>
      <div className="tkrow tkrow-cache"><div className="tgut">{W.CACHE_TITLE}</div><div className="tlane"><div className="cacherow" id="cacherow">
        <svg className="ctrace" viewBox={`0 0 ${n} 10`} preserveAspectRatio="none" aria-hidden="true">
          <path className="tier" d={paths.tier} /><path className="none" d={paths.none} /><path className="unk" d={paths.unk} />
        </svg>
        {(m ? m.trace : []).map((c: Cell, col: number) => <TraceCell key={keyAt(col)} c={c} i={bars[col].i} />)}
      </div></div></div>
      {m?.asks ? <div className="tkrow tkrow-asks" id="askrow"><div className="tgut">{m.asks.name}</div><div className="tlane"><div className="askrow" id="askscale">
        {bars.map((b, col) => { const t = ticks.get(col); return t ? <span key={keyAt(col)} className="atick" data-i={b.i} title={t.tip} /> : <span key={keyAt(col)} className="acell" /> })}
      </div></div></div> : null}
      <div id="rails" />
      {f != null ? <div className="scur" aria-hidden="true" style={{ '--f': f } as CSSProperties} /> : null}
    </div>
    <div className="tkrow tkrow-ovw"><div className="tgut" title={w.ovwTip}>{w.ovw}</div><div className="tlane">
      <div className="ovstrip" id="ovstrip" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={all}>
        {ovm ? <>
          <Backdrop ov={ovm} k={drag ? '' : ov} />
          {ovm.chapterTicks.map((c: { left: number }, i: number) => <span key={i} className="ovchap" aria-hidden="true" style={{ left: pct(c.left) }} />)}
          {ovm.pin != null ? <div className="ovpin" id="ovpin" style={{ left: pct(ovm.pin) }} /> : null}
          {ovm.brush ? <div className="ovbrush" id="ovbrush" tabIndex={0} aria-label={W.BRUSH_LABEL} title={W.BRUSH_LABEL} style={{ left: pct(ovm.brush.left), width: pct(ovm.brush.width) }}>
            <span className="ovh ovh-l" /><span className="ovh ovh-r" /></div> : null}
        </> : null}
      </div></div></div>
  </div>
}
