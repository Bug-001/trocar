// web/src/screens/capture/CaptureScreen.test.tsx — the capture page's re-read contracts (1.9 §页面结构 · §开关, 1.2 §点击与选中文字,
// D75④): a status answer that changes on every poll never disturbs the reader. Open state per stable row id, the focused control and a
// text selection survive a poll, the keyboard toggles a row, the switch plans before it writes (invariant 1), ?h= lands once, and the
// page carries no alert / live region / badge (D38⑦), and two missed reads say 「? not refreshed」 at each answer. The capture log
// (CaptureLogScreen) is held to the same keyboard, no-alert and stale contracts. Documents are spec 1.6's C.3 sample; polls are fake
// timers of INTERVAL.status.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { INTERVAL } from '../../../legacy/core/poll.mjs'
import { parseHash } from '../../../legacy/core/router.mjs'
import { store } from '../../../legacy/core/store.mjs'
import { ConfirmProvider } from '../../ui/Confirm'
import { HEALTH_READ } from '../../../legacy/labels/common.mjs'
import CaptureScreen from './CaptureScreen'
import CaptureLogScreen from './CaptureLogScreen'

const nodeFs = 'node:fs' // the web tsconfig carries no node types; the test reads the spec through a plain dynamic import
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string }
const SPEC = readFileSync('spec/01-trocar-rfc/1.6-cli.md', 'utf8') // the run's root is the repository (web/vitest.config.mjs)
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)![1])
const T = '2026-10-20T09:00:00Z'

type H = Record<string, unknown>
const FINE: H = { captured: true }
const PROBLEM: H = { captured: false, reason: 'config-after-start' }
const SETUP: H = { captured: true, setup: { state: 'needed', missing: [] } }
// a C.3 document (as test/web-v2/capture-model.test.mjs builds it): the daemon up, health ok, one harness per entry of `hs`; `n` is the
// answer's number, carried by the failure-group count and each agent's process pid, so every answer differs from the one before
function doc(hs: Record<string, H>, n: number) {
  const d = sample()
  d.daemon = { running: true, responding: true, pid: 4012, since: T, error: null }
  d.health = { state: 'ok', since: T }
  d.harnesses = Object.fromEntries(Object.entries(hs).map(([id, v]) => [id, { desired: 'on', updated_at: T, setup: { state: 'ready', missing: [] }, ...v }]))
  d.topology = Object.fromEntries(Object.keys(hs).map((id) => [id, { at: T, running: [{ pid: pid(n) }] }]))
  d.critical = []; d.changed = []; d.errors = []; d.install = { state: 'installed', pending: [] }
  d.failures = { since: T, groups: Array.from({ length: n }, () => ({ level: 'note', where: 'engine', code: 'x', count: 1, first_ts: T, last_ts: T })) }
  patch(d)
  return d
}
const pid = (n: number) => 7000 + n

type Answer = { ok: boolean, status: number, data: unknown, error: string | null }
let answers: Array<Record<string, H>> = [] // the harnesses of answer n (the last one repeats)
let served = 0
let patch: (d: Record<string, unknown>) => void = () => {} // a test's own fields on every answer
let failFrom = Infinity // answers from this one on are failed reads, all with the same reason
let controlAnswer: (verb: string, body: Record<string, unknown>) => Answer = () => ({ ok: true, status: 200, data: { ok: true }, error: null })

