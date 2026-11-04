// web/src/screens/overview/OverviewScreen.test.tsx — the overview's component contracts (1.7 §读取与刷新 · §组件状态 · 验收 #4 #8 #9 #10
// #18, 1.2 §点击与选中文字 ③, 1.5 K-01/K-02, D75④): answers that change on every poll never disturb the reader (open details,
// a selection, the focus), the keyboard reaches every control, a window change re-reads only the stats and never shows another
// window's numbers, the slow reads share two slots, first use turns into the normal page in place,
// and a stored sessions answer is never shown. Documents are spec 1.6's C.3 sample; polls are fake timers of INTERVAL.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { INTERVAL, backoffMs } from '../../../legacy/core/poll.mjs'
import { TIP_MS } from '../../../legacy/core/ui.mjs'
import { HEALTH_READ, TITLE_PENDING } from '../../../legacy/labels/common.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { store } from '../../../legacy/core/store.mjs'
import { ALIASES, HARNESS_ORDER, harnessKey } from '../../../legacy/core/chips.mjs'
import * as W from '../../../legacy/labels/overview.mjs'
import { ConfirmProvider } from '../../ui/Confirm'
import OverviewScreen from './OverviewScreen'
import type { ScreenProps } from '../../ScreenOutlet'

const router = {} as ScreenProps['router'] // these screens write nothing to the route

const nodeFs = 'node:fs' // the web tsconfig carries no node types; the test reads the spec through a plain dynamic import
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string }
const C3 = readFileSync('spec/01-trocar-rfc/1.6-cli.md', 'utf8').split('### C.3')[1]
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)![1])
const T = '2026-10-20T09:00:00Z'
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString()

// the status document spells a harness the CLI's way; three of the chip table's harnesses
const cli = (k: string) => Object.entries(ALIASES as Record<string, string>).find(([, v]) => v === k)?.[0] ?? k
const IDS = HARNESS_ORDER.slice(0, 3).map(cli)
type Ans = { ok: boolean, status: number, data: unknown, error: string | null }
type O = Record<string, unknown>
const ok = (data: unknown): Ans => ({ ok: true, status: 200, data, error: null })
const fail = (n = 0): Ans => ({ ok: false, status: 500 + (n % 3), data: null, error: `boom ${n}` })
// answer n of `status`: the daemon up, one harness with a problem (an item), the others fine, the n-th setup state as given; every
// answer differs from the one before (its failure-group count and each agent's pid)
function statusDoc(n: number, setup: O = { state: 'ready', missing: [] }) {
  const d = sample()
  d.daemon = { running: true, responding: true, pid: 4012, since: T, error: null }
  d.health = { state: 'ok', since: T }
  d.harnesses = Object.fromEntries(IDS.map((id, i) => [id, { desired: 'on', updated_at: T, setup: i === 2 ? setup : { state: 'ready', missing: [] },
    ...(i === 0 ? { captured: false, reason: 'config-after-start' } : { captured: true }) }]))
  d.topology = Object.fromEntries(IDS.map((id) => [id, { at: T, running: [{ pid: 7000 + n }] }]))
  d.critical = []; d.changed = []; d.errors = []; d.install = { state: 'complete', pending: [] }
  d.failures = { since: T, groups: Array.from({ length: n }, () => ({ level: 'note', where: 'engine', code: 'x', count: 1, first_ts: T, last_ts: T })) }
  return d
}
const sess = (id: string, min: number, calls = 1) => ({ session_id: id, project_slug: 'p', harness: IDS[1], title: `title ${id}`, title_source: 'wire', last_ts: ago(min), calls, probes: 0 })
const replay = (id: string) => `#/replay/p/${id}`
const ovDoc = (total: number) => ({ as_of: T, sessions: { total }, calls: { llm: total }, harnesses: [{ harness: IDS[1], sessions: 1, calls: total, last_ts: T }], usage: { rows: [] } })
const BASE: Record<string, (n: number, p: O) => Ans | Promise<Ans>> = {
  status: (n) => ok(statusDoc(n)),
  sessions: (n) => ok({ sessions: [sess('a', 60, n + 1)] }),
  classes: (n) => ok({ disk: { trocar_bytes: 1000 + n } }),
  pricing: () => ok({ models: [] }),
  overview: (n) => ok(ovDoc(10 + n)),
  segments: () => ok({ segments: [] }),
  traffic: () => ok({ hosts: [], harness_since: {} }),
}
const SLOW = ['classes', 'pricing', 'overview', 'segments', 'traffic']

