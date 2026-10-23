// test/web-v2/outline.test.mjs — the left outline (2.5): three groups (no counts: 2.5 §只做导航), the 「跳到变化处」 row gated by
// the window's own 变化线 predicate, the query rows' 「第 N 步起」 pairing and 「推测」 mark, and the B-split (resources never
// appear here). String level over constructed states; the jump-source identity (data-jumpfi ↔ the window's data-bi)
// is guarded by the test of that name below.
import test from 'node:test'
import assert from 'node:assert/strict'
import { outlineHtml, outlineEntries, queryStepLabels, wireOutline, jumpToAnchor } from '../../src/web/v2/replay/outline.mjs'
import { resourcesHtml } from '../../src/web/v2/replay/resources.mjs'
import { humanTurns, messageTurns } from '../../src/web/v2/replay/analysis.mjs'
import { openTurnFor, renderContextWindow } from '../../src/web/v2/replay/ctxwin.mjs'
import { turnIsOpen } from '../../src/web/v2/replay/fold.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { stepOf, createDesk, applySession } from '../../src/web/v2/replay/model.mjs'
import { createJumpQueue, anchorJump } from '../../src/web/v2/replay/jump.mjs'
import { deskOf, world, readLane } from './desk-world.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const blk = (o) => ({ sec: 'messages', kind: 'text', role: 'user', bytes: 10, chars: 10, key: 'k' + Math.random(), head: { role: 'user', tag: 'user', label: 'x' }, ...o })
const sys = (o) => ({ sec: 'system', kind: 'system', role: 'system', chars: 1200, key: 's' + Math.random(), label: '环境', head: { role: 'system', tag: 'def', label: '' }, ...o })
const tool = (o) => ({ sec: 'tools', kind: 'def', role: '', name: 'read_file', key: 't' + Math.random(), head: { role: '', tag: 'def', label: '' }, ...o })
// a renderer state over a desk: `lanes` as deskOf takes them, the playhead on the anchor lane's step `playhead`
const deskState = (lanes, { events, playhead = 0, ...extra } = {}) => {
  const desk = deskOf(lanes, { events })
  const ls = buildLanes(desk), anchor = anchorLane(ls)
  return { desk, lanes: ls, anchor, playhead, navOpen: new Set(['tools', 'sys', 'msg']), ...extra }
}
const stateOf = (flat, extra = {}) => deskState([{ kind: 'main', rows: [{}], blocks: [flat] }], extra)

test('a system row carries its size from the input; a tool row is a name, never a schema', () => {
  const flat = [tool({ schema: '{"type":"object"}' }), sys({ cc: { kind: 'ephemeral' } }), sys({ label: 'v', volatile: true })]
  const h = outlineHtml(stateOf(flat))
  assert.match(h, /1\.2k/) // 1200 chars from the input
  assert.ok(!/schema|type":"object/.test(h), 'a tool row is a navigation name; the schema lives in the window')
})

test('「跳到变化处」 appears iff the window draws the 变化线 (the one predicate), and it targets #cachebrk', () => {
  const mk = (row, held = true) => deskState([{ kind: 'main', rows: [row], ...(held ? { blocks: [[blk()]] } : {}) }])
  const changed = { cacheBreak: { cause: 'content-changed', idx: 0 } }
  const J = /data-jump="cachebrk"/
  assert.match(outlineHtml(mk(changed)), J)
  assert.ok(!J.test(outlineHtml(mk({ cacheBreak: { cause: 'append' } }))))
  assert.match(outlineHtml(mk({ ...changed, error: 'x' })), J, 'a failed step keeps the line: the 变化线 speaks about content')
  // a step whose lane is not held is still judged by cause (2.5 Edge case): the click queues the jump and waits for the lane
  assert.match(outlineHtml(mk({ ...changed, tools: 3 }, false)), J, 'unheld + content-changed keeps the row')
  assert.ok(!J.test(outlineHtml(mk({ cacheBreak: { cause: 'append' }, tools: 3 }, false))), 'a quiet-cause unheld step does not')
  // a body that can NEVER arrive draws a control that cannot work: the row stays off (jumpDecision drops those)
  assert.ok(!J.test(outlineHtml(mk({ ...changed, unparsed: true }, false))), 'unparsed: no blocks will ever land')
  assert.ok(!J.test(outlineHtml(mk({ ...changed, rec: null }, false))), 'no request: nothing to land on')
})

