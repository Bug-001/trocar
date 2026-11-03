// web/src/screens/library/LibraryScreen.test.tsx — the session library's re-read and control contracts (1.8 §一行 · §工具行 · §键盘 ·
// §数据与刷新, 1.2 §点击与选中文字, D75④): a poll never disturbs the reader (same row node, highlight, scroll, focus, a selection, an
// open menu, a search draft), the keys and every control write their exact route patch, and a stored answer is read again sooner.
// Documents are spec 1.6 C.5 `sessions` documents; polls are fake timers of 4.4's intervals.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../../../legacy/core/api.mjs'
import { INTERVAL } from '../../../legacy/core/poll.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { initKeys } from '../../../legacy/core/keys.mjs'
import { installUi } from '../../../legacy/core/ui.mjs'
import type { Route } from '../../LegacyScreen'
import type { ScreenProps } from '../../ScreenOutlet'
import LibraryScreen from './LibraryScreen'
import * as W from '../../../legacy/labels/library.mjs'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60e3).toISOString()
type S = Record<string, unknown>
// one C.5 `sessions` item
const sess = (id: string, calls: number, minAgo: number, o: S = {}): S => ({
  session_id: id, harness: 'codex', harness_inferred: false, provider: 'openai', project_slug: 'p1', project_path: '/w/p1',
  title: `title ${id}`, title_source: 'wire', entrypoint: null, calls, logged: 0, probes: 0, other: 0, has_subagent: false,
  session_synthesized: false, last_ts: iso(minAgo), ...o,
})
const key = (s: S) => `${s.project_slug}::${s.session_id}`
// answer n's list (the last one repeats) and its own fields (stored, …)
let lists: Array<(n: number) => S[]> = []
let extra: (n: number) => S = () => ({})
let served = 0
let at: number[] = []

beforeAll(() => {
  initKeys()
  installUi(document)
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  // the virtualizer sizes its window from the scroll element's client box, which jsdom leaves at 0
  for (const [k, v] of [['clientHeight', 600], ['clientWidth', 1024]] as const) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get(this: HTMLElement) { return this.id === 'liblist' ? v : 0 } })
  }
  Element.prototype.scrollTo = function (this: Element, a?: ScrollToOptions | number, b?: number) {
    const top = typeof a === 'object' ? a.top : b
    if (top != null) { this.scrollTop = top; this.dispatchEvent(new Event('scroll')) }
  } as Element['scrollTo']
})
beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  served = 0; at = []; extra = () => ({})
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => {
    if (name === 'sessions') {
      const n = served++; at.push(Date.now())
      const list = lists[Math.min(n, lists.length - 1)](n)
      return { ok: true, status: 200, data: { schema: 2, command: 'sessions', ok: true, errors: [], as_of: iso(0), next: null, sessions: list, ...extra(n) } }
    }
    if (name === 'status') return { ok: false, status: 404, data: null, error: 'HTTP 404' }
    return { ok: false, status: 404, data: null, error: 'HTTP 404' }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const settle = async () => { for (let i = 0; i < 4; i++) await tick(1) }
const poll = async () => { await tick(INTERVAL.sessions); await settle() }
const press = async (el: Element, k: string) => { fireEvent.keyDown(el, { key: k }); fireEvent.keyUp(el, { key: k }); await settle() }

type Patch = Record<string, string | null>
async function mount(hash = '#/sessions') {
  const sets: Patch[] = [], gos: Route[] = []
  function Host() {
    const [route, setRoute] = useState<Route>(() => parseHash(hash) as Route)
    const router = useMemo(() => ({
      setParams: (p: Patch) => {
        sets.push(p)
        setRoute((r: Route) => {
          const params = { ...(r.params as Record<string, string>) }
          for (const [k, v] of Object.entries(p)) { if (v == null || v === '') delete params[k]; else params[k] = v }
          return { ...r, params }
        })
      },
      go: (to: Route) => { gos.push(to) },
    }) as unknown as ScreenProps['router'], [])
    return <LibraryScreen route={route} router={router} />
  }
  const { container } = render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>)
  await settle()
  const list = container.querySelector<HTMLElement>('#liblist')!
  const row = (k: string) => list.querySelector<HTMLElement>(`a.lrow[data-key="${k}"]`)
  const trigger = (label: string) => container.querySelector<HTMLElement>(`.libtools button[aria-label="${label}"]`)!
  const openMenu = async (label: string) => { await press(trigger(label), 'Enter'); return document.querySelector<HTMLElement>('[role=menu]')! }
  return { container, list, row, trigger, openMenu, sets, gos }
}

