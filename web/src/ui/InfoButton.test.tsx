// web/src/ui/InfoButton.test.tsx — 1.2 §弹出层: the links inside an open layer are reachable with Tab, so the layer sits right after
// its button in the Tab order (as core/ui.mjs popover() puts it in the DOM), not at the end of the page.
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { InfoButton } from './InfoButton'

afterEach(cleanup)

// the document's Tab order for elements without a positive tabindex: focusable, not tabindex=-1, not hidden
const tabbables = () => [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
  .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[hidden], [inert]'))

test('with an open ⓘ, the next tabbable after the ⓘ is the first link in its layer', async () => {
  render(<main>
    <button type="button">before</button>
    <InfoButton label="About" title="Head" body={<a href="#/capture">link</a>} />
    <button type="button">after</button>
  </main>)
  const info = document.querySelector<HTMLElement>('.popbtn')!
  act(() => info.focus())
  fireEvent.keyDown(info, { key: 'Enter' }); fireEvent.keyUp(info, { key: 'Enter' })
  await act(async () => {})
  const link = document.querySelector('[role="dialog"] a[href]')
  expect(link).not.toBeNull()
  const order = tabbables()
  expect(order[order.indexOf(info) + 1]).toBe(link)
})
