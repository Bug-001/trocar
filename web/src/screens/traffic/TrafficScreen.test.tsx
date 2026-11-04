// web/src/screens/traffic/TrafficScreen.test.tsx — the traffic table's wiring contracts (1.10 §流量表 · §组件与状态 · §窄屏与键盘, 1.2 §键盘):
// #7 the coverage note waits for a fresh `sessions` answer and the re-render keeps the reader's focus; the keyboard highlight is a row
// key (↑ / ↓ / Enter, not inside a menu) that a re-read leaves on its host; #5 the window drives `?since=`; #19 a failed read says so
// with 「Retry」, no rows, the reason only in the closed technical details. Documents carry the C.5 keys (spec 1.6 附录 C.5) through a
// stubbed api.get; agents come from the chip table, hosts are made up.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { INTERVAL } from '../../../legacy/core/poll.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { initKeys } from '../../../legacy/core/keys.mjs'
import { HARNESS_ORDER } from '../../../legacy/core/chips.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'
import type { ScreenProps } from '../../ScreenOutlet'
import TrafficScreen from './TrafficScreen'

const [A, B, C] = HARNESS_ORDER as readonly string[] // A and B send traffic; C is only in `sessions`
const T = '2026-10-20T09:00:00Z', EARLY = '2026-09-01T09:00:00Z'
type Host = { harness: string, host: string, sent: number }
// a C.5 `traffic` document: every key of the shape, one entry per host
const trafficDoc = (hs: Host[]) => ({
  as_of: T,
  hosts: hs.map((h) => ({ harness: h.harness, harness_inferred: false, host: h.host, first_seen: EARLY, last_seen: T, requests: 3,
    sent_bytes: h.sent, received_bytes: 100, received_unrecorded: 0, classes: { other: 3 }, class_unrecorded: 0 })),
  harness_since: { [A]: EARLY, [B]: EARLY },
  totals: { requests: hs.length * 3, sent_bytes: hs.reduce((a, h) => a + h.sent, 0), received_bytes: hs.length * 100, is_floor: true },
  next: null, has_more: false,
})
// a C.5 `sessions` document; `stored` marks the worker's older answer (4.4 §存下的答案)
const session = (harness: string, n: number) => ({ session_id: `s${n}`, harness, harness_inferred: false, provider: null, project_slug: null,
  project_path: null, title: null, title_source: null, entrypoint: null, calls: 1, logged: 0, probes: 0, other: 0, has_subagent: false,
  session_synthesized: false, last_ts: T })
const sessionsDoc = (stored: boolean) => ({ sessions: [session(A, 1), session(C, 2)], next: null, ...(stored ? { stored: { at: EARLY } } : {}) })

// A's hosts by sent: big > mid; B has one. Group order is the chip table's, rows by sent (1.10 §列)
const HOSTS: Host[] = [{ harness: A, host: 'mid.example.test', sent: 2000 }, { harness: A, host: 'big.example.test', sent: 9000 }, { harness: B, host: 'one.example.test', sent: 500 }]
type Answer = { ok: boolean, status: number, data: unknown, error: string | null }
let trafficAnswer: (since: unknown) => Answer
let trafficReads: Array<Record<string, unknown>> = []
let sessionsServed = 0

