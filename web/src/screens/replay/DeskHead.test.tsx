// web/src/screens/replay/DeskHead.test.tsx — the new desk's session head (1.2 §会话头 · §会话保真行) rendered from a plain desk state:
// the chip is one DOM shape for every registry harness (1.2 #2 / harness seam), the head is only the table's parts (1.2 #3), the
// fidelity row exists iff a fact does (1.2 #14), 「several agents」 iff the multi-harness field has more than one (1.2 #15), the start
// time iff the head has a first chapter (1.2 #17), and the read-state line carries no control (no-load-control).
import { afterEach, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { HARNESS_REGISTRY } from '../../../../src/off/harness-names.mjs'
import { DeskHead } from './DeskHead'
import { reactView } from './view'
import * as W from '../../../legacy/labels/replay.mjs'

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
  const { el } = head({ desk: { pending: { done: 5, total: 9, calls: 2 } } })
  expect(el.querySelector<HTMLElement>('.readstate')!.dataset.readState).toBe('catching-up')
  expect(el.querySelector('.readstate')!.textContent).toBe(W.catchingUp(2))
})

test('1.2 #17: title_source unread reads the fixed word, not the untitled one', () => {
  const { el } = head({ meta: { title: null, title_source: 'unread' } })
  const name = el.querySelector<HTMLElement>('.sh-name')!
  expect(name.textContent).toBe(W.PROMPT_UNREAD)
  expect(name.title).toContain(W.PROMPT_UNREAD_TIP)
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
