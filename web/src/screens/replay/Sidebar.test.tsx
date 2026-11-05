// web/src/screens/replay/Sidebar.test.tsx — D80②: the tabs, and the slot a later tab registers in.
import { afterEach, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addSidebarTab, Sidebar } from './Sidebar'
import { reactView } from './view'

afterEach(() => { cleanup(); localStorage.clear() })

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
