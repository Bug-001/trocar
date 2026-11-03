// web/src/screens/settings/PricesAppearance.test.tsx — the prices and appearance screens' contracts (1.11 §价格 · §外观 · §组件状态,
// 1.5 K-29). Prices: a failed read shows Retry with the reason only behind the folded details, Retry reads again, a good answer draws one row
// per model, the page never writes; the unpriced card exists only while overview answers, and Copy template copies exactly the paste-ready
// line. Appearance: the choice starts from <html data-theme>, a press switches the attribute and the key, a storage that throws still
// switches and says so, and the page reads nothing from the server.
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../../../legacy/core/api.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { THEME_KEY } from '../../../legacy/core/ui.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { templateText } from '../../../legacy/settings/prices.mjs'
import { fmtTime } from '../../../legacy/core/fmt.mjs'
import PricesScreen from './PricesScreen'
import AppearanceScreen from './AppearanceScreen'

type Answer = { ok: boolean, status: number, data: unknown, error: string | null }
const ok = (data: unknown): Answer => ({ ok: true, status: 200, data, error: null })
const NOT_FOUND: Answer = { ok: false, status: 404, data: null, error: 'HTTP 404' }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  try { localStorage.clear() } catch { /* a test's throwing storage is restored above */ }
})

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
}
// the text a reader sees: everything outside [hidden] (a folded details panel is hidden)
function visible(el: Element) {
  const c = el.cloneNode(true) as Element
  for (const h of c.querySelectorAll('[hidden]')) h.remove()
  return c.textContent || ''
}
const pricingCalls = () => vi.mocked(api.get).mock.calls.filter(([n]) => n === 'pricing').length

test('P1: a failed price read shows Retry with the reason only in the folded details; Retry reads again; a good answer draws one row per model; nothing is written', async () => {
  const TOKEN = 'sk-ant-secret-7f3a'
  const MODELS = [{ model: 'claude-opus', input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
    { model: 'gpt-5', input: 1.25, output: 10, cache_write: 0, cache_read: 0.125 }, { model: 'glm', input: 0.6, output: 2.2, cache_write: 0, cache_read: 0.11 }]
  const pricing: Array<() => Promise<Answer>> = [
    async () => ({ ok: false, status: 500, data: null, error: `HTTP 500 ${TOKEN}` }),
    async () => { throw new Error(`fetch failed ${TOKEN}`) },
    async () => ok({ source: 'default', models: MODELS }),
  ]
  let n = 0
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => (name === 'pricing' ? pricing[Math.min(n++, pricing.length - 1)]() : NOT_FOUND))
  const control = vi.spyOn(api, 'control').mockImplementation(async () => ok({}))
  const { container, findByRole } = wrap(<PricesScreen route={parseHash('#/settings/prices')} />)

  for (let i = 1; i <= 2; i++) {
    const retry = await findByRole('button', { name: W.RETRY })
    expect(visible(container)).not.toContain(TOKEN)
    expect(pricingCalls()).toBe(i)
    await act(async () => { fireEvent.click(retry) })
    await waitFor(() => expect(pricingCalls()).toBe(i + 1))
  }
  await waitFor(() => expect(container.querySelector('table.ptable')).not.toBeNull())
  const rows = [...container.querySelectorAll('table.ptable tbody tr')]
  expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(MODELS.map((m) => m.model))
  expect(control).not.toHaveBeenCalled()
})

