// web/src/screens/replay/StepHead.test.tsx — the new desk's step head (2.2 §步头) over hand-made desks (desk-world.mjs deskOf): the
// step number reads N / M with the model's numbers and the model · time line beside it (not in it), the head is one row of the
// table's parts with no popover row while closed and no prompt ordinal (2.2 #19), the three read-outs are keyboard popovers (2.2 #17),
// 上下文 shows its calibre sentence when opened (2.2 #7), 对比 is a menu button whose choice renames it and × resets (2.2 #16), and the
// arrows pressed inside its menu or its step field stay there (1.2 #12). Expected values come from stepHeadModel and the labels.
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { deskOf } from '../../../../test/web-v2/desk-world.mjs'
import { buildLanes, anchorLane } from '../../../legacy/replay/lanes.mjs'
import { initKeys, isTyping, setScreenKeys } from '../../../legacy/core/keys.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { stepHeadModel } from './models.mjs'
import { StepHead } from './StepHead'
import { reactView } from './view'

afterEach(() => { cleanup(); document.body.replaceChildren(); setScreenKeys(null) })
beforeAll(() => initKeys())

const U = (read: number, create: number, fresh: number, out = 10) => ({ read, create, fresh, out })
const blk = (sec: string, role: string, bytes: number, extra = {}) => ({ sec, role, kind: 'text', bytes, chars: bytes, head: { role, tag: 'text', label: 'text' }, preview: 'p', ref: null, ...extra })
const ROWS = [{ usage: U(0, 10, 1), cacheBreak: { firstCall: true } }, { usage: U(5, 10, 1), cacheBreak: { cause: 'append' }, comp: { system: 50, user: 160 } }, { usage: U(5, 10, 1), cacheBreak: { cause: 'append' } }]
const BLOCKS = [100, 160, 400].map((n) => [blk('system', 'system', 50), blk('messages', 'user', n, { query: true })])

// a desk of one main lane at step `at`; setPlayhead / setDiff act on the state and repaint the step, as the controller does
function step({ at = 1, rows = ROWS, blocks = BLOCKS as unknown, extra = {} } = {}) {
  const desk = deskOf([{ kind: 'main', rows, blocks }])
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  const s: Record<string, any> = { desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, pricing: null, pricingErr: null, diffRef: null, view: { lo: 0, hi: 0 }, ...extra }
  const view = reactView(s, () => {}, () => {})
  s.setPlayhead = vi.fn((i: number) => { s.playhead = i; s.playRid = anchor.calls[i].rid; view.step() })
  s.setDiff = vi.fn((i: number | null) => { s.diffRef = i; view.step() })
  s.queueJump = vi.fn()
  render(<StepHead desk={view} />)
  const bar = () => document.querySelector<HTMLElement>('#stepbar')!
  return { s, view, bar, model: () => stepHeadModel(s) as any }
}
const press = async (el: Element, key: string) => { fireEvent.keyDown(el, { key }); fireEvent.keyUp(el, { key }); await act(async () => {}) }
const click = async (el: Element) => { fireEvent.pointerDown(el); fireEvent.mouseDown(el); fireEvent.pointerUp(el); fireEvent.mouseUp(el); fireEvent.click(el); await act(async () => {}) }
const readout = (label: string) => document.querySelector<HTMLElement>(`#stepbar .popbtn[aria-label="${label}"]`)!

test('.sb-no reads N / M with the model\'s n and m; the model · time line is beside it, not inside it', () => {
  for (const at of [0, 1, 2]) {
    const { bar, model } = step({ at })
    const m = model(), no = bar().querySelector('.sb-no')!
    const x = /(\d+)\s*\/\s*(\d+)/.exec(no.textContent!)!
    expect([+x[1], +x[2]]).toEqual([m.n, m.m])
    expect(no.getAttribute('data-n')).toBe(String(m.n))
    const time = [...bar().querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent === m.time)!
    expect(time).toBeTruthy()
    expect(no.contains(time)).toBe(false)
    cleanup()
  }
})

