// web/src/screens/replay/Window.test.tsx — the new desk's context window (2.3 §读与画「长对话的窗口」 · §block 卡 · §这一步的回复, 1.4 ①–⑨ ·
// §打开一步时落在哪, 1.2 格的键, D75④⑤): what the virtual list draws from the window model, its keys, its pins and landing band, who
// asks for bodies, the landing through the scroll position, reveal and the cell keys. Every expected value comes from windowItems or
// the list. jsdom has no layout: #ctxwin gets a client box and a scrollTo that moves scrollTop (as LibraryScreen.test.tsx), and an
// element's offsetHeight is the height window.css gives its kind (PX: a closed row, a turn head, a section header, a one-line item).
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { buildLanes, anchorLane } from '../../../legacy/replay/lanes.mjs'
import { stepOf } from '../../../legacy/replay/model.mjs'
import { bodyCache, deskMode, loadBodies, overrideScope, setDeskMode } from '../../../legacy/replay/cell.mjs'
import { initKeys, setScreenKeys } from '../../../legacy/core/keys.mjs'
import * as C from '../../../legacy/labels/cells.mjs'
import { deskOf, world, deskFrom } from '../../../../test/web-v2/desk-world.mjs'
import { windowItems } from './window-model.mjs'
import { reactView } from './view'
import { Window, withPins } from './Window'

const H = 600
const PX: Record<string, number> = { '--cblk-pitch': 30, '--cwturn-pitch': 40, '--cwsec-pitch': 46, '--cwline-pitch': 32 }
const OPEN_ROW = 4 * PX['--cblk-pitch']
let dispatchScroll = true
// the height of one item's root, by its kind (the item layer's wrapper is measured)
const sizeOf = (el: Element | null): number => {
  if (!el) return 0
  if (el.matches('.cblk')) return el.classList.contains('collapsed') ? PX['--cblk-pitch'] : OPEN_ROW
  if (el.matches('.cwturn')) return PX['--cwturn-pitch']
  if (el.matches('.cwsec')) return PX['--cwsec-pitch']
  if (el.matches('.cwreply')) return PX['--cwline-pitch'] + [...el.querySelectorAll('.cblk')].reduce((a, b) => a + sizeOf(b), 0)
  return PX['--cwline-pitch']
}
beforeAll(() => {
  initKeys()
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof IntersectionObserver
  for (const [k, v] of [['clientHeight', H], ['clientWidth', 900], ['scrollHeight', 1e6]] as const) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get(this: HTMLElement) { return this.id === 'ctxwin' ? v : 0 } })
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const m = /^var\((--[\w-]+)\)$/.exec(this.style?.height || '')
      if (m) return PX[m[1]] ?? 0
      return this.dataset?.index != null ? sizeOf(this.firstElementChild) : 0
    },
  })
  Element.prototype.scrollTo = function (this: Element, a?: ScrollToOptions | number, b?: number) {
    const top = typeof a === 'object' ? a.top : b
    if (top != null) { this.scrollTop = top; if (dispatchScroll) this.dispatchEvent(new Event('scroll')) }
  } as Element['scrollTo']
})
let n = 0
beforeEach(() => { bodyCache.clear(); overrideScope(`win ${n++}`); setDeskMode('raw'); dispatchScroll = true })
afterEach(() => { cleanup(); vi.restoreAllMocks(); setScreenKeys(null) })

