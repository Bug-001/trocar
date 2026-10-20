// test/web-v2/fold.test.mjs — the turn fold memory: persisted, capped at 2000 entries (oldest dropped), keyed by the turn's
// anchor block key. A fake storage object stands in for localStorage.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadFold, saveFold, setFold, turnAnchorKey, turnIsOpen, FOLD_KEY, FOLD_CAP } from '../../src/web/v2/replay/fold.mjs'

const fake = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } } }

test('the storage key is the v2 one', () => { assert.equal(FOLD_KEY, 'trocar.v2.turnfold'); assert.equal(FOLD_CAP, 2000) })
test('round trip through a fake storage', () => {
  const st = fake(); const f = new Map([['k1', true], ['k2', false]])
  saveFold(st, f)
  assert.ok(st.m.has(FOLD_KEY))
  assert.deepEqual([...loadFold(st)], [['k1', true], ['k2', false]])
})
test('cap: more than 2000 entries drop the OLDEST ones on save', () => {
  const st = fake(); const f = new Map()
  for (let i = 0; i < 2105; i++) setFold(f, 'key' + i, i % 2 === 0)
  saveFold(st, f)
  const back = loadFold(st)
  assert.equal(back.has('key0'), false); assert.equal(back.has('key104'), false)
  assert.equal(back.has('key105'), true); assert.equal(back.has('key2104'), true)
})
test('setFold moves a toggled key to the newest position', () => {
  const f = new Map([['a', true], ['b', true]]); setFold(f, 'a', false)
  assert.deepEqual([...f.keys()], ['b', 'a']); assert.equal(f.get('a'), false)
})
test('integer-like anchor keys keep their order (an array of pairs is stored, not an object)', () => {
  const st = fake(); const f = new Map([['20', true], ['10', true], ['x', false]]); saveFold(st, f)
  assert.deepEqual([...loadFold(st).keys()], ['20', '10', 'x'])
})
test('a broken, missing or hostile storage never throws', () => {
  assert.equal(loadFold(null).size, 0); assert.equal(loadFold(undefined).size, 0)
  assert.equal(loadFold(fake({ [FOLD_KEY]: '{not json' })).size, 0)
  assert.equal(loadFold(fake({ [FOLD_KEY]: '[["a",true],["b","yes"],7]' })).size, 1) // only boolean states survive
  const boom = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.equal(loadFold(boom).size, 0); assert.doesNotThrow(() => saveFold(boom, new Map([['a', true]])))
  assert.doesNotThrow(() => saveFold(null, new Map()))
})
test('an old object-shaped payload is read too', () => {
  assert.deepEqual([...loadFold(fake({ [FOLD_KEY]: '{"a":true,"b":false,"c":3}' }))].sort(), [['a', true], ['b', false]])
})
test('turnAnchorKey is the first block key of the turn, with a label fallback; the latest turn is open by default', () => {
  const flat = [{ key: 'T' }, { key: 'M:1' }, { key: 'M:2' }]
  assert.equal(turnAnchorKey(flat, { items: [1, 2], label: 'x' }), 'M:1')
  assert.equal(turnAnchorKey(flat, { items: [], label: 'x' }), 't:x')
  assert.equal(turnAnchorKey([{}], { items: [0], label: 'lab' }), 't:lab')
  const fold = new Map([['M:1', true]])
  assert.equal(turnIsOpen(fold, flat, { items: [1], label: '' }, 0, 3), true) // remembered open
  assert.equal(turnIsOpen(new Map([['M:1', false]]), flat, { items: [1], label: '' }, 3, 3), false) // remembered shut beats the default
  assert.equal(turnIsOpen(new Map(), flat, { items: [1], label: '' }, 3, 3), true) // default: the last turn open
  assert.equal(turnIsOpen(new Map(), flat, { items: [1], label: '' }, 1, 3), false) // …the rest shut
})
