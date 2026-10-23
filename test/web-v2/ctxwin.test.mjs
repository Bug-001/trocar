// test/web-v2/ctxwin.test.mjs — the context window over the desk (1.4 #1 #8 #10 #11 · 2.3 #3 #6 #7 #13): assembly order and
// positions, the whitelist of top-level children, the landing, the stand-ins, the cache / volatile marks, the step diff by
// content hash (fh), the change line and the reply rows. Structure is asserted by class / data attribute; words only through
// the labels' own functions. Inputs are desks (desk-world.mjs : deskOf / world); the real face goes through deskFrom.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { ctxWindowHtml, ctxWindowUnits, landingTarget, renderContextWindow } from '../../src/web/v2/replay/ctxwin.mjs'
import { QUIET_CAUSES } from '../../src/web/v2/replay/analysis.mjs'
import { stepOf } from '../../src/web/v2/replay/model.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'
import { deskOf, world, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

let rn = 0
const blk = (o = {}) => ({ sec: 'messages', role: 'user', kind: 'text', head: { role: 'user', tag: 'user', label: 'b' }, preview: 'p', chars: 5, bytes: 5, ref: `s/m#R::${rn++}-9`, ...o })
const sys = (o) => blk({ sec: 'system', role: 'system', head: { role: 'system', tag: 'text', label: 's' }, ...o })
const tool = (o) => blk({ sec: 'tools', role: 'system', head: { role: 'system', tag: 'def', label: 't' }, ...o })
const rp = (kind, o = {}) => ({ kind, name: kind === 'tool_use' ? 'Bash' : undefined, head: { role: 'assistant', tag: kind, label: kind }, preview: kind, chars: 4, bytes: 4, ref: `s/m#R::resp.raw::${rn++}-9`, ...o })
const stateOf = (desk, playhead = 0, extra = {}) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead, diffRef: null, navOpen: new Set(['cwremoved']), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), ctx: {}, ...extra }
}
// one main lane: rows (each a step's skeleton fields) and the blocks of each step; `held:false` leaves the lane not held
const desk1 = (blocks, rows = blocks.map(() => ({})), extra = {}) => deskOf([{ kind: 'main', rows: rows.map((r) => ({ rec: { request: { model: 'm' } }, ...r })), blocks: extra.held === false ? undefined : blocks, replies: extra.replies, details: extra.details }])

// the top-level children of an html string, as their class lists (only <div> elements nest at the top)
function tops(h) {
  const out = []
  let depth = 0
  for (const m of h.matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (m[1]) { depth--; continue }
    if (depth === 0) out.push(((/class="([^"]*)"/.exec(m[2]) || [])[1] || '').split(/\s+/).filter(Boolean))
    depth++
  }
  return out
}
// 1.4 ①–⑨ by structural class: ① cwfline ② cwwin ③④ the sections (cwsec · cblk · chline · cwremoved · cwfoldall · cwturn)
// ⑥ cwunparsed ⑦ cwnoreq ⑧ cwbusy ⑨ cwreply
const SLOT = { cwfline: 1, cwwin: 2, cwsec: 3, cblk: 3, chline: 3, cwremoved: 3, cwfoldall: 3, cwturn: 3, cwunparsed: 6, cwnoreq: 7, cwbusy: 8, cwreply: 9 }
function whitelist(h, why) {
  const slots = tops(h).map((cls) => { const k = cls.find((c) => SLOT[c]); assert.ok(k, `${why}: <div class="${cls.join(' ')}"> is not in the whitelist`); return SLOT[k] })
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] >= slots[i - 1], `${why}: whitelist order ${slots}`)
  if (slots.some((x) => x >= 6 && x <= 8)) assert.ok(!slots.some((x) => x === 3 || x === 9), `${why}: a stand-in replaces ③④⑨`)
  return slots
}
const bis = (h) => [...h.matchAll(/class="cblk[^"]*"[^>]*data-bi="(\d+)"/g)].map((m) => +m[1])

test('1.4 #1 · #8: over generated desks every step draws its rows in list order, sections as they come, messages in turns, inside the whitelist', async () => {
  let steps = 0
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const desk = await deskFrom(world(seed).get(), 'S')
    for (const lane of buildLanes(desk)) {
      for (let p = 0; p < lane.calls.length; p++) {
        const s = stateOf(desk, p, { anchor: lane }), h = ctxWindowHtml(s), flat = stepOf(desk, lane.calls[p].rid).flat
        whitelist(h, `seed ${seed} ${lane.calls[p].rid}`)
        assert.deepEqual(bis(h), flat.map((_, i) => i), 'data-bi strictly increasing = the materialised list')
        const secs = [...h.matchAll(/class="cwsec" id="sec-([^"]+)"/g)].map((m) => m[1])
        assert.deepEqual(secs, flat.map((b) => b.sec).filter((x, i, a) => x !== a[i - 1]), 'a header where the section changes, in list order')
        for (const t of tops(h).filter((c) => c.includes('cblk'))) assert.ok(!t.includes('s-messages'), 'a message row lives in a turn')
        steps++
      }
    }
  }
  assert.ok(steps > 50)
})