const base = Array.from({ length: 30 }, (_, i) => i)
// answer n: n new sessions arrived above the first 30, and every call count moved
const growing = (n: number) => [
  ...Array.from({ length: n }, (_, j) => sess(`new${j}`, 1, 0)),
  ...base.map((i) => sess(`s${i}`, 10 + i + n, 1 + i)),
]

test('V1: across polls that add sessions above and change counts, a session keeps its row node, the highlight and the scroll', async () => {
  lists = [growing]
  const selKey = key(sess('s3', 0, 0))
  const p = await mount(`#/sessions?sel=${encodeURIComponent(selKey)}`)
  const node = p.row(selKey)!
  expect(node).not.toBeNull()
  p.list.scrollTop = 40; p.list.dispatchEvent(new Event('scroll')); await settle()
  for (let i = 1; i <= 3; i++) {
    await poll()
    expect(served).toBe(i + 1)
    expect(p.row(selKey), `poll ${i}`).toBe(node)
    expect(p.list.querySelectorAll('a.lrow[aria-current]').length, `poll ${i}`).toBe(1)
    expect(node.getAttribute('aria-current'), `poll ${i}`).toBe('true')
    expect(p.list.scrollTop, `poll ${i}`).toBe(40)
    expect(p.row(key(sess(`new${i - 1}`, 0, 0))), `poll ${i}`).not.toBeNull()
    expect(node.querySelector('.ln')!.textContent, `poll ${i}: the changed count is drawn`).toBe(String(10 + 3 + i))
  }
})

test('V2: a focused row link keeps the focus across polls', async () => {
  lists = [growing]
  const p = await mount(`#/sessions?sel=${encodeURIComponent(key(sess('s2', 0, 0)))}`)
  const k = key(sess('s5', 0, 0))
  p.row(k)!.focus()
  expect(document.activeElement).toBe(p.row(k))
  for (let i = 1; i <= 3; i++) { await poll(); expect(document.activeElement, `poll ${i}`).toBe(p.row(k)) }
})

test('V3: a drag-select inside a row opens nothing, and the selection outlives a poll that changes that row', async () => {
  lists = [() => [sess('a', 5, 1)], () => [sess('a', 6, 1, { title: 'another title' })]]
  const p = await mount()
  const a = p.row(key(sess('a', 0, 0)))!
  const title = a.querySelector('.lt')!.firstChild!
  fireEvent.pointerDown(a)
  const r = document.createRange(); r.setStart(title, 0); r.setEnd(title, 4)
  document.getSelection()!.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
  fireEvent.click(a, { detail: 1 })
  expect(p.gos).toEqual([])
  await poll()
  expect(document.getSelection()!.isCollapsed).toBe(false)
  expect(p.gos).toEqual([])
})

test('V3b: while a selection holds the rows, the head\'s read-at time stays with them; once it is gone, the next poll moves it', async () => {
  lists = [(n) => [sess('a', 5 + n, 1)]]
  const p = await mount()
  const head = () => p.container.querySelector('#libhead .readat')!.textContent
  const first = head()
  expect(first).toBeTruthy()
  const title = p.row(key(sess('a', 0, 0)))!.querySelector('.lt')!.firstChild!
  const r = document.createRange(); r.setStart(title, 0); r.setEnd(title, 4)
  document.getSelection()!.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
  await poll()
  expect(served).toBe(2)
  expect(head(), 'held with the rows').toBe(first)
  expect(p.row(key(sess('a', 0, 0)))!.querySelector('.ln')!.textContent, 'the rows are held too').toBe('5')
  document.getSelection()!.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  await poll()
  expect(head(), 'moves once nothing is held').not.toBe(first)
})