type Call = { name: string, params: O, signal?: AbortSignal, at: number }
let calls: Call[] = []
let answer: typeof BASE = {}
let inFlight = 0, maxInFlight = 0
let client: QueryClient
const asked = (name: string) => calls.filter((c) => c.name === name)

beforeEach(() => {
  vi.useFakeTimers()
  store.set({ capH: null, capHOkAt: null, capHErr: null })
  calls = []; answer = { ...BASE }; inFlight = 0; maxInFlight = 0
  vi.spyOn(api, 'get').mockImplementation(async (name: string, params: O, opts?: { signal?: AbortSignal }) => {
    const n = asked(name).length
    calls.push({ name, params, signal: opts?.signal, at: Date.now() })
    const slow = SLOW.includes(name)
    let out = !slow
    const done = () => { if (!out) { out = true; inFlight-- } } // an abort gives the socket back, as the browser does
    if (slow) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight) }
    opts?.signal?.addEventListener('abort', done, { once: true })
    try { return await (answer[name] ?? (() => ({ ok: false, status: 404, data: null, error: "HTTP 404" })))(n, params) } finally { done() }
  })
  vi.spyOn(api, 'controlStatus').mockImplementation(async () => ok({ control: true, root: false }))
  vi.spyOn(api, 'control').mockImplementation(async () => ok({ ok: true }))
})
afterEach(() => {
  cleanup()
  client?.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  Reflect.deleteProperty(document, 'visibilityState')
})

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const settle = async () => { for (let i = 0; i < 3; i++) await tick(1) } // as CaptureScreen.test.tsx: notify, then the page's scheduling
const poll = async (name: keyof typeof INTERVAL) => { await tick(INTERVAL[name]); await settle() }
const hold = <V,>(ms: number, v: V) => new Promise<V>((res) => setTimeout(() => res(v), ms))

