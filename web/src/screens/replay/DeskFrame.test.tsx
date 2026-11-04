// web/src/screens/replay/DeskFrame.test.tsx — the new desk's frame (1.2 §回放台布局 #1, 1.4 #8): the main area holds its areas, the sidebar
// sits beside it, the middle column holds only the step head and the context window. The desk is a React view over a plain state with
// no lane: the legacy renderers the wrappers call draw nothing without one.
import { afterEach, beforeAll, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DeskFrame } from './DeskFrame'
import { reactView, type Els } from './view'

beforeAll(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver })
afterEach(() => { cleanup(); document.body.replaceChildren() })

function frame(state: object = {}) {
  const s = { project: 'p', id: 'i', view: { lo: 0, hi: 0 }, ...state }
  const handed: Els[] = []
  const desk = reactView(s, (E) => { handed.push(E) }, () => {})
  document.body.append(desk.root)
  render(<DeskFrame desk={desk} />, { container: desk.root })
  const $ = (sel: string) => desk.root.querySelector<HTMLElement>(sel)
  return { s, desk, $, handed }
}

test('1.2 #1: the main area holds the scope, the rails and the context window; the sidebar sits beside it; there is no outline column and no raw panel', () => {
  const { $ } = frame()
  const main = $('#desk-main')!, side = $('.deskside')!
  for (const id of ['#saw', '#rails', '#ctxwin']) expect(main.querySelector(id), id).not.toBeNull()
  expect(main.contains(side)).toBe(false)
  for (const id of ['#ctxnav', '#rawpanel']) expect($(id), id).toBeNull()
})

test('1.4 #8: the middle column\'s children are exactly the step head and #ctxwin, and the window is not handed to the controller', () => {
  const { $, handed } = frame()
  expect([...$('#ctxwin')!.parentElement!.children].map((c) => c.id)).toEqual(['stepbar', 'ctxwin'])
  expect(handed).toHaveLength(1)
  expect(Object.keys(handed[0])).not.toContain('ctxwin')
})
