// web/src/ui/Confirm.test.tsx — the confirm dialog gives focus back to the control that asked as it closes (Esc, Cancel, the confirm
// button), in the same task: a key pressed right after the close reaches that control, never the page body.
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ConfirmProvider, useConfirm } from './Confirm'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function Asker() {
  const ask = useConfirm()
  return <button type="button" data-asker="" onClick={() => { void ask({ q: 'Change it?', confirmLabel: 'Change' }) }}>Ask</button>
}

const open = async () => {
  render(<ConfirmProvider><Asker /></ConfirmProvider>)
  const asker = document.querySelector<HTMLElement>('[data-asker]')!
  act(() => asker.focus())
  await act(async () => { fireEvent.click(asker) })
  await waitFor(() => expect(document.activeElement?.getAttribute('data-confirm'), 'Cancel has the focus').toBe('cancel'))
  return asker
}

for (const [how, close] of [
  ['Esc', (el: Element) => { fireEvent.keyDown(el, { key: 'Escape' }); fireEvent.keyUp(el, { key: 'Escape' }) }],
  ['Cancel', () => { fireEvent.click(document.querySelector('[data-confirm="cancel"]')!) }],
  ['the confirm button', () => { fireEvent.click(document.querySelector('[data-confirm="ok"]')!) }],
] as const) {
  test(`${how} closes the dialog with the focus back on the control that asked, before the next frame`, async () => {
    const asker = await open()
    await act(async () => { close(document.activeElement!) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(asker)
  })
}
