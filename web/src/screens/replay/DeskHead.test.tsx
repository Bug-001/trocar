// web/src/screens/replay/DeskHead.test.tsx — the desk's session head (1.2 §会话头 · §会话保真行) rendered from a plain desk state:
// the chip is one DOM shape for every registry harness (1.2 #2 / harness seam), the head is only the table's parts (1.2 #3), the
// fidelity row exists iff a fact does (1.2 #14), 「several agents」 iff the multi-harness field has more than one (1.2 #15), the start
// time iff the head has a first chapter (1.2 #17), the read-state line exists iff the desk is pending or behind and carries no control
// (no-load-control), a stopped fold keeps its code in the technical details (1.5 K-31), a stale desk offers Retry outside the head row
// with every reason in collapsed details and marks follow paused (1.5 K-29), and the ⓘ's rows are drawn only when it opens (2.3 归约前沿).
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { HARNESS_REGISTRY } from '../../../../src/off/harness-names.mjs'
import { FOLD_STOPS } from '../../../../src/health/codes.mjs'
import { reasonsWith } from '../../../../test/web-v2/visible.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { DeskHead } from './DeskHead'
import { titleText } from '../library/model.mjs'
import { reactView } from './view'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const TS0 = '2026-10-01T10:40:00.000Z'
function head({ meta = {}, desk = {}, ...rest }: { meta?: object, desk?: object, [k: string]: unknown } = {}) {
  const s = { project: 'p', id: 'i', view: { lo: 0, hi: 0 }, lanes: [], follow: false,
    meta: { session_id: 'sid-1', title: 'A title', harness: 'claude-code', project_slug: 'proj', project_path: '/w/proj', ...meta },
    desk: { head: { steps: 3, chapters: [{ ts0: TS0 }] }, ...desk }, ...rest }
  const desk$ = reactView(s, () => {}, () => {})
  const r = render(<DeskHead desk={desk$} />)
  return { s, el: r.container.querySelector<HTMLElement>('#deskhead')! }
}
// an element's shape: tag and classes, its children's shapes; no text, no attribute values
const shape = (e: Element): string => `${e.tagName}.${[...e.classList].sort().join('.')}(${[...e.children].map(shape).join(',')})`

test('1.2 #2 / harness seam (d): the chip\'s DOM is the same for every registry harness; only its icon and name differ', () => {
  const shapes = new Set<string>()
  for (const r of HARNESS_REGISTRY) {
    const { el } = head({ meta: { harness: (r as { id: string }).id } })
    shapes.add(shape(el.querySelector('.sh-chip')!))
    cleanup()
  }
  expect(HARNESS_REGISTRY.length).toBeGreaterThan(1)
  expect([...shapes]).toHaveLength(1)
})

// the session head's parts (1.2 §会话头's table); a head with another session of the same title draws nothing more
const PARTS = new Set(['sh-back', 'sh-name', 'sh-chip', 'sh-multi', 'sh-proj', 'sh-start', 'sh-entry', 'spacer', 'sh-follow', 'sh-info'])
test('1.2 §读取状态: a re-read says updating with read / total and the calls it holds back; catching up counts pending.calls', () => {
  for (const calls of [0, 1, 12]) {
    const { el } = head({ desk: { pending: { done: 90, total: 100, seen: true, calls, read: 38 } } })
    const line = el.querySelector<HTMLElement>('.readstate')!
    expect(line.dataset.readState).toBe('updating')
    expect(line.textContent).toBe(W.updatingTo(38, calls))
    cleanup()
  }
  const { el } = head({ desk: { pending: { done: 5, total: 9, seen: true, calls: 2 } } })
  expect(el.querySelector<HTMLElement>('.readstate')!.dataset.readState).toBe('catching-up')
  expect(el.querySelector('.readstate')!.textContent).toBe(W.catchingUp(2))
})

test('1.2 §读取状态: a later read with no new call has no read-state line', () => {
  const { el } = head({ desk: { pending: { done: 9, total: 9, calls: 0 } } })
  expect(el.querySelector('.readstate')).toBeNull()
})

