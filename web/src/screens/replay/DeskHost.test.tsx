// web/src/screens/replay/DeskHost.test.tsx — the new desk's host (decision 2: 1.2 §路由「离开再回来」, D71③, D75①) over the real
// board router and the real session cache, with a stub desk in place of openDesk (it attaches and detaches its view's root the way the
// controller does, and records the routes it is handed): routes reach the desk inside the announcing call, the desk's root hangs in the
// host only while it is read, an evicted desk's subtree is gone, and the controller is handed the frame once. And 1.2 #19 for the
// desk's module: one that fails to load says why where the desk would be.
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { act, cleanup, render, type RenderResult } from '@testing-library/react'
import { createBoardRouter } from '../../router'
import { ScreenBoundary, lazyScreen } from '../../ScreenOutlet'
import { createSessionCache } from '../../../legacy/replay/session-cache.mjs'
import { screenBound } from '../../../legacy/core/dom.mjs'
import type { Route } from '../../LegacyScreen'
import DeskHost, { type DeskProps } from './DeskHost'
import type { DeskState, DeskView } from './view'

type Board = ReturnType<typeof createBoardRouter>
let board: Board | null = null
beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); board?.dispose(); board = null; document.body.replaceChildren(); history.replaceState(null, '', '#/') })

const isDesk = (r: Route) => !r.unknown && r.screen === 'replay'
const ctx = {}
const deskAt = (id: string, params: Record<string, string> = {}) => ({ area: 'replay', screen: 'replay', project: 'p', id, params } as unknown as Route)
const OVERVIEW = { area: 'overview', screen: 'overview', params: {} } as Route

type Stub = { id: string, view: DeskView, routes: (string | undefined)[], framed: number, elsAtAttach: unknown, disposed: number, onUpdate?: (r: Route) => void }
function host({ maxSessions = 3 } = {}) {
  history.replaceState(null, '', '#/overview')
  const router = (board = createBoardRouter(null)).legacy
  const desks: Stub[] = []
  const open: NonNullable<DeskProps['open']> = (_ctx, route0, makeView) => {
    const s: DeskState = { project: route0.project, id: route0.id, view: { lo: 0, hi: 0 }, railsFolded: true, rpOpen: false }
    const d = { id: route0.id, routes: [], framed: 0, elsAtAttach: undefined, disposed: 0 } as unknown as Stub
    d.view = makeView!(s, () => { d.framed++ }) as unknown as DeskView
    desks.push(d)
    return {
      key: route0.project + '::' + route0.id, bytes: () => 0,
      attach(el: HTMLElement) { d.elsAtAttach = d.view.els(); el.replaceChildren(d.view.root) },
      detach() { d.view.root.remove() },
      update(r: Route) { d.routes.push(r.params.step); d.onUpdate?.(r) },
      dispose() { d.disposed++; d.view.dispose() },
    } as unknown as ReturnType<NonNullable<DeskProps['open']>>
  }
  const el = document.createElement('div')
  document.body.append(el)
  const cache = createSessionCache({ maxSessions })
  render(<DeskHost router={router} ctx={ctx} host={{ current: el }} isDesk={isDesk} cache={cache} open={open} />)
  const desk = (id: string) => desks.find((d) => d.id === id)!
  return { router, el, desk, desks }
}

test('decision 2: a URL write the desk makes inside update() reaches it before the write returns, and no older route reaches it afterwards', async () => {
  const { router, desk } = host()
  act(() => { router.go(deskAt('a')) })
  const a = desk('a')
  let atReturn: string | undefined
  a.onUpdate = (r) => { if (r.params.step === '5') { router.setParams({ step: '6' }); atReturn = a.routes.at(-1) } }
  act(() => { router.setParams({ step: '5' }) })
  expect(atReturn).toBe('6')
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  expect(a.routes.at(-1)).toBe('6')
  expect(a.routes.lastIndexOf('5')).toBeLessThan(a.routes.lastIndexOf('6'))
})

test('decision 2: show and leave attach and detach the desk\'s root inside the announcing call', () => {
  const { router, el, desk } = host()
  act(() => {
    router.go(deskAt('a'))
    expect(el.contains(desk('a').view.root)).toBe(true)
    router.go(OVERVIEW)
    expect(desk('a').view.root.isConnected).toBe(false)
    router.go(deskAt('a'))
    expect(el.contains(desk('a').view.root)).toBe(true)
  })
})

test('decision 2: a desk the session cache evicts is disposed, and its subtree and portal content are gone', () => {
  const { router, desk } = host({ maxSessions: 1 })
  act(() => { router.go(deskAt('a')) })
  expect(desk('a').view.root.querySelector('#saw')).not.toBeNull()
  act(() => { router.go(deskAt('b')) })
  expect(desk('a').disposed).toBe(1)
  expect(desk('a').view.root.childElementCount).toBe(0)
  expect(desk('b').view.root.querySelector('#saw')).not.toBeNull()
})

test('decision 2: els() is null until the frame is there; the first commit hands it over once, and a desk hidden and shown again does not again', () => {
  const { router, desk } = host()
  act(() => { router.go(deskAt('a')) })
  const a = desk('a')
  expect(a.elsAtAttach).toBeNull()
  expect(a.framed).toBe(1)
  const E = a.view.els()!
  expect(a.view.root.contains(E.rails)).toBe(true)
  expect(E.resexp).toBe(a.view.resexp)
  act(() => { router.go(deskAt('b')) })
  act(() => { router.go(deskAt('a')) })
  expect(a.framed).toBe(1)
})

test('1.2 #19: a desk module that fails to load says why where the desk would be', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const d = lazyScreen<DeskProps>(async () => { throw new Error('chunk gone') })
  const router = (board = createBoardRouter(null)).legacy
  let r!: RenderResult
  await act(async () => { r = render(<ScreenBoundary><d.Screen router={router} ctx={ctx} host={{ current: null }} isDesk={isDesk} /></ScreenBoundary>) })
  await act(async () => { await d.load().catch(() => {}) })
  expect(r.container.querySelector('.screenerr[role="alert"]')?.textContent).toContain('chunk gone')
})

test('1.2 「层随屏走」: a core layer opened on the desk closes when the desk is left; one opened after it, on no screen, is not bound', () => {
  const { router } = host()
  const closed: string[] = []
  act(() => { router.go(deskAt('a')) })
  screenBound(() => closed.push('a'))
  act(() => { router.go(deskAt('b')) }) // another session is still the desk: its layers stay
  expect(closed).toEqual([])
  act(() => { router.go(OVERVIEW) })
  expect(closed).toEqual(['a'])
  screenBound(() => closed.push('after'))
  act(() => { router.go(deskAt('a')); router.go(OVERVIEW) })
  expect(closed).toEqual(['a'])
})
