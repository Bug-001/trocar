// web/src/ui/poll.test.tsx — 1.5 轮询 MUST through useStatusQuery: one status read per INTERVAL.status while the tab is visible, none
// while it is hidden, one at once when it is visible again, never two in flight, and after a failure the next read waits the back-off.
// Periods come from core/poll.mjs (4.4 §live-poll's table), never literals. A fresh QueryClient, fake timers, api.get spied.
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../../legacy/core/api.mjs'
import { INTERVAL, backoffMs } from '../../legacy/core/poll.mjs'
import { useStatusQuery } from './poll'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'visibilityState')
})

const setVisible = (visible: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

test('the status read: one per period while visible, none while hidden, one at once on return, never two in flight, back-off after a failure', async () => {
  vi.useFakeTimers()
  const base = INTERVAL.status
  type Answer = { ok: boolean, status: number, data?: unknown, error?: string }
  const ok: Answer = { ok: true, status: 200, data: { health: { state: 'ok' }, harnesses: {} } }
  const next: Array<() => Promise<Answer>> = []
  let inFlight = 0, maxInFlight = 0
  const get = vi.spyOn(api, 'get').mockImplementation(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    try { return await (next.shift() ?? (async () => ok))() } finally { inFlight-- }
  })
  const reads = () => get.mock.calls.filter((c) => c[0] === 'status').length
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useStatusQuery(), { wrapper })
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  await tick(0)
  expect(reads()).toBe(1) // the first read, at once
  expect(result.current.doc).toEqual(ok.data)
  // visible: one read per period, none sooner
  for (let i = 2; i <= 4; i++) {
    await tick(base - 1); expect(reads()).toBe(i - 1)
    await tick(1); expect(reads()).toBe(i)
  }
  // hidden: no read for several periods
  setVisible(false)
  await tick(base * 4)
  expect(reads()).toBe(4)
  // visible again: one read at once
  setVisible(true)
  await tick(0)
  expect(reads()).toBe(5)
  // an answer held across two periods: no second read goes out while it is in flight
  let release: (a: Answer) => void = () => {}
  next.push(() => new Promise<Answer>((res) => { release = res }))
  await tick(base)
  expect(reads()).toBe(6)
  await tick(base * 2)
  expect(reads()).toBe(6)
  release(ok)
  await tick(0)
  expect(maxInFlight).toBe(1)
  // a failure: the next read waits backoffMs(1, base), not the plain period
  await tick(base)
  const failedAt = reads()
  next.push(async () => ({ ok: false, status: 500, error: 'boom' }))
  await tick(base)
  expect(reads()).toBe(failedAt + 1)
  await tick(backoffMs(1, base) - 1)
  expect(reads()).toBe(failedAt + 1)
  expect(result.current.err).not.toBeNull()
  expect(result.current.doc).toEqual(ok.data) // the last good answer stays
  // failures in a row: the k-th waits backoffMs(k, base); a success ends the run, and the plain period is back
  next.push(async () => ({ ok: false, status: 500, error: 'boom' }), async () => ({ ok: false, status: 500, error: 'boom' }))
  await tick(1)
  expect(reads()).toBe(failedAt + 2)
  await tick(backoffMs(2, base) - 1)
  expect(reads()).toBe(failedAt + 2)
  await tick(1)
  expect(reads()).toBe(failedAt + 3)
  await tick(backoffMs(3, base))
  expect(reads()).toBe(failedAt + 4)
  await tick(base - 1)
  expect(reads()).toBe(failedAt + 4)
  await tick(1)
  expect(reads()).toBe(failedAt + 5)
  expect(maxInFlight).toBe(1)
})