test('1.2 #17: title_source unread reads the fixed word, not the untitled one', () => {
  const { el } = head({ meta: { title: null, title_source: 'unread' } })
  const name = el.querySelector<HTMLElement>('.sh-name')!
  expect(name.textContent).toBe(W.PROMPT_UNREAD)
  expect(name.title).toContain(W.PROMPT_UNREAD_TIP)
})

test('1.2 #17: the head cuts a long title (one line, ellipsis): its hover carries the title as the server sent it, with the source and the id', () => {
  const title = 'Refactor the session reader so '.repeat(9).trim() // ≤ 300 code points, the server's cap (4.4)
  const name = head({ meta: { title, title_source: 'wire' } }).el.querySelector<HTMLElement>('.sh-name')!
  expect(name.title).toContain(title)
  expect(name.title).toContain(W.TITLE_FROM_WIRE)
  expect(name.title).toContain('sid-1')
})

test('1.2 #3: with another session of the same title, the head is only the table\'s parts and names the title once', () => {
  const title = 'Same name'
  const other = { session_id: 'sid-2', title, harness: 'claude-code' }
  const { el } = head({ meta: { title }, sessions: [other], ctx: { store: { get: () => ({ libraryHash: '', sessions: [other] }) } } })
  const parts = [...el.querySelector('.sesshead')!.children].map((c) => c.className.split(' ')[0])
  for (const p of parts) expect(PARTS.has(p), p).toBe(true)
  expect(el.querySelector('.sesshead')!.textContent!.split(title).length - 1).toBe(1)
})

test('1.2 #14: the fidelity row exists iff one of the five facts does; an unknown count of 0 and a note-level error are no facts', () => {
  const facts = {
    truncated: { truncated: { shown: 5, total: 9, file_mb: 3 } },
    unknown: { unknown: { records: 2, reason: 'r', endpoints: ['/x'] } },
    logged: { logged: 4 },
    files: { errors: [{ where: 'seg', reason: 'gone' }] },
  } as Record<string, object>
  const noFacts = [{}, { unknown: { records: 0 } }, { errors: [{ where: 'idx', reason: 'cold', level: 'note' }] }, { logged: 0 }]
  const cases: Array<[object, boolean, boolean]> = []
  for (const d of noFacts) { cases.push([d, false, false]); cases.push([d, true, true]) }
  const keys = Object.keys(facts)
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    const d = Object.assign({}, ...keys.filter((_, i) => mask & (1 << i)).map((k) => facts[k]))
    cases.push([d, false, true]); cases.push([d, true, true])
  }
  for (const [d, gap, expected] of cases) {
    const { el } = head({ desk: d, gap: gap ? [{ code: 'x' }] : null })
    expect(!!el.querySelector('.fidline:not(.readstate):not(.fidstale)'), JSON.stringify({ d, gap })).toBe(expected)
    cleanup()
  }
})

test('1.2 §会话保真行: capture files not re-indexed yet are their own fact, never counted as files not read in full', () => {
  const pending = { where: 'index', code: 'index-pending', level: 'state', reason: 'r' }, lost = { where: 'segments/s', code: 'segment-unreadable', reason: 'gone' }
  for (const [errors, files] of [[[pending], null], [[pending, lost], '1 capture file was']] as Array<[object[], string | null]>) {
    const { el } = head({ desk: { errors } })
    expect(el.querySelector('[data-fact="reindexing"]'), JSON.stringify(errors)).not.toBeNull()
    const f = el.querySelector('[data-fact="files"]')
    if (files) expect(f!.textContent!.startsWith(files)).toBe(true); else expect(f).toBeNull()
    cleanup()
  }
})

test('1.2 #15: 「several agents」 is drawn iff meta.harnesses has more than one entry; provider "mixed" alone never draws it', () => {
  const cases: Array<[object, boolean]> = [
    [{}, false], [{ provider: 'mixed' }, false], [{ harnesses: [] }, false], [{ harnesses: [{ harness: 'codex' }] }, false],
    [{ harnesses: [{ harness: 'codex' }], provider: 'mixed' }, false],
    [{ harnesses: [{ harness: 'codex' }, { harness: 'claude-code' }] }, true],
    [{ harnesses: [{ harness: 'codex' }, { harness: 'opencode', inferred: true }, { harness: 'claude-code' }] }, true],
  ]
  for (const [meta, expected] of cases) {
    const { el } = head({ meta })
    expect(!!el.querySelector('.sh-multi'), JSON.stringify(meta)).toBe(expected)
    cleanup()
  }
})