function mount(hash = '#/overview') {
  client = new QueryClient()
  const ui = (h: string) => <QueryClientProvider client={client}><ConfirmProvider><OverviewScreen route={parseHash(h)} router={router} /></ConfirmProvider></QueryClientProvider>
  const r = render(ui(hash))
  const c = r.container
  const region = (name: string) => within(c).queryByRole('region', { name })
  const panelOf = (t: Element) => document.getElementById(t.getAttribute('aria-controls')!)!
  const open = (t: Element) => t.getAttribute('aria-expanded') === 'true' && !panelOf(t).hasAttribute('hidden')
  const shut = (t: Element) => t.getAttribute('aria-expanded') === 'false' && panelOf(t).hasAttribute('hidden')
  const link = (href: string) => c.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
  const readAt = () => c.querySelector('.readat')?.textContent ?? null
  return { c, region, open, shut, link, readAt, go: (h: string) => r.rerender(ui(h)) }
}
const setVisible = (visible: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

test('O1: the stats card\'s price-table details the reader opened stay open across polls; the failed session list\'s details stay closed', async () => {
  answer.pricing = (n) => fail(n)
  answer.sessions = (n) => fail(n)
  const p = mount(); await settle()
  const statsT = p.region(W.CARD.stats)!.querySelector('[aria-expanded]')!
  const sessT = () => p.c.querySelector('[data-g="sessions"]')!.closest('section')!.querySelector('[aria-expanded]')!
  expect(p.shut(statsT)).toBe(true)
  fireEvent.click(statsT); await settle()
  for (let i = 1; i <= 3; i++) {
    const before = [asked('status').length, asked('sessions').length, asked('overview').length]
    await poll('other')
    for (const [j, name] of ['status', 'sessions', 'overview'].entries()) expect(asked(name).length, `${name} poll ${i}`).toBeGreaterThan(before[j])
    expect(p.region(W.CARD.stats)!.querySelector('[aria-expanded]'), `poll ${i}`).toBe(statsT)
    expect(p.open(statsT), `poll ${i}`).toBe(true)
    expect(p.shut(sessT()), `poll ${i}`).toBe(true)
  }
})

test('O2: a selection in a recent row\'s title survives a changed sessions answer and holds 「Data read at」; once cleared, the next poll shows the new answer', async () => {
  answer.sessions = (n) => ok({ sessions: [sess(`s${n}`, 1), sess('a', 60)] })
  const p = mount(); await settle()
  const text = p.link(replay('a'))!.querySelector('.ovtx')!.firstChild!
  const sel = document.getSelection()!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
  sel.removeAllRanges(); sel.addRange(range)
  const picked = String(sel), at = p.readAt()
  expect(sel.isCollapsed).toBe(false)
  const n = asked('sessions').length
  await poll('sessions')
  expect(asked('sessions').length).toBeGreaterThan(n) // a changed answer came
  expect(p.link(replay(`s${n}`))).toBeNull()
  expect(text.isConnected).toBe(true)
  expect(String(document.getSelection())).toBe(picked)
  expect(p.readAt()).toBe(at)
  document.getSelection()!.removeAllRanges()
  await poll('sessions')
  expect(p.link(replay(`s${asked('sessions').length - 1}`))).not.toBeNull()
  expect(p.readAt()).not.toBe(at)
})

test('O3: the focused recent-row link keeps focus and its href when a newer session arrives at the top', async () => {
  answer.sessions = (n) => ok({ sessions: n ? [sess('b', 1), sess('a', 60)] : [sess('a', 60)] })
  const p = mount(); await settle()
  const el = p.link(replay('a'))!
  act(() => el.focus())
  expect(document.activeElement).toBe(el)
  await poll('sessions')
  expect(p.link(replay('b'))).not.toBeNull()
  expect(document.activeElement).toBe(el)
  expect(el.getAttribute('href')).toBe(replay('a'))
})

test('O4: Enter and Space toggle technical details; the ⓘ opens a dialog on Enter that a poll leaves open and Esc closes; no alert, no live region, only disclosure, ⓘ, Copy and Retry buttons (and the switches on first use)', async () => {
  answer.pricing = (n) => fail(n)
  answer.sessions = (n) => fail(n)
  const p = mount(); await settle()
  const t = p.region(W.CARD.stats)!.querySelector<HTMLElement>('[aria-expanded]')!
  for (const key of ['Enter', ' ']) {
    const was = t.getAttribute('aria-expanded')
    fireEvent.keyDown(t, { key }); fireEvent.keyUp(t, { key }); await settle()
    expect(t.getAttribute('aria-expanded'), key).toBe(was === 'true' ? 'false' : 'true')
  }
  const info = p.region(W.CARD.items)!.querySelector<HTMLElement>('.popbtn')!
  act(() => info.focus())
  fireEvent.keyDown(info, { key: 'Enter' }); fireEvent.keyUp(info, { key: 'Enter' }); await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await poll('status')
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' }); fireEvent.keyUp(document.activeElement ?? dialog, { key: 'Escape' }); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(info) // Esc gives the focus back, and that focus is not an open
  // 1.2 §弹出层: focus opens at once, hover after TIP_MS, a click outside closes; the layer is not modal: nothing outside is inert or
  // hidden, and the focus moves out freely
  act(() => t.focus()); act(() => info.focus()); await settle()
  expect(document.querySelector('[role="dialog"]'), 'focus').not.toBeNull()
  const free = (el: Element | null): boolean => !el || (!el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && free(el.parentElement))
  expect(free(t), 'outside stays live').toBe(true)
  act(() => t.focus())
  expect(document.activeElement, 'outside takes focus').toBe(t)
  fireEvent.click(document.body); await settle()
  expect(document.querySelector('[role="dialog"]'), 'click outside').toBeNull()
  fireEvent.mouseEnter(info); await tick(TIP_MS - 50)
  expect(document.querySelector('[role="dialog"]'), 'hover, early').toBeNull()
  await tick(50); await settle()
  expect(document.querySelector('[role="dialog"]'), 'hover').not.toBeNull()
  fireEvent.mouseLeave(info, { relatedTarget: document.body }); await settle()
  expect(document.querySelector('[role="dialog"]'), 'pointer left').toBeNull()

  const allowed = (b: Element, first: boolean) => (b.hasAttribute('aria-expanded') && b.hasAttribute('aria-controls')) || b.classList.contains('popbtn')
    || b.classList.contains('copybtn') || b.hasAttribute('data-g') || (first && b.hasAttribute('data-hctl'))
    || (b.closest('.react-aria-Popover') != null && (b as HTMLElement).tabIndex < 0) // an open ⓘ layer (it sits by its button)'s screen-reader Dismiss
  const check = async (c: HTMLElement, first: boolean) => {
    for (const x of c.querySelectorAll('[aria-expanded="false"][aria-controls]')) fireEvent.click(x) // the open panels' buttons too
    await settle()
    expect(c.querySelectorAll('[role="alert"], [aria-live]').length).toBe(0)
    const buttons = [...c.querySelectorAll('button, [role="button"]')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(allowed(b, first), b.outerHTML.slice(0, 80)).toBe(true)
  }
  await check(p.c, false)
  cleanup(); document.body.replaceChildren()
  answer.sessions = () => ok({ sessions: [] })
  answer.status = (n) => ok(statusDoc(n, { state: 'needed', missing: [] }))
  const f = mount(); await settle()
  expect(f.region(W.CARD.agents)).not.toBeNull()
  await check(f.c, true)
})

test('O5: every card is drawn before any answer; a window change moves the tab at once, aborts the old window\'s read, never shows its late answer, leaves the items alone; two slow reads at most', async () => {
  const D = 100
  const held: Array<{ since: unknown, res: (a: Ans) => void }> = []
  for (const name of Object.keys(BASE)) answer[name] = (n, params) => hold(D, BASE[name](n, params) as Ans)
  answer.overview = (_n, params) => new Promise<Ans>((res) => held.push({ since: params.since, res }))
  const p = mount('#/overview?window=24h')
  for (const id of ['ovcap', 'ovitems', 'ovstats', 'ovrecent']) expect(p.c.querySelector(`#${id}`)!.childElementCount, id).toBeGreaterThan(0)
  for (const name of [W.CARD.stats, W.CARD.recent]) expect(p.region(name)!.getAttribute('aria-busy'), name).toBe('true')
  for (let i = 0; i < 4; i++) await tick(D)
  await settle()
  const items = p.region(W.CARD.items)!, html = items.outerHTML
  const tab = (w: string) => p.c.querySelector(`a[href="#/overview?window=${w}"]`)!.getAttribute('aria-current')
  const reads = () => asked('overview')
  expect(reads().map((c) => c.params.since)).toEqual(['24h'])
  const LATE = 777
  for (const w of ['7d', 'all']) {
    const before = reads().length
    act(() => p.go(`#/overview?window=${w}`))
    expect(tab(w), w).toBe('true') // before any answer
    for (const o of W.WINDOWS.filter((x: string) => x !== w)) expect(tab(o), `${w}: ${o}`).toBeNull()
    await settle()
    expect(reads()[before - 1].signal!.aborted, w).toBe(true)
    expect(reads().length, w).toBe(before + 1)
    expect(p.region(W.CARD.stats)!.getAttribute('aria-busy'), w).toBe('true')
    expect(p.region(W.CARD.items), w).toBe(items)
    expect(items.outerHTML, w).toBe(html)
  }
  expect(reads().map((c) => c.params.since ?? null)).toEqual(['24h', '7d', null])
  for (const h of held.slice(0, 2)) h.res(ok(ovDoc(LATE))) // the late 24h and 7d answers
  await settle()
  const stats = () => p.region(W.CARD.stats)!
  expect(stats().getAttribute('aria-busy')).toBe('true')
  expect([...stats().querySelectorAll('a')].some((a) => a.textContent!.includes(W.SESSIONS_N(LATE)))).toBe(false)
  held[2].res(ok(ovDoc(5)))
  await settle()
  expect(stats().hasAttribute('aria-busy')).toBe(false)
  expect(stats().querySelector('a[href="#/sessions?window=all"]')).not.toBeNull()
  expect([...stats().querySelectorAll('a')].some((a) => a.textContent!.includes(W.SESSIONS_N(LATE)))).toBe(false)
  expect(maxInFlight).toBeLessThanOrEqual(2)
  expect(new Set(calls.map((c) => c.name).filter((n) => SLOW.includes(n)))).toEqual(new Set(SLOW))
})

test('#11: a recent row whose title is not read yet says so in the weakened style, not as an untitled session', async () => {
  answer.sessions = () => ok({ sessions: [{ ...sess('a', 60), title: null, title_source: 'pending' }] })
  const p = mount(); await settle()
  const t = p.link(replay('a'))!.querySelector('.ovtx')!
  expect(t.textContent).toBe(TITLE_PENDING)
  expect(t.classList.contains('pend')).toBe(true)
})

test('O6: with no session the page is capture + one control per agent + start, writes nothing, and turns into the normal page in place at the first session', async () => {
  answer.sessions = (n) => ok({ sessions: n ? [sess('a', 1)] : [] })
  answer.status = (n) => ok(statusDoc(n, { state: 'needed', missing: [] }))
  const p = mount(); await settle()
  for (const name of [W.CARD.capture, W.CARD.agents, W.CARD.start]) expect(p.region(name), name).not.toBeNull()
  for (const name of [W.CARD.items, W.CARD.stats, W.CARD.recent]) expect(p.region(name), name).toBeNull()
  const rows = [...p.region(W.CARD.agents)!.querySelectorAll(':scope > [data-h]')]
  expect(new Set(rows.map((r) => r.getAttribute('data-h')))).toEqual(new Set(IDS.map(harnessKey)))
  for (const r of rows) expect(r.querySelectorAll('[role="switch"], button[data-hctl="setup"]').length, r.getAttribute('data-h')!).toBe(1)
  const grid = p.c.querySelector('#ovgrid')
  await poll('status')
  expect(vi.mocked(api.control)).not.toHaveBeenCalled()
  await poll('sessions')
  for (const name of [W.CARD.start, W.CARD.agents]) expect(p.region(name), name).toBeNull()
  for (const name of [W.CARD.items, W.CARD.stats, W.CARD.recent]) expect(p.region(name), name).not.toBeNull()
  expect(p.c.querySelector('#ovgrid')).toBe(grid)
  expect(vi.mocked(api.control)).not.toHaveBeenCalled()
})

test('O7: while every read fails, each name\'s reads are at least the back-off apart; a hidden tab reads nothing', async () => {
  for (const name of Object.keys(BASE)) answer[name] = (n) => fail(n)
  const base: Record<string, number> = { status: INTERVAL.status, sessions: INTERVAL.sessions, ...Object.fromEntries(SLOW.map((n) => [n, INTERVAL.other])) }
  mount(); await settle()
  for (let t = 0; t < 120e3; t += 1000) await tick(1000)
  for (const [name, b] of Object.entries(base)) {
    const at = asked(name).map((c) => c.at)
    expect(at.length, name).toBeGreaterThan(2)
    for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1], `${name} read ${k}`).toBeGreaterThanOrEqual(backoffMs(k, b))
  }
  setVisible(false)
  const n = calls.length
  for (let t = 0; t < 60e3; t += 1000) await tick(1000)
  expect(calls.length).toBe(n)
})