// 2.2 §步头's parts: the arrows and the number (with model · time), ◐, 对比, the three read-outs
const PARTS = new Set(['sb-nav', 'sb-fid', 'sb-cmp', 'sb-reads'])
test('2.2 #19: one row of the table\'s parts; while closed no popover row is in the DOM; there is no prompt ordinal', () => {
  const { bar, model } = step()
  for (const c of bar().children) expect(PARTS.has(c.className.split(' ')[0]), c.className).toBe(true)
  expect([...bar().children].map((c) => c.className.split(' ')[0])).toEqual(expect.arrayContaining(['sb-nav', 'sb-cmp', 'sb-reads']))
  expect(document.querySelector('[role="dialog"], .pp-row, .pp-busy')).toBeNull()
  const m = model()
  for (const rows of [m.cacheRows(), m.costRows(), m.compRows()]) {
    for (const r of rows) if (r.text) expect(bar().textContent).not.toContain(r.text)
  }
  expect(bar().querySelector('.sb-ask, [data-k]')).toBeNull()
  for (let k = 1; k <= 3; k++) expect(bar().textContent).not.toContain(W.askNo(k))
})

test('2.2 #17: the three read-outs are focusable buttons with aria-haspopup / aria-expanded; Enter opens a titled dialog, Esc closes it back to the button', async () => {
  step()
  for (const [label, title] of [[W.COMP_POPOVER_LABEL, W.COMP_TITLE], [W.CACHE_POPOVER_LABEL, W.CACHE_TITLE], [W.COST_POPOVER_LABEL, W.COST_TITLE]]) {
    const b = readout(label)
    expect(b.tagName).toBe('BUTTON')
    expect(b.getAttribute('aria-haspopup')).toBeTruthy()
    expect(b.getAttribute('aria-expanded')).toBe('false')
    act(() => b.focus())
    await press(b, 'Enter')
    const dlg = document.querySelector('[role="dialog"]')!
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(dlg.getAttribute('aria-labelledby')!)!.textContent).toBe(title)
    await press(document.activeElement!, 'Escape')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(b)
  }
})

test('2.2 #7, render half: opening 上下文 shows the calibre sentence compRows() carries', async () => {
  const { model } = step()
  const calibre = (model().compRows() as Array<{ key: string, text: string }>).find((r) => r.key === 'calibre')!
  expect(calibre.text).toBe(W.COMP_CALIBRE)
  const b = readout(W.COMP_POPOVER_LABEL)
  act(() => b.focus())
  await press(b, 'Enter')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(calibre.text)
})

test('2.2 #16: 对比 opens on click, not on hover; choosing step K renames it to K; × goes back to the default', async () => {
  const { s, bar, model } = step({ at: 2 })
  const btn = () => bar().querySelector<HTMLElement>('.sb-cmp button[aria-haspopup]')!
  expect(btn().textContent).toContain(W.COMPARE)
  fireEvent.mouseEnter(btn()); fireEvent.pointerEnter(btn()); fireEvent.mouseOver(btn())
  await act(async () => { await new Promise((r) => setTimeout(r, 350)) })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await click(btn())
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent === W.COMPARE_PICK)!)
  const K = 1
  const field = document.querySelector<HTMLInputElement>('input[type="number"]')!
  fireEvent.change(field, { target: { value: String(K) } })
  fireEvent.submit(field.form!)
  await act(async () => {})
  expect(s.setDiff).toHaveBeenLastCalledWith(K - 1)
  expect(model().compare.sel).toBe(K)
  expect(btn().textContent).toContain(W.compareAt(K).replace(/\s*×$/, ''))
  await click(bar().querySelector(`[aria-label="${W.CMP_RESET}"]`)!)
  expect(s.setDiff).toHaveBeenLastCalledWith(null)
  expect(model().compare.sel).toBe(null)
  expect(btn().textContent).not.toContain(W.compareAt(K).replace(/\s*×$/, ''))
})

test('1.2 #12: ←/→ on an open 对比 menu item and inside its step field are owned there; the playhead does not move', async () => {
  const { s, bar } = step({ at: 2 })
  const screen = vi.fn((e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') s.setPlayhead(s.playhead - 1, true) })
  setScreenKeys(screen)
  // not vacuous: the same keys on the page reach the screen's handler
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  expect(screen).toHaveBeenCalledTimes(1)
  s.setPlayhead.mockClear(); screen.mockClear()
  await click(bar().querySelector('.sb-cmp button[aria-haspopup]')!)
  const item = document.querySelector('[role="menuitem"]')!
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    expect(isTyping({ key, target: item })).toBe(true)
    fireEvent.keyDown(item, { key })
  }
  await click([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent === W.COMPARE_PICK)!)
  const field = document.querySelector('input[type="number"]')!
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    expect(isTyping({ key, target: field })).toBe(true)
    fireEvent.keyDown(field, { key })
  }
  expect(screen).not.toHaveBeenCalled()
  expect(s.setPlayhead).not.toHaveBeenCalled()
})