test('1.2 #17: the start time is drawn iff the head has a first chapter with ts0, and the title never carries it', () => {
  for (const [h, expected] of [[{ steps: 3, chapters: [{ ts0: TS0 }] }, true], [{ steps: 0, chapters: [] }, false], [{ steps: 3 }, false], [null, false]] as const) {
    for (const title of ['A title', null]) {
      const { el } = head({ meta: { title }, desk: { head: h } })
      const start = el.querySelector('.sh-start')
      expect(!!start, JSON.stringify({ h, title })).toBe(expected)
      if (start) expect(el.querySelector('.sh-name')!.textContent).not.toContain(start.textContent)
      cleanup()
    }
  }
})

test('no-load-control: the read-state line, in every state, is words only: no control inside it', () => {
  const states = [
    { pending: { done: 3, total: 10 }, firstPending: true },
    { pending: { done: 3, total: 10 } },
    { pending: { done: 0, total: 0, stopped: { code: 'fold-failed', reason: 'boom' } } },
    { behind: { n: 4, more: false } },
    { behind: { n: 9, more: true } },
  ]
  for (const d of states) {
    const { el } = head({ desk: d })
    const line = el.querySelector('.readstate')
    expect(line, JSON.stringify(d)).not.toBeNull()
    expect(line!.textContent!.trim().length).toBeGreaterThan(0)
    expect(line!.querySelector('button, a, input, select, textarea, [role="button"], [tabindex]')).toBeNull()
    cleanup()
  }
})

test('1.2 不留空白屏: before the session answer the head holds the way back alone, so the frame has words from its first paint', () => {
  const desk$ = reactView({ project: 'p', id: 'i', view: { lo: 0, hi: 0 }, lanes: [], follow: false }, () => {}, () => {})
  const el = render(<DeskHead desk={desk$} />).container.querySelector('#deskhead')!
  expect([...el.querySelectorAll('.sesshead > *')].map((c) => c.className)).toEqual(['sh-back'])
  expect(el.querySelector('.sh-back')!.getAttribute('href')).toBe('#/sessions')
})

test('1.2 §会话头 读取状态: the read-state line exists iff the desk is pending or behind; its state is the answer\'s', () => {
  const cases: Array<[object, string | null]> = [
    [{}, null], [{ pending: null }, null],
    [{ pending: { done: 3, total: 10 }, firstPending: true }, 'reading'], [{ pending: { done: 3, total: 10 } }, 'catching-up'],
    [{ behind: { n: 2, more: false } }, 'behind'], [{ pending: { done: 1, total: 2 }, behind: { n: 2 } }, 'catching-up'],
  ]
  for (const [d, state] of cases) {
    const { el } = head({ desk: d })
    expect(el.querySelector('.readstate')?.getAttribute('data-read-state') ?? null, JSON.stringify(d)).toBe(state)
    cleanup()
  }
})

test('1.5 K-31: a stopped fold\'s line is the stopped one; its code is in the technical details, not the visible line', () => {
  for (const code of FOLD_STOPS) for (const firstPending of [true, false]) {
    const { el } = head({ desk: { pending: { done: 2, total: 9, stopped: { code, reason: 'why-q' } }, firstPending } })
    const line = el.querySelector('.readstate')!
    expect(line.getAttribute('data-read-state')).toBe('stopped')
    expect(line.textContent).not.toContain(code)
    expect(el.querySelector('.disc .tech')!.textContent).toContain(code)
    cleanup()
  }
})

