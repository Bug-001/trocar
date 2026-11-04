// web/src/shell/Sidebar.test.tsx — 1.2 §侧栏 behaviour: a plain click navigates through ctx.router, a modified click is the browser's
// own (a new tab); 会话 returns to the library as it was left and does nothing on the library; the current item carries
// aria-current="page"; the collapse button flips #app.rail and the per-viewer record. A real hash router in jsdom.
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { RouterProvider } from 'react-router/dom'
import { createBoardRouter } from '../router'
import { parseHash } from '../../legacy/core/router.mjs'
import { Sidebar } from './Sidebar'

let board: ReturnType<typeof createBoardRouter> | null = null
afterEach(() => { cleanup(); board?.dispose(); board = null; localStorage.clear(); document.body.replaceChildren() })

function mount(hash: string, libraryHash = '#/sessions') {
  history.replaceState(null, '', hash)
  const app = document.createElement('div'); app.id = 'app'; document.body.append(app)
  const store = { get: () => ({ libraryHash }) }
  const holder: { legacy?: ReturnType<typeof createBoardRouter>['legacy'] } = {}
  function El() { return <Sidebar route={holder.legacy!.current()} router={holder.legacy!} store={store} /> }
  board = createBoardRouter(<El />); holder.legacy = board.legacy
  const go = vi.spyOn(board.legacy, 'go')
  render(<RouterProvider router={board.router} />, { container: app })
  const a = (sel: string) => app.querySelector<HTMLAnchorElement>(sel)!
  return { app, go, a }
}

test('a plain click on a sidebar link goes there through ctx.router; a cmd / ctrl / shift click does not', () => {
  const { go, a } = mount('#/overview')
  const traffic = a('a.hit[data-id="traffic"]')
  expect(traffic.getAttribute('href')).toBe('#/traffic')
  for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) fireEvent.click(traffic, mod)
  expect(go).not.toHaveBeenCalled()
  fireEvent.click(a('.fsub a[href="#/capture/log"]'))
  expect(go.mock.calls.map((c) => c[0].screen)).toEqual(['capture-log'])
})

test('会话 from another screen returns to the library as it was left; on the library it does nothing', () => {
  const left = '#/sessions?h=codex&q=x'
  const away = mount('#/traffic', left)
  fireEvent.click(away.a('a.hit[data-id="library"]'))
  expect(away.go.mock.calls.map((c) => c[0])).toEqual([parseHash(left)])
  cleanup(); board?.dispose(); document.body.replaceChildren()
  const on = mount(left, left)
  fireEvent.click(on.a('a.hit[data-id="library"]'))
  expect(on.go).not.toHaveBeenCalled()
})

test('the current item carries aria-current="page"; the replay desk opens 会话', () => {
  const { app } = mount('#/settings/prices')
  expect([...app.querySelectorAll('[aria-current="page"]')].map((e) => e.getAttribute('href'))).toEqual(['#/settings/prices', '#/settings/prices'])
  cleanup(); board?.dispose(); document.body.replaceChildren()
  const desk = mount('#/replay/p/s')
  expect(desk.app.querySelector('li.item.open > a.hit')!.getAttribute('data-id')).toBe('library')
})

test('the collapse button flips #app.rail and aria-expanded, and the choice is the viewer\'s record', () => {
  const { app } = mount('#/overview')
  const btn = () => app.querySelector<HTMLButtonElement>('button[data-rail="toggle"]')!
  expect(app.classList.contains('rail')).toBe(false); expect(btn().getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(btn())
  expect(app.classList.contains('rail')).toBe(true); expect(btn().getAttribute('aria-expanded')).toBe('false')
  expect(localStorage.getItem('trocar.v2.sidebar')).toBe('1')
})
