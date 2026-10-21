// test/web-v2/cell-modes.test.mjs — a cell's view mode (spec 2.3 §两种模式, 1.2 §键盘):
// the per-cell override follows the cell's identity across steps, the desk default survives a reload through storage and
// degrades to Raw when storage fails, and the cell keys are a pure function of the key event. No DOM; storage is a fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cellOf, cellBodyHtml, modeOf, setMode, bodyCache } from '../../src/web/v2/replay/cell.mjs'
import { cellKey, keyAction } from '../../src/web/v2/replay/keymap.mjs'

const CELL = new URL('../../src/web/v2/replay/cell.mjs', import.meta.url).href
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) } }

test('C6a: an override follows the block across steps that re-send it, whatever its byte locator', () => {
  // one block re-sent at two steps: the same content key, two records
  const def1 = { sec: 'messages', role: 'user', kind: 'text', key: 'K:1', text_ref: 's/main#r1::10-20', chars: 6, preview: 'abc' }
  const def2 = { ...def1, text_ref: 's/main#r9::10-20' }
  bodyCache.set(def2.text_ref, { status: 'ok', text: '"abc"' })
  setMode(cellOf(def1).bid, 'read')
  const c2 = cellOf(def2)
  assert.equal(modeOf(c2.bid), 'read')
  assert.match(cellBodyHtml(c2, modeOf(c2.bid)), /data-mode="read"/)
  assert.equal(c2.ref, def2.text_ref, 'the bytes are located by the ref, never by the key')
})

test('C6b: the desk default survives a reload through storage', async () => {
  const storage = memStorage()
  const a = await import(CELL + '?fresh=b1')
  a.setDeskMode('read', { storage })
  const b = await import(CELL + '?fresh=b2')
  assert.equal(b.deskMode({ storage }), 'read')
})

test('C6c: a storage that throws leaves the desk default at Raw and never throws', async () => {
  const bad = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const m = await import(CELL + '?fresh=c1')
  assert.equal(m.deskMode({ storage: bad }), 'raw')
  assert.doesNotThrow(() => m.setDeskMode('read', { storage: bad }))
})

test('C7: the cell keys are a pure function of the key event, and the desk keys ignore them', () => {
  const cases = [
    [{ key: 'v' }, { flip: true }], [{ key: 'V', shiftKey: true }, { flipDesk: true }], [{ key: 'v', shiftKey: true }, { flipDesk: true }],
    [{ key: 'V' }, { flipDesk: true }], [{ key: 'c' }, { copy: true }], [{ key: 'x' }, null],
  ]
  for (const [e, want] of cases) { assert.deepEqual(cellKey(e), want); assert.deepEqual(cellKey({ ...e }), want, 'same input, same output') }
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) for (const key of ['v', 'V', 'c']) assert.equal(cellKey({ key, [mod]: true }), null)
  for (const key of ['v', 'V', 'c']) assert.equal(keyAction({ key }, { at: 0, n: 5, problems: [] }), null)
})