// ── the jump into a folded turn (2.5 验收 #2 second half: a reader's click writes the fold memory) ───────────────────
test('openTurnFor: a click into an explicitly folded card opens it AND writes the D12 memory; the automatic landing still loses to an explicit fold', () => {
  const qA = blk({ query: '第一问', key: 'a1' }), midA = blk({ role: 'assistant', kind: 'text', key: 'a2' }), qB = blk({ query: '第二问', key: 'b1' })
  const flat = [sys({ key: 's' }), qA, midA, qB, blk({ key: 'b2' })]
  let persisted = 0
  const s = stateOf(flat, { openBlocks: new Set(), turnFold: new Map([['a1', false]]), turnLanded: new Set(), persistFold: () => persisted++ })
  const el = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null, querySelectorAll: () => [] }
  renderContextWindow(el, s) // the desk has already painted this step and run its landing
  assert.match(el._h, /class="cwturn collapsed" data-anchor="a1"/, 'the reader folded the first card; the fold memory keeps it shut')
  assert.equal(openTurnFor(el, s, 1), true, 'fi 1 (第一问) lives in that folded card: the outline click opens it')
  assert.equal(s.turnFold.get('a1'), true, 'the open is written to the D12 fold memory (2.5 §跳转联动), not the ephemeral set')
  assert.equal(persisted, 1, 'and persisted')
  assert.equal(s.turnLanded.size, 0, 'the ephemeral set stays for the automatic landing only')
  assert.match(el._h, /class="cwturn " data-anchor="a1"/, 'the window repainted with the card open — the block can be scrolled to')
  assert.equal(openTurnFor(el, s, 3), false, 'a block in the (default-open) latest card: nothing to open')
  assert.equal(persisted, 1, 'and nothing further persisted')
  // the automatic landing on the same key WITHOUT a user click still respects the explicit fold (1.4's rule)
  const t0 = messageTurns(flat)[0]
  assert.equal(turnIsOpen(new Map([['a1', false]]), flat, t0, 0, 1, new Set(['a1'])), false, 'an explicit fold beats the ephemeral landed set')
})

test('query rows: 「第 N 步起」 pairs from the last, a mismatch kills it and every earlier one', () => {
  const flat = [blk({ query: '第一问,稍微长一点的问题文字' }), blk({ query: '第二问' }), blk({ query: '第三问' })]
  const lanes = [{ kind: 'main', rows: [{}, {}, {}], blocks: [[], [], flat] }]
  const ev = (i, preview) => ({ type: 'user', rid: `R0-${i}`, k: i + 1, preview })
  // the main lane's `lane` answer carries the user events with their preview (2.5:16)
  const held = (ls, events) => ls.map((l, i) => (i ? l : { ...l, events }))
  // events pair from the LAST backwards; the middle preview does not prefix-match → it and the first stay unnumbered
  let s = deskState(held(lanes, [ev(0, '第一问,稍微长一点的问题文字'), ev(1, '完全不相关的另一段'), ev(2, '第三问')]), { playhead: 2 })
  assert.deepEqual(queryStepLabels(s, humanTurns(stepOf(s.desk, 'R0-2').flat)), [null, null, { n: 3, rid: 'R0-2' }], 'a failed pair kills its own and every earlier number')
  s = deskState(held(lanes, [ev(0, '第一问,稍微长一点的问题文字'), ev(1, '第二问'), ev(2, '第三问')]), { playhead: 2, navOpen: new Set(['msg']) })
  assert.deepEqual(queryStepLabels(s, humanTurns(stepOf(s.desk, 'R0-2').flat)).map((x) => x && x.n), [1, 2, 3], 'N = stepRef(event.rid)')
  assert.match(outlineHtml(s), /data-jumprid="R0-0"/)
  // an event after the playhead's step is not counted: on step 2 only two events precede, so only the last two rows pair
  const s1 = deskState(held([{ kind: 'main', rows: [{}, {}, {}], blocks: [[], flat, []] }], [ev(0, '第二问'), ev(1, '第三问'), ev(2, 'later')]), { playhead: 1 })
  assert.deepEqual(queryStepLabels(s1, humanTurns(flat)).map((x) => x && x.n), [null, 1, 2])
  // no user events → no numbers
  assert.ok(!/data-jumprid/.test(outlineHtml(deskState(lanes, { playhead: 2, navOpen: new Set(['msg']) }))))
  // not the main lane → never numbered
  assert.deepEqual(queryStepLabels({ ...s, anchor: { ...s.anchor, kind: 'aux' } }, humanTurns(flat)), [])
})

