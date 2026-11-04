// web/src/screens/replay/Cell.tsx — one block body in the new desk's window (spec 2.3 §两种模式, D70), drawn with cell.mjs's shared
// parts: the controls are React, the Readable / Raw body is the exact markup cell.mjs produces (entryOf → kinds / jsonlay), set into a
// leaf only this file touches, and only when (bid, mode, bytes) change — a slice the sentinel appended survives any re-render.
// The cell never reads a body (2.3 §快速拖动: the window decides who asks): it draws what the body cache holds for its ref, else
// `fail` (the window's failed read), else the sized pending box. The view mode is cell.mjs's (modeOf / onModeChange), shared
// with the legacy cells of the raw panel and the drawer; a cell with one mode (onlyMode) is drawn in it and has no switch.
//   <Cell cell api fail bar? />   the body, with its controls above it unless bar is false
//   <CellBar cell api />          the controls alone, for a row head to hold
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import { HALF } from '../../../legacy/core/icons.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import * as C from '../../../legacy/labels/cells.mjs'
import {
  CELL_CAP, blobFor, byteKey, clipLine, copyText, entryOf, fillNode, gotOf, grow, headNote, idle, loadBody, modeOf, noteOpened, offsetIn, onModeChange,
  onlyMode, rawTip, reopen, say, setMode, viewIn, watcher,
} from '../../../legacy/replay/cell.mjs'

type Mode = 'raw' | 'read'
type View = { r: any, body: unknown, events?: number }
export type CellModel = { bid: string, ref?: string, inline?: string, r: any, ff: unknown, chars: number, preview: string, view?: View, reads?: string, block?: boolean }
export type Got = { status: string, text?: string, error?: string, reason?: string, view?: View }
type Api = { get: (...a: any[]) => Promise<any> }

// one IntersectionObserver per scroller for every sentinel on the page (cell.mjs's watcher); each sentinel calls its own cell back
const backs = new Map<Element, () => void>()
let io: ReturnType<typeof watcher> | null = null
const sentinels = () => (io ??= watcher((ents: IntersectionObserverEntry[]) => {
  for (const en of ents) if (en.isIntersecting) { io!.unobserve(en.target); const f = backs.get(en.target); if (f) idle(f) }
}))
const lines = (chars: number) => Math.max(1, Math.min(20, Math.ceil((Number(chars) || 0) / 100)))
const leafIn = (root: HTMLElement | null) => root?.querySelector<HTMLElement>(':scope > .cellraw, :scope > .cellread') ?? null
// a media cell's images take the blob: URL made from the view it already holds (never a request)
const mediaIn = (el: HTMLElement, cell: CellModel, view: View | null) => {
  for (const img of el.querySelectorAll<HTMLImageElement>('img[data-media]:not([src])')) { const u = blobFor(cell, view, img); if (u) img.src = u }
}
// an entry's markup as a leaf's innerHTML: cell.mjs doubles a leading newline for a parsed <pre> tag, which drops the first; set
// into an existing <pre> nothing is dropped, so the guard comes off again
const inner = (mode: Mode, body: string) => (mode === 'raw' && body.startsWith('\n') ? body.slice(1) : body)
const useDeskMode = (cell: CellModel) => useSyncExternalStore(onModeChange, () => modeOf(cell.bid)) as Mode

export function Cell({ cell, fail, api, bar = true }: { cell: CellModel, fail?: Got | null, api?: Api, bar?: boolean }) {
  const mode = useDeskMode(cell)
  const got: Got | null = gotOf(cell) ?? fail ?? null
  if (!got) return <pre className="cellpend" data-ref={cell.ref ?? ''} style={{ '--cl': lines(cell.chars) } as CSSProperties}>{String(cell.preview ?? '')}</pre>
  if (got.status !== 'ok') {
    return <div className="cbsrc warn" title={`locator: ${cell.ref ?? '—'}`}><span dangerouslySetInnerHTML={{ __html: HALF }} />{' ' + W.FF_WORD.notfetched + ' — ' + (got.error || got.reason || 'the capture could not be read')}</div>
  }
  return <Shown cell={cell} mode={onlyMode(cell, got) ?? mode} got={got} api={api} bar={bar} />
}

// the bytes may have left the bounded cache while the cell stayed open: the reader's own click reads them
async function copyCell(cell: CellModel, api?: Api) {
  let got = gotOf(cell)
  if ((!got || got.status !== 'ok') && api && cell.ref != null && cell.inline === undefined) got = await loadBody(api, cell.ref)
  if (got && got.status === 'ok') copyText(String(got.text ?? '')); else say(C.COPY_FAILED)
}

export function CellBar({ cell, api }: { cell: CellModel, api?: Api }) {
  const desk = useDeskMode(cell), got: Got | null = gotOf(cell)
  if (!got || got.status !== 'ok') return null
  const only = onlyMode(cell, got), mode = only ?? desk
  if (only === 'read') return null
  const flip = (m: Mode) => { setMode(cell.bid, m); say(m === 'read' ? C.READABLE_VIEW : C.RAW_VIEW) }
  const btn = (v: Mode, word: string, tip: string) => <button type="button" data-cellmode={v} aria-pressed={mode === v} title={tip} onClick={() => flip(v)}>{word}</button>
  return (
    <div className="cellbar" onClick={(ev) => ev.stopPropagation()}>
      {only ? null : <span className="cellview" role="group" aria-label={C.VIEW_GROUP}>{btn('read', C.READABLE, C.READ_TIP)}{btn('raw', C.RAW, rawTip(viewIn(cell, got)))}</span>}
      <button type="button" className="cellcopy" data-cellcopy="" onClick={() => copyCell(cell, api)}>{C.COPY}</button>
      {mode === 'raw' ? <span className="cellstate" title={C.RAW_TIP}>{C.RAW_STATE}</span> : null}
    </div>
  )
}

