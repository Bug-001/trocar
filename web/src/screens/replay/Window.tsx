// web/src/screens/replay/Window.tsx — the new desk's context window (2.3 §读与画「长对话的窗口」, 1.4 中栏): one virtual list (D75⑤) over the
// window model's items (window-model.mjs windowItems), each keyed by the model's key (D75④), rows drawn with the decision-4 head and the
// React cell (Cell.tsx). It owns #ctxwin and everything in it but each open cell's body leaf (R2 decision 13).
//   · The DOM holds the items within one window height of the visible box, plus the pins (withPins): the change line, the reply, the
//     item holding focus, the item holding the selection, the last reveal's target, the sticky section header, and — in the commit
//     that changes the step and has a landing target — the landing band, so the landed items are drawn before any scroll event.
//   · The landing (1.4 §打开一步时落在哪) is computed in render (landingFor, pure; a target inside a folded turn opens it for this display,
//     s.turnLanded) and scrolled in the layout effect of that commit: once per rid, never on a repaint of the same step.
//   · The window asks for bodies, never the cell (2.3 §快速拖动): a row the reader opens, or a reveal opens. A step painted with a row
//     already open shows the pending cell until the step's own read paints the window again (view.window()).
//   · A paint of the 'window' area (view.ts) re-renders it; the window's own actions mutate the desk's state and re-render it alone.
import { flushSync } from 'react-dom'
import { memo, useCallback, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import { esc, bytes, kf } from '../../../legacy/core/fmt.mjs'
import { HALF, discChev } from '../../../legacy/core/icons.mjs'
import { isTyping } from '../../../legacy/core/keys.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../../../legacy/labels/shell.mjs'
import * as C from '../../../legacy/labels/cells.mjs'
import { bodyVersion, cellOf, deskMode, gotOf, hasInline, headNote, isAddressed, isRetryable, loadBody, modeOf, modeVersion, onModeChange, say, setDeskMode } from '../../../legacy/replay/cell.mjs'
import { cellKey } from '../../../legacy/replay/keymap.mjs'
import { setFold, turnAnchorKey } from '../../../legacy/replay/fold.mjs'
import { stepOf } from '../../../legacy/replay/model.mjs'
import { tagWord } from '../../../legacy/replay/blocks.mjs'
import { TechDetails, type TechValue } from '../../ui/TechDetails'
import { Svg } from '../../ui/Svg'
import { Cell, CellBar, type CellModel } from './Cell'
import { faithOf, windowItems, landingFor, turnsOf, turnOpen } from './window-model.mjs'
import { useDeskVersion } from './useDesk'
import type { DeskState, DeskView, Reveal } from './view'

type Item = { key: string, type: string, [k: string]: any }
type Pairs = Array<[string, TechValue]>
const pairsOf = (rows: Array<[string, unknown]>): Pairs => rows.map(([k, v]) => [k, { text: String(v) }])
const copyOf = (rows: Array<[string, unknown]>) => rows.map(([k, v]) => (k ? `${k}: ${v}` : String(v))).join('\n')
const Tech = ({ rows }: { rows: Array<[string, unknown]> }) => (rows.length ? <TechDetails pairs={pairsOf(rows)} copy={copyOf(rows)} /> : null)
const Half = () => <span className="cwhalf" aria-hidden="true"><Svg html={HALF} /></span>

// ── the pins (decision 2), pure ───────────────────────────────────────────────────────────────────────────────────────
/** The indexes to draw: the visible range [startIndex, endIndex] widened by one window height `h` each way (by the item starts), the
 * pins, and the landing band — the items from index `band` through the last one starting within `h` after its start, clamped at the
 * list's end. `starts` are the items' starts in list order. */
export function withPins(range: { startIndex: number, endIndex: number, count: number, starts: ArrayLike<number>, h: number },
  pins: Array<number | null | undefined>, band: number | null): number[] {
  const { startIndex, endIndex, count, starts, h } = range
  const last = (y: number) => { let a = 0, b = count; while (a < b) { const m = (a + b) >> 1; if (starts[m] <= y) a = m + 1; else b = m } return a - 1 } // last start ≤ y
  const out = new Set<number>()
  const span = (lo: number, hi: number) => { for (let i = Math.max(0, lo); i <= Math.min(count - 1, hi); i++) out.add(i) }
  if (count) {
    span(Math.max(0, last(starts[Math.max(0, startIndex)] - h)), last(starts[Math.min(count - 1, endIndex)] + h))
    if (band != null && band >= 0 && band < count) span(band, Math.max(band, last(starts[band] + h - 0.5)))
  }
  for (const p of pins) if (p != null && p >= 0 && p < count) out.add(p)
  return [...out].sort((a, b) => a - b)
}
// ── the items ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const plainHead = (b: any) => b.head || { role: b.role || '', tag: b.kind || '', label: '' }
// the cell an open row holds: its bytes (addressed: the cache, `fail`, else pending), or the body the block carries itself; null: neither
const cellFor = (b: any): CellModel | null => (isAddressed(b) || hasInline(b) || (b.sec === 'tools' && (b.name != null || b.descChars != null || (b.props && b.props.length))) ? cellOf(b) : null)
// the words at an open row's label place: what its cell says of itself (headNote, by the cell's mode), else the row's own label
function HeadNote({ cell, label, id }: { cell: CellModel, label: string, id: string }) {
  const mode = useSyncExternalStore(onModeChange, () => modeOf(cell.bid)), got = gotOf(cell)
  const text = (got?.status === 'ok' && headNote(cell, got, mode)) || label
  return text ? <span className="cblabel" id={id} title={text}>{text}</span> : null
}
const FfBadge = ({ f, tech = '' }: { f: string, tech?: string }) => (f == null || f === 'verbatim' ? null
  : <span className={`ffbadge ff-${f}`} data-ff={f} title={tech || W.FF_WORD[f as keyof typeof W.FF_WORD] || W.FF_WORD.unknown}><Svg html={HALF} />{' ' + (W.FF_WORD[f as keyof typeof W.FF_WORD] || W.FF_WORD.unknown)}</span>)
const SrWord = ({ f }: { f: string }) => <span className="sr-only">,{W.FF_WORD[f as keyof typeof W.FF_WORD]}</span>

// THE row (2.3 §block 卡, decision 4): a plain click anywhere on the head toggles (one onClick on .cbh; the button's keyboard click
// bubbles to it); the button holds the chevron and the role, the reading text sits after it, so a drag over the label selects. Open,
// the head holds the cell's controls where the preview was (`head.preview`: the row's words only while closed)
type RowProps = { cls: string, attrs: Record<string, string | number | undefined>, head: any, open: boolean, chars: number | null,
  marks: ReactNode, onToggle: () => void, b: any, fail: any, api: any }
function RowView({ cls, attrs, head, open, chars, marks, onToggle, b, fail, api }: RowProps) {
  const id = useId(), tag = tagWord(head.tag), label = (open ? head.label : head.label || head.preview) || '', cell = open ? cellFor(b) : null
  return (
    <div className={`cblk${open ? '' : ' collapsed'} ${cls}`} {...attrs}>
      <div className="cbh" onClick={onToggle}>
        <button type="button" className="cbtog" aria-expanded={open} aria-controls={id + 'c'} aria-labelledby={label ? `${id}r ${id}l` : `${id}r`}>
          <Svg html={discChev(open)} /><span className="cbrole" id={id + 'r'}>{head.role}</span>
        </button>
        <span className="cbtag" title={tag || String(head.tag || '')}>{tag || W.TAG_UNKNOWN}</span>
        {cell ? <HeadNote cell={cell} label={label} id={id + 'l'} /> : label ? <span className="cblabel" id={id + 'l'} title={label}>{label}</span> : null}
        {marks}
        {typeof chars === 'number' ? <span className="cbchars">{`${kf(chars)} ${W.CHARS_WORD}`}</span> : null}
        {cell ? <CellBar cell={cell} api={api} /> : null}
      </div>
      <div className="cbc" id={id + 'c'} hidden={!open}>{!open ? null : cell ? <Cell cell={cell} fail={fail} api={api} bar={false} />
        : <div className="cbsrc warn"><Svg html={HALF} />{' ' + W.NO_BODY}</div>}</div>
    </div>
  )
}
type Acts = ReturnType<typeof makeActs>
const sameMarks = (a: any, b: any) => Object.keys(a).every((k) => a[k] === b[k])
const Row = memo(function Row({ it, acts, hl }: { it: Item, acts: Acts, hl: boolean, bv: number }) {
  const { b, marks: m, open } = it, h = plainHead(b)
  return <RowView cls={`${m.isNew ? 'is-new' : ''} s-${b.sec} r-${b.role} k-${b.kind}${it.turn != null ? ' cwtrow' : ''}${hl ? ' hl' : ''}`}
    attrs={{ 'data-bi': it.bi, 'data-sec': b.sec, 'data-ff': m.ff, 'data-rk': b.resKey || undefined, 'data-turn': it.turn ?? undefined }}
    head={{ role: h.role, tag: h.tag, label: h.label, preview: b.preview }} open={open} chars={typeof b.chars === 'number' ? b.chars : null}
    marks={<>
      {m.cc ? <span className="bpbadge" title={`${W.CACHE_MARK_TIP} · declared value: ${JSON.stringify(m.cc)}`}>{W.CACHE_MARK}</span> : null}
      {m.volatile ? <span className="volbadge" title={W.VOLATILE_MARK_TIP}>{W.VOLATILE_MARK}</span> : null}
      {m.isNew ? <span className="newmark" title={W.NEW_MARK_TIP}>{W.NEW_MARK}</span> : null}
      {m.badge ? <FfBadge f={m.ff} tech={m.tech} /> : null}
      {m.sr ? <SrWord f={m.sr} /> : null}
    </>}
    onToggle={() => acts.row(it)} b={b} fail={it.fail} api={acts.api} />
}, (p, n) => p.it.key === n.it.key && p.it.b === n.it.b && p.it.open === n.it.open && p.it.fail === n.it.fail && p.it.turn === n.it.turn
  && sameMarks(p.it.marks, n.it.marks) && p.hl === n.hl && p.acts === n.acts && (!n.it.open || p.bv === n.bv))

const CLAIM: Record<string, ReactNode> = {
  half: <span className="cwsecff" title={W.WINDOW_LINE}><Svg html={HALF} /></span>,
  verbatim: <span className="cwsecff v">{W.SECTION_VERBATIM}</span>,
  readable: <span className="cwsecff">{C.READABLE_VIEW}</span>,
}
const Sec = memo(function Sec({ it }: { it: Item }) {
  return <div className="cwsec" id={`sec-${it.sec}`}><b>{W.SECTION_NAME[it.sec as keyof typeof W.SECTION_NAME] || it.sec}</b><span className="cwsecn">{`${it.n} blocks`}</span>
    <span className="cwsecsz" title={it.est ? W.SECTION_SIZE_EST_TIP : W.SECTION_SIZE_TIP}>{`${it.est ? W.SECTION_SIZE_EST : ''} ${bytes(it.size)}`}</span>{(it.claim && CLAIM[it.claim]) || null}</div>
})
const Turn = memo(function Turn({ it, acts }: { it: Item, acts: Acts }) {
  const onKey = (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); acts.turn(it) } }
  return <div className={`cwturn${it.open ? '' : ' collapsed'}`} data-anchor={it.anchor}>
    <div className="cwturnhd" role="button" tabIndex={0} aria-expanded={it.open} onClick={() => acts.turn(it)} onKeyDown={onKey}>
      <span className="cwturnq" title={it.label}>{it.query ? <span className="qlabel">prompt</span> : null}{it.label}{it.acts ? <span className="qk">{it.acts}</span> : null}</span>
      <span className="cwturnn">{`${it.n} blocks`}</span>
    </div>
  </div>
})
const chHead = (b: any) => { const h = plainHead(b), t = tagWord(h.tag); return [h.role, t || h.tag, h.label || b.preview || ''].filter(Boolean).join(' · ') }
const Chline = memo(function Chline({ it }: { it: Item }) {
  const causeW = it.compaction ? W.CHANGE_COMPACT + (it.inferred ? `(${W.CHANGE_COMPACT_INFERRED})` : '') : W.causeWord(it.cause)
  return <div className="chline" id="cachebrk" title={W.changeFirstTip(chHead(it.first))}><span className="chbar" aria-hidden="true" />
    <span className="cht">{`${W.changeLine(it.k, causeW)} · `}<i className="chest" title={W.STRUCT_TIP}>{W.STRUCT_EST_WORD}</i>
      {it.auto ? <>{' · '}<i className="chest" title={W.STRUCT_TIP}>{W.CHANGE_REF_HINT}</i></> : null}</span></div>
})
// the removed list of the 内容对比步 (2.3): its rows open and close here only; their bytes are the window's to ask for
const Removed = memo(function Removed({ it, acts }: { it: Item, acts: Acts }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const flip = (j: number, b: any) => setOpen((o) => { const n = new Set(o); if (n.has(j)) n.delete(j); else { n.add(j); acts.ask(b) } return n })
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); acts.removed() } }
  return <div className={`cwremoved${it.open ? ' open' : ''}`}>
    <div className="cwremhd" data-navtoggle-rem="1" role="button" tabIndex={0} aria-expanded={it.open} onClick={acts.removed} onKeyDown={onKey}>
      <Svg html={discChev(it.open)} />{' ' + W.removedList(it.blocks.length, it.refK ?? '?')}</div>
    {it.open ? <div className="cwrembody">{it.blocks.map((b: any, j: number) => (
      <RowView key={j} cls="removed" attrs={{ 'data-rm': j, 'data-sec': b.sec }} head={plainHead(b)} open={open.has(j)} chars={null}
        marks={<><FfBadge f={faithOf(b)} tech={b.unaddressable} /><span className="remnote" title={`The full text is read back from its location in step ${it.refK ?? '?'}`}>removed</span></>}
        onToggle={() => flip(j, b)} b={b} fail={acts.fail(b)} api={acts.api} />
    ))}</div> : null}
  </div>
})