test('B-split: the outline carries only this step\'s entries; resource groups live on the right page', () => {
  const flat = [tool(), sys(), blk({ query: 'q' })]
  const s = deskState([{ kind: 'main', rows: [{}], blocks: [flat], resources: [{ kind: 'file', label: '/w/a.mjs', segments: [{ enter: 'R0-0', evict: null }] }] }],
    { navOpen: new Set(['tools', 'sys', 'msg', 'life-file']) })
  const h = outlineHtml(s)
  assert.ok(!/a\.mjs|data-rk/.test(h), 'no resource rows in #ctxnav')
  assert.match(resourcesHtml(s), /a\.mjs/)
})

test('a step with no call clears the column', () => {
  assert.equal(outlineHtml({ anchor: null, lanes: [] }), '')
})

test('outlineEntries is the one table any narrow-screen dropdown would draw from', () => {
  const flat = [tool(), blk({ query: 'q' })]
  const e = outlineEntries(stateOf(flat))
  assert.deepEqual(e.groups.map((g) => g.key), ['tools', 'sys', 'msg'])
  assert.deepEqual(e.groups[0].kids.map((k) => k.label), ['read_file'])
})

// ── keyboard reachability (2.5 前置定义: 子条键盘可达) ──────────────────────────────────────────────────────────────────
test('every interactive outline row is focusable and Enter/Space route through the click dispatch', () => {
  const flat = [tool(), sys(), blk({ query: '改一下' })]
  const h = outlineHtml(stateOf(flat))
  // group heads, tools/sys/msg rows, 跳到变化处 and 第 N 步起 all carry role="button" tabindex="0"
  const rows = h.match(/<(?:div|span)[^>]*>/g) || []
  const interactive = rows.filter((tag) => /data-navtoggle=|data-jumpfi=|data-jump=|data-jumprid=/.test(tag))
  assert.ok(interactive.length, 'the fixture renders interactive rows')
  for (const tag of interactive) { assert.match(tag, /role="button"/, tag); assert.match(tag, /tabindex="0"/, tag) }
  // wiring: keydown Enter/Space dispatch exactly like a click; other keys do nothing
  const handlers = {}
  const el = { addEventListener: (t, fn) => { handlers[t] = fn }, removeEventListener: () => {} }
  const acts = []
  const s = deskState([{ kind: 'main', rows: [{}, {}], blocks: [flat, flat] }],
    { renderNav: () => acts.push('render'), jumpTo: (i) => acts.push(['jumpTo', i]), queueJump: (j) => acts.push(['queue', j]) })
  wireOutline(el, s)
  const target = (sel, data) => ({ closest: (q) => (q === sel ? { dataset: data } : null) })
  handlers.keydown({ key: 'Enter', target: target('[data-navtoggle]', { navtoggle: 'tools' }) })
  assert.ok(!s.navOpen.has('tools'), 'Enter closes the group'); assert.deepEqual(acts[0], 'render')
  handlers.keydown({ key: ' ', target: target('[data-jump]', { jump: 'cachebrk' }) })
  assert.deepEqual(acts[1], ['queue', { kind: 'anchor', id: 'cachebrk' }], 'Space runs 跳到变化处 through queueJump')
  handlers.keydown({ key: 'Enter', target: target('[data-jumprid]', { jumprid: 'R0-1' }) })
  assert.deepEqual(acts[2], ['jumpTo', 1], 'Enter on 第 N 步起 moves the playhead to that rid\'s step')
  handlers.keydown({ key: 'a', target: target('[data-navtoggle]', { navtoggle: 'tools' }) })
  assert.equal(acts.length, 3, 'other keys are ignored')
  assert.ok(handlers.click, 'the click dispatch stays wired for the mouse')
})

// ── the jump-source identity (2.5 验收 #2: 点条必落对块 — data-jumpfi ⊆ the window's data-bi) ─────────────────────────
test('jump-source identity: every data-jumpfi names a block the window actually drew (.cblk[data-bi])', () => {
  const flat = [tool(), tool({ name: 'grep' }), sys(), blk({ query: '第一问' }), blk({ role: 'assistant', kind: 'text', query: null })]
  const s = stateOf(flat, { openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), diffRef: null })
  const outline = outlineHtml(s)
  const win = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null, querySelectorAll: () => [] }
  renderContextWindow(win, s)
  const inWindow = new Set([...win.innerHTML.matchAll(/data-bi="(\d+)"/g)].map((m) => +m[1]))
  const jumps = [...outline.matchAll(/data-jumpfi="(\d+)"/g)].map((m) => +m[1])
  assert.ok(jumps.length, 'the fixture yields jump rows')
  for (const j of jumps) assert.ok(inWindow.has(j), `data-jumpfi=${j} must be a .cblk[data-bi] the window drew`)
})