// ── constructed desks (window-model.test.mjs's shapes) ────────────────────────────────────────────────────────────────
let rn = 0
type B = Record<string, any>
const blk = (o: B = {}) => ({ sec: 'messages', role: 'user', kind: 'text', head: { role: 'user', tag: 'user', label: 'block label' }, preview: 'p', chars: 5, bytes: 5, ref: `s/m#R::${rn++}-9`, ...o })
const say = (o: B = {}) => blk({ role: 'assistant', head: { role: 'assistant', tag: 'say', label: 'answer label' }, ...o })
const sys = (o: B = {}) => blk({ sec: 'system', role: 'system', head: { role: 'system', tag: 'text', label: 's' }, ...o })
const tool = (o: B = {}) => blk({ sec: 'tools', role: 'system', head: { role: 'system', tag: 'def', label: 't' }, ...o })
const rp = (kind: string, o: B = {}) => ({ kind, head: { role: 'assistant', tag: kind, label: kind }, preview: kind, chars: 4, bytes: 4, ref: `s/m#R::resp.raw::${rn++}-9`, ...o })
const deskN = (steps: B[][], rows: B[] = steps.map(() => ({})), o: { held?: boolean, replies?: B[][], details?: B[] } = {}) => deskOf([{
  kind: 'main', rows: rows.map((r) => ({ rec: { request: { model: 'm' } }, ...r })), blocks: o.held === false ? undefined : steps, replies: o.replies, details: o.details,
}])
type Api = { get: ReturnType<typeof vi.fn> }
const stateOf = (desk: any, playhead = 0, extra: B = {}) => {
  const lanes = buildLanes(desk)
  return {
    desk, lanes, anchor: anchorLane(lanes), playhead, diffRef: null, navOpen: new Set(['cwremoved']), openBlocks: new Set<string>(), turnFold: new Map<string, boolean>(),
    turnLanded: new Set<string>(), bodyFail: new Map(), ctx: { api: { get: vi.fn() } as Api }, persistFold: vi.fn(), poll: vi.fn(), landedFor: null, replyFor: null,
    win: { kind: 'step', busy: false }, ...extra,
  } as B
}
const flatOf = (s: B) => stepOf(s.desk, s.anchor.calls[s.playhead].rid).flat
function mount(s: B) {
  const desk = reactView(s, () => {}, () => {})
  const r = render(<Window desk={desk} />)
  const win = r.container.querySelector('#ctxwin') as HTMLElement
  return { desk, win, paint: (d?: object) => act(() => { desk.window(d) }) }
}
const itemsOf = (s: B) => windowItems(s).items as B[]
const drawn = (win: HTMLElement) => [...win.querySelectorAll<HTMLElement>('.cwit')].map((w) => w.dataset.key!)
const yOf = (w: HTMLElement) => Number(/translateY\(([-\d.]+)px\)/.exec(w.style.transform)?.[1] ?? NaN)
const wrapOf = (win: HTMLElement, key: string) => win.querySelector<HTMLElement>(`.cwit[data-key="${CSS.escape(key)}"]`)
// a long step: tools · system · a folded first turn (prompt a, rows to `split`) · the open last turn (prompt b), the change line at `brk`
function longDesk(len = 160, split = 90, brk = 60) {
  const msgs = Array.from({ length: len }, (_, i) => (i === 0 ? blk({ query: 'a', bid: 'm0' }) : i === split ? blk({ query: 'b', bid: `m${i}` }) : say({ bid: `m${i}` })))
  const flat = [tool({ bid: 't' }), sys({ bid: 's' }), ...msgs]
  return { flat, brk: brk + 2, desk: deskN([flat.slice(0, 3), flat], [{}, { cacheBreak: { cause: 'content-changed', idx: brk + 2, firstCall: false, refRid: 'R0-0' } }]) }
}

// 1.4 ①–⑨ by the item root's class; ⑥–⑧ stand in for ③④⑨
const SLOT: Array<[string, number]> = [['cwfline', 1], ['cwwin', 2], ['cwsec', 3], ['cwfoldall', 3], ['cblk', 3], ['cwturn', 3], ['chline', 3], ['cwremoved', 3], ['cwunparsed', 6], ['cwnoreq', 7], ['cwbusy', 8], ['cwreply', 9]]
const slotOf = (el: Element) => SLOT.find(([c]) => el.classList.contains(c))?.[1]

