// web/src/screens/traffic/HostScreen.test.tsx — the host page's wiring contracts (1.10 §host 页 · §组件与状态 · §窄屏与键盘, 2.6 §C, 1.2
// §键盘 · §点击与选中文字): #21 「Show」 reads one header once and the detail keeps its open parts and the reader's selection; #12 the
// list pages by `next`, keyed by ref, so the focused and the selected row survive an append; #20 the drawer, Esc, ↓ and a drag-select
// that is not a click; #23 / #19 a late answer never paints over the newer selection, a failed read says so with Retry; #11 / #16 the
// page only reads and keeps the class. Documents carry the C.5 keys (spec 1.6 附录 C.5) and the 2.6 §C ctl shape through a stubbed
// api.get; the agent comes from the chip table, hosts and values are made up.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { initKeys } from '../../../legacy/core/keys.mjs'
import { installUi } from '../../../legacy/core/ui.mjs'
import { HARNESS_ORDER } from '../../../legacy/core/chips.mjs'
import type { ScreenProps } from '../../ScreenOutlet'

type BoardRouter = ScreenProps['router']
import HostScreen from './HostScreen'
import TrafficScreen from './TrafficScreen'

const H = (HARNESS_ORDER as readonly string[])[0], HOST = 'api.example.test', T = '2026-10-20T09:00:00Z', PAGE = 40
const SECRET = { authorization: 'Bearer s3cr3t-A', 'x-api-key': 'k3y-B' } as Record<string, string>
type Answer = { ok: boolean, status: number, data: unknown, error: string | null }
type P = Record<string, unknown>
const ok = (data: unknown): Answer => ({ ok: true, status: 200, data, error: null })
const doc = (o: P) => ({ schema: 2, command: 'calls', ok: true, errors: [], as_of: T, ...o })
const row = (i: number, cls = 'telemetry') => ({ id: `r${i}`, ts: T, harness: H, harness_inferred: false, class: cls, host: HOST, endpoint: '/events',
  status: 200, sent_bytes: 100 + i, received_bytes: 10, retention: 'full', ref: `r${i}` })
// one `calls {harness, host}` page: PAGE rows from `after` (a cursor 'c<n>'), two pages in all
const page = (after: unknown, cls: string) => {
  const from = after ? Number(String(after).slice(1)) : 0
  return doc({ total: 2 * PAGE, detail_limit: 0, records: Array.from({ length: PAGE }, (_, i) => row(from + i, cls)), next: from ? null : `c${PAGE}`, has_more: !from })
}
// one `calls {ref}` record: two credential headers the server blanked (ctl.masked), one plain; `reveal` carries that one value only
const refDoc = (ref: string, reveal?: string) => doc({ total: 1, next: null, has_more: false, records: [{
  ...row(Number(ref.slice(1))), method: 'POST',
  req_headers: ['authorization', 'x-api-key'].map((name) => (name === reveal ? { name, value: SECRET[name], masked: false } : { name, value: null, masked: true }))
    .concat([{ name: 'content-type', value: 'application/json', masked: false }]),
  resp: { status: 200, headers: [{ name: 'content-type', value: 'text/plain', masked: false }] },
  ctl: { traffic_class: 'telemetry', retention: 'full', host: HOST, hostHeader: HOST, hostDiffers: false, masked: ['authorization', 'x-api-key'].filter((n) => n !== reveal),
    req: { kind: 'text', text: '{"event":"opened","n":1}', bytes: 24 }, resp: { kind: 'text', text: 'accepted', bytes: 8 }, labels: [], wire_bytes: { req: 24, resp: 8 } },
}] })

let answerOf: (params: P) => Answer | Promise<Answer>
let wide = true
const reads = () => vi.mocked(api.get).mock.calls.filter(([n]) => n === 'calls').map(([, p]) => p as P)
const listReads = () => reads().filter((p) => !p.ref)

