// web/src/screens/replay/Cell.test.tsx — the React cell of the context window (spec 2.3 §两种模式, 1.4 #7): Raw shows the bytes (the
// leaf's text without its .lay spans is the source), Readable is renderKind's markup over the view unchanged, the first slice is a
// prefix with its own clip status, the view mode is cell.mjs's state on either side, a cell with one mode has no switch, a pending or
// failed body has no control, the cell never reads a body itself, what the reader opened comes back, and a grown leaf survives a
// re-render. Bodies are constructed here and from the generated desk world (desk-world.mjs).
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { DISPLAY_CLIP, blockGot, bodyCache, cellBodyHtml, cellOf, modeOf, overrideScope, setDeskMode, setMode, wireCells } from '../../../legacy/replay/cell.mjs'
import { renderKind } from '../../../legacy/replay/kinds.mjs'
import * as C from '../../../legacy/labels/cells.mjs'
import { stepOf } from '../../../legacy/replay/model.mjs'
import { deskFrom, world } from '../../../../test/web-v2/desk-world.mjs'
import { Cell, CellBar } from './Cell'

const KEY = 'trocar.v2.cellMode'
type Seen = { cb: IntersectionObserverCallback, els: Set<Element> }
const observers: Seen[] = [] // the cell's sentinel observer lives as long as the module
beforeAll(() => {
  globalThis.IntersectionObserver = class {
    s: Seen
    constructor(cb: IntersectionObserverCallback) { this.s = { cb, els: new Set() }; observers.push(this.s) }
    observe(el: Element) { this.s.els.add(el) }
    unobserve(el: Element) { this.s.els.delete(el) }
    disconnect() { this.s.els.clear() }
  } as unknown as typeof IntersectionObserver
})
let n = 0
beforeEach(() => { bodyCache.clear(); overrideScope(`case ${n++}`); try { localStorage.setItem(KEY, 'raw') } catch { /* the throwing case */ } })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const noApi = { get: vi.fn() }
const bytesOf = (pre: Element) => { const c = pre.cloneNode(true) as Element; for (const l of c.querySelectorAll('.lay')) l.remove(); return c.textContent }
const valueOf = (t: string) => { try { return JSON.parse(t) } catch { return t } }
// a body the caller holds, with the view the server would send for it
const inline = (text: string, r: object = { as: 'text' }, bid?: string) => cellOf({ inline: text, view: { r: { f: { body: [] }, ...r }, body: valueOf(text) }, ...(bid ? { bid } : {}) })
const TEXT_R = { as: 'text', f: { body: ['text'] } }
const leafOf = (c: HTMLElement) => c.querySelector('.cell > .cellraw, .cell > .cellread') as HTMLElement
// enter every watched sentinel and let the idle callback run
async function enter() {
  await act(async () => {
    for (const o of observers) for (const el of [...o.els]) o.cb([{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
    await new Promise((r) => setTimeout(r, 5))
  })
}

// the first case: the desk mode this page set is still unset (cell.mjs keeps the last one in memory when storage cannot)
test('2.3 #14: storage that throws on every access draws the cell in Readable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  const { container } = render(<Cell cell={inline('{"a":1}', { as: 'json' })} api={noApi} />)
  expect((container.querySelector('.cell') as HTMLElement).dataset.mode).toBe('read')
})

test('2.3 #1 · 1.4 #7 · AC-1: the Raw leaf without its .lay spans is the bytes', async () => {
  // a block of a drawn step of the generated world, as the window holds it (a def with its text_ref)
  const w = world(7), desk = await deskFrom(w.get(), 'S'), def = stepOf(desk, desk.order.at(-1)).flat[0]
  const bodies = [
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi\nthere "q" \\ end' }], n: [1, 2.5e-3, true, null] }, null, 2),
    '{"a":{"b":[1,2,{"c":"x\\ny\\u0000"}]},"e":"\\ud83d\\ude00 😀","t":"tab\\tcr\\r"}',
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\nevent: ping\ndata: {"type":"ping"}\n\n',
    '\nleading newline\r\nCRLF line\rlone CR\n',
    'not json {"half": \n[1,2\n😀 surrogate pair, lone \ud83d high\n  {"ok":true}\n',
    '{"k":"<script>alert(1)</script> &amp; </pre>"}',
  ]
  const cells = bodies.map((b, i) => inline(b, { as: 'text' }, `c${i}`))
  const ref = def.text_ref as string, wb = JSON.stringify({ type: 'tool_result', content: [{ type: 'text', text: 'line 1\nline 2' }] })
  bodyCache.set(ref, { status: 'ok', text: wb })
  cells.push(cellOf(def)); bodies.push(wb)
  cells.forEach((cell, i) => {
    const { container, unmount } = render(<Cell cell={cell} api={noApi} />)
    expect(bytesOf(container.querySelector('pre.cellraw')!)).toBe(bodies[i])
    unmount()
  })
})

test('2.3 #11: a body over DISPLAY_CLIP shows a prefix first, with a clip status of its own that is no source-truncation badge', () => {
  const text = Array.from({ length: 3 * DISPLAY_CLIP / 40 }, (_, i) => JSON.stringify({ i, v: 'x'.repeat(20) })).join('\n')
  const { container } = render(<Cell cell={inline(text)} api={noApi} />)
  const shown = bytesOf(container.querySelector('pre.cellraw')!)!
  expect(shown.length).toBeGreaterThan(0)
  expect(shown.length).toBeLessThan(text.length)
  expect(text.startsWith(shown)).toBe(true)
  const clip = container.querySelector('.cellclip')!
  expect(clip.textContent).not.toBe('')
  expect(clip.closest('.ffbadge')).toBeNull()
  expect(clip.querySelector('.ffbadge')).toBeNull()
  expect(clip.classList.contains('ffbadge')).toBe(false)
})

test('2.3 #14: a flip moves every mounted cell of that bid and no other; setDeskMode clears it; a cell.mjs flip redraws a React cell', () => {
  const a = inline('{"a":1}', { as: 'json' }, 'A'), a2 = inline('{"a":1}', { as: 'json' }, 'A'), b = inline('{"b":2}', { as: 'json' }, 'B')
  const { container } = render(<><Cell cell={a} api={noApi} /><Cell cell={a2} api={noApi} /><Cell cell={b} api={noApi} /></>)
  const modes = () => [...container.querySelectorAll<HTMLElement>('.cell')].map((c) => c.dataset.mode)
  fireEvent.click(container.querySelector('.cell [data-cellmode="read"]')!)
  expect(modes()).toEqual(['read', 'read', 'raw'])
  expect(container.querySelector('.cell [data-cellmode="read"]')!.getAttribute('aria-pressed')).toBe('true')
  act(() => setDeskMode('raw'))
  expect(modes()).toEqual(['raw', 'raw', 'raw'])
  act(() => setMode('B', 'read'))
  expect(modes()).toEqual(['raw', 'raw', 'read'])
})

test('2.3 #14: a flip on a React cell redraws the raw panel\'s and drawer\'s legacy cell of that bid', async () => {
  const a = inline('{"a":1}', { as: 'json' }, 'L'), host = document.createElement('div')
  document.body.appendChild(host)
  host.innerHTML = cellBodyHtml(a, modeOf('L'))
  const off = wireCells(host)
  const { container } = render(<Cell cell={a} api={noApi} />)
  fireEvent.click(container.querySelector('[data-cellmode="read"]')!)
  await enter()
  await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
  expect((host.querySelector('.cell') as HTMLElement).dataset.mode).toBe('read')
  off(); host.remove()
})

test('2.3 #17: the Readable leaf is renderKind\'s markup unchanged', () => {
  const cases: Array<[string, object]> = [
    ['{"a":{"b":[1,2,"<img src=x onerror=alert(1)>"]},"c":null}', { as: 'json' }],
    ['# t\n\n- <b>x</b>\n\n```js\nlet a = 1\n```\n[l](javascript:alert(1))', { as: 'markdown' }],
    ['--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new <script>', { as: 'diff' }],
    ['\u001b[31mred\u001b[0m </code>', { as: 'code' }],
  ]
  for (const [text, r] of cases) {
    const cell = inline(text, r), { container, unmount } = render(<Cell cell={cell} api={noApi} />)
    fireEvent.click(container.querySelector('[data-cellmode="read"]')!)
    const want = document.createElement('div')
    const opt = { budget: DISPLAY_CLIP } // as cell.mjs draws a first slice
    want.innerHTML = renderKind(cell.view.r, cell.view.body, opt).html
    expect(container.querySelector('.cell > .cellread')!.innerHTML).toBe(want.innerHTML)
    unmount()
  }
})

test('2.3 #21: a pending body is its preview in a sized box with no control; a failed one says its reason', () => {
  const cell = cellOf({ key: 'nb', ref: 's/x#r1::0-99', chars: 4000, preview: 'the first words' })
  const { container, rerender } = render(<Cell cell={cell} api={noApi} />)
  const box = container.querySelector('.cellpend') as HTMLElement
  expect(box.textContent).toBe('the first words')
  expect(Number(box.style.getPropertyValue('--cl'))).toBeGreaterThan(0)
  expect(container.querySelector('button, a, [tabindex]')).toBeNull()
  rerender(<Cell cell={cell} fail={{ status: 'error', error: 'HTTP 503 upstream gone' }} api={noApi} />)
  expect(container.textContent).toContain('HTTP 503 upstream gone')
  expect(container.querySelector('.cellpend, .cell')).toBeNull()
})

test('the cell never reads a body: an open cell whose body is not cached makes no api call', () => {
  const api = { get: vi.fn(async () => ({ ok: true, status: 200, data: { bytes: 'x' } })) }
  render(<Cell cell={cellOf({ key: 'nb2', ref: 's/x#r2::0-9', chars: 9, preview: 'p' })} api={api} />)
  expect(api.get).not.toHaveBeenCalled()
})

test('a slice the sentinel appended survives an unrelated re-render of the parent', async () => {
  const text = Array.from({ length: 3 * DISPLAY_CLIP / 40 }, (_, i) => JSON.stringify({ i, v: 'y'.repeat(20) })).join('\n')
  const cell = inline(text)
  let poke = () => {}
  function Parent() { const [t, setT] = useState(0); poke = () => setT(t + 1); return <div data-t={t}><Cell cell={cell} api={noApi} /></div> }
  const { container } = render(<Parent />)
  const first = bytesOf(leafOf(container))!.length
  await enter()
  const leaf = leafOf(container), node = leaf.firstChild, grown = bytesOf(leaf)!
  expect(grown.length).toBeGreaterThan(first)
  expect(text.startsWith(grown)).toBe(true)
  expect((container.querySelector('.cell') as HTMLElement).dataset.shown).toBe(String(grown.length))
  act(() => poke())
  expect(leafOf(container)).toBe(leaf)
  expect(leaf.firstChild).toBe(node)
  expect(bytesOf(leaf)).toBe(grown)
})

// the same cell drawn by each of the two builds' drawers: the new desk's React cell and the legacy cell, in a wired host of its own
function bothDraws(cell: any): Array<[string, HTMLElement]> {
  const host = document.createElement('div')
  host.innerHTML = cellBodyHtml(cell, modeOf(cell.bid))
  return [['react', render(<Cell cell={cell} api={noApi} />).container], ['legacy', host]]
}

test('2.3 #11: a view shorter than its bytes counts the view, draws a prefix of it, and Copy bytes still gives every byte', async () => {
  const words = Array.from({ length: 1500 }, (_, i) => `line ${i} of the reply`).join('\n')
  const bytes = words.split('\n').map((w) => `data: {"type":"delta","text":${JSON.stringify(w)}}\n\n`).join('')
  const ref = 's/x#m::resp.raw::0-9', api = { get: vi.fn() }
  bodyCache.set(ref, blockGot({ ref, bytes, fidelity: { verbatim: true }, view: { r: TEXT_R, body: { text: words } } }))
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { copied.push(t) } } })
  setDeskMode('read')
  const cell = cellOf({ sec: 'messages', kind: 'text', text_ref: ref, chars: bytes.length, preview: '' })
  for (const [, c] of bothDraws(cell)) {
    const el = c.querySelector('.cell') as HTMLElement, leaf = el.querySelector(':scope > .cellread')!
    expect(Number(el.dataset.chars)).toBe(words.length)
    expect(words.startsWith(leaf.textContent!)).toBe(true)
    expect(leaf.textContent!.length).toBeLessThan(words.length)
    expect(el.querySelector('.cellclip')).not.toBeNull()
  }
  const { container } = render(<Cell cell={cell} api={api} />)
  expect(container.querySelector('.cellread')!.compareDocumentPosition(container.querySelector('.cellclip')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await act(async () => { fireEvent.click(container.querySelector('[data-cellcopy]')!); await Promise.resolve() })
  expect(copied).toEqual([bytes])
})

test('2.3 #16: a cell with no view has only Raw: no switch, and only a block says so', () => {
  const ref = 's/x#r3::0-9'
  bodyCache.set(ref, { status: 'ok', text: '{"a":1}' })
  setDeskMode('read')
  const cases: Array<[any, boolean]> = [
    [cellOf({ sec: 'messages', kind: 'text', text_ref: ref, chars: 7, preview: '' }), true],
    [cellOf({ key: 'nb3', ref, chars: 7 }), false],
  ]
  for (const [cell, block] of cases) for (const [how, c] of bothDraws(cell)) {
    const el = c.querySelector('.cell') as HTMLElement
    expect([how, el.dataset.mode, el.dataset.only]).toEqual([how, 'raw', 'raw'])
    expect(el.querySelector('[data-cellmode]')).toBeNull()
    expect(el.querySelector('[data-cellcopy]')).not.toBeNull()
    expect(el.querySelector('pre.cellraw')).not.toBeNull()
    expect(!!el.querySelector('[data-noread]')).toBe(block)
  }
})

test('2.3 #40: a block with no bytes has only Readable: no switch, no Copy bytes, no Raw, and v leaves it there', () => {
  const r = { as: 'text', f: { body: ['block', 'text'] } }, block = { type: 'text', text: 'the parsed words' }
  const cases: Array<[string, any]> = [
    ['a definition\'s spec', { sec: 'messages', kind: 'text', bid: 'B40a', r, inline: { block } }],
    ['the older shape', { sec: 'messages', kind: 'text', bid: 'B40b', r: { as: 'text' }, inline: { block } }],
  ]
  setDeskMode('raw')
  for (const [why, def] of cases) {
    const cell = cellOf(def)
    for (const [how, c] of bothDraws(cell)) {
      const el = c.querySelector('.cell') as HTMLElement, at = `${why} ${how}`
      expect([at, el.dataset.mode, el.dataset.only]).toEqual([at, 'read', 'read'])
      expect(el.querySelector('[data-cellmode], [data-cellcopy], .cellraw')).toBeNull()
      expect(el.querySelector('.cellread')!.textContent).toContain('the parsed words')
      expect(el.querySelector('.cellnote')!.textContent).toBe(C.READ_ONLY_NOTE)
    }
    const row = document.createElement('div')
    row.className = 'cblk'
    row.innerHTML = cellBodyHtml(cell, 'raw')
    document.body.appendChild(row)
    const off = wireCells(row), el = row.querySelector('.cell') as HTMLElement
    for (const key of ['v', 'c']) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      expect((row.querySelector('.cell') as HTMLElement).dataset.mode).toBe('read')
      expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe(C.READ_ONLY)
    }
    off(); row.remove()
  }
})

