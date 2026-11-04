// web/src/screens/replay/Scope.tsx — the scope (1.3) in the new desk, drawn from models.mjs : scopeModel(s, K). Top to bottom (1.3 §排布):
// the legend row · the chapter row (a header on the bars' grid, not a track: replay.css .chaprow) · the axis with the playhead's step tag · the problem lane · the main track · the cache trace · the
// prompts lane · #rails (rails.mjs draws it; React renders it empty and never touches what is inside) · the whole-session strip (Strip.tsx).
// Every track is a .tkrow (.tgut + .tlane) on one --gut; one --cursor line runs through the detail rows.
// What changes on a step move is only what the playhead touches: bars, trace cells and problem marks are memoized and keyed by the row's
// rid (D75④), so a move re-renders the two bars whose .cur flips and the cursor. The bars row's grid column reports the lane's capacity
// (view.setCapacity); the rough page reports itself drawn (view.roughDrawn).
import { memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react'
import { SKELETON, laneCapacity } from '../../../legacy/replay/replay.mjs'
import { BAR_KEYS, problemJump } from '../../../legacy/replay/timeline.mjs'
import { L } from '../../../legacy/core/labels.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { overviewModel, scopeModel } from './models.mjs'
import { stepCount } from './strip.mjs'
import { Strip } from './Strip.tsx' // with its extension: on a case-insensitive disk the bare name finds strip.mjs
import { useDeskVersion } from './useDesk'
import type { Area, DeskState, DeskView } from './view'

type Bar = { rid?: string, i?: number, g: number, col: number, h: number, segs: Array<[string, number]> | null, hatched: boolean, fail: boolean, compact: boolean, cur: boolean, reviewed: boolean, tip: string }
type Cell = { rid?: string, col: number, state: string, tip: string }
type Item = { rid: string, i: number, col: number, kind: 'flag' | 'x' | 'compact', h: number | null, tip: string, aria: string }

// the tallest bar is --barh (scope.css: the main track yields to #ctxwin on a short viewport, 1.3 §排布); BAR_PX is its full height,
// used only to drop a segment too thin to draw. FLAG_PX: the tallest flag (h ∝ √ ≈ extra cost)
const BAR_PX = 80, FLAG_PX = 14
const barH = (f: number) => `calc(var(--barh) * ${f.toFixed(4)})`
const READS: Area[] = ['saw', 'overview', 'cur', 'problems', 'review', 'rough', 'empty'] // the areas the scope draws
const BACKDROP: Area[] = ['overview', 'rough', 'empty'] // the paints that read the strip's data anew; a step more does too
// the controller's state is plain JS the renderers share: the view switch writes through here, not on a value React tracks
const put = (s: DeskState, k: string, v: unknown) => { s[k] = v }
const pct = (f: number) => `${(f * 100).toFixed(3)}%`

// the row names the legacy skeleton carries and the labels do not (one source until the legacy desk retires)
let words: { ctx: string, ovw: string, cacheTip: string } | null = null
function skel() {
  if (words) return words
  const t = document.createElement('template')
  t.innerHTML = SKELETON
  const g = t.content.querySelector('.tkrow-ovw .tgut')!, c = t.content.querySelector('.cachelegend')!
  return (words = { ctx: t.content.querySelector('#sawgut')!.textContent!, ovw: g.textContent!, cacheTip: c.getAttribute('title') || '' })
}

// the playhead's step tag on the axis: the step's own global number (1.2 §编号)
function tagOf(m: any) {
  const b = m.cursor.col != null ? m.bars[m.cursor.col] : null
  return b ? W.axisNo(!m.noMain, b.g + 1) : null
}

function useScope(desk: DeskView) {
  const key = useSyncExternalStore(desk.subscribe, () => READS.map((a) => desk.version(a)).join('.'))
  const ovKey = useSyncExternalStore(desk.subscribe, () => `${BACKDROP.map((a) => desk.version(a)).join('.')}.${stepCount(desk.s)}`)
  const K = desk.capacity()
  const m = useMemo(() => {
    void key // the paint the model is computed for
    const m: any = scopeModel(desk.s, K) // the model's JSDoc shapes; the fields read below are its own
    return m && { ...m, tag: tagOf(m) }
  }, [desk, key, K])
  const ov = useMemo(() => { void ovKey; return overviewModel(desk.s) }, [desk, ovKey])
  return { m, ov }
}

const sameSegs = (a: Bar['segs'], b: Bar['segs']) => a === b || (!!a && !!b && a.length === b.length && a.every((x, j) => x[0] === b[j][0] && x[1] === b[j][1]))
const sameBar = (p: { b: Bar, cost: boolean }, n: { b: Bar, cost: boolean }) => p.cost === n.cost &&
  (['i', 'g', 'h', 'hatched', 'fail', 'compact', 'cur', 'reviewed', 'tip'] as const).every((k) => p.b[k] === n.b[k]) && sameSegs(p.b.segs, n.b.segs)

const BarView = memo(function BarView({ b, cost }: { b: Bar, cost: boolean }) {
  // a hatched cost bar is 0 high: its stripe says the estimate cannot be made
  const cls = ['bar', cost && 'cost', b.fail && 'err', b.compact && 'compact', b.cur && 'cur', b.reviewed && 'reviewed'].filter(Boolean).join(' ')
  const at = b.i != null ? { 'data-i': b.i } : { 'data-step': b.g } // a step without its row yet is a control too: it names the step
  return <div className={cls} {...at} style={{ height: barH(b.h) }} title={b.tip}>
    {b.fail ? null : b.hatched ? <span className="ct-unloaded" style={{ height: `max(6px, ${barH(b.h)})` }} />
      : cost || !b.segs ? null : b.segs.map(([k, f]) => f * b.h * BAR_PX < 0.4 ? null : <span key={k} className={`ct-${k}`} style={{ height: barH(f * b.h) }} />)}
  </div>
}, sameBar)

const TraceCell = memo(function TraceCell({ c, i }: { c: Cell, i?: number }) {
  if (c.state === 'gap') return <div className="cbar gap" /> // no row yet: an empty column, nothing to say
  return <div className={`cbar ${c.state}`} data-i={i} role="img" title={c.tip} aria-label={c.tip} />
}, (p, n) => p.i === n.i && p.c.state === n.c.state && p.c.tip === n.c.tip)

// the cache trace as one path per line style: a tier is a level, no usage a dashed middle line, uncertain its own style, failed or no row a gap
const LEVEL: Record<string, number> = { high: 2, mid: 5, low: 8, none: 5, unk: 5 }
function tracePaths(cells: Cell[]) {
  const d: Record<'tier' | 'none' | 'unk', string> = { tier: '', none: '', unk: '' }
  let prev: string | null = null
  cells.forEach((c, x) => {
    const k = c.state === 'fail' || c.state === 'gap' ? null : c.state === 'none' || c.state === 'unk' ? c.state : 'tier'
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

export function Scope({ desk }: { desk: DeskView }) {
  const el = useRef<HTMLDivElement>(null)
  const { m, ov } = useScope(desk)
  const s = desk.s
  const vRough = useDeskVersion(desk, 'rough')

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
  const keyAt = (col: number) => bars[col]?.rid ?? `s${bars[col]?.g}`
  const f = m && m.cursor.col != null ? (m.cursor.col + 0.5) / n : null

  // a bar, a flag, a × or a compaction mark moves the playhead to its step; a bar without its row names the step (s.chapterGo)
  const pick = (e: MouseEvent) => {
    const t = (e.target as Element).closest('#sawrow [data-i], #sawrow [data-step], #probrow [data-i]') as HTMLElement | null
    if (!t) return
    if (t.dataset.i != null) s.setPlayhead(+t.dataset.i, true)
    else s.chapterGo(+t.dataset.step!)
  }
  const probGo = (dir: number) => {
    if (!s.anchor) return
    const j = problemJump(s.anchor.calls, s.problems || [], s.playhead, dir)
    if (j) s.jumpTo(j.t, j.jump) // lands on the 变化线 when that problem step has one; a failed step just moves the playhead
  }
  const setView = (v: 'ctx' | 'cost') => { if (s.sawView !== v) { put(s, 'sawView', v); desk.saw() } }

  const w = skel(), lg = m?.legend, ch = m?.chapters, pr = m?.problems, items = new Map<number, Item>((pr?.items || []).map((p: Item) => [p.col, p]))
  const ticks = new Map<number, any>((m?.asks?.ticks || []).map((t: any) => [t.col, t]))
  const paths = tracePaths(m ? m.trace : [])
  const gutName = cost ? W.VIEW_COST : !m || rough || s.anchor?.kind === 'main' ? w.ctx : W.laneWord(s.anchor.kind)
  // the bars the window draws, which every detail lane (and #rails, inside #saw) narrows to: the model's window (1.3 §窗内步少时收窄)
  const nb = m ? { '--nbars': String(Math.max(1, m.view.hi - m.view.lo)) } as CSSProperties : undefined
  return <div id="saw" ref={el} style={nb}>
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
      <div className="tkrow tkrow-bars"><div className="tgut tgut-ctx" id="sawgut" title={m?.gutterTip || undefined}><span className="ghead">{gutName} <b title={m?.peak.tip || undefined}>{m?.peak.text || ''}</b></span>
        {!cost && m?.gutter.length ? <span className="gshares">{m.gutter.map((x: { ct: string, share: string }) => <span key={x.ct} className="gshare"><i className={`ct-${x.ct}`} />{x.share}</span>)}</span> : null}</div>
        <div className="tlane"><div className="sawrow" id="sawrow">
          <div id="reviewbracket" style={m?.review ? { display: 'block', width: pct(m.review.width) } : { display: 'none' }} title={m?.review?.tip}><span className="rbend" aria-hidden="true">{W.GUESS}</span></div>
          {bars.map((b, col) => <BarView key={keyAt(col)} b={b} cost={cost && !rough} />)}
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
    <div className="tkrow tkrow-ovw"><div className="tgut" title={W.STRIP_TIP}>{w.ovw}</div><div className="tlane"><Strip desk={desk} m={m} ov={ov} /></div></div>
  </div>
}