test('1.4 #8: the drawn items are the model\'s, in its order, their roots in whitelist order; a stand-in step has no section, line or reply', async () => {
  const states: B[] = []
  const desk = await deskFrom(world(3).get(), 'S')
  for (const lane of buildLanes(desk).slice(0, 2)) for (let p = 0; p < Math.min(4, lane.calls.length); p++) states.push(stateOf(desk, p, { anchor: lane }))
  const flat = [tool(), sys(), blk()]
  const rows = [{}, { unparsed: true, errMsg: 'E' }, { rec: null }, { cacheBreak: { cause: 'compaction', idx: 2, firstCall: false } }]
  const d2 = deskN(rows.map(() => flat), rows)
  for (let p = 0; p < rows.length; p++) states.push(stateOf(d2, p))
  states.push(stateOf(deskN([flat], [{ comp: { tools: 9000, messages: 3000 } }], { held: false })))
  for (const s of states) {
    const { win } = mount(s)
    const keys = itemsOf(s).map((it) => it.key), got = drawn(win)
    expect(got.length).toBeGreaterThan(0)
    expect(got.map((k) => keys.indexOf(k))).toEqual([...got.map((k) => keys.indexOf(k))].sort((a, b) => a - b))
    expect(got.every((k) => keys.includes(k))).toBe(true)
    const slots = [...win.querySelectorAll('.cwit')].map((w) => slotOf(w.firstElementChild!))
    expect(slots.every((x) => x != null)).toBe(true)
    expect(slots).toEqual([...slots].sort((a, b) => a! - b!))
    if (slots.some((x) => x! >= 6 && x! <= 8)) expect(win.querySelector('.cwsec, .chline, .cwreply')).toBeNull()
    cleanup()
  }
})

test('D75④: a row inserted before keeps every unchanged row\'s DOM node (an index-keyed copy of the list does not)', () => {
  const a = [sys({ bid: 's1' }), blk({ bid: 'q1', query: 'q' }), say({ bid: 'a1' }), say({ bid: 'a2' }), say({ bid: 'a3' })]
  const b = [a[0], blk({ bid: 'n1' }), ...a.slice(1)]
  const s = stateOf(deskN([a, b]))
  const { win, paint } = mount(s)
  const byBid = () => new Map([...win.querySelectorAll<HTMLElement>('.cblk[data-bi]')].map((e) => [flatOf(s)[+e.dataset.bi!].bid, e]))
  const before = byBid()
  s.playhead = 1
  paint({ kind: 'step', busy: false })
  const after = byBid()
  for (const bid of ['s1', 'q1', 'a1', 'a2', 'a3']) expect(after.get(bid)).toBe(before.get(bid))
  // the control: the same two lists drawn keyed by position lose a node the insert moved
  const listOf = (st: B) => itemsOf(st).filter((it) => it.type === 'row')
  function ByIndex({ st }: { st: B[] }) { return <>{st.map((it, i) => <div key={i} className={`r-${it.b.bid}`} />)}</> }
  let set: (x: B[]) => void = () => {}
  function Host() { const [st, s2] = useState(listOf({ ...s, playhead: 0 })); set = s2; return <ByIndex st={st} /> }
  const { container } = render(<Host />)
  const node = container.querySelector('.r-a3')
  act(() => set(listOf({ ...s, playhead: 1 })))
  expect(container.querySelector('.r-a3')).not.toBe(node)
})

test('2.3 §读与画: an answer that appends a row leaves an open row open with the same cell node', () => {
  const flat = [sys({ bid: 's1' }), blk({ bid: 'q1', query: 'q' }), say({ bid: 'a1' })]
  const s = stateOf(deskN([flat]))
  const key = itemsOf(s).find((it) => it.type === 'row' && it.b.bid === 'a1')!.key
  s.openBlocks.add(key)
  bodyCache.set(flatOf(s)[2].text_ref, { status: 'ok', text: 'the bytes' })
  const { win, paint } = mount(s)
  const cell = win.querySelector(`.cblk[data-bi="2"] .cell`)
  expect(cell).not.toBeNull()
  s.desk = deskN([[...flat, say({ bid: 'a2' })]]) // the same rid, one more row
  paint()
  const row = win.querySelector<HTMLElement>(`.cblk[data-bi="2"]`)!
  expect(row.classList.contains('collapsed')).toBe(false)
  expect(row.querySelector('.cell')).toBe(cell)
  expect(win.querySelector('.cblk[data-bi="3"]')).not.toBeNull()
})

