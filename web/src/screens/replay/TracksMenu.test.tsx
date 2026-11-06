// web/src/screens/replay/TracksMenu.test.tsx — the Tracks menu (2.1 ⑥, 2.1 #18, 1.2 #26's hide half) over hand-made desks (desk-world.mjs deskOf).
// Expected values come from railToggles / problemTarget / problemJump and the rows, never from the component's output. ←/→ pressed in
// the menu stay there through the guard on role=menu: StepHead.test.tsx's 1.2 #12 covers it.
import { Activity, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { deskOf as deskWorld } from '../../../../test/web-v2/desk-world.mjs'
import { anchorLane, buildLanes } from '../../../legacy/replay/lanes.mjs'
import { railToggles } from '../../../legacy/replay/rails.mjs'
import { problemJump, problemSteps, problemTarget } from '../../../legacy/replay/timeline.mjs'
import { Scope } from './Scope'
import { TracksMenu } from './TracksMenu'
import { reactView } from './view'

const deskOf = deskWorld as (lanes: object[]) => any

afterEach(() => { cleanup(); document.body.replaceChildren() })

const OK = { usage: { read: 90, create: 10, fresh: 5, out: 10 }, cacheBreak: { firstCall: true } }
const BAD = { usage: null, error: 'rate limited', cacheBreak: { cause: 'append' } }
const ROWS = [OK, BAD, OK, BAD, OK]
const MAIN = { kind: 'main', rows: ROWS }, QUIET = { kind: 'main', rows: [OK, OK] }
const RAILS = [{ kind: 'subagent', rows: [{}] }, { kind: 'subagent', rows: [{}] }, { kind: 'monitor', rows: [{}, {}] }]

function stateOf(lanesIn: object[], at: number, extra = {}) {
  const desk = deskOf(lanesIn), lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return { desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, sawView: 'ctx', problems: problemSteps(anchor), pricing: null, diffRef: null, reviewRange: null,
    collapsedRails: new Set(), subgroupOpen: false, bgOpen: false, drawRails: vi.fn(), setPlayhead: vi.fn(), brushTo: vi.fn(), chapterGo: vi.fn(), jumpTo: vi.fn(), refit: () => {}, ...extra } as any
}
function mount(s: any) {
  const desk = reactView(s, () => {}, () => {})
  document.body.append(desk.root)
  render(<Scope desk={desk} />, { container: desk.root })
  act(() => { desk.saw(); desk.overview() })
  return desk
}
const press = async (el: Element, key: string) => { fireEvent.keyDown(el, { key }); fireEvent.keyUp(el, { key }); await act(async () => {}) }
const click = async (el: Element) => { fireEvent.pointerDown(el); fireEvent.mouseDown(el); fireEvent.pointerUp(el); fireEvent.mouseUp(el); fireEvent.click(el); await act(async () => {}) }
const button = () => document.querySelector<HTMLElement>('.tracksbtn')
const menu = () => document.querySelector('[role="menu"]')
const checks = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const open = async () => { act(() => button()!.focus()); await press(button()!, 'Enter') }
const checkOf = (s: any, id: string) => checks()[railToggles(s).findIndex((t: any) => t.id === id)]

test('2.1 #18: Enter on the button opens a menu with one checkbox per toggle, in row order, checked when the row is open', async () => {
  const s = stateOf([MAIN, ...RAILS], 2, { subgroupOpen: true })
  s.collapsedRails.add(s.lanes.find((l: any) => l.kind === 'subagent').id)
  mount(s)
  await open()
  expect(menu()).not.toBeNull()
  const want = railToggles(s) as any[]
  expect(checks().map((e) => e.textContent)).toEqual(want.map((t) => t.name))
  expect(checks().map((e) => e.getAttribute('aria-checked'))).toEqual(want.map((t) => String(t.open)))
})

test('2.1 #18: pressing a group flips the state the gutter reads, draws the rails once, and the menu stays with the group\'s lanes in it', async () => {
  const s = stateOf([MAIN, ...RAILS], 2)
  mount(s)
  await open()
  const before = railToggles(s).length
  await click(checkOf(s, 'group:sub'))
  expect(s.subgroupOpen).toBe(true)
  expect(s.drawRails).toHaveBeenCalledTimes(1)
  expect(menu()).not.toBeNull()
  expect(railToggles(s).length).toBeGreaterThan(before)
  expect(checks().length).toBe(railToggles(s).length)
  await press(checkOf(s, 'group:sub'), 'Enter') // the keyboard's press leaves it open too
  expect(s.subgroupOpen).toBe(false)
  expect(s.drawRails).toHaveBeenCalledTimes(2)
  expect(menu()).not.toBeNull()
})

test('2.1 #18: pressing a lane flips that lane in s.collapsedRails, both ways', async () => {
  const s = stateOf([MAIN, ...RAILS], 2, { subgroupOpen: true })
  const id = s.lanes.find((l: any) => l.kind === 'subagent').id
  mount(s)
  await open()
  for (const closed of [true, false]) {
    await click(checkOf(s, id))
    expect(s.collapsedRails.has(id)).toBe(closed)
    expect(checkOf(s, id).getAttribute('aria-checked')).toBe(String(!closed))
  }
})

test('2.1 #18: Next problem lands where › lands and closes the menu', async () => {
  const s = stateOf([MAIN, ...RAILS], 2)
  mount(s)
  await open()
  expect(items().length).toBe(2)
  await click(items()[1])
  const j = problemJump(s.anchor.calls, s.problems, s.playhead, 1)!
  expect(s.jumpTo).toHaveBeenCalledTimes(1)
  expect(s.jumpTo).toHaveBeenCalledWith(j.t, j.jump)
  expect(menu()).toBeNull()
})

test('2.1 #18: an end of the problems disables that side only, and a step move while open follows', async () => {
  for (const at of [0, ROWS.length - 1]) {
    const s = stateOf([MAIN, ...RAILS], at), desk = mount(s)
    await open()
    const disabled = () => items().map((e) => e.getAttribute('aria-disabled') === 'true')
    expect(disabled()).toEqual([-1, 1].map((d) => problemTarget(s.problems, s.playhead, d) == null))
    expect(disabled().filter(Boolean).length).toBe(1)
    s.playhead = 2
    act(() => desk.cur())
    expect(disabled()).toEqual([false, false])
    cleanup(); document.body.replaceChildren()
  }
})

test('2.1 #18: no problems: no pager; no problems and only the main lane: no button', async () => {
  const s = stateOf([QUIET, ...RAILS], 1)
  expect(s.problems).toEqual([])
  mount(s)
  await open()
  expect(items()).toEqual([])
  expect(checks().length).toBe(railToggles(s).length)
  cleanup(); document.body.replaceChildren()
  const alone = stateOf([QUIET], 1)
  mount(alone)
  expect(button()).toBeNull()
})

test('2.1 #18: problems and only the main lane: the pager and no track group', async () => {
  mount(stateOf([MAIN], 2))
  await open()
  expect(items().length).toBe(2)
  expect(checks()).toEqual([])
})

test('2.1 #18: Escape closes the menu and focus returns to the button', async () => {
  mount(stateOf([MAIN, ...RAILS], 2))
  await open()
  await press(document.activeElement!, 'Escape')
  expect(menu()).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(button()))
})

test('1.2 #26: hiding the desk closes the menu; it is not open when the desk comes back', async () => {
  const s = stateOf([MAIN, ...RAILS], 2), desk = reactView(s, () => {}, () => {})
  let show!: (m: 'visible' | 'hidden') => void
  function Host() { const [m, setM] = useState<'visible' | 'hidden'>('visible'); show = setM; return <Activity mode={m}><TracksMenu desk={desk} /></Activity> }
  document.body.append(desk.root)
  render(<Host />, { container: desk.root })
  await open()
  expect(menu()).not.toBeNull()
  await act(async () => show('hidden'))
  await act(async () => show('visible'))
  expect(menu()).toBeNull()
})