beforeEach(() => {
  initKeys()
  wide = true
  answerOf = (p) => (p.ref ? ok(refDoc(String(p.ref), p.reveal as string | undefined)) : ok(page(p.after, String(p.class ?? 'telemetry'))))
  vi.spyOn(api, 'get').mockImplementation(async (name: string, params: P) => {
    if (name === 'calls') return answerOf(params)
    if (name === 'traffic') return ok({ as_of: T, hosts: [{ harness: H, harness_inferred: false, host: HOST, first_seen: T, last_seen: T, requests: 3, sent_bytes: 9,
      received_bytes: 9, received_unrecorded: 0, classes: { telemetry: 3 }, class_unrecorded: 0 }], harness_since: { [H]: T }, totals: { requests: 3, sent_bytes: 9, received_bytes: 9, is_floor: true }, next: null, has_more: false })
    if (name === 'sessions') return ok({ sessions: [], next: null })
    return { ok: false, status: 404, data: null, error: 'HTTP 404' }
  })
  vi.spyOn(api, 'control').mockImplementation(() => { throw new Error('the traffic pages never write') })
  window.matchMedia = ((q: string) => ({ matches: wide, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  // jsdom lays nothing out: every box is 340 px tall (ten rows), and scrolling is a property the test sets
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(340)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  Element.prototype.scrollTo = function () {} as Element['scrollTo']
})
afterEach(() => {
  cleanup()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const held = () => { let release!: (a: Answer) => void; const p = new Promise<Answer>((r) => { release = r }); return { p, release } }

function mount(hash: string) {
  let router!: BoardRouter
  function Wrapper() {
    const [route, setRoute] = useState(() => parseHash(hash))
    const [r] = useState(() => ({
      current: () => route,
      go: vi.fn((to) => setRoute(to)),
      setParams: vi.fn((patch: P) => setRoute((at: ReturnType<typeof parseHash>) => ({ ...at, params: Object.fromEntries(Object.entries({ ...at.params, ...patch }).filter(([, v]) => v != null)) }))),
      onRoute: () => () => {},
    }) as unknown as BoardRouter)
    router = r
    const Screen = route.screen === 'traffic-host' ? HostScreen : TrafficScreen
    return <Screen route={route} router={r} />
  }
  const v = render(<QueryClientProvider client={new QueryClient()}><Wrapper /></QueryClientProvider>)
  const $ = <E extends Element = HTMLElement>(s: string) => v.container.querySelector<E>(s)
  const link = (ref: string) => [...v.container.querySelectorAll<HTMLAnchorElement>('a.hmain')].find((a) => a.href.includes(`ref=${ref}`))
  const goHref = (href: string) => act(() => { router.go(parseHash(new URL(href, 'http://x/').hash)) })
  return { ...v, $, link, goHref, router: () => router }
}
const hostHash = (q: string) => `#/traffic/host/${H}/${HOST}?${q}`
const press = (k: string, target: Element = document.body) => fireEvent.keyDown(target, { key: k })
const showButton = (c: HTMLElement, name: string) => {
  const k = [...c.querySelectorAll('.kvt .k')].find((e) => e.textContent === name)
  return k?.nextElementSibling?.querySelector('button') ?? null
}

test('d1 #21: Show reads that one header once, shows it alone, and keeps Technical details open and the selection in place', async () => {
  const p = mount(hostHash('ref=r1'))
  await waitFor(() => expect(p.$('.rqd[data-ref="r1"]')).not.toBeNull())
  const tech = p.getByRole('button', { name: /technical details/i })
  fireEvent.click(tech)
  expect(tech.getAttribute('aria-expanded')).toBe('true')
  const text = p.$('[data-side=req-body] pre.rqd-pre')!.firstChild!
  document.getSelection()!.setBaseAndExtent(text, 0, text, 8)

  fireEvent.click(showButton(p.container, 'authorization')!)
  await waitFor(() => expect(p.container.textContent).toContain(SECRET.authorization))
  expect(reads().filter((r) => r.reveal === 'authorization')).toEqual([expect.objectContaining({ ref: 'r1', reveal: 'authorization' })])
  expect(p.container.textContent).not.toContain(SECRET['x-api-key'])
  expect(showButton(p.container, 'x-api-key')).not.toBeNull()
  expect(p.getByRole('button', { name: /technical details/i }).getAttribute('aria-expanded')).toBe('true')
  const sel = document.getSelection()!
  expect(sel.isCollapsed).toBe(false)
  expect(sel.anchorNode!.isConnected).toBe(true)

  // the shown value belongs to that one selection: moving away and back masks it again, with no read of its own
  const shown = reads().filter((r) => r.reveal).length
  fireEvent.click(p.link('r2')!)
  await waitFor(() => expect(p.$('.rqd[data-ref="r2"]')).not.toBeNull())
  fireEvent.click(p.link('r1')!)
  await waitFor(() => expect(p.$('.rqd[data-ref="r1"]')).not.toBeNull())
  await act(async () => {})
  expect(p.container.textContent).not.toContain(SECRET.authorization)
  expect(showButton(p.container, 'authorization')).not.toBeNull()
  expect(reads().filter((r) => r.reveal).length).toBe(shown)

  // a failed reveal keeps that value masked
  answerOf = (q) => (q.reveal ? { ok: false, status: 500, data: null, error: 'boom' } : ok(refDoc(String(q.ref))))
  fireEvent.click(showButton(p.container, 'x-api-key')!)
  await waitFor(() => expect(reads().some((r) => r.reveal === 'x-api-key')).toBe(true))
  await act(async () => {})
  expect(p.container.textContent).not.toContain(SECRET['x-api-key'])
  expect(showButton(p.container, 'x-api-key')).not.toBeNull()
})

test('d2 #12: the end of the list reads after=next; the focused and the selected rows stay the same nodes; no read once next is null', async () => {
  let page2 = held()
  answerOf = (q) => (q.after ? page2.p : q.ref ? ok(refDoc(String(q.ref))) : ok(page(null, 'telemetry')))
  const p = mount(hostHash('ref=r30'))
  await waitFor(() => expect(p.$('#hlist')).not.toBeNull())
  const scroller = p.$('.tlist')!
  let top = 0
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v } })
  const scrollTo = async (y: number) => { top = y; fireEvent.scroll(scroller); await act(async () => {}) }
  await scrollTo(PAGE * 34 - 340)
  await waitFor(() => expect(listReads().map((r) => r.after ?? null)).toEqual([null, `c${PAGE}`]))
  const focused = p.link('r28')!, current = p.$('a.hmain[aria-current]')!
  expect(current).toBe(p.link('r30'))
  focused.focus()
  const done = page2; page2 = held()
  await act(async () => { done.release(ok(page(`c${PAGE}`, 'telemetry'))) })
  await waitFor(() => expect(p.$<HTMLElement>('#hlist')!.style.height).toBe(`${2 * PAGE * 34}px`))
  expect(p.link('r28')).toBe(focused)
  expect(document.activeElement).toBe(focused)
  expect(p.$('a.hmain[aria-current]')).toBe(current)
  await scrollTo(2 * PAGE * 34 - 340)
  await act(async () => {})
  expect(listReads().length).toBe(2)
})

test('d2b #12 / K-29 a next page that fails keeps the rows drawn and says so; scrolling does not re-read it, Retry reads after=next again', async () => {
  for (const fail of [{ ok: false, status: 0, data: null, error: 'timeout' }, { ok: false, status: 503, data: null, error: 'down' }] as Answer[]) {
    vi.mocked(api.get).mockClear()
    let down = true
    answerOf = (q) => (q.after ? (down ? fail : ok(page(q.after, 'telemetry'))) : ok(page(null, 'telemetry')))
    const p = mount(hostHash('window=24h'))
    await waitFor(() => expect(p.$('#hlist')).not.toBeNull())
    const scroller = p.$('.tlist')!
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v } })
    const scrollTo = async (y: number) => { top = y; fireEvent.scroll(scroller); await act(async () => {}) }
    await scrollTo(PAGE * 34 - 340)
    const retry = await waitFor(() => p.getByRole('button', { name: /retry/i }))
    expect(p.$<HTMLElement>('#hlist')!.style.height).toBe(`${PAGE * 34}px`)
    await scrollTo(PAGE * 34 - 300)
    await act(async () => {})
    expect(listReads().map((r) => r.after ?? null)).toEqual([null, `c${PAGE}`])
    down = false
    fireEvent.click(retry)
    await waitFor(() => expect(p.$<HTMLElement>('#hlist')!.style.height).toBe(`${2 * PAGE * 34}px`))
    expect(listReads().map((r) => r.after ?? null)).toEqual([null, `c${PAGE}`, `c${PAGE}`])
    expect(p.queryByRole('button', { name: /retry/i })).toBeNull()
    p.unmount()
  }
})

