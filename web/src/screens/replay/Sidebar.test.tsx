// web/src/screens/replay/Sidebar.test.tsx — D80②: the tabs, and the slot a later tab registers in.
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { overviewModel } from './overview-model.mjs'
import { addSidebarTab, Sidebar } from './Sidebar'
import { reactView } from './view'

vi.mock('./overview-model.mjs', () => ({ overviewModel: vi.fn(() => ({ single: true, parts: [] })) }))
afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(overviewModel).mockClear() })

const desk = () => reactView({ project: 'p', id: 'i' }, () => {}, () => {})
const tabIds = () => screen.getAllByRole('tab').map((t) => t.getAttribute('data-key'))

test('D80②: without a registration the tabs are overview and resources; a registered tab is one more and its panel draws', () => {
  const d = desk()
  const first = render(<Sidebar desk={d} />)
  expect(tabIds()).toEqual(['overview', 'resources'])
  first.unmount()
  const out = addSidebarTab({ id: 'rules', label: 'Rules', Panel: () => <p data-testid="rules" /> })
  try {
    render(<Sidebar desk={d} />)
    expect(tabIds()).toEqual(['overview', 'resources', 'rules'])
    fireEvent.click(screen.getAllByRole('tab')[2])
    expect(screen.getByTestId('rules')).not.toBeNull()
    expect(localStorage.getItem('trocar.v2.sidetab')).toBe('rules')
  } finally { out() }
})

test('1.2 §回放台布局: the Resources panel holds the controller\'s element only while it is the current tab', () => {
  const d = desk()
  render(<Sidebar desk={d} />)
  expect(d.resexp.isConnected).toBe(false)
  fireEvent.click(screen.getAllByRole('tab')[1])
  expect(d.resexp.isConnected).toBe(true)
  fireEvent.click(screen.getAllByRole('tab')[0])
  expect(d.resexp.isConnected).toBe(false)
})

test('2.3 §大致页面 · §抽取或归约没追上: the Overview runs its model on nav alone, never for the rough page or a step move', () => {
  const d = desk()
  render(<Sidebar desk={d} />)
  act(() => { d.rough(); d.step(); d.window() })
  expect(overviewModel).not.toHaveBeenCalled()
  act(() => { d.nav() })
  expect(overviewModel).toHaveBeenCalledTimes(1)
  act(() => { d.step(); d.window() })
  expect(overviewModel).toHaveBeenCalledTimes(1)
})