beforeEach(() => {
  vi.useFakeTimers()
  store.set({ capH: null, capHOkAt: null, capHErr: null })
  served = 0; patch = () => {}; failFrom = Infinity
  vi.spyOn(api, 'get').mockImplementation(async (name: string) => {
    if (name === 'status') { const n = served++; if (n >= failFrom) return { ok: false, status: 502, data: null, error: 'HTTP 502' }; return { ok: true, status: 200, data: doc(answers[Math.min(n, answers.length - 1)], n) } }
    if (name === 'overview') return { ok: true, status: 200, data: { harnesses: [] } }
    return { ok: false, status: 404, error: 'HTTP 404' }
  })
  vi.spyOn(api, 'controlStatus').mockImplementation(async () => ({ ok: true, status: 200, data: { control: true, root: false } }))
  vi.spyOn(api, 'control').mockImplementation(async (verb: string, body: Record<string, unknown>) => controlAnswer(verb, body))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
// an answer reaches the render a few short timers after it resolves (the query's notify, then the page's own scheduling)
const settle = async () => { for (let i = 0; i < 3; i++) await tick(1) }
const poll = async () => { await tick(INTERVAL.status); await settle() }

async function mount(hash = '#/capture', Screen = CaptureScreen) {
  const toasts = document.createElement('div'); toasts.id = 'toasts'; document.body.append(toasts)
  let made = 0
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if ((n as Element).classList?.contains('toast')) made++ }).observe(toasts, { childList: true })
  const client = new QueryClient()
  const { container } = render(
    <QueryClientProvider client={client}><ConfirmProvider><Screen route={parseHash(hash)} /></ConfirmProvider></QueryClientProvider>,
  )
  await settle()
  const row = (id: string) => container.querySelector<HTMLElement>(`.crow[data-h="${id}"]`)!
  const trigger = (id: string) => row(id).querySelector<HTMLButtonElement>(`button[data-caprow="cap-${id}"]`)!
  const panelOf = (t: Element) => document.getElementById(t.getAttribute('aria-controls')!)!
  const techT = (id: string) => row(id).querySelector<HTMLButtonElement>('.disc .disc-t')!
  const open = (t: Element) => t.getAttribute('aria-expanded') === 'true' && !panelOf(t).hasAttribute('hidden')
  const shut = (t: Element) => t.getAttribute('aria-expanded') === 'false' && panelOf(t).hasAttribute('hidden')
  const expanded = (t: Element) => t.getAttribute('aria-expanded')
  return { container, row, trigger, techT, panelOf, open, shut, expanded, toasts: () => made }
}

test('C1: a row the reader opened and its technical details stay open across polls, also when a row above it leaves', async () => {
  answers = [{ codex: FINE, opencode: FINE }, { codex: FINE, opencode: FINE }, { opencode: FINE }, { opencode: FINE }]
  const p = await mount()
  expect(p.shut(p.trigger('opencode'))).toBe(true) // not open by default
  fireEvent.click(p.trigger('opencode')); fireEvent.click(p.techT('opencode'))
  for (let i = 1; i <= 3; i++) {
    await poll()
    expect(served).toBe(i + 1)
    expect(p.open(p.trigger('opencode')), `poll ${i}`).toBe(true)
    expect(p.open(p.techT('opencode')), `poll ${i}`).toBe(true)
  }
  expect(p.row('codex')).toBeNull()
})

test('C2: an untouched problem row follows the answer; a problem row the reader closed stays closed', async () => {
  answers = [{ codex: PROBLEM, opencode: PROBLEM }, { codex: FINE, opencode: PROBLEM }, { codex: PROBLEM, opencode: PROBLEM }]
  const p = await mount()
  expect(p.open(p.trigger('codex'))).toBe(true)
  expect(p.open(p.trigger('opencode'))).toBe(true)
  fireEvent.click(p.trigger('opencode'))
  expect(p.shut(p.trigger('opencode'))).toBe(true)
  await poll()
  expect(p.shut(p.trigger('codex'))).toBe(true)
  expect(p.shut(p.trigger('opencode'))).toBe(true)
  await poll()
  expect(p.open(p.trigger('codex'))).toBe(true)
  expect(p.shut(p.trigger('opencode'))).toBe(true)
})

test('C3: a selection in an open row survives a changed answer and a click inside it; once cleared, the next poll shows the new answer', async () => {
  answers = [{ opencode: FINE }]
  const p = await mount()
  fireEvent.click(p.trigger('opencode')); fireEvent.click(p.techT('opencode'))
  const tech = () => p.panelOf(p.techT('opencode'))
  const monoOf = (n: number) => [...tech().querySelectorAll('.mono')].find((e) => e.textContent === String(pid(n))) ?? null
  const span = monoOf(served - 1)!
  const text = span.firstChild!
  const sel = document.getSelection()!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length)
  sel.removeAllRanges(); sel.addRange(range)
  const picked = String(sel)
  expect(sel.isCollapsed).toBe(false)
  fireEvent.pointerDown(span); fireEvent.pointerUp(span); fireEvent.click(span)
  expect(p.open(p.trigger('opencode'))).toBe(true)
  expect(p.open(p.techT('opencode'))).toBe(true)
  const before = served
  await poll()
  expect(served).toBe(before + 1) // a changed answer came
  expect(text.isConnected).toBe(true)
  expect(String(document.getSelection())).toBe(picked)
  document.getSelection()!.removeAllRanges()
  await poll()
  expect(monoOf(served - 1)).not.toBeNull()
})