test('O7b: opened in a hidden tab, the slow reads wait until the tab is visible, then each is asked', async () => {
  setVisible(false)
  mount(); await settle()
  for (let t = 0; t < 20e3; t += 1000) await tick(1000)
  for (const name of SLOW) expect(asked(name), name).toHaveLength(0)
  setVisible(true); await settle()
  for (let t = 0; t < 5e3; t += 500) await tick(500)
  for (const name of SLOW) expect(asked(name).length, name).toBeGreaterThan(0)
})

test('O8: a sessions answer that carries `stored` is never shown; the fresh one after it is, on the same rows', async () => {
  answer.sessions = (n) => n === 0 ? ok({ sessions: [sess('a', 60)] })
    : n <= 5 ? ok({ sessions: [sess('s', 1)], stored: { at: T } }) : ok({ sessions: [sess('b', 1), sess('a', 60)] })
  const p = mount(); await settle()
  const a = p.link(replay('a'))!
  let seen = false
  new MutationObserver(() => { seen ||= p.link(replay('s')) != null }).observe(p.c, { subtree: true, childList: true, attributes: true })
  await tick(INTERVAL.sessions)
  for (let i = 0; i < 30 && !p.link(replay('b')); i++) await tick(500)
  await settle()
  expect(asked('sessions').length).toBeGreaterThan(6)
  expect(seen).toBe(false)
  expect(p.link(replay('b'))).not.toBeNull()
  expect(p.link(replay('a'))).toBe(a)
})

