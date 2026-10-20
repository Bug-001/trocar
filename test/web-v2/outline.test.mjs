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

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const blk = (o) => ({ sec: 'messages', kind: 'text', role: 'user', bytes: 10, chars: 10, key: 'k' + Math.random(), head: { role: 'user', tag: 'user', label: 'x' }, ...o })
const sys = (o) => ({ sec: 'system', kind: 'system', role: 'system', chars: 1200, key: 's' + Math.random(), label: '环境', head: { role: 'system', tag: 'def', label: '' }, ...o })
const tool = (o) => ({ sec: 'tools', kind: 'def', role: '', name: 'read_file', key: 't' + Math.random(), head: { role: '', tag: 'def', label: '' }, ...o })
const stateOf = (flat, extra = {}) => {
  const anchor = { id: 'main', kind: 'main', calls: [{ gi: 0, ts: ts(0), flat, rec: { request: {} } }], giLocal: new Map([[0, 0]]), events: [], resources: [], callsLength: 1 }
  return { anchor, lanes: [anchor], playhead: 0, curFlat: flat, navOpen: new Set(['tools', 'sys', 'msg']), ...extra }
}

test('a system row carries its size from the input; a tool row is a name, never a schema', () => {
  const flat = [tool({ schema: '{"type":"object"}' }), sys({ cc: { kind: 'ephemeral' } }), sys({ label: 'v', volatile: true })]
  const h = outlineHtml(stateOf(flat))
  assert.match(h, /1\.2k/) // 1200 chars from the input
  assert.ok(!/schema|type":"object/.test(h), 'a tool row is a navigation name; the schema lives in the window')
})

test('「跳到变化处」 appears iff the window draws the 变化线 (the one predicate), and it targets #cachebrk', () => {
  const changed = { cacheBreak: { cause: 'content-changed', idx: 0 }, flat: [blk()], rec: { request: {} }, ts: ts(0), gi: 0 }
  const quiet = { cacheBreak: { cause: 'append' }, flat: [blk()], rec: { request: {} }, ts: ts(0), gi: 0 }
  const mk = (call) => ({ anchor: { id: 'main', kind: 'main', calls: [call] }, lanes: [], playhead: 0, curFlat: call.flat, navOpen: new Set() })
  const J = /data-jump="cachebrk"/
  assert.match(outlineHtml(mk(changed)), J)
  assert.ok(!J.test(outlineHtml(mk(quiet))))
  const failed = { ...changed, error: 'x' } // a failed step keeps the line: the 变化线 speaks about content
  assert.match(outlineHtml(mk(failed)), J)
  // a body off this page is still judged by cause (2.5 Edge case): the click queues the jump and waits for the page
  const paged = { cacheBreak: { cause: 'content-changed', idx: 0 }, flat: [], paged_out: true, tools: 3, rec: { request: {} }, ts: ts(0), gi: 0 }
  assert.match(outlineHtml(mk(paged)), J, 'paged-out + content-changed keeps the row')
  assert.ok(!J.test(outlineHtml(mk({ ...paged, cacheBreak: { cause: 'append' } }))), 'a quiet-cause paged step does not')
  // a body that can NEVER arrive draws a control that cannot work: the row stays off (jumpDecision drops those)
  assert.ok(!J.test(outlineHtml(mk({ ...paged, unparsed: true }))), 'unparsed: no page will ever land')
  assert.ok(!J.test(outlineHtml(mk({ ...paged, rec: null }))), 'no request: nothing to land on')
})

// ── the jump into a folded turn (2.5 验收 #2 second half: a reader's click writes the fold memory) ───────────────────
test('openTurnFor: a click into an explicitly folded card opens it AND writes the D12 memory; the automatic landing still loses to an explicit fold', () => {
  const qA = blk({ query: '第一问', key: 'a1' }), midA = blk({ role: 'assistant', kind: 'text', key: 'a2' }), qB = blk({ query: '第二问', key: 'b1' })
  const flat = [sys({ key: 's' }), qA, midA, qB, blk({ key: 'b2' })]
  const anchor = { id: 'main', kind: 'main', calls: [{ gi: 0, ts: ts(0), flat, rec: { request: {} }, cacheBreak: { idx: 4, cause: 'append', firstCall: false } }], giLocal: new Map([[0, 0]]), events: [], resources: [] }
  let persisted = 0
  const s = { anchor, lanes: [anchor], playhead: 0, curFlat: flat, navOpen: new Set(), openBlocks: new Set(), turnFold: new Map([['a1', false]]), turnLanded: new Set(), persistFold: () => persisted++ }
  const el = { _h: '', set innerHTML(v) { this._h = v }, get innerHTML() { return this._h }, querySelector: () => null, querySelectorAll: () => [] }
  renderContextWindow(el, s) // the desk has already painted this step and run its landing
  assert.match(el._h, /class="cwturn collapsed" data-turn="0" data-anchor="a1"/, 'the reader folded the first card; the fold memory keeps it shut')
  assert.equal(openTurnFor(el, s, 1), true, 'fi 1 (第一问) lives in that folded card: the outline click opens it')
  assert.equal(s.turnFold.get('a1'), true, 'the open is written to the D12 fold memory (2.5 §跳转联动), not the ephemeral set')
  assert.equal(persisted, 1, 'and persisted')
  assert.equal(s.turnLanded.size, 0, 'the ephemeral set stays for the automatic landing only')
  assert.match(el._h, /class="cwturn " data-turn="0" data-anchor="a1"/, 'the window repainted with the card open — the block can be scrolled to')
  assert.equal(openTurnFor(el, s, 3), false, 'a block in the (default-open) latest card: nothing to open')
  assert.equal(persisted, 1, 'and nothing further persisted')
  // the automatic landing on the same key WITHOUT a user click still respects the explicit fold (1.4's rule)
  const t0 = messageTurns(flat)[0]
  assert.equal(turnIsOpen(new Map([['a1', false]]), flat, t0, 0, 1, new Set(['a1'])), false, 'an explicit fold beats the ephemeral landed set')
})