test('2.3 #39: a node the reader opened comes back when the leaf is mounted again; a toggle event alone remembers nothing', () => {
  const tree = { top: { mid: { deep: { leaf: 'the words at the bottom' } } }, other: { mid: { deep: { leaf: 'not opened' } } } }
  const cell = inline(JSON.stringify(tree), { as: 'json' }, 'J39')
  const nodeAt = (c: HTMLElement, path: string[]) => c.querySelector<HTMLDetailsElement>(`details[data-path='${JSON.stringify(path)}']`)
  setDeskMode('read')
  // the reader's click, then the toggle the browser fires for it; a node past the first paint exists only once its parent is open
  const toggled = (d: HTMLDetailsElement) => act(() => { d.open = true; d.dispatchEvent(new Event('toggle')) })
  const clicked = (d: HTMLDetailsElement) => { fireEvent.click(d.querySelector('summary')!); toggled(d) }
  const first = render(<Cell cell={cell} api={noApi} />)
  const TOP = ['top', 'mid'], DEEP = ['top', 'mid', 'deep']
  clicked(nodeAt(first.container, TOP)!)
  clicked(nodeAt(first.container, DEEP)!)
  toggled(nodeAt(first.container, ['other', 'mid'])!)
  expect(nodeAt(first.container, DEEP)!.textContent).toContain('the words at the bottom')
  first.unmount()
  const { container } = render(<Cell cell={cell} api={noApi} />)
  const reopened = () => { for (const p of [TOP, DEEP]) expect(nodeAt(container, p)!.open).toBe(true); expect(nodeAt(container, DEEP)!.textContent).toContain('the words at the bottom') }
  reopened()
  expect(nodeAt(container, ['other', 'mid'])!.open).toBe(false)
  expect(nodeAt(container, ['other', 'mid'])!.children.length).toBe(1)
  act(() => setMode('J39', 'raw'))
  act(() => setMode('J39', 'read'))
  reopened()
})