test('d3 #20 detail placement follows the media query: the drawer opens with ref; ↓ selects the next ref, Esc drops it; a drag-select over a row is not a click', async () => {
  wide = false
  const p = mount(hostHash('ref=r1'))
  await waitFor(() => expect(p.$('aside.hdetail.open .rqd')).not.toBeNull())
  expect(p.$('.thost.drawer')).not.toBeNull()
  press('ArrowDown')
  expect(p.router().setParams).toHaveBeenLastCalledWith({ ref: 'r2' })
  press('Escape')
  expect(p.router().setParams).toHaveBeenLastCalledWith({ ref: null })
  await waitFor(() => expect(p.$('aside.hdetail.open')).toBeNull())

  installUi(document)
  vi.mocked(p.router().setParams).mockClear()
  const cell = p.link('r3')!.querySelector('.cell-endpoint')!
  fireEvent.pointerDown(cell)
  document.getSelection()!.setBaseAndExtent(cell.firstChild!, 0, cell.firstChild!, 4)
  fireEvent.click(cell, { detail: 1 })
  expect(p.router().setParams).not.toHaveBeenCalled()
})

test('d4 #23 / #19 a detail that cannot be read says why: a slower earlier answer never paints over the newer selection; a failed ref read shows Retry, which re-reads', async () => {
  const a = held()
  answerOf = (q) => (q.ref === 'r1' ? a.p : q.ref === 'r3' ? { ok: false, status: 500, data: null, error: 'boom' } : q.ref ? ok(refDoc(String(q.ref))) : ok(page(q.after, 'telemetry')))
  const p = mount(hostHash('ref=r1'))
  await waitFor(() => expect(p.link('r2')).toBeTruthy())
  fireEvent.click(p.link('r2')!)
  await waitFor(() => expect(p.$('.rqd')?.getAttribute('data-ref')).toBe('r2'))
  await act(async () => { a.release(ok(refDoc('r1'))) })
  expect(p.$('.rqd')!.getAttribute('data-ref')).toBe('r2')

  fireEvent.click(p.link('r3')!)
  const retry = await p.findByRole('button', { name: /retry/i })
  expect(p.$('.d-err')).not.toBeNull()
  const before = reads().filter((r) => r.ref === 'r3').length
  fireEvent.click(retry)
  await waitFor(() => expect(reads().filter((r) => r.ref === 'r3').length).toBe(before + 1))
  p.unmount()

  // a list that cannot be read: Retry and no rows, never an empty table
  answerOf = (q) => (q.ref ? ok(refDoc(String(q.ref))) : { ok: false, status: 503, data: null, error: 'no store' })
  const f = mount(hostHash('window=7d'))
  const again = await f.findByRole('button', { name: /retry/i })
  expect(f.$('#hlist')).toBeNull()
  expect(f.$('[data-empty]')).toBeNull()
  const n = listReads().length
  fireEvent.click(again)
  await waitFor(() => expect(listReads().length).toBe(n + 1))
})