const Reply = memo(function Reply({ it, acts }: { it: Item, acts: Acts, bv: number }) {
  const stop = it.stop ? <span className="cbstop" dangerouslySetInnerHTML={{ __html: W.stopReasonRow(`<span class="mono">${esc(it.stop)}</span>`) }} /> : null
  let inner: ReactNode
  if (it.failed) inner = <div className="cwrline">{W.FAILED_NO_REPLY}{it.failed.reason ? <Tech rows={[['reason', it.failed.reason]]} /> : null}</div>
  else if (it.empty) inner = <div className="cwrline">{it.empty === 'unread' ? W.UNREAD_REPLY : W.EMPTY_REPLY}{stop}</div>
  else {
    inner = <div className="cwrrows">{it.rows.map((r: any) => (
      <RowView key={r.key} cls={`r-assistant k-${r.b.kind}`} attrs={{ 'data-rp': r.key, 'data-ff': r.mark }} head={{ role: 'assistant', tag: r.tag, preview: r.b.preview }}
        open={r.open} chars={typeof r.b.chars === 'number' && !r.hideChars ? r.b.chars : null}
        marks={<>{r.mark === 'verbatim' ? <SrWord f={r.sr} /> : <FfBadge f={r.mark} />}{r.last ? stop : null}</>}
        onToggle={() => acts.reply(r)} b={r.b} fail={acts.fail(r.b)} api={acts.api} />
    ))}</div>
  }
  return <div className="cwreply" role="group" aria-label={W.REPLY_WORD}>{inner}{it.assembled ? <div className="cwrline" data-assembled="">{C.ASSEMBLED}</div> : null}</div>
})
const Fid = ({ it }: { it: Item }) => <div className="cwfline"><Half />{' '}<span className="cwffacts">{it.facts.join(' · ')}</span><Tech rows={it.tech} /></div>
const Win = ({ it }: { it: Item }) => <div className="cwwin"><Half />{' ' + W.WINDOW_LINE}<Tech rows={it.reasons.map((r: string, i: number) => [`reason ${i + 1}`, r])} /></div>
const FoldAll = ({ acts }: { acts: Acts }) => <div className="cwfoldall">
  <button type="button" className="foldallbtn" data-foldall="open" title={W.FOLD_ALL_OPEN_TIP} onClick={() => acts.foldAll(true)}>{W.FOLD_ALL_OPEN}</button>
  <button type="button" className="foldallbtn" data-foldall="close" title={W.FOLD_ALL_CLOSE_TIP} onClick={() => acts.foldAll(false)}>{W.FOLD_ALL_CLOSE}</button></div>
