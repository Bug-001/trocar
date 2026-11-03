// test/web-v2/stepbar.test.mjs — 2.2 §步头 as data: web/src/screens/replay/models.mjs : stepHeadModel() over hand-made desks
// (desk-world.mjs deskOf) and, for #6, over the seven harnesses' sessions on the real server. Expected values come from
// core/metrics.mjs, analysis.mjs : segTax() and the rows themselves; words are compared to the label constants, never to literals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepHeadModel } from '../../web/src/screens/replay/models.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { segTax } from '../../web/legacy/replay/analysis.mjs'
import { costOf, priceMatch, hitRatio, QUIET_CAUSES } from '../../web/legacy/core/metrics.mjs'
import { usd } from '../../web/legacy/core/fmt.mjs'
import { priceStateNote } from '../../web/legacy/replay/stepbar.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'

const U = (read, create, fresh, out = 10) => ({ read, create, fresh, out })
const blk = (sec, role, bytes, extra = {}) => ({ sec, role, kind: 'text', bytes, chars: bytes, head: { role, tag: 'text', label: 'text' }, preview: 'p', ref: null, ...extra })
// a desk of one main lane (rows + optional blocks) and the controller's state at `at`
function stateOf(rows, { blocks, at = 0, ...extra } = {}) {
  const desk = deskOf([{ kind: 'main', rows, blocks }])
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return { desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, pricing: null, pricingErr: null, diffRef: null, ...extra }
}
const head = (rows, o) => stepHeadModel(stateOf(rows, o))
const rowsOf = (m, k) => m[k]()

test('2.2 #3 · ≈ $: the label is costOf(priceMatch(table, model).row, usage); a key match names its key; unknown is ≈ — with one reason, never $0', () => {
  const table = { 'big-model': [3, 15, 3.75, 0.3], small: [1, 5, 1.25, 0.1] }
  for (const model of ['big-model', 'xx-small-2']) {
    const u = U(100, 20, 5, 7), m = head([{ usage: u, rec: { request: { model } } }], { pricing: table })
    const pm = priceMatch(table, model)
    assert.equal(m.cost.label, W.approxUsd(usd(costOf(pm.row, u))))
    const rows = rowsOf(m, 'costRows')
    assert.equal(rows[0].text, W.COST_CALIBRE)
    assert.equal(rows.some((r) => r.text === W.PRICE_BY_KEY(pm.key)), pm.exact === false, model)
  }
  const cases = [
    [{ usage: U(1, 1, 1), rec: { request: { model: 'none' } } }, table, null, W.COST_WHY['no-price']],
    [{ usage: null }, table, null, W.COST_WHY['no-usage']],
    [{ usage: null, error: 'boom' }, table, null, W.COST_WHY.failed],
    [{ usage: U(1, 1, 1) }, null, 'EACCES', priceStateNote(null, 'EACCES')],
    [{ usage: U(1, 1, 1) }, null, null, W.PRICES_LOADING],
  ]
  for (const [row, pricing, pricingErr, why] of cases) {
    const m = head([row], { pricing, pricingErr }), rows = rowsOf(m, 'costRows')
    assert.equal(m.cost.label, W.COST_NONE)
    assert.deepEqual(rows.filter((r) => r.key === 'why').map((r) => r.text), [why])
    assert.doesNotMatch(JSON.stringify([m.cost.label, rows]), /\$0(?![.\d])/)
  }
})

test('2.2 #4 · 缓存 popover: the four numbers are usage.read / create / fresh / out; NULL is — with its tip; no usage writes no row and no 0%', () => {
  const u = { read: 0, create: null, fresh: 14, out: 164 }
  const rows = rowsOf(head([{ usage: u, cacheBreak: { cause: 'append' } }]), 'cacheRows')
  const items = rows.find((r) => r.key === 'usage').items
  assert.deepEqual(items.map((x) => x.n), [u.read, u.create, u.fresh, u.out])
  for (const x of items) assert.equal(x.tip === W.USAGE_NULL_TIP, x.n == null, x.key)
  assert.notEqual(items[0].text, items[1].text, 'a real 0 is not the NULL dash')
  for (const row of [{ usage: null }, { usage: null, error: 'x' }, { usage: U(0, 0, 0) }]) {
    const m = head([row]), r = rowsOf(m, 'cacheRows')
    assert.ok(!r.some((x) => x.key === 'usage'), JSON.stringify(row))
    assert.ok([W.CACHE_CELL_NONE, W.CACHE_CELL_FAILED].includes(m.cache.label), 'never a 0% hit')
  }
})

