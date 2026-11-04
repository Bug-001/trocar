// web/src/screens/replay/Strip.tsx — the whole-session strip (1.3 §概览条), drawn from models.mjs : overviewModel(s) and the window in
// scopeModel(); strip.mjs : stripLayout() is the one source of every x here, in pixels, and the DOM takes them as % of W. A part is a block,
// the window's is lit; the box marks the window in a part too long for it; the mark is the playhead wherever the window is.
// On the strip a press that travels drags the bars and leaves the playhead alone, a press that does not is a click, and the box's grips
// zoom. A drag frame only asks for a window (s.brushTo): the terrain is memoized and nothing here reads a body (D64).
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { capWindow, chapterAt, fitWindow } from '../../../legacy/replay/timeline.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { panSpan, stripLayout } from './strip.mjs'
import type { DeskView } from './view'

type Mark = { g: number, v: number, failed: boolean }
type Overview = { mode: string, marks: Mark[], parts: Array<{ s0: number, s1: number }> }
type Layout = { ticks: boolean, W: number, parts: Array<{ s0: number, s1: number, x0: number, x1: number }>, xOf: (g: number) => number, stepOf: (x: number) => number, hit: (x: number) => { k: number, g: number } }
type Span = { lo: number, hi: number }
type Press = { mode: 'pending' | 'drag' | 'l' | 'r', left: number, x: number, grab: number, part: number, win: Span }

const SLOP = 3, H = 22 // px a press travels before it is a drag; the terrain's viewBox height
const pct = (f: number) => `${(f * 100).toFixed(3)}%`
const span = (l: Layout, a: number, b: number): CSSProperties => ({ left: pct(a / l.W), width: pct((b - a) / l.W) })
const barH = (v: number) => Math.max(1, v * 20)
const pointOf = (x: number, v: number) => `${x.toFixed(2)},${(H - Math.max(0.5, v * 20)).toFixed(2)}`

// per part a line from edge to edge, so a break breaks it and a part with one mark still shows
function lines(marks: Mark[], { parts, xOf }: Layout) {
  const per: Mark[][] = parts.map(() => [])
  let k = 0
  for (const mk of marks) { while (k < parts.length - 1 && mk.g >= parts[k].s1) k++; per[k].push(mk) }
  return parts.flatMap((p, j) => {
    const ms = per[j]
    return ms.length ? [[pointOf(p.x0, ms[0].v), ...ms.map((mk) => pointOf(xOf(mk.g + 0.5), mk.v)), pointOf(p.x1, ms[ms.length - 1].v)].join(' ')] : []
  })
}