test('query rows: 「第 N 步起」 pairs from the last, a mismatch kills it and every earlier one', () => {
  const flat = [blk({ query: '第一问,稍微长一点的问题文字' }), blk({ query: '第二问' }), blk({ query: '第三问' })]
  const anchor = { id: 'main', kind: 'main', calls: [{ gi: 5, ts: ts(0), flat, rec: {} }], giLocal: new Map([[0, 0]]), events: [], resources: [] } // the playhead's gi covers the earlier events
  const s = { anchor, lanes: [anchor], playhead: 0, curFlat: flat, navOpen: new Set(['msg']) }
  // events pair from the LAST backwards; the middle preview does not prefix-match → it and the first stay unnumbered
  const events = [{ type: 'user', step: 0, preview: '第一问,稍微长一点的问题文字' }, { type: 'user', step: 0, preview: '完全不相关的另一段' }, { type: 'user', step: 0, preview: '第三问' }]
  anchor.events = events
  const labels = queryStepLabels(s, humanTurns(flat))
  assert.deepEqual(labels, [null, null, { n: 1, gi: 0 }], 'a failed pair kills its own and every earlier number')
  anchor.events = [{ type: 'user', step: 0, preview: '第一问,稍微长一点的问题文字' }, { type: 'user', step: 2, preview: '第二问' }, { type: 'user', step: 5, preview: '第三问' }]
  anchor.giLocal = new Map([[0, 0], [2, 1], [5, 2]]) // the events' steps are global gis (1.2 §编号)
  const ok = queryStepLabels(s, humanTurns(flat))
  assert.deepEqual(ok.map((x) => x && x.n), [1, 2, 3])
  assert.match(outlineHtml(s), /data-jumpgi="0"/)
  // no user events → no numbers
  anchor.events = []
  assert.ok(!/data-jumpgi/.test(outlineHtml(s)))
  // not the main lane → never numbered
  assert.deepEqual(queryStepLabels({ ...s, anchor: { ...anchor, kind: 'aux' } }, humanTurns(flat)), [])
})

test('B-split: the outline carries only this step\'s entries; resource groups live on the right page', () => {
  const flat = [tool(), sys(), blk({ query: 'q' })]
  const anchor = { id: 'main', kind: 'main', calls: [{ gi: 0, ts: ts(0), flat, rec: {} }], giLocal: new Map([[0, 0]]), events: [], resources: [{ kind: 'file', label: '/w/a.mjs', segments: [{ enter: 0, evict: null }] }], seenFiles: [] }
  const s = { anchor, lanes: [anchor], playhead: 0, curFlat: flat, navOpen: new Set(['tools', 'sys', 'msg', 'life-file']) }
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
  const interactive = rows.filter((tag) => /data-navtoggle=|data-jumpfi=|data-jump=|data-jumpgi=/.test(tag))
  assert.ok(interactive.length, 'the fixture renders interactive rows')
  for (const tag of interactive) { assert.match(tag, /role="button"/, tag); assert.match(tag, /tabindex="0"/, tag) }
  // wiring: keydown Enter/Space dispatch exactly like a click; other keys do nothing
  const handlers = {}
  const el = { addEventListener: (t, fn) => { handlers[t] = fn }, removeEventListener: () => {} }
  const acts = []
  const anchor = { id: 'main', kind: 'main', calls: [{ gi: 0, ts: ts(0), flat, rec: {} }, { gi: 3, ts: ts(3), flat, rec: {} }], giLocal: new Map([[0, 0], [3, 1]]), events: [], resources: [] }
  const s = { anchor, lanes: [anchor], playhead: 0, curFlat: flat, navOpen: new Set(['tools', 'sys', 'msg']),
    renderNav: () => acts.push('render'), jumpTo: (i) => acts.push(['jumpTo', i]), queueJump: (j) => acts.push(['queue', j]) }
  wireOutline(el, s)
  const target = (sel, data) => ({ closest: (q) => (q === sel ? { dataset: data } : null) })
  handlers.keydown({ key: 'Enter', target: target('[data-navtoggle]', { navtoggle: 'tools' }) })
  assert.ok(!s.navOpen.has('tools'), 'Enter closes the group'); assert.deepEqual(acts[0], 'render')
  handlers.keydown({ key: ' ', target: target('[data-jump]', { jump: 'cachebrk' }) })
  assert.deepEqual(acts[1], ['queue', { kind: 'anchor', id: 'cachebrk' }], 'Space runs 跳到变化处 through queueJump')
  handlers.keydown({ key: 'Enter', target: target('[data-jumpgi]', { jumpgi: '3' }) })
  assert.deepEqual(acts[2], ['jumpTo', 1], 'Enter on 第 N 步起 moves the playhead (stepRef gi 3 → step 2 → index 1)')
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