test('C4: the focused Copy button of an open row\'s technical details and the row\'s switch keep focus across a poll', async () => {
  answers = [{ opencode: FINE }]
  const p = await mount()
  fireEvent.click(p.trigger('opencode')); fireEvent.click(p.techT('opencode'))
  for (const el of [p.panelOf(p.techT('opencode')).querySelector<HTMLElement>('.copybtn')!, p.row('opencode').querySelector<HTMLElement>('.hswitch input')!]) {
    act(() => el.focus())
    expect(document.activeElement).toBe(el)
    await poll()
    expect(document.activeElement).toBe(el)
  }
})

// the capture page's machine-wide changes and the log's groups (one by design, one an agent's problem) on every answer
const LOGGED = (d: Record<string, unknown>) => {
  d.changed = [{ path: '/etc/x.json', what: 'json-key proxy' }]
  d.errors = [{ where: 'other', reason: 'r' }]
  d.failures = { since: T, groups: [{ level: 'problem', where: 'engine', code: 'x', harness: 'codex', count: 2, first_ts: T, last_ts: T },
    { level: 'expected', where: 'engine', code: 'y', count: 1, first_ts: T, last_ts: T }] }
}

test('C5: every trigger on both pages (row name, log row ▸, changes block, technical details) toggles on Enter and Space; clicks elsewhere on a head line or inside the panel do not', async () => {
  answers = [{ opencode: FINE }]
  patch = LOGGED
  const cap = await mount()
  fireEvent.click(cap.trigger('opencode'))
  const capTriggers = [cap.trigger('opencode'), cap.techT('opencode'), cap.container.querySelector<HTMLElement>('.cblock .disc-t')!]
  const keys = async (t: HTMLElement, label: string) => {
    for (const key of ['Enter', ' ']) {
      const was = cap.expanded(t)
      expect(was, label).toMatch(/^(true|false)$/)
      fireEvent.keyDown(t, { key }); fireEvent.keyUp(t, { key }); await settle()
      expect(t.getAttribute('aria-expanded'), `${label} ${key}`).toBe(was === 'true' ? 'false' : 'true')
    }
  }
  for (const [i, t] of capTriggers.entries()) await keys(t, `capture trigger ${i}`)
  // the rest of the head line and the open panel are text, not triggers
  const t = cap.trigger('opencode')
  const was = cap.expanded(t)
  for (const el of [...cap.row('opencode').querySelectorAll<HTMLElement>('.crow-t > :not(button)'), cap.panelOf(t)]) {
    fireEvent.click(el); await settle()
    expect(cap.expanded(t), el.className).toBe(was)
  }
  cleanup(); document.body.replaceChildren()

  const log = await mount('#/capture/log', CaptureLogScreen)
  const lgo = log.container.querySelector<HTMLElement>('.lr .lgo')!
  await keys(lgo, 'log row')
  const lr = lgo.closest('.lr')!
  const logTriggers = [lr.querySelector<HTMLElement>('.disc-t')!, ...log.container.querySelectorAll<HTMLElement>('#clogmain > .disc > .disc-t')]
  expect(logTriggers.length).toBe(2)
  for (const [i, x] of logTriggers.entries()) await keys(x, `log trigger ${i}`)
  const lwas = log.expanded(lgo)
  for (const el of [...lr.querySelectorAll<HTMLElement>(':scope > span'), log.panelOf(lgo)]) {
    fireEvent.click(el); await settle()
    expect(log.expanded(lgo), el.className).toBe(lwas)
  }
})

