// web/src/screens/replay/Strip.test.tsx — the strip as React renders overviewModel() and scopeModel() over a hand-made desk with three
// parts (1.3 #8 #22). Geometry is what strip.mjs : stripLayout() says for the head's chapters; the controller's seams are vi.fn.
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Strip } from './Strip.tsx'
import { overviewModel, scopeModel } from './models.mjs'
import { stripLayout } from './strip.mjs'
import { deskOf as deskWorld } from '../../../../test/web-v2/desk-world.mjs'
import { buildLanes, anchorLane } from '../../../legacy/replay/lanes.mjs'

const deskOf = deskWorld as (lanes: object[], answer?: object) => any

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const LEFT = 30, N = 130, CHAPTERS = [[0, 40], [40, 100], [100, N]].map(([s0, s1], k) => ({ k, s0, s1, ts0: null, inferred: false }))
const ROWS = Array.from({ length: N }, () => ({ usage: { read: 1, create: 1, fresh: 1, out: 1 } }))

function world({ at = 55, span = { lo: 50, hi: 60 } as { lo: number, hi: number }, follow = false, W = 1000, K = 20, chapters = CHAPTERS } = {}) {
  const desk = deskOf([{ kind: 'main', rows: ROWS }])
  desk.head = { tier: 1, axis: 'R0-0', steps: N, peak: 1000, bucket: 1, chapters }
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  const s = { desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, sawView: 'ctx', problems: [], pricing: null, diffRef: null, reviewRange: null,
    span, follow, brushTo: vi.fn(), chapterGo: vi.fn(), setPlayhead: vi.fn(), followOff: vi.fn() } as any
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: W, left: LEFT, right: LEFT + W, top: 0, bottom: 24, height: 24, x: LEFT, y: 0, toJSON() {} } as DOMRect)
  const m = scopeModel(s, K) as any, ov = overviewModel(s) as any
  const { container } = render(<Strip desk={{ s, capacity: () => K } as any} m={m} ov={ov} />)
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel)
  const layout = stripLayout(chapters, W), strip = $('#ovstrip')!
  const px = (g: number) => LEFT + layout.xOf(g + 0.5) // the middle of step g, in client x
  const down = (g: number, on: Element = strip) => fireEvent.pointerDown(on, { clientX: px(g), pointerId: 1 })
  const move = (g: number) => fireEvent.pointerMove(strip, { clientX: px(g), pointerId: 1 })
  const up = (g: number) => fireEvent.pointerUp(strip, { clientX: px(g), pointerId: 1 })
  return { s, m, $, $$: (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)], layout, strip, px, down, move, up }
}
const last = (s: any) => { const [lo, hi] = s.brushTo.mock.lastCall; return { lo, hi } }

test('1.3 #8: one block per part at the layout\'s place, the window\'s part lit; the box only when the window is narrower than its part; the mark on the playhead wherever the window is', () => {
  const W = 1000
  const { $, $$, layout, m } = world({ at: 120, span: { lo: 50, hi: 60 }, W })
  const blocks = $$('.ovpart')
  expect(blocks.map((b) => +b.dataset.part!)).toEqual(CHAPTERS.map((_, k) => k))
  blocks.forEach((b, k) => {
    expect(parseFloat(b.style.left)).toBeCloseTo(layout.parts[k].x0 / W * 100, 2)
    expect(parseFloat(b.style.width)).toBeCloseTo((layout.parts[k].x1 - layout.parts[k].x0) / W * 100, 2)
  })
  expect(blocks.filter((b) => b.classList.contains('lit')).map((b) => +b.dataset.part!)).toEqual([m.part])
  expect(parseFloat($('#ovpin')!.style.left)).toBeCloseTo(layout.xOf(120.5) / W * 100, 2)
  expect(parseFloat($('#ovbrush')!.style.left)).toBeCloseTo(layout.xOf(50) / W * 100, 2)
  expect($$('.ovchap')).toHaveLength(0)
  cleanup()
  const whole = world({ at: 45, span: { lo: 40, hi: 100 }, K: 100 })
  expect(whole.m.box).toBeNull()
  expect(whole.$('#ovbrush')).toBeNull()
  expect(whole.$('#ovpin')).not.toBeNull()
})

test('1.3 #8: when the blocks do not fit, a tick stands at every part\'s start', () => {
  const W = 8, { $$, layout } = world({ W })
  expect(layout.ticks).toBe(true)
  const ticks = $$('.ovchap')
  expect(ticks).toHaveLength(CHAPTERS.length)
  ticks.forEach((t, k) => expect(parseFloat(t.style.left)).toBeCloseTo(layout.xOf(CHAPTERS[k].s0) / W * 100, 2))
})

