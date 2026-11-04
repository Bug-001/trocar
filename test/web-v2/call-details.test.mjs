// test/web-v2/call-details.test.mjs — Call details (2.6 §A): the two window items after the reply. The rows come from the lane step's
// detail and each ref resolves to the record's own bytes (#1); each step state has its own items (#2); what capturing changed stands
// in a line of its own, never folded (#4). Expected values come from the detail, the record on disk or the constructed desk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { parseTextRef } from '../../src/raw/refs.mjs'
import { callDetailItems } from '../../web/src/screens/replay/call-details.mjs'
import { windowItems } from '../../web/src/screens/replay/window-model.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import { serveBoard } from './real-face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { writeSegment } from '../query/raw-home.mjs'

const SEG = '20260719T090000Z'
const stateOf = (desk, playhead = 0) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead, rawPanelGone: true, diffRef: null, navOpen: new Set(), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), ctx: {} }
}
const blk = { sec: 'system', role: 'system', kind: 'text', head: { role: 'system', tag: 'text', label: 's' }, preview: 'p', chars: 5, bytes: 5, ref: 's/m#R::0-5' }
const detailOf = (o = {}) => ({ norm: { stop_reason: null }, respRefs: [], nonBlockKeys: [], extraMessages: [], wire: null, ...o })
const deskWith = (row = {}, detail = detailOf(), held = true) => deskOf([{ kind: 'main', rows: [{ rec: { request: { model: 'm' } }, ...row }], blocks: held ? [[blk]] : undefined, details: [detail] }])
const tail = (s) => windowItems(s).items.map((it) => it.type).filter((t) => ['impact', 'details', 'reply', 'unparsed', 'noreq', 'frames'].includes(t))
const itemOf = (s, type) => windowItems(s).items.find((it) => it.type === type)

test('2.6 #1: the rows are the detail\'s, every ref reads back the record\'s own span, and the details start folded', async () => {
  const demo = fs.readFileSync(new URL('../../samples/demo-session.ndjson', import.meta.url), 'utf8').split('\n').filter(Boolean)
  const userHome = tmpDir('trocar-board-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  // the sample's replies are parsed JSON and it has no later client message: two records store what a stream and a socket store
  const shaped = { 1: { resp: { status: 200, kind: 'sse', raw: 'data: {"a":1}\n\n' }, req_extra_messages: ['{"type":"later"}'] }, 2: { resp: { status: 200, kind: 'ws', messages: ['{"m":1}', '{"m":2}'] } } }
  const lines = demo.map((l, i) => (shaped[i] ? JSON.stringify({ ...JSON.parse(l), ...shaped[i] }) : l))
  writeSegment(home, SEG, lines)
  const recs = lines.map((l) => JSON.parse(l))
  const face = await serveBoard({ userHome, home })
  try {
    const get = async (name, p) => (await face.get(name, p)).doc
    const desk = await deskFrom(get, (await get('sessions')).sessions[0].session_id)
    const s = stateOf(desk), seen = { params: 0, raw: 0, extra: 0 }
    for (let p = 0; p < s.anchor.calls.length; p++) {
      const call = s.anchor.calls[p], st = stepOf(desk, call.rid)
      if (!st.held || !call.rec) continue
      const it = callDetailItems(call, st, s).find((x) => x.type === 'details'), d = st.detail
      assert.equal(it.open, false, `${call.rid}: folded by default`)
      for (const [name, want] of [['params', d.nonBlockKeys], ['raw', d.respRefs], ['extra', d.extraMessages]]) {
        assert.equal(it[name].length, want.length, `${call.rid} ${name}`)
        for (const [i, x] of it[name].entries()) {
          for (const k of ['key', 'chars', 'ref']) assert.equal(x[k], want[i][k], `${call.rid} ${name} ${k}`)
          if (!x.ref) continue
          const { field, start, end, recordId } = parseTextRef(x.ref)
          const rec = recs[Number(recordId.slice(recordId.lastIndexOf(':') + 1)) - 1]
          const text = field == null ? rec.req_body : field.split('.').reduce((v, k) => v[k], rec)
          const [block] = (await face.get('block', { ref: x.ref })).doc.blocks
          assert.equal(block.bytes, text.slice(start, end), `${x.ref}: the bytes read back are the record's`)
          seen[name]++
        }
      }
    }
    for (const [name, n] of Object.entries(seen)) assert.ok(n > 0, `${name}: some row resolved`)
  } finally { await face.close() }
})

test('2.6 #2: no request keys · an unparsed step · a failed step · no request · a lane not held', () => {
  const empty = stateOf(deskWith())
  assert.deepEqual(itemOf(empty, 'details').params, [])
  assert.equal(itemOf(empty, 'details').unparsed, false)

  const unparsed = stateOf(deskWith({ unparsed: true, errMsg: 'E-bad-json' }))
  assert.deepEqual(tail(unparsed), ['unparsed', 'details'], 'it follows the stand-in')
  assert.equal(itemOf(unparsed, 'details').unparsed, true)
  assert.ok(itemOf(unparsed, 'details').tech.some(([, v]) => String(v).includes('E-bad-json')), 'the reason is a tech detail')

  const respRefs = [{ label: 'reply', ref: null, chars: null, why: 'W-none' }]
  const failed = stateOf(deskWith({ error: 'boom', status: 500 }, detailOf({ respRefs })))
  assert.deepEqual(tail(failed), ['reply', 'details'])
  assert.deepEqual(itemOf(failed, 'details').raw.map((x) => [x.label, x.ref, x.why]), [['reply', null, 'W-none']], 'a failed step still lists its reply bytes')

  assert.deepEqual(tail(stateOf(deskWith({ rec: null }))), ['noreq'])
  assert.deepEqual(tail(stateOf(deskWith({}, detailOf(), false))), ['frames'])
  assert.deepEqual(tail(stateOf(deskWith({ unparsed: true }, detailOf(), false))), ['unparsed'], 'an unparsed step whose lane is not held has nothing yet')
})

test('2.6 #4: each observer effect is a line of its own with no fold; none means no item', () => {
  const fx = [{ id: 'x-1', cause: 'C1', what: 'what one' }, { id: 'x-2', cause: 'C2', what: 'what two', text: 'text two' }]
  const s = stateOf(deskWith({}, detailOf({ wire: { transport: 'http', observerEffect: fx } })))
  const it = itemOf(s, 'impact')
  assert.deepEqual(tail(s), ['reply', 'impact', 'details'])
  assert.deepEqual(it.lines.map((l) => l.text), fx.map((o) => o.text ?? o.what))
  assert.equal(new Set(it.lines.map((l) => l.key)).size, fx.length)
  assert.ok(!('open' in it), 'nothing folds it')
  for (const o of fx) assert.ok(itemOf(s, 'details').tech.some(([, v]) => String(v).includes(o.id) && String(v).includes(o.cause)), `${o.id}: id and cause are tech details`)
  assert.equal(itemOf(stateOf(deskWith()), 'impact'), undefined)
})

test('the legacy desk has no such items: its drawing table does not know them', () => {
  const s = { ...stateOf(deskWith({}, detailOf({ wire: { observerEffect: [{ id: 'x', what: 'w' }] } }))), rawPanelGone: false }
  assert.deepEqual(tail(s), ['reply'])
})
