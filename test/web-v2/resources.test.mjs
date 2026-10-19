// test/web-v2/resources.test.mjs — the resource explorer's own suite (2.4): bad data degrades instead of throwing
// (#10: unknown kinds land in 「其他资源」 with the kind on hover, undated rows carry no step), the six display groups
// and the 「其他 N 项」 wrapper count their own entries (#1), the fidelity annotations of 只见到名字 (#3: no data-view,
// 「推测」 on the group, the ⓘ text), the two no-ledger sentences with the compaction group still drawn (#7), the
// out-of-closed-set note rides on the hover (never an inline parenthesis), and the < 1200 px fold line's N is the
// 读过的文件 group's own count — never a "0" standing in for absent records (1.2 §窄屏, invariant 4).
// String level over constructed lanes (the RFC's 「怎么跑」: no DOM, no server needed for these shapes).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resourcesHtml, renderResources } from '../../src/web/v2/replay/resources.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'

const ts = (i) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 5)).toISOString()
const calls = (n) => Array.from({ length: n }, (_, i) => ({ gi: i, ts: ts(i), ctx: 100 + i }))
const anchorOf = (o = {}) => ({ id: 'main', kind: 'main', calls: calls(6), giLocal: new Map(calls(6).map((c, i) => [c.gi, i])), seenFiles: [], events: [], ...o })
const ALL_OPEN = ['life-file', 'life-load', 'life-others', 'life-seen', 'life-cap', 'life-dl', 'life-comp', 'life-other']
const stateOf = (anchor, extra = {}) => ({ lanes: [anchor], anchor, anchorTs: anchor.calls.map((c) => Date.parse(c.ts)), view: { lo: 0, hi: anchor.calls.length }, playhead: 0, sawView: 'ctx', collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false, meta: { project_path: '/w/p' }, navOpen: new Set(ALL_OPEN), navSeenExpanded: false, ...extra })
// a group header's count, the way navGroupHtml writes it: <span class="navlbl">label</span><span class="navct">N</span>
const grpCount = (h, label) => { const m = h.match(new RegExp(`navlbl">${label}</span><span class="navct">(\\d+)</span>`)); return m ? +m[1] : null }

test('#10 bad data degrades, never throws: unknown kinds land in 其他资源 with the kind on hover; undated rows carry no step', () => {
  const anchor = anchorOf({ resources: [
    { kind: 'weird', label: 'w1' },                                                    // segments missing entirely
    { kind: 'weird2', label: null, segments: [] },                                     // segments empty AND label null
    { kind: 'file', label: '/w/p/a.mjs', segments: null },                             // KNOWN kind, unusable segments: joins no counted group
    { kind: 'weird3', label: 'w3', segments: [{ enter: 2, evict: null }] },            // unknown kind, dated
    { kind: 'file', label: '/w/p/b.mjs', segments: [{ enter: 1, evict: null }] },      // one good file
  ] })
  const h = resourcesHtml(stateOf(anchor)) // the first assertion is that this does not throw
  assert.equal(grpCount(h, W.RES_GRP.other), 3, 'the three unknown-kind rows land in 其他资源')
  for (const k of ['weird', 'weird2', 'weird3']) assert.match(h, new RegExp(`title="${k}"`), 'the kind raw value rides on the hover')
  assert.equal(grpCount(h, W.RES_GRP.file), 1, 'a known-kind file without usable segments joins no counted group')
  const undated = h.match(/<div class="navsub[^"]*"[^>]*title="weird2">[\s\S]*?<\/div>/)
  assert.ok(undated && !/data-navstep/.test(undated[0]), 'an undated row has no step to locate and no button claiming one')
  const dated = h.match(/<div class="navsub[^"]*"[^>]*title="weird3">[\s\S]*?<\/div>/)
  assert.ok(dated && /data-navstep="2"/.test(dated[0]), 'a dated unknown row locates its enter step')
})

test('the < 1200 px fold line: N is the file group\'s own count; no ledger or nothing countable → no number', () => {
  const barOf = (anchor) => {
    const bar = { textContent: '' }
    const el = { innerHTML: '' }
    renderResources(el, stateOf(anchor, { root: { querySelector: (sel) => (sel === '#rpbar' ? bar : null) } }))
    return { bar, h: el.innerHTML }
  }
  for (const a of [{ resources: null, resources_note: 'no-ledger' }, {}, { resources: [] }]) {
    assert.ok(!/\d/.test(barOf(anchorOf(a)).bar.textContent), 'nothing countable: no number, never a 0 standing in')
  }
  const mixed = barOf(anchorOf({ resources: [
    { kind: 'file', label: '/w/a.mjs', segments: [{ enter: 0, evict: null }] },
    { kind: 'file', label: '/w/b.mjs', segments: [{ enter: 1, evict: 2 }] },
    { kind: 'file', label: '/w/c.mjs' },                                        // unusable segments: neither the group nor the bar counts it
    { kind: 'capability', label: 'srv', segments: [{ enter: 0, evict: null }] },
  ] }))
  assert.match(mixed.bar.textContent, /\b2\b/)
  assert.equal(grpCount(mixed.h, W.RES_GRP.file), 2, 'the fold line and the group header count the same hasSeg-filtered set')
})