test('1.3 #8: the strip is a slider whose value is the playhead\'s step', () => {
  const { strip } = world({ at: 120 })
  expect(strip.getAttribute('role')).toBe('slider')
  expect(strip.tabIndex).toBe(0)
  expect([strip.getAttribute('aria-valuemin'), strip.getAttribute('aria-valuemax'), strip.getAttribute('aria-valuenow')]).toEqual(['1', String(N), '121'])
})

test('1.3 #22: a drag moves the bars inside the part under the pointer, width kept, and never the playhead', () => {
  const { s, down, move, up } = world()
  down(52); move(70); up(70)
  const { lo, hi } = last(s)
  expect(hi - lo).toBe(10)
  expect(lo).toBeGreaterThanOrEqual(40)
  expect(hi).toBeLessThanOrEqual(100)
  expect(lo).toBeLessThanOrEqual(70)
  expect(hi).toBeGreaterThan(70)
  expect(s.setPlayhead).not.toHaveBeenCalled()
  expect(s.chapterGo).not.toHaveBeenCalled()
})

test('1.3 #22: a drag past the part\'s end stops the window at the end of the part', () => {
  const { s, down, move } = world()
  down(55); move(99)
  expect(last(s)).toEqual({ lo: 90, hi: 100 })
})

test('1.3 #22: the first drag move turns follow off, once; a session not followed is left alone', () => {
  for (const follow of [true, false]) {
    const { s, down, move, up } = world({ follow })
    down(55); move(60); move(70); up(70)
    expect(s.followOff).toHaveBeenCalledTimes(follow ? 1 : 0)
    cleanup()
  }
})

test('1.3 #22: crossing a break gives the new part\'s window around the pointer', () => {
  const { s, down, move } = world()
  down(55); move(120)
  const { lo, hi } = last(s), [, , c] = CHAPTERS
  expect(lo).toBeGreaterThanOrEqual(c.s0)
  expect(hi).toBeLessThanOrEqual(c.s1)
  expect(hi - lo).toBeLessThanOrEqual(20)
  expect(lo).toBeLessThanOrEqual(120)
  expect(hi).toBeGreaterThan(120)
  move(10) // and on into another: the window just taken is what the next move starts from
  expect(last(s).hi).toBeLessThanOrEqual(CHAPTERS[0].s1)
})

test('1.3 #22: the label stands by the pointer with the step under it while dragging, and goes when the drag ends or is cancelled', () => {
  const { $, down, move, up, strip } = world()
  expect($('.ovlabel')).toBeNull()
  down(55); move(70)
  expect($('.ovlabel')!.dataset.step).toBe('70')
  move(120)
  expect($('.ovlabel')!.dataset.step).toBe('120')
  up(120)
  expect($('.ovlabel')).toBeNull()
  down(55); move(70)
  fireEvent.pointerCancel(strip, { pointerId: 1 })
  expect($('.ovlabel')).toBeNull()
})

test('1.3 #22: a press that does not travel is a click: the playhead goes to that step and the bars are not dragged', () => {
  const { s, down, up, layout, px } = world()
  down(120); up(120)
  expect(s.chapterGo).toHaveBeenCalledTimes(1)
  expect(s.chapterGo).toHaveBeenCalledWith(layout.hit(px(120) - LEFT).g)
  expect(s.brushTo).not.toHaveBeenCalled()
})

test('1.3 #22: a cancelled press is no click', () => {
  const { s, down, strip } = world()
  down(120)
  fireEvent.pointerCancel(strip, { pointerId: 1 })
  expect(s.chapterGo).not.toHaveBeenCalled()
})

test('1.3 #22: a grip moves its edge alone, stays in the part, keeps a step, and stops at K', () => {
  const { s, $, down, move } = world({ K: 20 })
  const ends = (grip: string, from: number, to: number) => { down(from, $(grip)!); move(to); return last(s) }
  expect(ends('.ovh-r', 60, 99)).toEqual({ lo: 50, hi: 70 }) // K
  expect(ends('.ovh-r', 60, 20)).toEqual({ lo: 50, hi: 51 }) // past the other edge
  expect(ends('.ovh-l', 50, 20)).toEqual({ lo: 40, hi: 60 }) // the part's start is also K here
  expect(ends('.ovh-l', 50, 120)).toEqual({ lo: 59, hi: 60 })
  cleanup()
  const wide = world({ K: 200 })
  wide.down(60, wide.$('.ovh-r')!); wide.move(120)
  expect(last(wide.s)).toEqual({ lo: 50, hi: 100 }) // the part's end
})

test('1.3 #22: a double-click on the box gives the largest window the part fits, around the box', () => {
  const { s, $ } = world({ K: 20, span: { lo: 70, hi: 74 } })
  fireEvent.doubleClick($('#ovbrush')!)
  const { lo, hi } = last(s)
  expect(hi - lo).toBe(20)
  expect(lo).toBeGreaterThanOrEqual(40)
  expect(hi).toBeLessThanOrEqual(100)
  expect(lo).toBeLessThanOrEqual(72)
  expect(hi).toBeGreaterThan(72)
})