test('P2: no unpriced card while overview is not there; each unpriced model copies exactly its paste-ready template, for a price file and for the defaults', async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const MODELS = [{ model: 'claude', input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 }]
  const ROWS = [{ model: 'claude-sonnet-4', calls: 4, sessions: 2 }, { model: 'glm-4.6', calls: 3, sessions: 1 }, { model: 'kimi-k2', calls: 2, sessions: 5 }]
  const UNPRICED = ['glm-4.6', 'kimi-k2'] // no key of MODELS is contained in these names

  let overview: Answer = NOT_FOUND, source = 'default'
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => (name === 'pricing' ? ok({ source, models: MODELS }) : name === 'overview' ? overview : NOT_FOUND))

  let page = wrap(<PricesScreen route={parseHash('#/settings/prices')} />)
  await waitFor(() => expect(page.container.querySelector('table.ptable')).not.toBeNull())
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([nm]) => nm === 'overview')).toBe(true))
  expect(page.container.querySelector('.umodel')).toBeNull()
  expect(page.queryByRole('heading', { name: W.CARD_UNPRICED })).toBeNull()
  cleanup()

  overview = ok({ as_of: '2026-10-20T09:00:00Z', usage: { rows: ROWS } })
  for (const src of ['/home/u/.trocar/pricing.json', 'default']) {
    source = src
    writeText.mockClear()
    page = wrap(<PricesScreen route={parseHash('#/settings/prices')} />)
    await page.findByRole('heading', { name: W.CARD_UNPRICED })
    // the source line shows the file the table came from; the defaults say so instead of a path (§价格, 验收 16)
    const from = page.container.querySelector('.from')!
    if (src === 'default') expect(from.textContent).toBe(W.PRICE_DEFAULT)
    else expect(from.textContent).toContain(src)
    for (const model of UNPRICED) {
      const um = [...page.container.querySelectorAll('.umodel')].find((u) => u.querySelector('.um')?.textContent === model) as HTMLElement
      expect(um).toBeTruthy()
      expect(um.querySelector('.well')!.textContent).toBe(templateText(model, src))
      await act(async () => { fireEvent.click(within(um).getByRole('button', { name: W.COPY_TEMPLATE })) })
      expect(writeText).toHaveBeenLastCalledWith(templateText(model, src))
    }
    cleanup()
  }
})

test('P3: every entry reads the price table again; a failed re-read keeps the last good answer\'s read time (1.11 §数据与刷新)', async () => {
  const T1 = Date.UTC(2026, 9, 20, 9, 0, 0), T2 = T1 + 3 * 3600e3 + 7e3
  let now = T1, answer: Answer = ok({ source: 'default', models: [{ model: 'claude', input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 }] })
  vi.spyOn(api, 'now').mockImplementation(() => now)
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => (name === 'pricing' ? answer : NOT_FOUND))
  const client = new QueryClient() // one client for the board, as in main.tsx
  const tree = () => <QueryClientProvider client={client}><PricesScreen route={parseHash('#/settings/prices')} /></QueryClientProvider>
  let r = render(tree())
  await waitFor(() => expect(r.container.querySelector('.readat')?.textContent).toContain(fmtTime(T1)))
  r.unmount()
  now = T2; answer = { ok: false, status: 0, data: null, error: 'fetch failed' }
  r = render(tree())
  await r.findByRole('button', { name: W.RETRY })
  expect(pricingCalls()).toBe(2)
  expect(r.container.querySelector('.readat')!.textContent).toContain(fmtTime(T1))
  expect(r.container.textContent).not.toContain(fmtTime(T2))
})

test('A1: the theme choice starts from <html data-theme>, Space switches the attribute and the key, a throwing storage still switches and says so, no server read', async () => {
  const get = vi.spyOn(api, 'get')
  const route = parseHash('#/settings/appearance')

  document.documentElement.setAttribute('data-theme', 'dark')
  let page = wrap(<AppearanceScreen route={route} />)
  const dark = page.getByRole('radio', { name: W.THEME_DARK })
  expect(dark.getAttribute('aria-checked')).toBe('true')
  expect(dark.getAttribute('data-theme-choice')).toBe('dark')
  cleanup()

  document.documentElement.removeAttribute('data-theme')
  page = wrap(<AppearanceScreen route={route} />)
  expect(page.getByRole('radio', { name: W.THEME_SYSTEM }).getAttribute('aria-checked')).toBe('true')
  const light = page.getByRole('radio', { name: W.THEME_LIGHT })
  await act(async () => { fireEvent.keyDown(light, { key: ' ' }); fireEvent.keyUp(light, { key: ' ' }) })
  expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  expect(localStorage.getItem(THEME_KEY)).toBe('light')
  expect(page.container.querySelector('.themewarn')!.hasAttribute('hidden')).toBe(true)

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
  const darkBtn = page.getByRole('radio', { name: W.THEME_DARK })
  await act(async () => { fireEvent.keyDown(darkBtn, { key: ' ' }); fireEvent.keyUp(darkBtn, { key: ' ' }) })
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  expect(page.container.querySelector('.themewarn')!.hasAttribute('hidden')).toBe(false)
  expect(get).not.toHaveBeenCalled()
})