test('#1 the six groups count their own entries (one constructed lane)', () => {
  const anchor = anchorOf({
    resources: [
      { kind: 'file', label: '/w/p/a.mjs', segments: [{ enter: 0, evict: null }] },
      { kind: 'file', label: '/w/p/b.mjs', segments: [{ enter: 1, evict: null }] },
      { kind: 'scaffold', label: 'CLAUDE.md', segments: [{ enter: 0, evict: null }] },
      { kind: 'skill', label: 'build', loads: [], segments: [{ enter: 0, evict: null }] },
      { kind: 'capability', label: 'srv', segments: [{ enter: 0, evict: null }] },
      { kind: 'dir', label: '/w/p/src', segments: [{ enter: 0, evict: null }] },
      { kind: 'link', label: 'https://x/y', segments: [{ enter: 0, evict: null }] },
      { kind: 'weird3', label: 'w3', segments: [{ enter: 2, evict: null }] },
    ],
    seenFiles: [{ path: '/w/p/s1.md', count: 1, firstStep: 1 }, { path: '/w/p/s2.md', count: 2, firstStep: 2 }, { path: '/w/p/s3.md', count: 1, firstStep: 3 }],
    events: [{ type: 'compaction', step: 2, from: 10, to: 3 }, { type: 'summarize', step: 3, out: 1200 }],
  })
  const h = resourcesHtml(stateOf(anchor))
  assert.equal(grpCount(h, W.RES_GRP.file), 2)
  assert.equal(grpCount(h, W.RES_GRP.load), 1)
  assert.equal(grpCount(h, `${W.RES_GRP.seen} · ${W.GUESS}`), 3)
  assert.equal(grpCount(h, W.RES_GRP.cap), 2, 'skill + capability together')
  assert.equal(grpCount(h, W.RES_GRP.dl), 2, 'dir + link together')
  assert.equal(grpCount(h, W.RES_GRP.comp), 2, 'compaction + summarize events')
  assert.equal(grpCount(h, W.RES_GRP.other), 1)
})

test('#3 a names-only chip never opens content and locates its first step', () => {
  const anchor = anchorOf({ resources: [], seenFiles: [{ path: '/w/p/seen.md', count: 2, firstStep: 1 }] })
  const h = resourcesHtml(stateOf(anchor))
  const chip = h.match(/<span class="navchip[^"]*"[^>]*>/)[0]
  assert.ok(!/data-view/.test(chip), 'a names-only chip has no view affordance — there is no content behind it')
  assert.match(chip, /data-navstep="1"/)
})

test('#7 the compaction group still draws with no ledger and with an empty one', () => {
  const comps = [{ type: 'compaction', step: 2, from: 10, to: 3 }]
  const noLedger = resourcesHtml(stateOf(anchorOf({ resources: null, resources_note: 'no-ledger', events: comps })))
  assert.equal(grpCount(noLedger, W.RES_GRP.comp), 1, 'compaction events still draw with no ledger')
  assert.equal(grpCount(noLedger, W.RES_GRP.file), null, 'no empty groups are drawn')
  const empty = resourcesHtml(stateOf(anchorOf({ resources: [], events: comps })))
  assert.equal(grpCount(empty, W.RES_GRP.comp), 1, 'compaction events still draw with an empty ledger')
})

test('a note outside the closed set rides on the hover — never an inline parenthesis', () => {
  const odd = resourcesHtml(stateOf(anchorOf({ resources: null, resources_note: 'odd-code' })))
  assert.match(odd, /class="navwhy" title="odd-code">/, 'the raw note is the hover')
  assert.equal((odd.match(/odd-code/g) || []).length, 1, 'it appears exactly once — no second, visible copy')
  const closed = resourcesHtml(stateOf(anchorOf({ resources: null, resources_note: 'no-ledger' })))
  assert.match(closed, /class="navwhy">/, 'the closed-set code adds no hover')
  const none = resourcesHtml(stateOf(anchorOf({ resources: null })))
  assert.match(none, /class="navwhy">/, 'no note key: no hover')
})
