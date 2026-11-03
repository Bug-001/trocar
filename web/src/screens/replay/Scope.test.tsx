// web/src/screens/replay/Scope.test.tsx — the scope as React renders scopeModel() (1.3 #1 #8 #18 #19, 2.1 #5, D75④) over hand-made desks
// (test/web-v2/desk-world.mjs deskOf). Expected values are the model's own fields or the rows', never the component's output.
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Scope } from './Scope'
import { reactView } from './view'
import { scopeModel } from './models.mjs'
import { deskOf as deskWorld } from '../../../../test/web-v2/desk-world.mjs'
import { buildLanes, anchorLane } from '../../../legacy/replay/lanes.mjs'
import { problemSteps } from '../../../legacy/replay/timeline.mjs'

const deskOf = deskWorld as (lanes: object[], answer?: object) => any

afterEach(() => { cleanup(); document.body.replaceChildren() })

const U = (read: number, create: number, fresh: number) => ({ read, create, fresh, out: 10 })
// a failed step, a break, an inferred compaction, prompts on two steps, comp on most rows
const ROWS = [
  { usage: U(0, 100, 10), cacheBreak: { firstCall: true }, comp: { system: 3, user: 7 } },
  { usage: U(90, 20, 5), cacheBreak: { cause: 'append' }, comp: { system: 3, user: 9, tool_result: 4 } },
  { usage: U(0, 120, 5), cacheBreak: { cause: 'tool-array-reorder' }, comp: { tools: 2, user: 1 } },
  { usage: null, error: 'rate limited', cacheBreak: { cause: 'append' } },
  { usage: U(10, 100, 5), cacheBreak: { cause: 'append' }, comp: { user: 5 } },
  { usage: U(50, 10, 40), wire: { cacheSemanticsKnown: false }, cacheBreak: { cause: 'append' } },
  { usage: U(0, 200, 5), compaction: true, compactionInferred: true, cacheBreak: { cause: 'compaction' }, comp: { system: 1 } },
  { usage: U(200, 10, 5), cacheBreak: { cause: 'append' }, comp: { assistant: 2, thinking: 1 } },
]
const EVENTS = [{ type: 'user', rid: 'R0-1', lane: 'R0-0' }, { type: 'user', rid: 'R0-4', lane: 'R0-0' }]

function stateOf(desk: any, { at = 0, view = null as null | { lo: number, hi: number }, ...extra } = {}) {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes), N = anchor.calls.length
  return { desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, view: view || { lo: 0, hi: N }, sawView: 'ctx',
    problems: problemSteps(anchor), pricing: { m: [3, 15, 3.75, 0.3] }, diffRef: null, reviewRange: null,
    setPlayhead: vi.fn(), setView: vi.fn(), chapterGo: vi.fn(), jumpTo: vi.fn(), refit: () => {}, ...extra } as any
}
function mount(s: any) {
  const desk = reactView(s, () => {}, () => {})
  document.body.append(desk.root)
  const r = render(<Scope desk={desk} />, { container: desk.root })
  act(() => { desk.saw(); desk.overview() })
  const $ = (sel: string) => desk.root.querySelector<HTMLElement>(sel)
  const $$ = (sel: string) => [...desk.root.querySelectorAll<HTMLElement>(sel)]
  return { s, desk, $, $$, r, model: () => scopeModel(s, desk.capacity()) as any }
}
const world = (o: object = {}) => mount(stateOf(deskOf([{ kind: 'main', rows: ROWS }], { events: EVENTS }), o))

test('1.3 #1: every track is a .tkrow of exactly a .tgut and a .tlane', () => {
  const { $ } = world({ at: 2 })
  for (const sel of ['#chapnav', '.sawaxis', '#probrow', '#sawrow', '#cacherow', '#askscale', '#ovstrip']) {
    const row = $(sel)!.closest('.tlane')!.parentElement!
    expect(row.classList.contains('tkrow'), sel).toBe(true)
    expect([...row.children].map((c) => c.className.split(' ')[0]), sel).toEqual(['tgut', 'tlane'])
  }
})