const Unparsed = ({ it }: { it: Item }) => <div className="cwunparsed"><div className="cwuhd">{W.UNPARSED_TITLE}</div><div className="cwub">{W.UNPARSED_KEEP}</div>
  {it.errMsg ? <Tech rows={[['errMsg', it.errMsg]]} /> : null}</div>
// ⑧ no text, no control: the frames of a step whose lane is not held (2.3 §车道未到手)
const Frames = ({ it }: { it: Item }) => <div className="cwbusy" aria-busy="true">{it.frames.map((f: any) => <div key={f.sec} className="cwframe" data-sec={f.sec} style={{ '--fr': f.fr } as React.CSSProperties} />)}</div>
const Busy = ({ n = 0 }: { n?: number }) => <div className="cwbusy" aria-busy="true" style={n > 0 ? { '--n': n } as React.CSSProperties : undefined} />

function ItemView({ it, acts, hl, bv }: { it: Item, acts: Acts, hl: boolean, bv: number }) {
  switch (it.type) {
    case 'row': return <Row it={it} acts={acts} hl={hl} bv={bv} />
    case 'sec': return <Sec it={it} />
    case 'turn': return <Turn it={it} acts={acts} />
    case 'chline': return <Chline it={it} />
    case 'removed': return <Removed it={it} acts={acts} />
    case 'reply': return <Reply it={it} acts={acts} bv={bv} />
    case 'fid': return <Fid it={it} />
    case 'win': return <Win it={it} />
    case 'foldall': return <FoldAll acts={acts} />
    case 'noreq': return <div className="cwnoreq">{W.NO_REQUEST}</div>
    case 'unparsed': return <Unparsed it={it} />
    case 'frames': return <Frames it={it} />
    default: return null
  }
}
// ── the actions (wireCtxWin's semantics): mutate the desk's state, then re-render ─────────────────────────────────────
function makeActs(s: DeskState, bump: () => void) {
  // the window asks for a body: once per ref in flight (cell.mjs joins a second ask); a retryable failure is kept in s.bodyFail, so
  // the poll asks again and the row says why (2.3 §读失败)
  const ask = (b: any) => {
    if (!b || !isAddressed(b) || gotOf(cellOf(b))) return
    void loadBody(s.ctx.api, b.text_ref).then((got: any) => {
      if (isRetryable(got)) s.bodyFail.set(b.text_ref, got); else s.bodyFail.delete(b.text_ref)
      bump()
    })
  }
  const flipKey = (k: string) => { if (s.openBlocks.has(k)) s.openBlocks.delete(k); else s.openBlocks.add(k) }
  return {
    get api() { return s.ctx?.api }, ask,
    fail: (b: any) => (s.bodyFail && b.text_ref && s.bodyFail.get(b.text_ref)) || null,
    row(it: Item) { flipKey(it.key); if (!it.open) ask(it.b); bump() },
    reply(r: any) { flipKey(r.key); if (!r.open) ask(r.b); bump() },
    turn(it: Item) { setFold(s.turnFold, it.anchor, !it.open); s.persistFold(); bump() },
    foldAll(open: boolean) { for (const t of turnsOf(s.curFlat).list) setFold(s.turnFold, turnAnchorKey(s.curFlat, t), open); s.persistFold(); bump() },
    removed() { if (s.navOpen.has('cwremoved')) s.navOpen.delete('cwremoved'); else s.navOpen.add('cwremoved'); bump() },
  }
}
// the item heights CSS fixes (window.css), read once per window from its custom properties; open rows and groups are measured
const PITCH = { row: '--cblk-pitch', turn: '--cwturn-pitch', sec: '--cwsec-pitch', line: '--cwline-pitch' } as const
type Pitch = Record<keyof typeof PITCH, number>
function readPitch(el: HTMLElement): Pitch {
  const p = document.createElement('div')
  p.style.cssText = 'position:absolute;visibility:hidden;width:0'
  el.appendChild(p)
  const out = Object.fromEntries(Object.entries(PITCH).map(([k, name]) => { p.style.height = `var(${name})`; return [k, p.offsetHeight] })) as Pitch
  p.remove()
  return out
}
const rowEst = (open: boolean, P: Pitch) => (open ? P.row * 6 : P.row)
const estimate = (it: Item | undefined, P: Pitch) => {
  if (!it) return P.row
  switch (it.type) {
    case 'row': return rowEst(it.open, P)
    case 'turn': return P.turn
    case 'sec': return P.sec
    case 'reply': return P.line + (it.rows.reduce((a: number, r: any) => a + rowEst(r.open, P), 0) || P.row)
    case 'frames': return it.frames.reduce((a: number, f: any) => a + f.fr * P.row, 0) || P.row
    default: return P.line
  }
}
// the reply flips belong to the step they were made on (2.3 §这一步的回复): a step whose lane is held starts from the defaults
function resetReplyFlips(s: DeskState) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call || !call.rec || call.unparsed || !s.desk || s.replyFor === call.rid || !stepOf(s.desk, call.rid).held) return
  for (const k of [...s.openBlocks]) if (String(k).startsWith('rp:')) s.openBlocks.delete(k)
  s.replyFor = call.rid
}
const landIndex = (items: Item[], t: any, fi: number | null) => (!t ? -1 : t.reply ? items.findIndex((x) => x.type === 'reply')
  : t.anchor ? items.findIndex((x) => x.type === 'chline') : items.findIndex((x) => x.type === 'row' && x.bi === fi))