test('2.2 #7 · 组成 popover: content bytes, the four shares, the culprit and the bytes / token sentence; metadata-only tools say so', () => {
  for (const ff of ['verbatim', 'metadata']) {
    const blocks = [[blk('tools', 'tools', 300, { ff: { faithfulness: ff } }), blk('system', 'system', 100), blk('messages', 'user', 50, { query: true })]]
    const s = stateOf([{ usage: U(0, 10, 1) }], { blocks }), rows = rowsOf(stepHeadModel(s), 'compRows')
    const tax = segTax(stepOf(s.desk, s.anchor.calls[0].rid).flat)
    assert.equal(rows.find((r) => r.key === 'size').bytes, tax.total)
    assert.equal(rows.find((r) => r.key === 'calibre').text, W.COMP_CALIBRE)
    assert.deepEqual(rows.find((r) => r.key === 'segs').items.map((x) => x.pct), ['tools', 'system', 'history', 'task'].map((k) => tax.pct(k)))
    assert.equal(rows.find((r) => r.key === 'culprit').seg, tax.culprit)
    assert.equal(rows.some((r) => r.text === W.TOOLS_ESTIMATED), ff === 'metadata')
  }
  assert.equal(rowsOf(head([{ usage: U(0, 10, 1) }]), 'compRows'), 'busy', 'a lane not held: a sized empty row, no words')
})

test('2.2 #8 · 组成 growth: against the content ref, following the compare pick; compaction is a rewrite; the first call has none', () => {
  const sizes = [100, 160, 400]
  const blocks = sizes.map((n) => [blk('system', 'system', 50), blk('messages', 'user', n, { query: true })])
  const rows = [{ usage: U(0, 10, 1), cacheBreak: { firstCall: true } }, { usage: U(5, 10, 1), cacheBreak: { cause: 'append' } }, { usage: U(5, 10, 1), cacheBreak: { cause: 'append' } }]
  const total = (s, i) => segTax(stepOf(s.desk, s.anchor.calls[i].rid).flat).total
  for (const diffRef of [null, 0]) {
    const s = stateOf(rows, { blocks, at: 2, diffRef }), g = rowsOf(stepHeadModel(s), 'compRows')
    const ref = diffRef ?? 1
    assert.equal(g.find((r) => r.key === 'growth').delta, total(s, 2) - total(s, ref))
    assert.equal(g.find((r) => r.key === 'growth').refK, ref + 1)
    assert.ok(g.some((r) => r.text === W.DIAGNOSE_ONLY))
  }
  assert.ok(!rowsOf(stepHeadModel(stateOf(rows, { blocks, at: 0 })), 'compRows').some((r) => r.key === 'growth'), 'the first call has no growth')
  const comp = rows.map((r, i) => (i === 2 ? { ...r, cacheBreak: { cause: 'compaction' } } : r))
  const c = rowsOf(stepHeadModel(stateOf(comp, { blocks, at: 2 })), 'compRows')
  assert.ok(c.some((r) => r.text === W.COMPACTION_REWRITE) && !c.some((r) => r.key === 'growth'))
})

test('2.2 #13 · 缓存 label: failed · — · N%? · N%', () => {
  const u = U(70, 20, 10)
  const pct = Math.round(hitRatio(u) * 100)
  assert.equal(head([{ error: 'x', usage: u }]).cache.label, W.CACHE_CELL_FAILED)
  assert.equal(head([{ usage: null }]).cache.label, W.CACHE_CELL_NONE)
  assert.equal(head([{ usage: u, wire: { cacheSemanticsKnown: false } }]).cache.label, W.cacheCellUnknown(pct))
  assert.equal(head([{ usage: u, cacheBreak: { cause: 'append' } }]).cache.label, W.cacheCellPct(pct))
})