function Shown({ cell, mode, got, api, bar }: { cell: CellModel, mode: Mode, got: Got, api?: Api, bar: boolean }) {
  const k = `${cell.bid}|${mode}|${byteKey(cell)}`, only = onlyMode(cell, got)
  const e = entryOf(cell, mode, got)
  // what this cell's leaf holds: the entry its leaf was set from at k (onSet), then what the sentinel grew it to
  const [held, setHeld] = useState<{ k: string, shown: number, next: number | null }>({ k, shown: e.shown, next: e.next })
  const cur = held.k === k ? held : { k, shown: e.shown, next: e.next }
  const root = useRef<HTMLDivElement>(null), sent = useRef<HTMLSpanElement>(null)
  const live = useRef({ cell, mode, got, cur })
  useLayoutEffect(() => { live.current = { cell, mode, got, cur } })
  const onSet = (el: HTMLElement) => {
    const view = viewIn(cell, got)
    mediaIn(el, cell, view)
    if (mode === 'read') reopen(el, cell, view)
    setHeld((h) => (h.k === k && h.shown === e.shown && h.next === e.next ? h : { k, shown: e.shown, next: e.next }))
  }

  // the sentinel: the next slice where the reader is heading (another copy of this cell that grew further: its whole entry)
  const more = cur.next != null && cur.shown < CELL_CAP
  useEffect(() => {
    const el = sent.current
    if (!el) return
    backs.set(el, () => {
      const { cell, mode, got, cur } = live.current, lf = leafIn(root.current), view = viewIn(cell, got)
      if (!lf || !el.isConnected) return
      let en = entryOf(cell, mode, got, cur.shown)
      if (en.shown !== cur.shown) lf.innerHTML = inner(mode, en.body)
      else { const g = grow(cell, mode, en, got); lf.insertAdjacentHTML('beforeend', g.html); en = g.entry }
      mediaIn(lf, cell, view)
      if (mode === 'read') reopen(lf, cell, view)
      setHeld({ k: cur.k, shown: en.shown, next: en.next })
    })
    sentinels().observe(el)
    return () => { backs.delete(el); io?.unobserve(el) }
  }, [k, cur.shown])

  // a json node opened for the first time draws its children; a toggle does not bubble, so it is heard in the capture phase
  useEffect(() => {
    const el = root.current!
    const onToggle = (ev: Event) => {
      const d = ev.target as HTMLDetailsElement
      if (d?.tagName === 'DETAILS') fillNode(d, viewIn(live.current.cell, live.current.got))
    }
    el.addEventListener('toggle', onToggle, true)
    return () => el.removeEventListener('toggle', onToggle, true)
  }, [])

  const onCopy = (ev: ClipboardEvent) => { // exact bytes from a selection inside the Raw leaf; a selection that leaves it is the browser's
    const sel = getSelection(), r = sel && sel.rangeCount === 1 ? sel.getRangeAt(0) : null, pre = leafIn(root.current)
    if (!r || !pre || mode !== 'raw' || !pre.contains(r.startContainer) || !pre.contains(r.endContainer)) return
    ev.clipboardData.setData('text/plain', String(got.text ?? '').slice(offsetIn(pre, r.startContainer, r.startOffset), offsetIn(pre, r.endContainer, r.endOffset)))
    ev.preventDefault()
  }
  const onClick = (ev: MouseEvent) => { // inside the Readable markup: a node the reader opens, a media cell's save action
    const t = ev.target as Element
    noteOpened(cell.bid, t)
    const save = t.closest?.<HTMLElement>('[data-cellsave]'), u = save && blobFor(cell, viewIn(cell, got), save)
    if (u) { const a = document.createElement('a'); a.href = u; a.download = ''; a.click() }
  }

  const clip = clipLine(cur.shown, e.total), note = bar ? headNote(cell, got, mode) : null
  return (
    <div ref={root} className="cell" data-bid={cell.bid} data-mode={mode} data-only={only ?? undefined} data-chars={e.total} data-shown={cur.shown} data-ref={cell.ref} onCopy={onCopy} onClick={onClick}>
      {bar ? <CellBar cell={cell} api={api} /> : null}
      {note ? <div className="cellnote">{note}</div> : null}
      {only === 'raw' && cell.block ? <div className="cellnote" data-noread="">{C.NO_READABLE}</div> : null}
      <Leaf key={k} raw={mode === 'raw'} cls={e.cls} html={e.body} onSet={onSet} />
      {clip ? <span className="cellclip">{clip}</span> : null}
      {more ? <span ref={sent} className="cellmore" data-at={cur.next!} /> : null}
    </div>
  )
}

// the body leaf: its markup is set once, when it mounts (the parent keys it by bid, mode and bytes); React never renders into it again
const Leaf = memo(function Leaf({ raw, cls, html, onSet }: { raw: boolean, cls: string, html: string, onSet: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => { const el = ref.current!; el.innerHTML = inner(raw ? 'raw' : 'read', html); onSet(el) }, [raw, html, onSet])
  return raw ? <pre ref={ref as RefObject<HTMLPreElement>} className="cellraw" /> : <div ref={ref as RefObject<HTMLDivElement>} className={`cellread ${cls}`} />
}, () => true)