test('2.3 §两种模式: the images of one tool result each take their own data', () => {
  const png = (w: number) => btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, w, 0, 0, 0, 1, 8, 2, 0, 0, 0))
  const made: BlobPart[][] = []
  URL.createObjectURL = vi.fn((b: Blob) => { made.push([b]); return `blob:u${made.length}` })
  URL.revokeObjectURL = vi.fn()
  const img = (w: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(w) } })
  const kid = { as: 'media', f: { body: [], data: ['source', 'data'], mime: ['source', 'media_type'] } }
  const view = { r: { as: 'parts', f: { body: ['block', 'content'] }, kids: { 0: kid, 1: kid } }, body: { block: { type: 'tool_result', content: [img(2), img(3)] } } }
  const ref = 's/x#r5::0-9'
  bodyCache.set(ref, { status: 'ok', text: 'x', view })
  setDeskMode('read')
  const { container } = render(<Cell cell={cellOf({ sec: 'messages', kind: 'tool_result', text_ref: ref, chars: 1, preview: '' })} api={noApi} />)
  const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))
  expect(srcs).toHaveLength(2)
  expect(new Set(srcs).size).toBe(2)
  expect(srcs.every(Boolean)).toBe(true)
})

test('2.3 §两种模式: Readable comes first, bar={false} leaves the controls to a CellBar, whose clicks stay out of the row, and it has none before the body', () => {
  const cell = inline('{"a":1}', { as: 'json' }, 'BAR'), row = vi.fn()
  setDeskMode('read')
  const { container } = render(<div onClick={row}><CellBar cell={cell} api={noApi} /><Cell cell={cell} bar={false} api={noApi} /></div>)
  expect(container.querySelector('.cell .cellbar')).toBeNull()
  expect([...container.querySelectorAll<HTMLElement>('.cellbar [data-cellmode]')].map((b) => b.dataset.cellmode)).toEqual(['read', 'raw'])
  fireEvent.click(container.querySelector('.cellbar [data-cellmode="raw"]')!)
  expect((container.querySelector('.cell') as HTMLElement).dataset.mode).toBe('raw')
  expect(row).not.toHaveBeenCalled()
  const pending = cellOf({ key: 'nb5', ref: 's/x#r6::0-9', chars: 9, preview: 'p' })
  expect(render(<CellBar cell={pending} api={noApi} />).container.innerHTML).toBe('')
})

