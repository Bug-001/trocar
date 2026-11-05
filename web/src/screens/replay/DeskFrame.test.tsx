// web/src/screens/replay/DeskFrame.test.tsx — the new desk's frame (1.2 §回放台 B 布局 #1, 1.4 #8, decision 12): the pages hold their
// areas, the middle column holds only the step head and the context window, and what the frame renders from the desk's state
// (`railopen`) follows that state across paints of other areas. The desk is a React view over a plain state with no lane:
// the legacy renderers the wrappers call draw nothing without one.
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { DeskFrame } from './DeskFrame'
import { reactView, type Els } from './view'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function frame(state: object = {}) {
  const s = { project: 'p', id: 'i', view: { lo: 0, hi: 0 }, railsFolded: false, rpOpen: false, ...state }
  const handed: Els[] = []
  const desk = reactView(s, (E) => { handed.push(E) }, () => {})
  document.body.append(desk.root)
  render(<DeskFrame desk={desk} />, { container: desk.root })
  const $ = (sel: string) => desk.root.querySelector<HTMLElement>(sel)
  return { s, desk, $, handed }
}

test('1.2 #1: the left page holds the scope, the rails and the context window; the right page the resources and the raw panel; the outline holds no resource', () => {
  const { $ } = frame()
  const left = $('#leftpage')!, right = $('#rightpage')!
  for (const id of ['#saw', '#rails', '#ctxwin']) expect(left.querySelector(id), id).not.toBeNull()
  for (const id of ['#resexp', '#rawpanel']) expect(right.querySelector(id), id).not.toBeNull()
  for (const id of ['#resexp', '#rawpanel']) expect(left.querySelector(id), id).toBeNull()
  expect($('#ctxnav')!.querySelector('#resexp, [data-res], .res')).toBeNull()
})

test('1.4 #8: the middle column\'s children are exactly the step head and #ctxwin, and the window is not handed to the controller', () => {
  const { $, handed } = frame()
  expect([...$('#ctxwin')!.parentElement!.children].map((c) => c.id)).toEqual(['stepbar', 'ctxwin'])
  expect(handed).toHaveLength(1)
  expect(Object.keys(handed[0])).not.toContain('ctxwin')
})

test('decision 12: #leftpage has railopen iff the rails are not folded, kept across a paint of another area', () => {
  for (const folded of [false, true]) for (const [lo, hi] of [[0, 0], [3, 3], [0, 1], [2, 9], [10, 250]]) {
    const { s, desk, $ } = frame({ railsFolded: !folded })
    act(() => { s.railsFolded = folded; desk.frame() })
    expect($('#leftpage')!.classList.contains('railopen'), `folded=${folded}`).toBe(!folded)
    act(() => { s.view = { lo, hi }; desk.saw() })
    expect($('#leftpage')!.classList.contains('railopen'), `folded=${folded} after a scope paint`).toBe(!folded)
    cleanup(); document.body.replaceChildren()
  }
})
