// web/src/screens/replay/Cell.tsx — one block body in the new desk's window (spec 2.3 §两种模式, D70), drawn with cell.mjs's shared
// parts: the toolbar is React, the Raw / Readable body is the exact markup cell.mjs produces (entryOf → jsonlay / kinds), set into a
// leaf only this file touches, and only when (bid, mode, bytes) change — a slice the sentinel appended survives any re-render.
// The cell never reads a body (2.3 §快速拖动: the window decides who asks): it draws what the body cache holds for its ref, else
// `fail` (the window's failed read), else the sized pending box. The view mode is cell.mjs's (modeOf / onModeChange), shared
// with the legacy cells of the raw panel and the drawer.
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import { HALF } from '../../../legacy/core/icons.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import * as C from '../../../legacy/labels/cells.mjs'
import {
  CELL_CAP, DISPLAY_CLIP, blobOf, byteKey, clipLine, copyText, entryOf, gotOf, grow, idle, loadBody, modeOf, offsetIn, onModeChange,
  say, setMode, watcher,
} from '../../../legacy/replay/cell.mjs'
import { jsonNodeHtml, valueOf } from '../../../legacy/replay/kinds.mjs'

type Mode = 'raw' | 'read'
export type CellModel = { bid: string, ref?: string, inline?: string, r: any, ff: unknown, chars: number, preview: string }
export type Got = { status: string, text?: string, error?: string, reason?: string }
type Api = { get: (...a: any[]) => Promise<any> }

// one IntersectionObserver per scroller for every sentinel on the page (cell.mjs's watcher); each sentinel calls its own cell back
const backs = new Map<Element, () => void>()
let io: ReturnType<typeof watcher> | null = null
const sentinels = () => (io ??= watcher((ents: IntersectionObserverEntry[]) => {
  for (const en of ents) if (en.isIntersecting) { io!.unobserve(en.target); const f = backs.get(en.target); if (f) idle(f) }
}))
const lines = (chars: number) => Math.max(1, Math.min(20, Math.ceil((Number(chars) || 0) / 100)))
const leafIn = (root: HTMLElement | null) => root?.querySelector<HTMLElement>(':scope > .cellraw, :scope > .cellread') ?? null
// a media cell's images take the blob: URL made from the bytes it already holds (never a request)
const mediaIn = (el: HTMLElement, cell: CellModel, text: string) => {
  for (const img of el.querySelectorAll<HTMLImageElement>('img[data-media]:not([src])')) if (img.dataset.media) { const u = blobOf(cell, text); if (u) img.src = u }
}
// an entry's markup as a leaf's innerHTML: cell.mjs doubles a leading newline for a parsed <pre> tag, which drops the first; set
// into an existing <pre> nothing is dropped, so the guard comes off again
const inner = (mode: Mode, body: string) => (mode === 'raw' && body.startsWith('\n') ? body.slice(1) : body)
const at = (v: any, p: unknown[]) => { for (const k of p) { if (v == null || typeof v !== 'object' || !Object.hasOwn(v, k as string)) return undefined; v = v[k as string] } return v }

export function Cell({ cell, fail, api }: { cell: CellModel, fail?: Got | null, api?: Api }) {
  const mode = useSyncExternalStore(onModeChange, () => modeOf(cell.bid)) as Mode
  const got: Got | null = gotOf(cell) ?? fail ?? null
  if (!got) return <pre className="cellpend" data-ref={cell.ref ?? ''} style={{ '--cl': lines(cell.chars) } as CSSProperties}>{String(cell.preview ?? '')}</pre>
  if (got.status !== 'ok') {
    return <div className="cbsrc warn" title={`locator: ${cell.ref ?? '—'}`}><span dangerouslySetInnerHTML={{ __html: HALF }} />{' ' + W.FF_WORD.notfetched + ' — ' + (got.error || got.reason || 'the capture could not be read')}</div>
  }
  return <Shown cell={cell} mode={mode} text={String(got.text ?? '')} api={api} />
}

