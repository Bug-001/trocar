// web/src/screens/settings/StorageScreen.test.tsx — the storage page's component contracts (1.11 §组件状态 · §改级别 · 验收 5/7–10/15,
// 1.5 K-29, D75④): a re-read after a level change or a window switch keeps what the reader opened and where focus is; the level control
// is a radiogroup whose selection is the server's keep; a change plans before it writes (invariant 1) and asks only for llm /
// token-count → log; each answer leaves its receipt and server words sit only in collapsed technical details; ?class= marks one row; a
// failed read says so with a Retry. Documents are built in the C.5 `classes` / `segments` shape; the control plane is a stand-in.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { CLASS_NAME } from '../../../legacy/core/classes.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { fmtTime } from '../../../legacy/core/fmt.mjs'
import { ConfirmProvider } from '../../ui/Confirm'
import StorageScreen from './StorageScreen'
import type { ScreenProps } from '../../ScreenOutlet'

const router = {} as ScreenProps['router'] // these screens write nothing to the route

const T = '2026-10-20T09:00:00Z'
const CLASSES = Object.keys(CLASS_NAME)
const TOKEN = 'tok-7f3a9c' // a server word: it may only appear inside technical details
type Answer = { ok: boolean, status: number, data: unknown, error: string | null }
type Body = Record<string, unknown>

let keeps: Record<string, string> = {}
let big: string | null = null // the class whose stored bytes jump to the top in the next classes answers
let gate: Promise<void> | null = null // while set, classes answers wait for it
let classesFail: Answer | null = null
let segmentsFail: Answer | null = null
let control: { control: boolean, root: boolean } = { control: true, root: false }
let answer: (body: Body) => Answer | Promise<Answer> = serve

const counts = (i: number, c: string) => {
  const n = (m: number) => ({ calls: (i + 1) * m, bytes: c === big ? 9e9 : (CLASSES.length - i) * 1000 * m })
  return { h24: n(1), d7: n(7), all: n(30) }
}
const classesDoc = () => ({
  classes: CLASSES.map((c, i) => ({ class: c, keep: keeps[c], builtin: true, rules: c === 'other' ? [] : [{ host: `${c}.example` }], counts: counts(i, c) })),
  disk: { trocar_bytes: 5e6, records_bytes: 4e6, sealed_bytes: 1e6 }, file: '/home/u/.trocar/classes.json', last_change: null, as_of: T, errors: [],
})
// the control plane: a plan first (409), then the confirmed write changes that one class and says before / after
function serve(body: Body): Answer {
  if (!body.confirm) return { ok: false, status: 409, data: { need: 'confirm', plan: { class: body.class, keep: body.keep }, plan_id: `plan-${body.class}` }, error: 'HTTP 409' }
  const before = keeps[String(body.class)]
  keeps[String(body.class)] = String(body.keep)
  return { ok: true, status: 200, data: { ok: true, class: body.class, before: { keep: before }, after: { keep: body.keep }, changed: before !== body.keep }, error: null }
}

beforeEach(() => {
  keeps = Object.fromEntries(CLASSES.map((c) => [c, 'full']))
  big = null; gate = null; classesFail = null; segmentsFail = null; control = { control: true, root: false }; answer = serve
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => {
    if (name === 'classes') {
      if (gate) await gate
      return classesFail ?? { ok: true, status: 200, data: classesDoc(), error: null }
    }
    if (name === 'segments') return segmentsFail ?? { ok: true, status: 200, data: { segments: [{ segment: 'raw/a.ndjson', problems: [] }], errors: [] }, error: null }
    return { ok: false, status: 404, data: null, error: 'HTTP 404' }
  })
  vi.spyOn(api, 'controlStatus').mockImplementation(async () => ({ ok: true, status: 200, data: { ...control }, error: null }))
  vi.spyOn(api, 'control').mockImplementation(async (_verb: string, body: Body) => answer(body))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.replaceChildren() })

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const page = (hash: string) => <QueryClientProvider client={new QueryClient()}><ConfirmProvider><StorageScreen route={parseHash(hash)} router={router} /></ConfirmProvider></QueryClientProvider>
async function mount(hash = '#/settings/storage') {
  const client = new QueryClient()
  const tree = (h: string) => <QueryClientProvider client={client}><ConfirmProvider><StorageScreen route={parseHash(h)} router={router} /></ConfirmProvider></QueryClientProvider>
  const r = render(tree(hash))
  await settle()
  return { ...r, go: async (h: string) => { r.rerender(tree(h)); await settle() } }
}
const row = (c: string) => document.querySelector<HTMLElement>(`tr[data-class="${c}"]`)!
const group = (c: string) => within(row(c)).getByRole('radiogroup', { name: W.LEVEL_OF(CLASS_NAME[c as keyof typeof CLASS_NAME]) })
const radio = (c: string, keep: string) => row(c).querySelector<HTMLElement>(`[role="radio"][data-keep="${keep}"]`)!
const press = async (el: Element) => { fireEvent.click(el); await settle() }
const key = async (el: Element, k: string) => { fireEvent.keyDown(el, { key: k }); fireEvent.keyUp(el, { key: k }); await settle() }
const bodies = () => vi.mocked(api.control).mock.calls.map((c) => c[1] as Body)
const confirms = () => bodies().filter((b) => b.confirm != null).length
const visible = () => { const c = document.body.cloneNode(true) as Element; c.querySelectorAll('[hidden]').forEach((e) => e.remove()); return c.textContent ?? '' }
const discT = (card: number) => document.querySelectorAll<HTMLElement>('#smain > .scard')[card].querySelector<HTMLElement>(':scope > .disc > .disc-t')!