const matches = (x: Item, t: Reveal) => ('anchor' in t ? (t.anchor === 'cachebrk' ? x.type === 'chline' : x.type === 'sec' && `sec-${x.sec}` === t.anchor) : x.type === 'row' && x.bi === t.fi)

export function Window({ desk }: { desk: DeskView }) {
  const s = desk.s
  const ref = useRef<HTMLDivElement>(null)
  useDeskVersion(desk, 'window') // a paint of the 'window' area re-renders it
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useSyncExternalStore(onModeChange, modeVersion) // a mode change re-renders the section claims and the reply's closing line
  const acts = useMemo(() => makeActs(s, bump), [s])
  const [P, setP] = useState<Pitch | null>(null)
  const [hl, setHl] = useState<string | null>(null)
  const revealKey = useRef<string | null>(null)
  const prev = useRef<Item[] | null>(null)

  // the model of this render: the step's items, its landing (pure; a folded turn holding the target opens for this display)
  const w = s.win || { kind: 'empty', msg: '' }
  let items: Item[] | null = null, land: any = null
  if (w.kind === 'step') {
    resetReplyFlips(s)
    land = landingFor(s)
    if (land && land.turn != null) s.turnLanded.add(land.turn)
    const m = windowItems(s)
    // a step whose lane is not held keeps the rows drawn until the desk's 150 ms decision (busy) says to draw its frames
    items = m.state === 'none' ? null : m.state === 'frames' && !w.busy && prev.current ? prev.current : m.items
  }
  const list = items ?? []
  const landIdx = land ? landIndex(list, land.t, land.fi) : -1
  const bv = bodyVersion()

  // the pins: the change line, the reply, focus, the selection, the last reveal (by key: an index moves when items do)
  const keyAt = (n: Node | null | undefined) => {
    const e = n && (n.nodeType === 1 ? n as Element : n.parentElement), x = e && e.closest('[data-key]')
    return x && ref.current && ref.current.contains(x) ? x.getAttribute('data-key') : null
  }
  const sel = typeof document !== 'undefined' ? document.getSelection() : null
  const pinKeys = [keyAt(typeof document !== 'undefined' ? document.activeElement : null), keyAt(sel && sel.rangeCount ? sel.anchorNode : null), revealKey.current]
  const pins = [list.findIndex((x) => x.type === 'chline'), list.findIndex((x) => x.type === 'reply'), ...pinKeys.map((k) => (k ? list.findIndex((x) => x.key === k) : -1))]
  const vRef = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(null)
  // the sticky section header: the last header starting above the visible box's top
  const top = vRef.current?.scrollOffset ?? 0
  let stick = -1
  for (const m of vRef.current?.measurementsCache ?? []) { if (m.start > top) break; if (list[m.index]?.type === 'sec') stick = m.index }
  if (stick >= 0 && (vRef.current?.measurementsCache[stick]?.start ?? 0) >= top) stick = -1
  const pinSig = [...pins, stick, landIdx].join(',')
  const rangeExtractor = useCallback((r: Range) => {
    const ms = vRef.current?.measurementsCache ?? [], h = vRef.current?.scrollRect?.height ?? 0
    return withPins({ startIndex: r.startIndex, endIndex: r.endIndex, count: r.count, starts: ms.map((m) => m.start), h }, [...pins, stick], landIdx >= 0 ? landIdx : null)
  }, [pinSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/incompatible-library -- the window reads the virtualizer on every render
  const virt = useVirtualizer({
    count: list.length, getScrollElement: () => ref.current, overscan: 0, rangeExtractor, useFlushSync: false,
    getItemKey: (i) => list[i]?.key ?? i, estimateSize: (i) => estimate(list[i], P ?? { row: 1, turn: 1, sec: 1, line: 1 }),
    measureElement: (el) => (el as HTMLElement).offsetHeight,
  })
  vRef.current = virt
  prev.current = items

  useLayoutEffect(() => { setP(readPitch(ref.current!)) }, [])
  useLayoutEffect(() => { if (P) virt.measure() }, [P, virt])
  // the landing: once per rid, in the commit that drew the step's items (the band holds them before any scroll event)
  useLayoutEffect(() => {
    if (!land) return
    s.landedFor = s.anchor.calls[s.playhead].rid
    if (landIdx >= 0) virt.scrollToIndex(landIdx, { align: 'start' })
  })

  // reveal (view.reveal): open its turn into the D12 memory, or its row (and ask for the bytes), draw it, bring it into view, flash it
  const live = useRef({ list, virt })
  useLayoutEffect(() => { live.current = { list, virt } })
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    desk.setRevealer((t) => {
      const s = desk.s, flat = s.curFlat
      const fi = 'anchor' in t ? (t.anchor === 'cachebrk' ? s.anchor?.calls[s.playhead]?.cacheBreak?.idx ?? null : null) : t.fi
      if (flat && fi != null && flat[fi]) {
        const T = turnsOf(flat), ti = T.at[fi] ?? -1
        if (ti >= 0 && !turnOpen(s, flat, T, ti)) { setFold(s.turnFold, turnAnchorKey(flat, T.list[ti]), true); s.persistFold() }
        const k = s.curKeys?.[fi]
        if (!('anchor' in t) && t.open && k && !s.openBlocks.has(k)) { s.openBlocks.add(k); acts.ask(flat[fi]) }
      }
      flushSync(bump)
      const idx = live.current.list.findIndex((x) => matches(x, t))
      if (idx < 0) return null
      const key = live.current.list[idx].key
      revealKey.current = key
      flushSync(bump)
      live.current.virt.scrollToIndex(idx, { align: 'anchor' in t ? 'start' : 'center' })
      const wrap = ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      const el = (wrap?.firstElementChild as HTMLElement | null) ?? null
      if (el && t.flash) {
        flushSync(() => setHl(key))
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => setHl((h) => (h === key ? null : h)), t.flash)
      }
      return el
    })
    return () => { desk.setRevealer(null); if (timer) clearTimeout(timer) }
  }, [desk, acts])

  // the cell keys (2.3 §两种模式): v flips the focused row's cell, Shift+V the desk default, c copies; focus stays where it is
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const a = isTyping(e.nativeEvent) ? null : cellKey(e.nativeEvent), row = a && (e.target as Element).closest?.('.cblk')
    if (!a || !row) return
    e.preventDefault()
    const cell = row.querySelector<HTMLElement>(':scope > .cbc .cell')
    if (a.flipDesk) { flipDesk(); return }
    if (!cell) return
    const control = (sel: string) => row.querySelector<HTMLButtonElement>(`:scope > .cbh ${sel}`) // the controls sit in the row's head
    const flip = a.flip ? control(`[data-cellmode="${cell.dataset.mode === 'raw' ? 'read' : 'raw'}"]`) : null
    if (!a.flip) control('[data-cellcopy]')?.click()
    else if (flip) flip.click()
    else if (cell.dataset.only) say(C.RAW_ONLY)
  }

  let body: ReactNode
  if (w.kind === 'step' && items) {
    const vis = virt.getVirtualItems() // placed by `top`: in a transformed item an open row's sticky head does not stick
    body = <div className="cwlist" style={{ height: virt.getTotalSize() }}>
      {vis.map((x) => {
        const it = list[x.index]
        if (!it) return null
        const sticky = x.index === stick
        return <div key={it.key} className={sticky ? 'cwit cwstick' : 'cwit'} data-index={x.index} data-key={it.key} ref={virt.measureElement}
          style={sticky ? undefined : { top: x.start }}><ItemView it={it} acts={acts} hl={hl === it.key} bv={bv} /></div>
      })}
    </div>
  } else if (w.kind === 'rough') body = <Busy n={w.n} />
  else if (w.kind === 'notlisted') body = <div className="empty" id="notlisted">{SESSION_NOT_LISTED + ' · '}<a href="#/sessions">{BACK_TO_SESSIONS}</a></div>
  else if (w.kind === 'none') body = <div className="empty">{w.msg}</div>
  else if (w.kind === 'empty' && w.msg) {
    const rows: Array<[string, unknown]> = w.err ? [...(typeof w.err.status === 'number' ? [['status', w.err.status] as [string, unknown]] : []), ['error', w.err.error == null || w.err.error === '' ? '—' : w.err.error]] : []
    body = <div className="empty">{w.msg}
      {w.err ? <div className="emptywhy"><button type="button" className="linkbtn" data-retry="1" onClick={() => s.poll()}>{W.RETRY}</button><Tech rows={rows} /></div> : null}</div>
  } else body = <Busy />
  return <div id="ctxwin" ref={ref} onKeyDown={onKeyDown}>{body}</div>
}
function flipDesk() {
  setDeskMode(deskMode() === 'raw' ? 'read' : 'raw')
  say(deskMode() === 'read' ? C.READABLE_VIEW : C.RAW_VIEW)
}