function Shown({ cell, mode, text, api }: { cell: CellModel, mode: Mode, text: string, api?: Api }) {
  const k = `${cell.bid}|${mode}|${byteKey(cell)}`
  const e = entryOf(cell, mode, text)
  // what this cell's leaf holds: the entry its leaf was set from at k (onSet), then what the sentinel grew it to
  const [held, setHeld] = useState<{ k: string, shown: number, next: number | null }>({ k, shown: e.shown, next: e.next })
  const cur = held.k === k ? held : { k, shown: e.shown, next: e.next }
  const root = useRef<HTMLDivElement>(null), sent = useRef<HTMLSpanElement>(null)
  const live = useRef({ cell, mode, text, cur })
  useLayoutEffect(() => { live.current = { cell, mode, text, cur } })
  const onSet = (el: HTMLElement) => {
    mediaIn(el, cell, text)
    setHeld((h) => (h.k === k && h.shown === e.shown && h.next === e.next ? h : { k, shown: e.shown, next: e.next }))
  }

  // the sentinel: the next slice where the reader is heading (another copy of this cell that grew further: its whole entry)
  const more = cur.next != null && cur.shown < CELL_CAP
  useEffect(() => {
    const el = sent.current
    if (!el) return
    backs.set(el, () => {
      const { cell, mode, text, cur } = live.current, lf = leafIn(root.current)
      if (!lf || !el.isConnected) return
      let en = entryOf(cell, mode, text, cur.shown)
      if (en.shown !== cur.shown) lf.innerHTML = inner(mode, en.body)
      else { const g = grow(cell, mode, en, text); lf.insertAdjacentHTML('beforeend', g.html); en = g.entry }
      mediaIn(lf, cell, text)
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
      if (!d || d.tagName !== 'DETAILS' || !d.open || d.dataset.path == null || d.children.length > 1) return
      const { cell, text } = live.current
      let path
      try { path = JSON.parse(d.dataset.path) } catch { return }
      const v = valueOf(text), body = Array.isArray(cell.r?.f?.body) ? at(v, cell.r.f.body) : v
      d.insertAdjacentHTML('beforeend', jsonNodeHtml(body, path, d.dataset.span ? d.dataset.span.split(',').map(Number) : undefined, { q: d.dataset.q != null, budget: DISPLAY_CLIP }))
    }
    el.addEventListener('toggle', onToggle, true)
    return () => el.removeEventListener('toggle', onToggle, true)
  }, [])

  const flip = (m: Mode) => { setMode(cell.bid, m); say(m === 'read' ? C.READABLE_VIEW : C.RAW_VIEW) }
  const copy = async () => {
    let got = gotOf(cell) // the bytes may have left the bounded cache while the cell stayed open: the reader's own click reads them
    if ((!got || got.status !== 'ok') && api && cell.ref != null && cell.inline === undefined) got = await loadBody(api, cell.ref)
    if (got && got.status === 'ok') copyText(String(got.text ?? '')); else say(C.COPY_FAILED)
  }
  const onCopy = (ev: ClipboardEvent) => { // exact bytes from a selection inside the Raw leaf; a selection that leaves it is the browser's
    const sel = getSelection(), r = sel && sel.rangeCount === 1 ? sel.getRangeAt(0) : null, pre = leafIn(root.current)
    if (!r || !pre || mode !== 'raw' || !pre.contains(r.startContainer) || !pre.contains(r.endContainer)) return
    ev.clipboardData.setData('text/plain', text.slice(offsetIn(pre, r.startContainer, r.startOffset), offsetIn(pre, r.endContainer, r.endOffset)))
    ev.preventDefault()
  }
  const onClick = (ev: MouseEvent) => { // a media cell's save action, inside the Readable markup
    if (!(ev.target as Element).closest?.('[data-cellsave]')) return
    const u = blobOf(cell, text)
    if (u) { const a = document.createElement('a'); a.href = u; a.download = ''; a.click() }
  }

  const btn = (v: Mode, word: string) => <button type="button" data-cellmode={v} aria-pressed={mode === v} onClick={() => flip(v)}>{word}</button>
  const clip = clipLine(cur.shown, text.length)
  return (
    <div ref={root} className="cell" data-bid={cell.bid} data-mode={mode} data-chars={text.length} data-shown={cur.shown} data-ref={cell.ref} onCopy={onCopy} onClick={onClick}>
      <div className="cellbar">
        <span className="cellview" role="group" aria-label={C.VIEW_GROUP}>{btn('raw', C.RAW)}{btn('read', C.READABLE)}</span>
        <button type="button" className="cellcopy" data-cellcopy="" onClick={copy}>{C.COPY}</button>
        {mode === 'read'
          ? <><span className="cellkind">{C.KIND_WORD[e.as as keyof typeof C.KIND_WORD] || C.KIND_WORD.text}</span><span className="cellstate">{C.READ_STATE}</span></>
          : <span className="cellstate" title={C.RAW_TIP}>{C.RAW_STATE}</span>}
        {clip ? <span className="cellclip">{clip}</span> : null}
      </div>
      <Leaf key={k} raw={mode === 'raw'} cls={e.cls} html={e.body} onSet={onSet} />
      {more ? <span ref={sent} className="cellmore" data-at={cur.next!} /> : null}
    </div>
  )
}

// the body leaf: its markup is set once per node (the parent keys it by bid, mode and bytes); React never renders into it again, and
// a hidden <Activity> shown again runs this effect on a leaf that already holds what the sentinel grew and the reader opened
const Leaf = memo(function Leaf({ raw, cls, html, onSet }: { raw: boolean, cls: string, html: string, onSet: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => { const el = ref.current!; if (el.firstChild) return; el.innerHTML = inner(raw ? 'raw' : 'read', html); onSet(el) }, [raw, html, onSet])
  return raw ? <pre ref={ref as RefObject<HTMLPreElement>} className="cellraw" /> : <div ref={ref as RefObject<HTMLDivElement>} className={`cellread ${cls}`} />
}, () => true)