test('V1: the card\'s technical details and the disk files stay open across a change\'s re-read and a window switch', async () => {
  const p = await mount()
  await press(discT(0)); await press(discT(1))
  big = 'telemetry'
  await press(radio('telemetry', 'log'))
  await waitFor(() => expect(radio('telemetry', 'log').getAttribute('aria-checked')).toBe('true'))
  await p.go('#/settings/storage?window=7d')
  expect(discT(0).getAttribute('aria-expanded')).toBe('true')
  expect(discT(1).getAttribute('aria-expanded')).toBe('true')
})

test('V2: the radio the reader pressed keeps focus and the rows keep their places when the re-read moves its class to the top', async () => {
  await mount()
  const order = () => [...document.querySelectorAll<HTMLElement>('.ctable tbody tr')].map((t) => t.dataset.class)
  const shown = order()
  const r = radio('telemetry', 'log')
  act(() => r.focus())
  big = 'telemetry'
  await press(r)
  await waitFor(() => expect(radio('telemetry', 'log').getAttribute('aria-checked')).toBe('true'))
  const a = document.activeElement as HTMLElement
  expect([a.dataset.class, a.dataset.keep]).toEqual(['telemetry', 'log'])
  expect(order()).toEqual(shown)
})

test('V3: each class has a named radiogroup checked at its keep; Space changes; Enter opens a popover with one link, Esc returns focus', async () => {
  keeps.files = 'log'
  await mount()
  for (const c of CLASSES) {
    expect(group(c)).toBeTruthy()
    for (const k of Object.keys(W.KEEP_NAME)) expect(radio(c, k).getAttribute('aria-checked')).toBe(String(keeps[c] === k))
  }
  await key(radio('files', 'full'), ' ')
  expect(bodies()[0]).toMatchObject({ kind: 'set', class: 'files', keep: 'full' })
  const info = within(row('telemetry')).getByRole('button', { name: CLASS_NAME.telemetry })
  act(() => info.focus())
  await key(info, 'Enter')
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  const live = [...dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
  expect(live.map((e) => [e.tagName, e.getAttribute('href')])).toEqual([['A', '#/traffic?class=telemetry&window=24h']])
  await key(document.activeElement!, 'Escape')
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(info))
})

test('V3: a class ⓘ opens on focus and is not modal: outside stays live and takes the focus (1.2 §弹出层)', async () => {
  await mount()
  const info = within(row('telemetry')).getByRole('button', { name: CLASS_NAME.telemetry })
  act(() => info.focus())
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const t = radio('files', 'full')
  const free = (el: Element | null): boolean => !el || (!el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && free(el.parentElement))
  expect(free(t), 'outside stays live').toBe(true)
  act(() => t.focus())
  expect(document.activeElement, 'outside takes focus').toBe(t)
})

test('V3: with a class ⓘ open, the next tabbable after it is the layer\'s 「看这类流量 ›」 link (1.2 §弹出层)', async () => {
  await mount()
  const info = within(row('telemetry')).getByRole('button', { name: CLASS_NAME.telemetry })
  act(() => info.focus())
  await key(info, 'Enter')
  const link = document.querySelector<HTMLElement>('[role="dialog"] a[href]')
  expect(link?.getAttribute('href')).toBe('#/traffic?class=telemetry&window=24h')
  const order = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[hidden], [inert]'))
  expect(order[order.indexOf(info) + 1]).toBe(link)
})