test('2.2 #14 · 缓存 popover: a structural sentence carries 结构估计 (states 4–7 and volatile-nonce-only); 1–3 and append do not', () => {
  const u = U(0, 50, 10)
  const cases = [
    [{ error: 'x', usage: u }, false], [{ usage: null }, false], [{ usage: u, cacheBreak: { firstCall: true } }, false],
    [{ usage: u, gt: 'ttl-rebuild', cacheBreak: { cause: 'append' } }, true], [{ usage: u, gt: 'provider-contradiction', cacheBreak: { cause: 'append' } }, true],
    [{ usage: u, cacheBreak: { cause: 'tool-array-reorder' } }, true], [{ usage: u, cacheBreak: { cause: 'append' } }, true],
    [{ usage: U(90, 5, 5), cacheBreak: { cause: 'volatile-nonce-only' } }, true], [{ usage: U(90, 5, 5), cacheBreak: { cause: 'append' } }, false],
  ]
  for (const [row, struct] of cases) {
    const m = head([{ usage: U(0, 10, 1) }, row], { at: 1 })
    const sentence = rowsOf(m, 'cacheRows')[0]
    assert.equal(sentence.key, 'sentence')
    assert.equal(sentence.struct, struct, JSON.stringify(row))
    assert.equal(sentence.structTip, W.STRUCT_TIP)
  }
})

test('2.2 #15 · 跳到变化处 only when the cause is outside QUIET_CAUSES (a failed step too) and the step\'s blocks reach the change', () => {
  const blocks = [[blk('system', 'system', 10)], [blk('system', 'system', 10), blk('messages', 'user', 5)]]
  for (const cause of ['append', 'first-call', 'volatile-nonce-only', 'content-changed', 'tool-array-reorder', 'compaction']) {
    for (const error of [null, 'boom']) {
      const row = { usage: error ? null : U(0, 10, 1), cacheBreak: { cause, idx: 1 }, ...(error ? { error } : {}) }
      const m = head([{ usage: U(0, 10, 1) }, row], { blocks, at: 1 })
      assert.equal(rowsOf(m, 'cacheRows').some((r) => r.text === W.JUMP_TO_CHANGE), !QUIET_CAUSES.has(cause), `${cause} ${error}`)
    }
  }
})

test('2.2 §步头 上下文: the value is the row\'s ctx; the bar exists iff the row has comp; no prompt ordinal on the step head', () => {
  for (const row of [{ ctx: 9040, comp: { system: 10, user: 30 } }, { ctx: 77 }, { ctx: 5, rec: null }]) {
    const m = head([{ usage: U(1, 1, 1), ...row }])
    assert.equal(m.ctx.value, row.rec === null ? null : row.ctx)
    assert.equal(!!m.ctx.comp, !!row.comp)
    assert.equal(m.ctx.word, W.CTX_BTN)
    assert.ok(!JSON.stringify(m).includes(W.askNo(1)) && !('ask' in m))
  }
})

test('2.2 #6 · step head on the real server: every main step of every harness dir has N / M and the three read-outs; usage words are the closed set', { timeout: 180_000 }, async () => {
  const face = await serveBoard(boardHome({ bytes: 4e5 }))
  try {
    const get = async (name, p) => (await face.get(name, p)).doc
    const sessions = (await get('sessions')).sessions
    assert.ok(new Set(sessions.map((x) => x.harness)).size >= 7, 'the set covers the seven harnesses')
    const words = new Set(Object.values(W.USAGE_WORD))
    let steps = 0
    for (const { session_id: id } of sessions) {
      const desk = await deskFrom(get, id), lanes = buildLanes(desk), anchor = anchorLane(lanes)
      if (!anchor || anchor.kind !== 'main') continue
      for (let at = 0; at < anchor.calls.length; at++) {
        const m = stepHeadModel({ desk, meta: desk.meta, lanes, anchor, playhead: at, playRid: anchor.calls[at].rid, pricing: null, diffRef: null })
        assert.equal(m.n, at + 1 + anchor.base, id)
        assert.equal(m.m, desk.lanes.get(anchor.id).count, id)
        for (const k of ['ctx', 'cache', 'cost']) assert.ok(m[k] && m[k].word, `${id} ${k}`)
        for (const r of m.cacheRows()) for (const x of r.items || []) assert.ok(words.has(x.word), x.word)
        steps++
      }
    }
    assert.ok(steps > 20, `main steps checked: ${steps}`)
  } finally { await face.close() }
})