test('2.3 #2: each row\'s data-ff and badge are the model\'s, 以下逐字 shows iff the claim is verbatim, and an unproven body changes both in the commit after it arrives', async () => {
  const ff = (f: string) => ({ ff: { faithfulness: f } })
  const s = stateOf(deskN([[tool(), tool(ff('metadata')), sys(), blk({ query: 'q', ...ff('opaque') }), say()]]))
  const { win } = mount(s)
  const check = () => {
    const items = itemsOf(s)
    for (const it of items.filter((x) => x.type === 'row')) {
      const el = win.querySelector<HTMLElement>(`.cblk[data-bi="${it.bi}"]`)!
      expect(el.dataset.ff).toBe(it.marks.ff)
      expect(!!el.querySelector(':scope > .cbh .ffbadge')).toBe(it.marks.badge)
    }
    for (const it of items.filter((x) => x.type === 'sec')) expect(!!win.querySelector(`#sec-${it.sec} .cwsecff.v`)).toBe(it.claim === 'verbatim')
    return items
  }
  const before = check()
  const last = before.filter((x) => x.type === 'row').at(-1)!
  expect(last.marks.ff).toBe('verbatim')
  s.ctx.api.get.mockResolvedValue({ ok: true, status: 200, data: { bytes: 'x', fidelity: { verbatim: false } } })
  await act(async () => { fireEvent.click(win.querySelector(`.cblk[data-bi="${last.bi}"] .cbrole`)!); await Promise.resolve() })
  const after = check()
  expect(after.find((x) => x.key === last.key)!.marks.ff).not.toBe('verbatim')
  expect(after.find((x) => x.type === 'sec' && x.sec === 'messages')!.claim).not.toBe('verbatim')
})

test('2.3 #14: the desk default Readable makes every section header say Readable view; back to Raw restores the proof rule\'s claim', () => {
  const s = stateOf(deskN([[tool(), sys(), blk({ query: 'q' }), say()]]))
  const { win } = mount(s)
  const claims = () => [...win.querySelectorAll('.cwsec')].map((h) => [h.id, h.querySelector('.cwsecff')?.className ?? null, h.querySelector('.cwsecff')?.textContent ?? null])
  const want = () => itemsOf(s).filter((x) => x.type === 'sec').map((x) => [`sec-${x.sec}`, x.claim === 'verbatim' ? 'cwsecff v' : x.claim ? 'cwsecff' : null, x.claim === 'readable' ? C.READABLE_VIEW : x.claim === 'verbatim' ? expect.any(String) : x.claim ? '' : null])
  const raw = want()
  act(() => setDeskMode('read'))
  expect(itemsOf(s).every((x) => x.type !== 'sec' || x.claim === 'readable')).toBe(true)
  expect(claims()).toEqual(want())
  act(() => setDeskMode('raw'))
  expect(claims()).toEqual(raw)
})

test('2.3 #13: one .cblk[data-rp] per reply row, none with data-bi / data-rk / data-sec, the stop reason on the last head only, the reply a named group', () => {
  const parts = [rp('thinking'), rp('text'), rp('tool_use', { name: 'Bash' })]
  const s = stateOf(deskN([[sys(), blk({ query: 'q', resKey: 'f' })]], [{}], { replies: [parts], details: [{ norm: { stop_reason: 'tool_use' } }] }))
  const { win } = mount(s)
  const reply = itemsOf(s).find((x) => x.type === 'reply')!
  const rows = [...win.querySelectorAll<HTMLElement>('.cwreply[role=group][aria-label] .cblk[data-rp]')]
  expect(rows.map((r) => r.dataset.rp)).toEqual(reply.rows.map((r: B) => r.key))
  for (const r of rows) for (const a of ['data-bi', 'data-rk', 'data-sec']) expect(r.hasAttribute(a)).toBe(false)
  expect(rows.map((r) => !!r.querySelector(':scope > .cbh .cbstop'))).toEqual(rows.map((_, i) => i === rows.length - 1))
})