test('V4: a change plans then confirms, stays busy without disabling, ignores a second press, shows the server\'s level only after the re-read', async () => {
  await mount()
  let release!: (a: Answer) => void
  answer = (b) => (b.confirm ? new Promise<Answer>((res) => { release = res }) : serve(b))
  await press(radio('telemetry', 'log'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(group('telemetry').getAttribute('aria-busy')).toBe('true')
  expect(document.querySelectorAll('[role="radio"][disabled], [role="radio"][aria-disabled="true"]').length).toBe(0)
  await press(radio('telemetry', 'log'))
  expect(bodies()).toEqual([{ kind: 'set', class: 'telemetry', keep: 'log' }, { kind: 'set', class: 'telemetry', keep: 'log', confirm: 'plan-telemetry' }])
  let open!: () => void
  gate = new Promise<void>((res) => { open = res })
  await act(async () => { release(serve(bodies()[1])) })
  await settle()
  expect(radio('telemetry', 'full').getAttribute('aria-checked')).toBe('true')
  gate = null; await act(async () => { open() }); await settle()
  expect(radio('telemetry', 'log').getAttribute('aria-checked')).toBe('true')
  expect(row('telemetry').querySelector('[data-receipt]')?.getAttribute('data-receipt')).toBe('changed')
})

test('V5: only llm and token-count to log ask first; Cancel has focus, Esc and Cancel send no confirm, OK sends exactly one', async () => {
  await mount()
  for (const c of ['llm', 'token-count']) {
    const before = confirms()
    await press(radio(c, 'log'))
    await waitFor(() => expect(document.activeElement?.getAttribute('data-confirm')).toBe('cancel'))
    await key(document.activeElement!, 'Escape')
    await press(radio(c, 'log'))
    await press(document.querySelector('[data-confirm="cancel"]')!)
    expect(confirms()).toBe(before)
    await press(radio(c, 'log'))
    await press(document.querySelector('[data-confirm="ok"]')!)
    expect(confirms()).toBe(before + 1)
  }
  await waitFor(() => expect(radio('llm', 'log').getAttribute('aria-checked')).toBe('true'))
  for (const [c, k] of [['llm', 'full'], ['telemetry', 'log']]) {
    await press(radio(c, k))
    expect(document.querySelector('[data-confirm]')).toBeNull()
  }
})

test('V6: each answer leaves its receipt; server words only in technical details; 405 turns the levels to text; 403 stops', async () => {
  const cases: Array<[string, (b: Body) => Answer | Promise<Answer>]> = [
    ['not-changed', (b) => (b.confirm ? { ok: false, status: 400, data: { error: `bad class ${TOKEN}` }, error: 'HTTP 400' } : serve(b))],
    ['offline', () => { throw new Error(`fetch failed ${TOKEN}`) }],
    ['already', (b) => (b.confirm ? { ok: true, status: 200, data: { ok: true, before: { keep: 'log' }, after: { keep: 'log' } }, error: null } : serve(b))],
  ]
  await mount()
  for (const [kind, a] of cases) {
    answer = a
    await press(radio('telemetry', 'log'))
    const rc = row('telemetry').querySelector<HTMLElement>('[data-receipt]')!
    expect(rc.getAttribute('data-receipt')).toBe(kind)
    if (kind === 'not-changed') {
      expect(visible()).not.toContain(TOKEN)
      await press(rc.querySelector('.disc-t')!)
      expect(visible()).toContain(TOKEN)
    }
    if (kind === 'offline') {
      const n = bodies().length
      await press(within(rc).getByRole('button', { name: W.RETRY }))
      expect(bodies().length).toBeGreaterThan(n)
    }
  }
  // 409 to the confirm (the plan went stale) then 200: the same press confirms the new one-class plan once, never the old plan_id again
  let stale = true
  answer = (b) => {
    if (b.confirm && stale) { stale = false; return { ok: false, status: 409, data: { need: 'confirm', plan: { class: b.class, keep: b.keep }, plan_id: 'plan-new' }, error: 'HTTP 409' } }
    return serve(b)
  }
  const c = CLASSES.find((x) => !['llm', 'token-count', 'telemetry'].includes(x))!
  const before = bodies().length
  await press(radio(c, 'log'))
  expect(document.querySelector('[data-confirm]')).toBeNull()
  expect(bodies().slice(before).map((b) => b.confirm ?? null)).toEqual([null, `plan-${c}`, 'plan-new'])
  expect(row(c).querySelector('[data-receipt]')?.getAttribute('data-receipt')).toBe('changed')
  await waitFor(() => expect(radio(c, 'log').getAttribute('aria-checked')).toBe('true'))

  answer = () => ({ ok: false, status: 405, data: null, error: 'HTTP 405' })
  control = { control: false, root: true }
  const asked = vi.mocked(api.controlStatus).mock.calls.length
  await press(radio('telemetry', 'log'))
  expect(row('telemetry').querySelector('[data-receipt]')?.getAttribute('data-receipt')).toBe('read-only')
  expect(vi.mocked(api.controlStatus).mock.calls.length).toBeGreaterThan(asked)
  await waitFor(() => expect(document.querySelector('[role="radiogroup"]')).toBeNull())
  expect(document.querySelectorAll('button[disabled], [aria-disabled="true"]').length).toBe(0)

  cleanup(); control = { control: true, root: false }
  answer = () => ({ ok: false, status: 403, data: null, error: 'HTTP 403' })
  await mount()
  const calls = () => vi.mocked(api.get).mock.calls.length + vi.mocked(api.controlStatus).mock.calls.length + vi.mocked(api.control).mock.calls.length
  await press(radio('telemetry', 'log'))
  const after = calls()
  await settle()
  expect(document.querySelector('[data-receipt]')).toBeNull()
  expect(calls()).toBe(after)
})

test('V7: ?class= marks only that row; an unknown class marks none and the table stays whole', async () => {
  const p = await mount('#/settings/storage?class=telemetry')
  expect([...document.querySelectorAll<HTMLElement>('tr[data-hl="true"]')].map((t) => t.dataset.class)).toEqual(['telemetry'])
  await p.go('#/settings/storage?class=nosuch')
  expect(document.querySelectorAll('tr[data-hl="true"]').length).toBe(0)
  expect(document.querySelectorAll('.ctable tbody tr').length).toBe(CLASSES.length)
  const pointer = [...document.querySelectorAll<HTMLAnchorElement>('#smain a')].find((a) => a.textContent?.startsWith(W.CAPTURE_PAGE_LINE))
  expect(pointer?.getAttribute('href')).toBe(W.CAPTURE_PAGE_HREF)
})

test('V8: a failed classes read offers Retry with the reason hidden; a failed segments read is said in the disk card, not as a count', async () => {
  classesFail = { ok: false, status: 502, data: null, error: `upstream ${TOKEN}` }
  render(page('#/settings/storage'))
  await settle()
  expect(visible()).not.toContain(TOKEN)
  const n = vi.mocked(api.get).mock.calls.filter((c) => c[0] === 'classes').length
  classesFail = null
  segmentsFail = { ok: false, status: 0, data: null, error: `no route ${TOKEN}` }
  await press(within(document.querySelector<HTMLElement>('#smain .err')!).getByRole('button', { name: W.RETRY }))
  expect(vi.mocked(api.get).mock.calls.filter((c) => c[0] === 'classes').length).toBe(n + 1)
  cleanup()
  render(page('#/settings/storage'))
  await settle()
  const disk = document.querySelectorAll('#smain > .scard')[0]
  expect(disk.querySelector('.jumpfiles')).toBeNull()
  expect(within(disk.querySelector<HTMLElement>('.dline.bad')!).getByRole('button', { name: W.RETRY })).toBeTruthy()
  expect(visible()).not.toContain(TOKEN)
})

test('V9: every entry reads classes again; a cached document drawn on entry keeps its own read time when the re-read fails (1.11 §数据与刷新, invariant 4)', async () => {
  const T1 = Date.UTC(2026, 9, 20, 9, 0, 0), T2 = T1 + 3 * 3600e3 + 7e3
  let now = T1
  vi.spyOn(api, 'now').mockImplementation(() => now)
  const client = new QueryClient() // one client for the board, as in main.tsx
  const tree = () => <QueryClientProvider client={client}><ConfirmProvider><StorageScreen route={parseHash('#/settings/storage')} router={router} /></ConfirmProvider></QueryClientProvider>
  let r = render(tree())
  await settle()
  expect(document.querySelector('.readat')!.textContent).toContain(fmtTime(T1))
  r.unmount()
  now = T2; classesFail = { ok: false, status: 0, data: null, error: 'no route' }
  r = render(tree())
  await settle()
  expect(vi.mocked(api.get).mock.calls.filter((c) => c[0] === 'classes').length).toBe(2)
  expect(within(document.querySelector<HTMLElement>('#smain .err')!).getByRole('button', { name: W.RETRY })).toBeTruthy()
  expect(document.querySelector('.readat')!.textContent).toContain(fmtTime(T1))
  expect(document.body.textContent).not.toContain(fmtTime(T2))
})