const Backdrop = memo(function Backdrop({ ov, l }: { ov: Overview, l: Layout }) {
  return <svg className="ovsvg" viewBox={`0 0 ${l.W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
    {ov.mode === 'bars'
      ? ov.marks.map((k) => { const x = l.xOf(k.g), h = barH(k.v); return <rect key={k.g} className={k.failed ? 'err' : undefined} x={x.toFixed(2)} y={(H - h).toFixed(2)} width={Math.max(1, l.xOf(k.g + 1) - x - 1).toFixed(2)} height={h.toFixed(2)} /> })
      : lines(ov.marks, l).map((pts, k) => <polyline key={k} points={pts} />)}
  </svg>
})

const Blocks = memo(function Blocks({ l, lit }: { l: Layout, lit: number }) {
  return <>
    {l.parts.map((p, k) => <div key={k} className={`ovpart${k === lit ? ' lit' : ''}`} data-part={k} style={span(l, p.x0, p.x1)} />)}
    {l.ticks ? l.parts.map((p, k) => <span key={k} className="ovchap" aria-hidden="true" style={{ left: pct(p.x0 / l.W) }} />) : null}
  </>
})

export function Strip({ desk, m, ov }: { desk: DeskView, m: any, ov: Overview | null }) {
  const el = useRef<HTMLDivElement>(null), press = useRef<Press | null>(null)
  const [w, setW] = useState(0)
  const [label, setLabel] = useState<{ x: number, g: number, k: number } | null>(null)
  const s = desk.s

  useLayoutEffect(() => {
    const strip = el.current!, fit = () => setW(strip.getBoundingClientRect().width)
    fit()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    ro?.observe(strip)
    return () => ro?.disconnect()
  }, [])
  // a time axis has no parts: its one stretch is the buckets
  const l = useMemo((): Layout | null => (ov && w > 0 ? stripLayout(ov.parts.length ? ov.parts : [{ s0: 0, s1: Math.max(1, ov.marks.length) }], w) : null), [ov, w])
  const on = !!(l && m && ov?.parts.length)
  const wordAt = (k: number) => (l!.parts.length > 1 ? W.partWord(k) : null)

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!on || e.button) return
    const strip = e.currentTarget, left = strip.getBoundingClientRect().left, x = e.clientX - left, t = e.target as Element
    const win = { lo: m.view.lo, hi: m.view.hi }, g = l!.hit(x).g
    const mode = t.classList.contains('ovh-l') ? 'l' : t.classList.contains('ovh-r') ? 'r' : 'pending'
    press.current = { mode, left, x, win, part: m.part, grab: g >= win.lo && g < win.hi ? g - (win.lo + win.hi) / 2 : 0 }
    try { strip.setPointerCapture(e.pointerId) } catch { /* no capture: the drag still works while the pointer stays over the strip */ }
    e.preventDefault()
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p) return
    const x = e.clientX - p.left, K = desk.capacity()
    if (p.mode === 'pending') {
      if (Math.abs(x - p.x) <= SLOP) return
      p.mode = 'drag'
      if (s.follow) s.followOff()
    }
    if (p.mode === 'drag') {
      const { k, g } = l!.hit(x)
      if (k !== p.part) { p.part = k; p.grab = 0 }
      p.win = panSpan(p.win, l!.parts[k], g - p.grab, K)
      setLabel({ x, g, k })
    } else {
      const c = l!.parts[p.part], edge = Math.round(l!.stepOf(x)), { lo, hi } = p.win
      const next = p.mode === 'l' ? { lo: Math.max(c.s0, Math.min(hi - 1, edge)), hi } : { lo, hi: Math.min(c.s1, Math.max(lo + 1, edge)) }
      p.win = capWindow({ ...next, prev: p.win, K, playhead: (lo + hi) >> 1 })
    }
    s.brushTo(p.win.lo, p.win.hi)
  }
  const end = () => { press.current = null; setLabel(null) }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (p?.mode === 'pending') s.chapterGo(l!.hit(e.clientX - p.left).g)
    end()
  }
  const widen = (e: MouseEvent) => {
    if (!on || !(e.target as Element).closest('.ovbrush')) return
    const c = l!.parts[m.part], { lo, hi } = m.view
    e.preventDefault()
    const f = fitWindow({ lo: c.s0, hi: c.s1, K: desk.capacity(), playhead: (lo + hi) >> 1 })
    s.brushTo(f.lo, f.hi)
  }

  const slider = on ? { role: 'slider', tabIndex: 0, 'aria-label': W.STRIP_LABEL, 'aria-valuemin': 1, 'aria-valuemax': m.view.N, 'aria-valuenow': m.at + 1,
    'aria-valuetext': W.stripAt(wordAt(chapterAt(l!.parts, m.at)), m.at + 1) } : undefined
  return <div className={`ovstrip${label ? ' drag' : ''}`} id="ovstrip" ref={el} {...slider} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={end} onDoubleClick={widen}>
    {l && ov ? <>
      {on ? <Blocks l={l} lit={m.part} /> : null}
      <Backdrop ov={ov} l={l} />
      {on && m.box ? <div className="ovbrush" id="ovbrush" style={span(l, l.xOf(m.box.lo), l.xOf(m.box.hi))}><span className="ovh ovh-l" /><span className="ovh ovh-r" /></div> : null}
      {on ? <div className="ovpin" id="ovpin" style={{ left: pct(l.xOf(m.at + 0.5) / l.W) }} /> : null}
      {label ? <div className="ovlabel" data-step={label.g} style={{ left: pct(label.x / l.W), '--f': Math.max(0, Math.min(1, label.x / l.W)) } as CSSProperties}>{W.stripAt(wordAt(label.k), label.g + 1)}</div> : null}
    </> : null}
  </div>
}