const STALE = (r: object) => ({ r, since: new Date(Date.now() - 5000).toISOString() })
test('1.5 K-29: a stale desk draws a Retry outside the head row that reads again; no stale state, no line', () => {
  const poll = vi.fn()
  const { el } = head({ staleErr: STALE({ ok: false, status: 500, error: 'x' }), poll })
  const retry = el.querySelector<HTMLElement>('.fidstale button')!
  expect(retry).not.toBeNull()
  expect(el.querySelector('.sesshead')!.contains(retry)).toBe(false)
  fireEvent.click(retry)
  expect(poll).toHaveBeenCalledTimes(1)
  cleanup()
  expect(head({ staleErr: null }).el.querySelector('.fidstale')).toBeNull()
})

test('1.5 K-29: the stale line keeps every reason out of its visible text, escaped in collapsed details', () => {
  let n = 0
  for (const status of [0, 404, 500, undefined]) for (const reason of reasonsWith('TOKEN')) {
    const t = `tok-${++n}-s9`, error = reason.replace('TOKEN', t)
    const { el } = head({ staleErr: STALE(status === undefined ? { ok: false, error } : { ok: false, status, error }) })
    const line = el.querySelector('.fidstale')!, where = `${status} · ${n}`
    expect(line.textContent!.trim().length, where).toBeGreaterThan(0)
    expect(line.textContent, where).not.toContain(t)
    const body = el.querySelector('.disc-b')!
    expect(body.hasAttribute('hidden'), where).toBe(true)
    if (error.includes(t)) expect(body.textContent, where).toContain(t) // kept as text: markup in the reason is not parsed
    expect(el.querySelector('.disc-b b'), where).toBeNull()
    cleanup()
  }
})

test('1.5 K-29: a stale desk marks the follow chip paused; its pressed state stays the reader\'s', () => {
  for (const follow of [true, false]) for (const stale of [true, false]) {
    const { el } = head({ follow, staleErr: stale ? STALE({ ok: false, status: 500, error: 'x' }) : null })
    const chip = el.querySelector('.sh-follow')!
    expect(chip.getAttribute('data-state')).toBe(stale ? 'paused' : null)
    expect(chip.getAttribute('aria-pressed')).toBe(String(follow))
    cleanup()
  }
})

test('2.3 归约前沿: the session-info rows are not in the DOM until the ⓘ opens; opening draws them', async () => {
  const { el } = head({ desk: { truncated: { shown: 2, total: 9, file_mb: 1 } } })
  expect(document.querySelector('.sipb')).toBeNull()
  await act(async () => { fireEvent.click(el.querySelector<HTMLElement>(`.sh-info [aria-label="${W.SESSION_INFO_LABEL}"]`)!) })
  expect(document.querySelectorAll('.sipb [data-row]').length).toBeGreaterThan(0)
})

test('1.2 #7: a declared parent is a link to #/session/<id>; the layer draws no link for a no-keys answer', async () => {
  for (const [meta, link] of [[{ lineage_source: 'wire', parent_session_id: 'P 1', fork_of_session_id: null }, '#/session/P%201'], [{ lineage_source: 'no-keys' }, null]] as const) {
    const { el } = head({ meta })
    await act(async () => { fireEvent.click(el.querySelector<HTMLElement>(`.sh-info [aria-label="${W.SESSION_INFO_LABEL}"]`)!) })
    const links = [...document.querySelectorAll('.sipb [data-row] a[href^="#/session/"]')].map((a) => a.getAttribute('href'))
    expect(links).toEqual(link ? [link] : [])
    cleanup()
  }
})


// 1.2 §会话头 标题 · 1.8 §标题规则: one title rule on two screens, so the replay head and the session list never say two things about one
// session at one moment, whatever its title_source (a stored head from before an update may carry another value, or none)
test('1.2 标题: the replay head\'s title is the session list row\'s for the same meta, for every title_source', () => {
  const cases: object[] = [{ title: 'A title', title_source: 'wire' }, { title: null, title_source: null }, { title: null, title_source: 'unread' },
    { title: null }, { title: null, title_source: 'pending' }]
  for (const m of cases) {
    const { s, el } = head({ meta: m })
    expect(el.querySelector('.sh-name')!.textContent).toBe(titleText(s.meta))
    cleanup()
  }
})