test('C6: the switch plans first and writes only after a yes to that plan; Set up sends setup; a press during a round sends nothing', async () => {
  answers = [{ codex: FINE, opencode: SETUP }]
  controlAnswer = (_verb, body) => (body.confirm
    ? { ok: true, status: 200, data: { ok: true }, error: null }
    : { ok: false, status: 409, data: { need: 'confirm', plan: [{ path: '~/.codex/.env', how: 'proxy entry' }], plan_id: 'p1' }, error: null })
  const p = await mount()
  const control = vi.mocked(api.control)
  const sw = () => p.row('codex').querySelector<HTMLInputElement>('.hswitch input')!
  const answer = async (which: 'cancel' | 'ok') => { fireEvent.click(document.querySelector(`[data-confirm="${which}"]`)!); await tick(0); await tick(0) }

  fireEvent.click(sw()); await tick(0)
  expect(document.querySelector('[data-confirm="cancel"]')).not.toBeNull()
  fireEvent.click(sw()); await tick(0) // the round is out
  expect(control).toHaveBeenCalledTimes(1)
  await answer('cancel')
  expect(control).toHaveBeenCalledTimes(1)
  expect(control.mock.calls[0][0]).toBe('harness')
  expect('confirm' in control.mock.calls[0][1]).toBe(false)

  fireEvent.click(sw()); await tick(0)
  await answer('ok')
  expect(control).toHaveBeenCalledTimes(3)
  expect('confirm' in control.mock.calls[1][1]).toBe(false)
  expect(control.mock.calls[2][1].confirm).toBe('p1')

  fireEvent.click(p.row('opencode').querySelector('.hsetup')!); await tick(0)
  expect(control).toHaveBeenCalledTimes(4)
  expect(control.mock.calls[3][0]).toBe('setup')
  await answer('cancel')
})

test('C7: ?h= opens that row after the first answer; ?h= with no row says so once and leaves the page head alone', async () => {
  answers = [{ codex: FINE, opencode: FINE }]
  const land = await mount('#/capture?h=opencode')
  expect(land.open(land.trigger('opencode'))).toBe(true)
  expect(land.shut(land.trigger('codex'))).toBe(true)
  cleanup(); document.body.replaceChildren()

  const miss = await mount('#/capture?h=kimi')
  const head = miss.container.querySelector('#caphead h1')!.textContent
  expect(miss.toasts()).toBe(1)
  await poll(); await poll()
  expect(miss.toasts()).toBe(1)
  expect(miss.container.querySelector('#caphead h1')!.textContent).toBe(head)
})

test('C8: neither the capture page nor the capture log carries an alert, a live region or anything that reads as a badge, an unread mark or a dismiss control', async () => {
  answers = [{ codex: PROBLEM, opencode: FINE, kimi: SETUP }]
  patch = LOGGED
  for (const [hash, Screen] of [['#/capture', CaptureScreen], ['#/capture/log', CaptureLogScreen]] as const) {
    const p = await mount(hash, Screen)
    await poll()
    for (const t of p.container.querySelectorAll('[aria-expanded="false"]')) fireEvent.click(t) // the open panels too
    await settle()
    const c = p.container
    expect(c.querySelectorAll('[role="alert"], [aria-live]').length, hash).toBe(0)
    const said = /badge|unread|dismiss/i
    for (const el of c.querySelectorAll('*')) expect(said.test(String(el.getAttribute('class') ?? '')), el.outerHTML.slice(0, 80)).toBe(false)
    expect(said.test(c.textContent ?? ''), hash).toBe(false)
    cleanup(); document.body.replaceChildren()
  }
})

test('C9: failed reads with one unchanging reason say 「? not refreshed」 on both pages once two polls are missed, not before', async () => {
  answers = [{ opencode: FINE }]
  const STALE = HEALTH_READ.stale('').toLowerCase() // the label up to its time (the page capitalises a sentence's first letter)
  for (const [hash, Screen, where] of [['#/capture', CaptureScreen, '.crow[data-h] .stt'], ['#/capture/log', CaptureLogScreen, '.caplog-say']] as const) {
    failFrom = Infinity; served = 0
    store.set({ capH: null, capHOkAt: null, capHErr: null })
    const p = await mount(hash, Screen)
    const said = () => (p.container.querySelector(where)?.textContent ?? '').toLowerCase()
    expect(said().includes(STALE), hash).toBe(false)
    failFrom = served
    const okAt = Date.now()
    await poll()
    expect(served, hash).toBe(failFrom + 1) // one failed read, inside two periods: still the last answer, no stale mark
    expect(said().includes(STALE), hash).toBe(false)
    while (Date.now() - okAt <= 2 * INTERVAL.status) await tick(INTERVAL.status / 5)
    const out = served
    for (let i = 0; i < 20 && served === out; i++) await tick(INTERVAL.status / 5) // the next failed read, same reason, after the cut
    await settle()
    expect(served, hash).toBeGreaterThan(out)
    expect(said().includes(STALE), hash).toBe(true)
    cleanup(); document.body.replaceChildren()
  }
})