test('V8: each row is one link with no focusable inside, and its href reads back as the replay route of that session (id escaped)', async () => {
  const ids = ['a"<b>', 'x y/z?#&', 'plain']
  lists = [() => ids.map((id, i) => sess(id, 3, i + 1, { project_slug: `p${i}` }))]
  const p = await mount()
  const rows = [...p.list.querySelectorAll<HTMLAnchorElement>('.lrow')]
  expect(rows.map((a) => a.tagName)).toEqual(ids.map(() => 'A'))
  for (const [i, id] of ids.entries()) {
    const a = rows.find((x) => x.dataset.key === `p${i}::${id}`)!
    expect(a, id).toBeTruthy()
    expect(a.querySelectorAll('a, button, input, select, textarea, [tabindex], [contenteditable]').length, id).toBe(0)
    expect(parseHash(a.getAttribute('href')!), id).toMatchObject({ area: 'replay', screen: 'replay', project: `p${i}`, id })
  }
})

test('V4: ↓ ↑ End write sel, Enter opens, / focuses the search, keys typed there do nothing; the agent menu is a menu of checkboxes', async () => {
  lists = [() => [sess('a', 5, 1), sess('b', 4, 2), sess('c', 3, 3, { harness: 'opencode' })]]
  const p = await mount(`#/sessions?sel=${encodeURIComponent(key(sess('a', 0, 0)))}`)
  await press(document.body, 'ArrowDown')
  expect(p.sets.at(-1)).toEqual({ sel: key(sess('b', 0, 0)) })
  await press(document.body, 'ArrowUp')
  expect(p.sets.at(-1)).toEqual({ sel: key(sess('a', 0, 0)) })
  await press(document.body, 'End')
  expect(p.sets.at(-1)).toEqual({ sel: key(sess('c', 0, 0)) })
  await press(document.body, 'Enter')
  expect(p.gos.at(-1)).toMatchObject({ screen: 'replay', project: 'p1', id: 'c' })
  const q = p.container.querySelector<HTMLInputElement>('#libq')!
  await press(document.body, '/')
  expect(document.activeElement).toBe(q)
  const before = p.sets.length
  for (const k of ['ArrowDown', 'End', 'Enter']) await press(q, k)
  expect(p.sets.length).toBe(before)
  expect(p.gos.length).toBe(1)
  // a search draft survives a poll
  fireEvent.change(q, { target: { value: 'tit' } }); await settle()
  await poll()
  expect(document.activeElement).toBe(q)
  expect(q.value).toBe('tit')
  // the agent menu: role menu, checkbox items; Space writes h; the menu stays open across a poll
  const m = await p.openMenu(W.AGENT_MENU)
  expect(m).not.toBeNull()
  const items = [...m.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')]
  expect(items.length).toBeGreaterThan(0)
  await press(items[0], ' ')
  expect(p.sets.at(-1)).toHaveProperty('h')
  expect(typeof p.sets.at(-1)!.h).toBe('string')
  await poll()
  expect(document.querySelector('[role=menu]')).not.toBeNull()
})

test('V5: the route\'s q, h, project, window and sort show in the controls, and each control writes its exact patch', async () => {
  lists = [() => [sess('a', 5, 1), sess('b', 4, 2, { harness: 'opencode', project_slug: 'p2', project_path: '/w/p2' })]]
  const p = await mount('#/sessions?q=tit&h=codex&project=p1&window=7d&sort=calls')
  expect(p.container.querySelector<HTMLInputElement>('#libq')!.value).toBe('tit')
  const radios = [...p.container.querySelectorAll<HTMLElement>('#libhead [role=radiogroup] [role=radio]')]
  expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').length).toBe(1)
  const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true')!
  // the window: another choice writes its id, 「all」 writes null
  const others = radios.filter((r) => r !== checked)
  for (const r of others) { fireEvent.click(r); await settle() }
  const winPatches = p.sets.filter((s) => 'window' in s)
  expect(winPatches.map((s) => Object.keys(s))).toEqual(others.map(() => ['window']))
  expect(winPatches.some((s) => s.window === null)).toBe(true)
  expect(winPatches.some((s) => s.window === '24h')).toBe(true)
  // search
  const q = p.container.querySelector<HTMLInputElement>('#libq')!
  q.focus(); fireEvent.change(q, { target: { value: 'x' } }); await settle()
  expect(p.sets.at(-1)).toEqual({ q: 'x' })
  q.blur(); await settle()
  // agents: codex is on, opencode is not; choosing opencode writes both
  let m = await p.openMenu(W.AGENT_MENU)
  const agentItems = [...m.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')]
  const on = agentItems.filter((x) => x.getAttribute('aria-checked') === 'true')
  expect(on.length).toBe(1)
  const off = agentItems.find((x) => x.getAttribute('aria-checked') === 'false')!
  await press(off, ' ')
  expect(p.sets.at(-1)).toEqual({ h: 'codex,opencode' })
  await press(document.querySelector('[role=menu]')!, 'Escape')
  // project: p1 is the checked radio; p2 writes p2, 「All projects」 writes null
  m = await p.openMenu(W.PROJECT_MENU)
  const projItems = [...m.querySelectorAll<HTMLElement>('[role=menuitemradio]')]
  expect(projItems.filter((x) => x.getAttribute('aria-checked') === 'true').length).toBe(1)
  const p2 = projItems.find((x) => x.querySelector('[title="/w/p2"]'))!
  await press(p2, 'Enter')
  expect(p.sets.at(-1)).toEqual({ project: 'p2' })
  m = await p.openMenu(W.PROJECT_MENU)
  await press(m.querySelectorAll<HTMLElement>('[role=menuitemradio]')[0], 'Enter')
  expect(p.sets.at(-1)).toEqual({ project: null })
  // sort: calls is checked; the other writes null
  m = await p.openMenu(W.SORT_MENU)
  const sortItems = [...m.querySelectorAll<HTMLElement>('[role=menuitemradio]')]
  expect(sortItems.filter((x) => x.getAttribute('aria-checked') === 'true').length).toBe(1)
  await press(sortItems.find((x) => x.getAttribute('aria-checked') === 'false')!, 'Enter')
  expect(p.sets.at(-1)).toEqual({ sort: null })
  // chips drop one filter each; Clear filters drops all four
  const chips = () => [...p.container.querySelectorAll<HTMLButtonElement>('.fchip')]
  expect(chips().length).toBeGreaterThan(0)
  fireEvent.click(chips()[0]); await settle()
  expect(Object.keys(p.sets.at(-1)!)).toHaveLength(1)
  fireEvent.click(p.container.querySelector<HTMLButtonElement>('#libclear')!); await settle()
  expect(p.sets.at(-1)).toEqual({ q: null, h: null, project: null, window: null })
  expect(p.container.querySelector<HTMLButtonElement>('#libclear')!.disabled).toBe(true)
})

test('V7: after an answer carrying `stored` the next read comes INTERVAL.session later; after a fresh one, INTERVAL.sessions later', async () => {
  lists = [() => [sess('a', 5, 1)]]
  extra = (n) => (n === 0 ? { stored: { at: iso(2) } } : {})
  await mount()
  await tick(INTERVAL.sessions * 2 + 10); await settle()
  expect(at.length).toBeGreaterThanOrEqual(3)
  const d1 = at[1] - at[0], d2 = at[2] - at[1]
  expect(d1).toBeGreaterThanOrEqual(INTERVAL.session); expect(d1).toBeLessThan(INTERVAL.session + 10)
  expect(d2).toBeGreaterThanOrEqual(INTERVAL.sessions); expect(d2).toBeLessThan(INTERVAL.sessions + 10)
})