test('1.3 #19: the legend is the first row; #rails comes after the prompts row and before the overview; one playhead; the gutter shares', () => {
  for (const at of ROWS.keys()) {
    const { s, desk, $, $$ } = world({ at })
    expect($('#saw')!.firstElementChild!.classList.contains('sawlegend')).toBe(true)
    const rails = $('#rails')!
    expect($('#askrow')!.compareDocumentPosition(rails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rails.compareDocumentPosition($('.tkrow-ovw')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect($$('.scur')).toHaveLength(1)
    const comp: Record<string, number> | undefined = (ROWS[at] as any).comp
    const shares = $$('#sawgut .gshare')
    expect(shares, `step ${at}`).toHaveLength(comp ? Object.values(comp).filter((v) => v > 0).length : 0)
    for (const g of shares) expect(g.textContent).toContain('≈')
    act(() => { s.sawView = 'cost'; desk.saw() })
    expect($$('#sawgut .gshare'), `step ${at} cost view`).toHaveLength(0)
    cleanup(); document.body.replaceChildren()
  }
})

test('1.3 #8 gestures: dragging the brush body pans, a grip zooms, a double-click shows all', () => {
  const view = { lo: 2, hi: 5 }, { s, $ } = world({ at: 3, view }), N = ROWS.length, W = 800
  const strip = $('#ovstrip')!
  strip.getBoundingClientRect = () => ({ width: W, left: 0, right: W, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON() {} }) as DOMRect
  const drag = (sel: string, steps: number) => {
    fireEvent.pointerDown($(sel)!, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(strip, { clientX: 100 + (steps * W) / N, pointerId: 1 })
    fireEvent.pointerUp(strip, { pointerId: 1 })
  }
  drag('#ovbrush', 1); expect(s.setView).toHaveBeenLastCalledWith(view.lo + 1, view.hi + 1, false)
  drag('.ovh-l', -1); expect(s.setView).toHaveBeenLastCalledWith(view.lo - 1, view.hi, false)
  drag('.ovh-r', 2); expect(s.setView).toHaveBeenLastCalledWith(view.lo, view.hi + 2, false)
  expect(s.brushDragging).toBe(false)
  fireEvent.doubleClick($('#ovbrush')!); expect(s.setView).toHaveBeenLastCalledWith(0, N, true)
})

test('1.3 #18 render: label k / n, a–b and inferred; ‹ › disabled at the ends; one overview tick per chapter start', () => {
  const N = ROWS.length, starts = [0, 3, 6]
  for (const at of [0, 4, 7]) {
    const desk = deskOf([{ kind: 'main', rows: ROWS }], { events: EVENTS })
    desk.head = { tier: 1, axis: 'R0-0', steps: N, peak: 1000, bucket: 1, chapters: starts.map((s0, k) => ({ k, s0, s1: starts[k + 1] ?? N, ts0: null, inferred: s0 === 6 })) }
    const { $, $$, model } = mount(stateOf(desk, { at, view: null }))
    const c = model().chapters, lab = $('#chapnav .chaplabel')!
    expect([lab.dataset.part, lab.dataset.of, lab.dataset.s0, lab.dataset.s1, lab.dataset.inferred]).toEqual([c.k, c.n, c.a - 1, c.b, c.inferred].map(String))
    expect(lab.textContent).toBe(c.label)
    expect(($('#chapPrev') as HTMLButtonElement).disabled).toBe(c.prev == null)
    expect(($('#chapNext') as HTMLButtonElement).disabled).toBe(c.next == null)
    const ticks = model().overview.chapterTicks
    expect($$('#ovstrip .ovchap')).toHaveLength(c.n)
    $$('#ovstrip .ovchap').forEach((t, j) => expect(parseFloat(t.style.left)).toBeCloseTo(ticks[j].left * 100, 2))
    cleanup(); document.body.replaceChildren()
  }
})

test('1.3 marks: trace columns, flags, × and compaction carry the model\'s tip and aria; marks are focusable; a bar or a mark moves the playhead to its step', () => {
  const { s, $, $$, model } = world({ at: 1 })
  const m = model()
  expect($$('#cacherow .cbar').map((c) => [c.title, c.getAttribute('aria-label')])).toEqual(m.trace.map((t: any) => [t.tip, t.tip]))
  const marks = $$('#probrow [data-i]')
  expect(marks.map((e) => [+e.dataset.i!, e.title, e.getAttribute('aria-label')])).toEqual(m.problems.items.map((p: any) => [p.i, p.tip, p.aria]))
  expect(new Set(m.problems.items.map((p: any) => p.kind))).toEqual(new Set(['flag', 'x', 'compact']))
  for (const e of marks) { e.focus(); expect(document.activeElement).toBe(e) }
  for (const e of marks) { fireEvent.click(e); expect(s.setPlayhead).toHaveBeenLastCalledWith(+e.dataset.i!, true) }
  const bar = $$('#sawrow .bar')[4]
  fireEvent.click(bar); expect(s.setPlayhead).toHaveBeenLastCalledWith(m.bars[4].i, true)
})

test('D75④: with a row inserted before the window (every i + 1), the bars of unchanged rows are the same DOM nodes', () => {
  const rid = (i: number) => ({ rid: `k${i}` })
  const rows = ROWS.map((r, i) => ({ ...r, ...rid(i) }))
  const one = (extra: object[]) => deskOf([{ kind: 'main', rows: [{ usage: U(1, 1, 1) }, ...extra, ...rows] }])
  const s = stateOf(one([]), { at: 3, view: { lo: 1, hi: 1 + rows.length } })
  const { desk, $$ } = mount(s)
  const before = $$('#sawrow .bar'), at0 = before.map((b) => +b.dataset.i!)
  act(() => { Object.assign(s, stateOf(one([{ usage: U(2, 2, 2), rid: 'new' }]), { at: 4, view: { lo: 2, hi: 2 + rows.length } })); desk.saw() })
  const after = $$('#sawrow .bar')
  expect(after.map((b) => +b.dataset.i!)).toEqual(at0.map((i) => i + 1))
  before.forEach((b, j) => expect(after[j], `bar ${j}`).toBe(b))
})

test('2.1 #5 render: with a review range the bars below k are .reviewed and the bracket is review.width wide, through a step change', () => {
  const k = 5, { s, desk, $, $$, model } = world({ at: 1, view: { lo: 2, hi: ROWS.length }, reviewRange: { k } })
  act(() => { desk.review() })
  for (const at of [1, 6]) {
    if (at !== 1) act(() => { s.playhead = at; s.playRid = s.anchor.calls[at].rid; desk.cur() })
    const m = model()
    expect($$('#sawrow .bar').map((b) => b.classList.contains('reviewed'))).toEqual(m.bars.map((b: any) => b.i < k))
    expect(parseFloat($('#reviewbracket')!.style.width)).toBeCloseTo(m.review.width * 100, 2)
    expect($('#reviewbracket')!.style.display).toBe('block')
  }
})