test('2.3 §两种模式: a shell command\'s note sits under the controls in Readable, and a guess gives way to what the tool call reads', () => {
  const shell = { r: { as: 'shell', f: { body: ['block', 'input'], cmd: ['block', 'input', 'command'], note: ['block', 'input', 'description'] } }, body: { block: { input: { command: 'ls -la', description: 'List the files' } } } }
  const ref = 's/x#r7::0-9'
  bodyCache.set(ref, { status: 'ok', text: 'x', view: shell })
  setDeskMode('read')
  const { container, unmount } = render(<Cell cell={cellOf({ sec: 'messages', kind: 'tool_use', bid: 'SH', text_ref: ref, chars: 1, preview: '' })} api={noApi} />)
  expect(container.querySelector('.cellnote')!.textContent).toBe('List the files')
  act(() => setMode('SH', 'raw'))
  expect(container.querySelector('.cellnote')).toBeNull()
  unmount()
  bodyCache.set(ref, { status: 'ok', text: 'x', view: { r: { as: 'text', guess: true, f: { body: ['text'] } }, body: { text: 'plain output' } } })
  const out = render(<Cell cell={cellOf({ sec: 'messages', kind: 'tool_result', bid: 'GU', text_ref: ref, reads: 'code', chars: 1, preview: '' })} api={noApi} />)
  expect(out.container.querySelector('.cellread')!.classList.contains('kd-code')).toBe(true)
})