beforeEach(() => {
  vi.useFakeTimers()
  initKeys()
  trafficReads = []; sessionsServed = 0
  trafficAnswer = () => ({ ok: true, status: 200, data: trafficDoc(HOSTS), error: null })
  vi.spyOn(api, 'get').mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (name === 'traffic') { trafficReads.push(params); return trafficAnswer(params.since) }
    if (name === 'sessions') return { ok: true, status: 200, data: sessionsDoc(sessionsServed++ === 0), error: null }
    return { ok: false, status: 404, data: null, error: 'HTTP 404' }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const settle = async () => { for (let i = 0; i < 3; i++) await tick(1) }

async function mount(hash = '#/traffic') {
  const router = { current: () => parseHash(hash), go: vi.fn(), setParams: vi.fn(), onRoute: () => () => {} } as unknown as ScreenProps['router']
  const client = new QueryClient()
  const ui = (h: string) => <QueryClientProvider client={client}><TrafficScreen route={parseHash(h)} router={router} /></QueryClientProvider>
  const r = render(ui(hash))
  await settle()
  const rows = () => [...r.container.querySelectorAll<HTMLElement>('.trow:not(.thead):not(.ttotal)')]
  const hostOf = (el: Element | null | undefined) => el?.querySelector('.host')?.textContent ?? null
  const hi = () => hostOf(r.container.querySelector('.trow.hi'))
  const rerender = async (h: string) => { r.rerender(ui(h)); await settle() }
  return { ...r, router, rows, hostOf, hi, rerender }
}
const key = (target: Element, k: string) => { fireEvent.keyDown(target, { key: k }); fireEvent.keyUp(target, { key: k }) }

test('#7 wiring: the coverage note appears only with the fresh sessions answer, and the focused row keeps focus', async () => {
  const p = await mount()
  const link = p.container.querySelector<HTMLAnchorElement>('a.trow')!
  link.focus()
  expect(document.activeElement).toBe(link)
  expect(p.container.querySelector('.cap-agent')).toBeNull() // the first answer carries `stored`: not counted
  await tick(INTERVAL.session); await settle()
  expect(sessionsServed).toBe(2)
  expect(p.container.querySelector(`.cap-agent[data-h="${C}"]`)).not.toBeNull()
  expect(p.container.querySelector(`.cap-agent[data-h="${A}"]`)).toBeNull()
  expect(link.isConnected).toBe(true)
  expect(document.activeElement).toBe(link)
})

test('keyboard: ↓ ↓ Enter opens the second row; a key inside the open menu leaves the highlight; re-reads keep it on its host', async () => {
  const p = await mount()
  key(document.body, 'ArrowDown'); key(document.body, 'ArrowDown')
  expect(p.hi()).toBe('mid.example.test') // A's group first, by sent: big, then mid
  key(document.body, 'Enter')
  expect(p.router.go).toHaveBeenCalledTimes(1)
  const to = vi.mocked(p.router.go).mock.calls[0][0] as { screen: string, harness: string, host: string }
  expect([to.screen, to.harness, to.host]).toEqual(['traffic-host', A, 'mid.example.test'])

  const btn = p.getByRole('button', { name: W.FILTER_CLASS })
  btn.focus(); key(btn, 'Enter'); await settle()
  const menu = document.querySelector('[role=menu]')!
  expect(menu).not.toBeNull()
  expect(menu.querySelectorAll('[role=menuitem]').length).toBeGreaterThan(0)
  key(document.activeElement && menu.contains(document.activeElement) ? document.activeElement : menu, 'ArrowDown')
  expect(p.hi()).toBe('mid.example.test')
  key(document.activeElement ?? menu, 'Escape'); await settle()

  await tick(INTERVAL.session); await settle() // the fresh sessions answer re-renders the table
  expect(p.hi()).toBe('mid.example.test')
  // another window whose answer puts mid above big: the highlight follows its host, not its place
  trafficAnswer = () => ({ ok: true, status: 200, data: trafficDoc(HOSTS.map((h) => (h.host === 'mid.example.test' ? { ...h, sent: 99000 } : h))), error: null })
  await p.rerender('#/traffic?window=7d')
  expect(p.hostOf(p.rows()[0])).toBe('mid.example.test')
  expect(p.hi()).toBe('mid.example.test')
})

test('#5 / #19 wiring: the window drives since; a failed read says so with Retry, no rows, the reason only in closed details', async () => {
  const junk = await mount('#/traffic?window=junk')
  expect(trafficReads.at(-1)!.since).toBe('24h')
  junk.unmount()
  const all = await mount('#/traffic?window=all')
  expect(all.rows().length).toBe(HOSTS.length)
  expect(trafficReads.at(-1)!.since).toBeUndefined()
  all.unmount()

  const REASON = 'upstream said no: 7f3a'
  trafficAnswer = () => ({ ok: false, status: 502, data: null, error: REASON })
  const p = await mount()
  const retry = p.getByRole('button', { name: /retry/i })
  expect(p.container.querySelector('a.trow')).toBeNull()
  const tech = p.getByRole('button', { name: /technical details/i })
  expect(tech.getAttribute('aria-expanded')).toBe('false')
  const outside = p.container.cloneNode(true) as HTMLElement
  outside.querySelectorAll('.disc-b').forEach((e) => e.remove())
  expect(outside.textContent).not.toContain(REASON)
  const before = trafficReads.length
  fireEvent.click(retry); await settle()
  expect(trafficReads.length).toBe(before + 1)
})