test('d5 #11 read only: every request the page makes is a GET to /api/; #16 and every calls list read keeps class=telemetry through a window change, a reveal and Esc', async () => {
  const t = mount('#/traffic?class=telemetry')
  await waitFor(() => expect(t.$('.seg a')).not.toBeNull())
  t.goHref(t.$<HTMLAnchorElement>('.seg a:not(.on)')!.href)
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.filter(([n]) => n === 'traffic').length).toBe(2))
  t.unmount()

  const p = mount(hostHash('class=telemetry&ref=r1'))
  await waitFor(() => expect(p.$('.rqd')).not.toBeNull())
  p.goHref(p.$<HTMLAnchorElement>('.seg a:not(.on)')!.href)
  await waitFor(() => expect(listReads().length).toBe(2))
  act(() => { p.router().setParams({ ref: 'r1' }) })
  await waitFor(() => expect(showButton(p.container, 'authorization')).not.toBeNull())
  fireEvent.click(showButton(p.container, 'authorization')!)
  await waitFor(() => expect(p.container.textContent).toContain(SECRET.authorization))
  press('Escape')
  await waitFor(() => expect(p.$('aside.hdetail.open')).toBeNull())
  expect(api.control).not.toHaveBeenCalled()
  expect(listReads().length).toBeGreaterThan(0)
  expect(listReads().every((r) => r.class === 'telemetry')).toBe(true)
})