test('1.4 #8: constructed stand-ins and edge steps stay inside the whitelist; an unheld step and an undrawn session show frames with no text', () => {
  const flat = [tool(), sys(), blk()]
  const rows = [{}, { unparsed: true, errMsg: 'E-x' }, { rec: null }, { wire: { contextState: 'partial', contextMissing: 2 } },
    { cacheBreak: { cause: 'compaction', idx: 2, firstCall: false } }]
  const desk = desk1(rows.map(() => flat), rows)
  for (let p = 0; p < rows.length; p++) whitelist(ctxWindowHtml(stateOf(desk, p)), `row ${p}`)
  assert.ok(whitelist(ctxWindowHtml(stateOf(desk1([flat.map((b) => ({ ...b, ref: undefined, unaddressable: 'x' }))]))), 'no ref').includes(2), '② the window line')
  for (const [s, why] of [[stateOf(desk1([flat], [{}], { held: false })), 'unheld'], [{ ...stateOf(desk1([flat])), anchor: null }, 'no session']]) {
    const h = ctxWindowHtml(s), frame = h.slice(h.indexOf('<div class="cwbusy"'))
    assert.ok(whitelist(h, why).includes(8))
    assert.match(frame, /^<div class="cwbusy" aria-busy="true">/)
    assert.equal(frame.replace(/<[^>]*>/g, ''), '', `${why}: the frame has no text`)
    assert.ok(!/<(button|a)\b|tabindex|role="button"/.test(frame), `${why}: no control`)
  }
})

test('1.4 #11: no request → ⑦; unparsed → ⑥ with errMsg only in the technical details', () => {
  const desk = desk1([[blk()], [blk()]], [{ rec: null }, { unparsed: true, errMsg: 'ERR-unparse-zz' }])
  assert.deepEqual(tops(ctxWindowHtml(stateOf(desk, 0))).flat(), ['cwnoreq'])
  const h = ctxWindowHtml(stateOf(desk, 1))
  assert.ok(tops(h).some((c) => c.includes('cwunparsed')))
  assert.ok(h.indexOf('ERR-unparse-zz') > h.indexOf('id="cwu-tech'), 'the reason is inside the disclosure')
})

// a lane of two steps: step 1's list against step 0 as its 缓存对比步; `cause` on step 1
const pair = (a, b, cause = 'content-changed', idx = 1, row1 = {}) => desk1([a, b], [{}, { cacheBreak: { cause, idx, firstCall: false, refRid: 'R0-0' }, ...row1 }])