test('O8: status failing with one unchanging reason, the other reads standing still: the capture card says 「? not refreshed」 once two polls are missed, not before', async () => {
  const still = () => new Promise<Ans>(() => {}) // no other answer moves the bundle, so only the repeated failure can
  for (const n of ['sessions', ...SLOW]) answer[n] = still
  let failFrom = Infinity
  answer.status = (n) => (n >= failFrom ? { ok: false, status: 500, data: null, error: 'boom' } : ok(statusDoc(0)))
  const STALE = HEALTH_READ.stale('').toLowerCase() // the label up to its time (the page capitalises a sentence's first letter)
  const p = mount(); await settle()
  const said = () => (p.region(W.CARD.capture)?.textContent ?? '').toLowerCase()
  expect(said()).not.toBe('')
  expect(said().includes(STALE)).toBe(false)
  failFrom = asked('status').length
  const okAt = Date.now()
  await poll('status')
  expect(asked('status').length).toBe(failFrom + 1) // one failed read, inside two periods: still the last answer, no stale mark
  expect(said().includes(STALE)).toBe(false)
  while (Date.now() - okAt <= 2 * INTERVAL.status) await tick(INTERVAL.status / 5)
  const out = asked('status').length
  for (let i = 0; i < 20 && asked('status').length === out; i++) await tick(INTERVAL.status / 5) // the next failed read, same reason, after the cut
  await settle()
  expect(asked('status').length).toBeGreaterThan(out)
  expect(said().includes(STALE)).toBe(true)
})
