// test/web-v2/readable-default.test.mjs — the desk's start (spec 2.3 §两种模式 · D70): with no stored choice an open cell that has a view is
// Readable and its section says so, a cell with no view is Raw, a stored choice wins, and a storage that throws starts Readable. Its own file
// (its own process): the module's page memory of the last choice is still empty here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyCache, cellBodyHtml, cellOf, deskMode, modeOf } from '../../web/legacy/replay/cell.mjs'
import { windowItems } from '../../web/src/screens/replay/window-model.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { deskOf } from './desk-world.mjs'

const memStorage = (v) => { const m = new Map(v ? [['trocar.v2.cellView', v]] : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, x) => m.set(k, String(x)) } }
const THROWS = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
const VIEW = { r: { as: 'text', f: { body: ['text'] } }, body: { text: 'abc' } }
const modeIn = (html) => /data-mode="(\w+)"/.exec(html)[1]

test('with no stored choice a block that has a view opens Readable, and its section says Readable view', () => {
  const def = { sec: 'messages', role: 'user', kind: 'text', head: { role: 'user', tag: 'user', label: 'b' }, preview: 'p', chars: 3, bytes: 3, ref: 's/m#R::0-5' }
  bodyCache.set(def.ref, { status: 'ok', text: '"abc"', view: VIEW })
  const cell = cellOf(def)
  for (const storage of [null, memStorage()]) assert.equal(modeIn(cellBodyHtml(cell, modeOf(cell.bid, { storage }))), 'read', `storage ${storage ? 'empty' : 'absent'}`)
  const desk = deskOf([{ kind: 'main', rows: [{ rec: { request: { model: 'm' } } }], blocks: [[def]] }])
  const lanes = buildLanes(desk)
  const s = { desk, lanes, anchor: anchorLane(lanes), playhead: 0, diffRef: null, navOpen: new Set(['cwremoved']), openBlocks: new Set([def.key ?? '']), turnFold: new Map(), turnLanded: new Set(), ctx: {} }
  const secs = windowItems(s).items.filter((it) => it.type === 'sec')
  assert.ok(secs.length > 0 && secs.every((h) => h.claim === 'readable'), JSON.stringify(secs.map((h) => h.claim)))
})

test('a cell with no view is Raw, whatever the desk default', () => {
  const key = cellOf({ key: 'req', ref: 'r1::req.raw::0-5', chars: 5 })
  bodyCache.set(key.ref, { status: 'ok', text: '"abc"', view: VIEW })
  assert.equal(modeIn(cellBodyHtml(key, modeOf(key.bid, { storage: null }))), 'raw')
})

test('a stored choice wins: raw stays raw, read stays read', () => {
  for (const v of ['raw', 'read']) assert.equal(deskMode({ storage: memStorage(v) }), v)
})

test('a storage that throws starts Readable', () => {
  assert.equal(deskMode({ storage: THROWS }), 'read')
})