// A4 (1.5 motion): a jump scrolls instantly under prefers-reduced-motion, smoothly otherwise
test('an outline jump honours prefers-reduced-motion', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'matchMedia'), prev = globalThis.matchMedia
  try {
    for (const reduce of [true, false]) {
      globalThis.matchMedia = (q) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q) })
      let arg = null
      const target = { scrollIntoView: (o) => { arg = o }, classList: { add() {}, remove() {} } }
      const s = { root: { querySelector: (sel) => (sel === '#x1' ? target : null) } }
      jumpToAnchor(s, 'x1')
      assert.equal(arg && arg.behavior, reduce ? 'auto' : 'smooth')
    }
  } finally { if (had) globalThis.matchMedia = prev; else delete globalThis.matchMedia }
})

// ── 2.5 #2 (lane-wait half): a jump to a step whose lane is not held waits for the lane, runs once, and a reader move drops it
test('A25 jump waits for the target lane: not held → wait; held → run once; a reader move in between → dropped', async () => {
  for (const seed of [3, 11, 29]) {
    const w = world(seed), get = w.get(), desk = createDesk()
    applySession(desk, await get('session', { id: 'S' })) // the skeleton only: no lane held
    const [key, rids] = [...desk.laneRids].find(([, r]) => r.length > 1)
    let playhead = rids.at(-1)
    const done = []
    const q = createJumpQueue({ getPlayhead: () => playhead, getCall: () => desk.rows.get(playhead), getHeld: () => stepOf(desk, playhead).held, perform: (j) => done.push(j) })
    q.queue(playhead, anchorJump('cachebrk'))
    assert.equal(done.length, 0, 'the lane is not held: the jump waits')
    assert.ok(q.pending(), 'and is kept')
    await readLane(get, 'S', desk, { lane: key })
    q.settle(); q.settle()
    assert.deepEqual(done, [{ kind: 'anchor', id: 'cachebrk' }], 'held: it runs exactly once')
    // a reader move before the next lane lands drops the waiting jump
    const other = [...desk.laneRids.keys()].find((k) => k !== key)
    if (!other) continue
    playhead = desk.laneRids.get(other).at(-1)
    q.queue(playhead, anchorJump('cachebrk'))
    playhead = rids[0] // the reader moved
    await readLane(get, 'S', desk, { lane: other })
    q.settle()
    assert.equal(done.length, 1, 'dropped: the playhead left its step')
    assert.equal(q.pending(), null)
  }
})

// ── 2.5 #9: the outline on a step whose lane is not held, and the same step once held ──────────────────────────────────
test('A26 an unheld step: the tool count is the row\'s, the other groups are busy rows (no words, no 0, no control); held → its blocks', () => {
  const ALL = new Set(['tools', 'sys', 'msg'])
  for (let tools = 1; tools <= 4; tools++) {
    const flat = [...Array.from({ length: tools }, (_, i) => tool({ name: `t${i}` })), sys(), blk({ query: 'q' + tools })]
    const rows = [{ tools }, { tools }]
    const unheld = outlineHtml(deskState([{ kind: 'main', rows }], { playhead: 1, navOpen: ALL }))
    assert.equal(+(unheld.match(/data-tools="(\d+)"/) || [])[1], tools, 'the tool count is the skeleton row\'s `tools`')
    const busy = [...unheld.matchAll(/<div[^>]*aria-busy="true"[^>]*>([\s\S]*?)<\/div>/g)]
    assert.equal(busy.length, 2, 'the system and query groups each hold a busy row')
    for (const b of busy) assert.equal(b[1], '', 'a busy row has no text and no element in it')
    assert.ok(!/data-tools="0"|class="navct">0</.test(unheld), 'no count renders 0')
    assert.ok(!/data-jumpfi/.test(unheld), 'no block row before the blocks are there')
    const held = outlineHtml(deskState([{ kind: 'main', rows, blocks: [flat, flat] }], { playhead: 1, navOpen: ALL }))
    assert.ok(!/aria-busy/.test(held), 'held: no busy row')
    assert.equal((held.match(/data-jumpfi=/g) || []).length, tools + 2, 'held: every tool, the system block and the query are listed')
  }
})