test('1.2 格的键 · 2.3 #19: v, Shift+V and c act only from inside a row; f, ?, n, p and the arrows reach the screen\'s keys', async () => {
  const s = stateOf(deskN([[sys(), blk({ query: 'q' }), say()]]))
  const key = itemsOf(s).find((it) => it.type === 'row' && it.bi === 2)!.key
  s.openBlocks.add(key)
  bodyCache.set(flatOf(s)[2].text_ref, { status: 'ok', text: '{"a":1}' })
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { writes.push(t) } } })
  const seen: string[] = []
  setScreenKeys((e: KeyboardEvent) => { seen.push(e.key) })
  const { win } = mount(s)
  const tog = win.querySelector<HTMLElement>('.cblk[data-bi="2"] .cbtog')!, out = win.querySelector<HTMLElement>('.foldallbtn')!
  const mode = () => win.querySelector<HTMLElement>('.cblk[data-bi="2"] .cell')!.dataset.mode
  tog.focus()
  const m0 = mode()
  act(() => { fireEvent.keyDown(out, { key: 'v' }) })
  expect(mode()).toBe(m0)
  act(() => { fireEvent.keyDown(tog, { key: 'v' }) })
  expect(mode()).not.toBe(m0)
  expect(document.activeElement).toBe(tog)
  const d0 = deskMode()
  act(() => { fireEvent.keyDown(out, { key: 'V', shiftKey: true }) })
  expect(deskMode()).toBe(d0)
  act(() => { fireEvent.keyDown(tog, { key: 'V', shiftKey: true }) })
  expect(deskMode()).not.toBe(d0)
  await act(async () => { fireEvent.keyDown(out, { key: 'c' }); await Promise.resolve() })
  expect(writes).toEqual([])
  await act(async () => { fireEvent.keyDown(tog, { key: 'c' }); await Promise.resolve() })
  expect(writes).toEqual(['{"a":1}'])
  const pass = ['f', '?', 'n', 'p', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
  seen.length = 0
  for (const k of pass) fireEvent.keyDown(tog, { key: k })
  expect(seen).toEqual(pass)
})

test('2.3 #28: reveal into a folded turn opens it into the D12 memory; reveal of a row not drawn returns it drawn and open', () => {
  const { desk, brk } = longDesk(300, 200)
  const s = stateOf(desk, 1, { landedFor: 'R0-1' }) // no landing: the window stays at its top
  s.ctx.api.get.mockReturnValue(new Promise(() => {}))
  const { desk: view, win } = mount(s)
  const folded = itemsOf(s).find((x) => x.type === 'turn' && !x.open)!
  const fi = flatOf(s).findIndex((b: B, i: number) => i > brk && b.sec === 'messages' && i < 200)
  let el: HTMLElement | null = null
  act(() => { el = view.reveal({ fi }) })
  expect(s.turnFold.get(folded.anchor)).toBe(true)
  expect(s.persistFold).toHaveBeenCalled()
  expect(el).toBe(win.querySelector(`.cblk[data-bi="${fi}"]`))
  const far = flatOf(s).length - 3
  expect(win.querySelector(`.cblk[data-bi="${far}"]`)).toBeNull()
  act(() => { el = view.reveal({ fi: far, open: true }) })
  expect(el).not.toBeNull()
  expect(el!.isConnected).toBe(true)
  expect(el!.dataset.bi).toBe(String(far))
  expect(el!.classList.contains('collapsed')).toBe(false)
})

test('pins: withPins always holds the four pins and the widened range, sorted once each', () => {
  const r = (seed: number) => { let a = seed; return () => ((a = (a * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) }
  for (let k = 1; k < 40; k++) {
    const rnd = r(k), count = 1 + Math.floor(rnd() * 200), starts: number[] = []
    for (let i = 0, y = 0; i < count; i++) { starts.push(y); y += 10 + Math.floor(rnd() * 90) }
    const a = Math.floor(rnd() * count), b = Math.min(count - 1, a + Math.floor(rnd() * 10)), pins = [0, 1, 2, 3].map(() => Math.floor(rnd() * count))
    const out = withPins({ startIndex: a, endIndex: b, count, starts, h: 300 }, pins, null)
    for (const p of pins) expect(out).toContain(p)
    for (let i = a; i <= b; i++) expect(out).toContain(i)
    expect(out).toEqual([...new Set(out)].sort((x, y) => x - y))
    expect(out.every((i) => i >= 0 && i < count)).toBe(true)
  }
})

test('landing band: withPins holds the landing index through the last item starting within one window height after it, clamped at the end', () => {
  const sizes = [30, 46, 30, 120, 30, 40, 30, 30, 120, 30, 30, 32, 30]
  const starts = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0))
  for (const h of [50, 200, 600]) {
    for (let band = 0; band < sizes.length; band++) {
      const out = withPins({ startIndex: 0, endIndex: 0, count: sizes.length, starts, h }, [], band)
      const seen = starts.map((_, i) => i).filter((i) => starts[i] <= h) // the visible range (item 0) widened by h
      const want = starts.map((_, i) => i).filter((i) => i >= band && starts[i] < starts[band] + h)
      expect(out).toEqual([...new Set([...seen, ...want])].sort((x, y) => x - y))
    }
  }
})