test('2.3 #7 · 1.4 #11: the change line iff the cause is not quiet, before block idx, naming the reference step; the structural hint iff no block declares cc', () => {
  const a = [sys({ key: 's' }), blk({ key: 'm1' })], b = [sys({ key: 's' }), blk({ key: 'm2' }), blk({ key: 'm3' })]
  for (const cause of ['first-call', 'append', 'volatile-nonce-only', 'compaction', 'tool-array-reorder', 'json-key-reorder', 'content-changed']) {
    const h = ctxWindowHtml(stateOf(pair(a, b, cause), 1))
    assert.equal(h.includes('id="cachebrk"'), !QUIET_CAUSES.has(cause), cause)
    if (QUIET_CAUSES.has(cause)) continue
    assert.match(h, /id="cachebrk"[\s\S]*?<\/div>(<div class="cwremoved[\s\S]*?<\/div><\/div>)?<div class="cblk[^"]*"[^>]*data-bi="1"/, `${cause}: before block 1`)
    assert.ok(h.includes(W.changeLine(1, cause === 'compaction' ? W.CHANGE_COMPACT : W.causeWord(cause)).slice(0, 12)), `${cause}: step K = 1`)
  }
  const line = (h) => /<div class="chline"[\s\S]*?<\/span><\/div>/.exec(h)[0]
  assert.equal((line(ctxWindowHtml(stateOf(pair(a, b), 1))).match(/class="chest"/g) || []).length, 2, 'no cc: the structural hint is added')
  assert.equal((line(ctxWindowHtml(stateOf(pair(a, [b[0], { ...b[1], cc: { type: 'ephemeral' } }, b[2]]), 1))).match(/class="chest"/g) || []).length, 1, 'cc: no hint')
  assert.ok(ctxWindowHtml(stateOf(pair(a, b, 'content-changed', 1, { error: 'boom', status: 500 }), 1)).includes('id="cachebrk"'), 'a failed step keeps its line')
})

const newKeys = (h) => [...h.matchAll(/<div class="cblk[^"]*is-new[^"]*"[^>]*data-bi="(\d+)"/g)].map((m) => +m[1])
const removedN = (h) => (h.match(/data-rm="/g) || []).length

test('2.3 #6: 「新」 = fh not in the reference list; the removed list = the reference\'s fh not here; any pinned step moves them', () => {
  const ref = [sys({ key: 's' }), blk({ key: 'x' }), blk({ key: 'gone' })], cur = [sys({ key: 's' }), blk({ key: 'x' }), blk({ key: 'added' })]
  const h = ctxWindowHtml(stateOf(pair(ref, cur, 'content-changed', 2), 1))
  assert.deepEqual(newKeys(h), [2]); assert.equal(removedN(h), 1)
  // a step that is not the previous one, pinned: the marks follow it
  const d3 = desk1([[blk({ key: 'only0' })], ref, cur], [{}, {}, { cacheBreak: { cause: 'content-changed', idx: 0, firstCall: false, refRid: 'R0-1' } }])
  assert.deepEqual(newKeys(ctxWindowHtml(stateOf(d3, 2, { diffRef: 0 }))), [0, 1, 2])
  assert.deepEqual(newKeys(ctxWindowHtml(stateOf(d3, 2))), [2], 'the default 内容对比步 is the 缓存对比步 (refRid)')
  // no change line → no removed list; a quiet step still marks its new block
  const q = ctxWindowHtml(stateOf(pair(ref, cur, 'append', 2), 1))
  assert.equal(removedN(q), 0); assert.ok(!q.includes('cwremoved'))
  // the reference step's lane not held: no 「新」, no removed list
  const split = deskOf([{ kind: 'main', rows: [{ rec: {} }, { rec: {}, cacheBreak: { cause: 'content-changed', idx: 0, firstCall: false, refRid: 'R1-0' } }], blocks: [cur, cur] }, { kind: 'subagent', rows: [{ rec: {} }] }])
  const s = stateOf(split, 1); s.diffRef = null
  s.anchor = { ...s.anchor, calls: [split.rows.get('R1-0'), split.rows.get('R0-1')], ridLocal: new Map([['R1-0', 0], ['R0-1', 1]]) }
  const u = ctxWindowHtml(s)
  assert.deepEqual(newKeys(u), []); assert.equal(removedN(u), 0)
})

test('A13 (2.3 #6): two steps differing only in where cache_control sits (bid differs, fh equal): no 「新」, no removed list', () => {
  const a = [sys({ key: 's' }), blk({ key: 'm', cc: { type: 'ephemeral' } }), blk({ key: 'n' })]
  const b = [sys({ key: 's' }), blk({ key: 'm' }), blk({ key: 'n', cc: { type: 'ephemeral' } })]
  const desk = pair(a, b, 'content-changed', 1)
  assert.notDeepEqual(stepOf(desk, 'R0-0').flat.map((x) => x.bid), stepOf(desk, 'R0-1').flat.map((x) => x.bid), 'the bids differ')
  const h = ctxWindowHtml(stateOf(desk, 1))
  assert.ok(!h.includes('class="newmark"')); assert.equal(removedN(h), 0); assert.ok(!h.includes('cwremoved'))
})

test('2.3 #3: cc → the cache mark; volatile → its mark and never 「新」', () => {
  const h = ctxWindowHtml(stateOf(pair([sys({ key: 's' })], [sys({ key: 's', cc: { type: 'ephemeral' } }), blk({ key: 'v', volatile: true })], 'volatile-nonce-only'), 1))
  assert.match(h, /data-bi="0"[^>]*>[\s\S]*?class="bpbadge"/)
  const row1 = h.slice(h.indexOf('data-bi="1"') - 200)
  assert.ok(/class="volbadge"/.test(row1) && !newKeys(h).includes(1))
})

test('1.4 #10: landing — follow → ⑨; a reader\'s step → the change line, else the first 「新」, else none; once per step; the landing turn is not D12 memory', () => {
  const ref = [blk({ key: 'q1', query: true }), blk({ key: 'a1' })], cur = [blk({ key: 'q1', query: true }), blk({ key: 'a1' }), blk({ key: 'q2', query: true }), blk({ key: 'a2' })]
  const before = ctxWindowHtml(stateOf(pair(ref, cur, 'content-changed', 1), 1))
  assert.deepEqual(landingTarget({ ...stateOf(pair(ref, cur)), playhead: 1, followLanding: true }), { reply: true })
  assert.equal(landingTarget(stateOf(pair(ref, cur, 'content-changed', 1), 1)).anchor, 'cachebrk')
  assert.deepEqual(landingTarget(stateOf(pair(ref, cur, 'append', 2), 1)), { bi: 2 })
  assert.equal(landingTarget(stateOf(pair(ref, ref, 'append', 2), 1)), null)
  assert.equal(ctxWindowHtml(stateOf(pair(ref, cur, 'content-changed', 1), 1)), before, 'landingTarget does not reorder')
  // the change line sits in the first (folded) turn: the landing opens it for this display only, and scrolls once
  let scrolls = 0
  const node = { scrollIntoView: () => scrolls++ }
  const el = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: (q) => (q === '#cachebrk' ? node : null) }
  const s = stateOf(pair(ref, cur, 'content-changed', 1), 1, { persistFold: () => assert.fail('the landing writes no fold memory') })
  renderContextWindow(el, s); renderContextWindow(el, s)
  assert.equal(scrolls, 1, 'one landing per step'); assert.equal(s.turnFold.size, 0); assert.equal(s.turnLanded.size, 1)
  assert.ok(!/class="cwturn collapsed"[^>]*data-anchor/.test(el.innerHTML.split('id="cachebrk"')[0].slice(-400)), 'the turn holding the line is open')
})

// ── ⑨ the reply (2.3 #13 · A14) ───────────────────────────────────────────────────────────────────────────────────────
const replyDesk = (replies, rows) => desk1(replies.map(() => [sys({ key: 's' }), blk({ key: 'q', query: true })]), rows || replies.map(() => ({})),
  { replies, details: replies.map(() => ({ norm: { stop_reason: 'tool_use' } })) })
const seg = (h) => h.slice(h.lastIndexOf('<div class="cwreply">'))
const rows = (h) => [...seg(h).matchAll(/<div class="cblk([^"]*)"([^>]*)>/g)].map((m) => ({ cls: m[1], attrs: m[2] }))

test('A14 (2.3 #13): one row per reply def through the row component, no request attributes; data-bi only on request rows; one mark at most', () => {
  const desk = replyDesk([[rp('thinking'), rp('text'), rp('tool_use'), rp('tool_use', { name: 'Read' })]])
  const h = ctxWindowHtml(stateOf(desk)), rs = rows(h)
  assert.equal(rs.length, 4)
  for (const r of rs) { assert.match(r.attrs, /data-rp="rp:/); for (const a of ['data-bi', 'data-rk', 'data-ff']) assert.ok(!r.attrs.includes(a), a) }
  for (const x of ['newmark', 'bpbadge', 'volbadge', 'ffbadge']) assert.ok(!seg(h).includes(x), x)
  assert.equal(bis(h).length, stepOf(desk, 'R0-0').flat.length)
  assert.ok(seg(h).includes('Bash') && seg(h).includes('Read'), 'tool rows carry the tool name')
  assert.ok(seg(h).includes('tool_use'), 'the stop reason from detail.norm')
  assert.equal((seg(h).match(/class="rpmark"/g) || []).length, 0, 'every part on its resp.raw span: no mark')
  const parsed = ctxWindowHtml(stateOf(replyDesk([[rp('text', { ref: 's/m#R::10-20' }), rp('text')]])))
  assert.equal((seg(parsed).match(/class="rpmark"/g) || []).length, 1, 'one mark for the segment')
  const part = ctxWindowHtml(stateOf(replyDesk([[rp('text')]], [{ respIncomplete: { truncated: true } }])))
  assert.equal((seg(part).match(/class="rpmark"/g) || []).length, 1)
})

test('A14 (2.3:195): default open text → tool call → thinking; a flip stays across re-renders of the step, not across a step change', () => {
  for (const [parts, open] of [[['thinking', 'text', 'tool_use'], 'k-text'], [['thinking', 'tool_use'], 'k-tool_use'], [['thinking'], 'k-thinking']]) {
    for (const r of rows(ctxWindowHtml(stateOf(replyDesk([parts.map((k) => rp(k))]))))) assert.equal(r.cls.includes('collapsed'), !r.cls.includes(open), `${parts}: ${r.cls}`)
  }
  const desk = replyDesk([[rp('text'), rp('tool_use')], [rp('text'), rp('tool_use')]]), s = stateOf(desk, 0)
  const key = /data-rp="([^"]+)"/.exec(rows(ctxWindowHtml(s))[1].attrs)[1]
  s.openBlocks.add(key) // the reader opened the tool call
  assert.ok(!rows(ctxWindowHtml(s))[1].cls.includes('collapsed'))
  assert.ok(!rows(ctxWindowHtml(s))[1].cls.includes('collapsed'), 'kept on a re-render')
  s.playhead = 1; ctxWindowHtml(s); s.playhead = 0
  assert.ok(rows(ctxWindowHtml(s))[1].cls.includes('collapsed'), 'reset by the step change')
})

test('2.3 #13: a failed step\'s segment is one line, its reason in the technical details', () => {
  const h = seg(ctxWindowHtml(stateOf(replyDesk([[rp('text')]], [{ error: 'ERR-boom-q', status: 500 }]))))
  assert.ok(!h.includes('class="cblk')); assert.ok(h.indexOf('ERR-boom-q') > h.indexOf('id="cwfail'))
})

test('the real face: every main step of the demo session draws inside the whitelist with one row per reply def', async () => {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    const desk = await deskFrom((n, p) => face.get(n, p).then((r) => r.doc), id)
    const s = stateOf(desk)
    for (let p = 0; p < s.anchor.calls.length; p++) {
      s.playhead = p
      const h = ctxWindowHtml(s), st = stepOf(desk, s.anchor.calls[p].rid)
      whitelist(h, `step ${p + 1}`)
      if (st.held && !s.anchor.calls[p].error) assert.equal(rows(h).length, st.reply.length)
    }
  } finally { await face.close() }
})

test('2.3 §读失败 (K-29): a step whose lane read failed says so in place — Retry, the reason in the details — never empty frames', () => {
  const desk = desk1([[blk()], [blk()]], undefined, { held: false }), s = stateOf(desk, 1)
  assert.ok(ctxWindowUnits(s).some((u) => u.key === 'frames'), 'not held, no failure: the sized empty frames')
  const reason = 'the worker exited (code 1)', lane = stepOf(desk, s.anchor.calls[1].rid).lane
  s.laneErr = new Map([[lane, reason]])
  const units = ctxWindowUnits(s), fail = units.find((u) => /data-fail="lane"/.test(u.html))
  assert.ok(!units.some((u) => u.key === 'frames' || /aria-busy/.test(u.html)), 'no busy frame stands in for the failure')
  assert.ok(fail && /data-retry=/.test(fail.html), 'the failure carries Retry')
  assert.ok(fail.html.includes(reason), 'the reason is in the window')
  s.laneErr = new Map([['another lane', reason]])
  assert.ok(ctxWindowUnits(s).some((u) => u.key === 'frames'), "another lane's failure is not this step's")
})