test('pins and landing: the change line and the reply stay drawn scrolled away; a step change draws its landing band before any scroll event and lands it at the top; a repaint, a reader\'s scroll and a step with no landing keep scrollTop; the landing turn is not in D12', () => {
  const { desk, brk } = longDesk(300, 200, 60)
  const parts = [rp('text')]
  const d = deskOf([{ kind: 'main', rows: [{ rec: { request: { model: 'm' } } }, { rec: { request: { model: 'm' } }, cacheBreak: stepOf(desk, 'R0-1') && { cause: 'content-changed', idx: brk, firstCall: false, refRid: 'R0-0' } }], blocks: [stepOf(desk, 'R0-0').flat, stepOf(desk, 'R0-1').flat], replies: [[], parts] }])
  const s = stateOf(d, 0)
  const { win, paint } = mount(s)
  win.scrollTo({ top: 0 })
  dispatchScroll = false // the virtualizer hears no scroll: what is drawn is the band's doing
  s.playhead = 1
  paint({ kind: 'step', busy: false })
  const items = itemsOf(s), at = items.findIndex((x) => x.type === 'chline')
  const line = wrapOf(win, 'chline')!
  expect(line).not.toBeNull()
  expect(win.scrollTop).toBe(yOf(line))
  // every item starting within one window height of the landing item's start is drawn
  let y = yOf(line)
  for (let i = at; i < items.length && y < yOf(line) + H; i++) {
    const w = wrapOf(win, items[i].key)
    expect(w, items[i].key).not.toBeNull()
    y = yOf(w!) + sizeOf(w!.firstElementChild)
  }
  const turn = items.find((x) => x.type === 'turn' && x.anchor && s.turnLanded.has(x.anchor))
  expect(turn).toBeDefined()
  expect(s.turnFold.has(turn!.anchor)).toBe(false)
  // the pins, scrolled far away
  dispatchScroll = true
  const landed = win.scrollTop
  paint()
  expect(win.scrollTop).toBe(landed)
  act(() => { win.scrollTo({ top: landed + 4000 }) })
  expect(win.querySelector('#cachebrk')).not.toBeNull()
  expect(win.querySelector('.cwreply')).not.toBeNull()
  paint()
  expect(win.scrollTop).toBe(landed + 4000)
  // a step whose landing names nothing (the first step) leaves the reader's scroll
  s.playhead = 0
  paint({ kind: 'step', busy: false })
  expect(win.scrollTop).toBe(landed + 4000)
})

test('2.3 #10: a step whose lane is not held is frames: aria-busy, no button, link or tabindex', () => {
  const s = stateOf(deskN([[tool(), sys(), blk()]], [{ comp: { tools: 9000, system: 2000, messages: 3000 } }], { held: false }))
  const { win } = mount(s)
  const busy = win.querySelector('.cwbusy')!
  expect(busy.getAttribute('aria-busy')).toBe('true')
  expect(busy.querySelectorAll('.cwframe[data-sec]').length).toBe(itemsOf(s).find((x) => x.type === 'frames')!.frames.length)
  expect(busy.querySelector('button, a, [tabindex]')).toBeNull()
})

test('2.3 #3: the cache mark iff the block declares one, the volatile mark iff it is volatile, never 「新」 on a volatile row', () => {
  const a = [sys({ key: 's' }), blk({ key: 'q', query: 'q' })]
  const b = [...a, say({ key: 'c', cc: { type: 'ephemeral' } }), say({ key: 'v', volatile: true }), say({ key: 'n' })]
  const s = stateOf(deskN([a, b]), 1)
  const { win } = mount(s)
  const rows = itemsOf(s).filter((x) => x.type === 'row')
  expect(rows.some((x) => x.marks.isNew)).toBe(true)
  for (const it of rows) {
    const h = win.querySelector(`.cblk[data-bi="${it.bi}"] > .cbh`)!
    expect(!!h.querySelector('.bpbadge')).toBe(!!it.marks.cc)
    expect(!!h.querySelector('.volbadge')).toBe(it.marks.volatile)
    if (it.marks.volatile) expect(h.querySelector('.newmark')).toBeNull()
  }
})

// ── who asks for bodies ───────────────────────────────────────────────────────────────────────────────────────────────
const blockReads = (api: Api) => api.get.mock.calls.filter((c) => c[0] === 'block').length
const deferred = () => { let res: (v: unknown) => void = () => {}; const p = new Promise((r) => { res = r }); return { p, res } }

test('2.3 §快速拖动: opening an uncached row reads it once, a reopen while it is in flight reads nothing more', async () => {
  const s = stateOf(deskN([[sys(), blk({ query: 'q' }), say()]]))
  const d = deferred()
  s.ctx.api.get.mockImplementation(() => d.p)
  const { win } = mount(s)
  const role = () => win.querySelector<HTMLElement>('.cblk[data-bi="2"] .cbrole')!
  act(() => { fireEvent.click(role()) })
  act(() => { fireEvent.click(role()) })
  act(() => { fireEvent.click(role()) })
  expect(blockReads(s.ctx.api)).toBe(1)
  await act(async () => { d.res({ ok: true, status: 200, data: { bytes: 'the bytes', fidelity: { verbatim: true } } }); await d.p })
  expect(win.querySelector('.cblk[data-bi="2"] .cell')).not.toBeNull()
})

test('2.3 §读失败: a failed read shows its reason on the row, and the next open reads again', async () => {
  const s = stateOf(deskN([[sys(), blk({ query: 'q' }), say()]]))
  s.ctx.api.get.mockResolvedValue({ ok: false, status: 500, error: 'reason-from-server' })
  const { win } = mount(s)
  const role = () => win.querySelector<HTMLElement>('.cblk[data-bi="2"] .cbrole')!
  await act(async () => { fireEvent.click(role()); await Promise.resolve(); await Promise.resolve() })
  const ref = flatOf(s)[2].text_ref
  expect(s.bodyFail.get(ref)?.error).toBe('reason-from-server')
  expect(win.querySelector('.cblk[data-bi="2"] .cbc .cbsrc')?.textContent).toContain(s.bodyFail.get(ref).error)
  act(() => { fireEvent.click(role()) })
  await act(async () => { fireEvent.click(role()); await Promise.resolve() })
  expect(blockReads(s.ctx.api)).toBe(2)
})

test('2.3 #25: a step painted with a row already open reads nothing; the row is pending until its bytes are cached and the window is painted', async () => {
  const s = stateOf(deskN([[sys(), blk({ query: 'q' }), say()]]))
  s.openBlocks.add(itemsOf(s).find((it) => it.type === 'row' && it.bi === 2)!.key)
  const { win, paint } = mount(s)
  expect(blockReads(s.ctx.api)).toBe(0)
  expect(win.querySelector('.cblk[data-bi="2"] .cellpend')).not.toBeNull()
  const own = { get: vi.fn(async () => ({ ok: true, status: 200, data: { bytes: 'b', fidelity: { verbatim: true } } })) } // the step's own read
  await loadBodies(own, [flatOf(s)[2].text_ref])
  expect(win.querySelector('.cblk[data-bi="2"] .cellpend')).not.toBeNull()
  paint({ kind: 'step', busy: false })
  expect(win.querySelector('.cblk[data-bi="2"] .cell')).not.toBeNull()
  expect(blockReads(s.ctx.api)).toBe(0)
})
