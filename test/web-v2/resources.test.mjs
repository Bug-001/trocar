// test/web-v2/resources.test.mjs — the resource explorer's own suite (2.4): bad data degrades instead of throwing
// (#10: unknown kinds land in 「其他资源」 with the kind on hover, undated rows carry no step), the six display groups
// and the 「其他 N 项」 wrapper count their own entries (#1), the fidelity annotations of 只见到名字 (#3: no data-view,
// 「推测」 on the group, the ⓘ text), an empty ledger with the compaction group still drawn (#7), and the < 1200 px fold
// line's N is the 读过的文件 group's own count — never a "0" standing in for absent records (1.2 §窄屏, invariant 4).
// String level over desk-model states: the ledger is the anchor lane's `lane` answer as the desk holds it (desk-world.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resourcesHtml, renderResources } from '../../web/legacy/replay/resources.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'
import { relPath } from '../../web/legacy/replay/analysis.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { deskOf } from './desk-world.mjs'
import { applyLane, applyLedger, seenFiles } from '../../web/legacy/replay/model.mjs'

// the main lane's six rows are R0-0 … R0-5 (deskOf); `ledger` is its lane answer's {resources, seen, events}
const R = (i) => `R0-${i}`
const anchorOf = ({ resources = [], ...ledger } = {}) => ({ kind: 'main', rows: Array.from({ length: 6 }, () => ({})), blocks: Array.from({ length: 6 }, () => []),
  resources: resources.map((r) => ({ key: `${r.kind}:${r.label}`, ...r })), ...ledger })
const ALL_OPEN = ['life-file', 'life-load', 'life-others', 'life-seen', 'life-cap', 'life-dl', 'life-comp', 'life-other']
const stateOf = (lane, extra = {}) => {
  const desk = deskOf([lane]), lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return { desk, lanes, anchor, anchorTs: anchor.calls.map((c) => Date.parse(c.ts)), view: { lo: 0, hi: anchor.calls.length }, playhead: 0, sawView: 'ctx', collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false, meta: { project_path: '/w/p' }, navOpen: new Set(ALL_OPEN), navSeenExpanded: false, ...extra }
}
// a group header's count, the way navGroup writes it: <span class="navlbl">label</span><span class="navct">N</span>
const grpCount = (h, label) => { const m = h.match(new RegExp(`navlbl">${label}</span><span class="navct">(\\d+)</span>`)); return m ? +m[1] : null }

test('#10 bad data degrades, never throws: unknown kinds land in 其他资源 with the kind on hover; undated rows carry no step', () => {
  const anchor = anchorOf({ resources: [
    { kind: 'weird', label: 'w1' },                                                  // segments missing entirely
    { kind: 'weird2', label: null, segments: [] },                                     // segments empty AND label null
    { kind: 'file', label: '/w/p/a.mjs', segments: null },                             // KNOWN kind, unusable segments: joins no counted group
    { kind: 'weird3', label: 'w3', segments: [{ enter: R(2), evict: null }] },            // unknown kind, dated
    { kind: 'file', label: '/w/p/b.mjs', segments: [{ enter: R(1), evict: null }] },      // one good file
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
  for (const a of [{}, { resources: [] }]) {
    assert.ok(!/\d/.test(barOf(anchorOf(a)).bar.textContent), 'nothing countable: no number, never a 0 standing in')
  }
  const mixed = barOf(anchorOf({ resources: [
    { kind: 'file', label: '/w/a.mjs', segments: [{ enter: R(0), evict: null }] },
    { kind: 'file', label: '/w/b.mjs', segments: [{ enter: R(1), evict: R(2) }] },
    { kind: 'file', label: '/w/c.mjs' },                                        // unusable segments: neither the group nor the bar counts it
    { kind: 'capability', label: 'srv', segments: [{ enter: R(0), evict: null }] },
  ] }))
  assert.match(mixed.bar.textContent, /\b2\b/)
  assert.equal(grpCount(mixed.h, W.RES_GRP.file), 2, 'the fold line and the group header count the same hasSeg-filtered set')
})

test('#1 the six groups count their own entries (one constructed lane)', () => {
  const anchor = anchorOf({
    resources: [
      { kind: 'file', label: '/w/p/a.mjs', segments: [{ enter: R(0), evict: null }] },
      { kind: 'file', label: '/w/p/b.mjs', segments: [{ enter: R(1), evict: null }] },
      { kind: 'scaffold', label: 'CLAUDE.md', segments: [{ enter: R(0), evict: null }] },
      { kind: 'skill', label: 'build', loads: [], segments: [{ enter: R(0), evict: null }] },
      { kind: 'capability', label: 'srv', segments: [{ enter: R(0), evict: null }] },
      { kind: 'dir', label: '/w/p/src', segments: [{ enter: R(0), evict: null }] },
      { kind: 'link', label: 'https://x/y', segments: [{ enter: R(0), evict: null }] },
      { kind: 'weird3', label: 'w3', segments: [{ enter: R(2), evict: null }] },
    ],
    seen: [{ path: '/w/p/s1.md', count: 1, firstRid: R(1) }, { path: '/w/p/s2.md', count: 2, firstRid: R(2) }, { path: '/w/p/s3.md', count: 1, firstRid: R(3) }],
    events: [{ type: 'compaction', rid: R(2), from: 10, to: 3 }, { type: 'summarize', rid: R(3), out: 1200 }],
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
  const anchor = anchorOf({ resources: [], seen: [{ path: '/w/p/seen.md', count: 2, firstRid: R(1) }] })
  const h = resourcesHtml(stateOf(anchor))
  const chip = h.match(/<span class="navchip[^"]*"[^>]*>/)[0]
  assert.ok(!/data-view/.test(chip), 'a names-only chip has no view affordance — there is no content behind it')
  assert.match(chip, /data-navstep="1"/)
})

test('#7 the compaction group still draws with an empty ledger', () => {
  const comps = [{ type: 'compaction', rid: R(2), from: 10, to: 3 }]
  const empty = resourcesHtml(stateOf(anchorOf({ resources: [], events: comps })))
  assert.equal(grpCount(empty, W.RES_GRP.comp), 1, 'compaction events still draw with an empty ledger')
  assert.equal(grpCount(empty, W.RES_GRP.file), null, 'no empty groups are drawn')
})

// 2.4 element table: a long path is cut in the middle — the base name stays whole, the length fits unless the base
// name alone is longer
test('midClip keeps the base name whole and fits max unless the base name alone is longer', async () => {
  const { midClip } = await import('../../web/legacy/replay/analysis.mjs')
  let seed = 7
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let t = 0; t < 400; t++) {
    const depth = 1 + rnd(8)
    const segs = Array.from({ length: depth }, () => 'abcdefghij'.repeat(4).slice(0, 1 + rnd(40)))
    const path = (rnd(2) ? '/' : '') + segs.join('/')
    const max = 20 + rnd(41)
    const out = midClip(path, max)
    const base = segs[segs.length - 1]
    assert.ok(out.endsWith(base), `${path} → ${out}`)
    if (base.length <= max) assert.ok(out.length <= max, `${path} @${max} → ${out}`)
    if (path.length <= max) assert.equal(out, path)
  }
})

test('#3 a seen-name chip\'s hover holds the full project-relative path, escaped once', () => {
  const cwd = '/w/p'
  const decode = (t) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const odd of ['&', '<', '>', '"', 'a&amp;b', '']) for (const depth of [1, 4, 9]) {
    const path = `${cwd}/${Array.from({ length: depth }, (_, i) => `dir-${i}-${odd}-segment`).join('/')}/file${odd}name.mjs`
    const anchor = anchorOf({ seen: [{ path, count: 2, firstRid: R(1) }] })
    const h = resourcesHtml(stateOf(anchor, { meta: { project_path: cwd } }))
    const m = /<span class="navchip[^"]*"[^>]*title="([^"]*)"/.exec(h)
    assert.ok(m, 'a chip with a hover')
    assert.ok(decode(m[1]).startsWith(relPath(cwd, path)), path)
    assert.ok(!decode(m[1]).replace(relPath(cwd, path), '').includes('&amp;'), 'escaped once')
  }
})

// 2.4 lifecycle on rids: a file row is pending before its first segment enters, live inside a segment [enter, evict), evicted
// after; segments name their steps by rid. Every playhead × generated segment list.
test('resource state on rids: pending / live / evicted at every playhead', () => {
  let seed = 5
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let t = 0; t < 40; t++) {
    const a = rnd(5), b = a + 1 + rnd(5 - a), c = rnd(2) ? b + rnd(6 - b) : null // [a, b) then maybe [c, end)
    const segs = [[a, b], ...(c != null && c < 6 ? [[c, null]] : [])]
    const lane = anchorOf({ resources: [{ kind: 'file', label: '/w/p/f.mjs', segments: segs.map(([e, v]) => ({ enter: R(e), evict: v == null || v > 5 ? null : R(v) })) }] })
    for (let ph = 0; ph < 6; ph++) {
      const row = resourcesHtml(stateOf(lane, { playhead: ph })).match(/<div class="navsub([^"]*)" data-navstep[^>]*data-navres="file:/)
      const live = segs.some(([e, v]) => e <= ph && (v == null || v > 5 || v > ph))
      const want = ph < a ? 'pend' : live ? '' : 'dead'
      assert.equal(row[1].trim(), want, `${JSON.stringify(segs)} @${ph}`)
    }
  }
})

// 2.4 #1, 2.4:67 · :148: 只见到名字 leaves out every opened file under either spelling; while the anchor lane's
// `ledger_next` chain is unread, each count the ledger gives is an empty busy box (no digit, never a 0); the compaction
// count (lane events) is exact once the lane is held; the chain read to its end → the counts are the ledger's.
test('2.4 #1: seen minus opened files; ledger counts busy until the ledger chain is read, then the ledger\'s', () => {
  const key = R(0), cwd = '/w/p'
  const res = [
    { kind: 'file', label: `${cwd}/src/a.mjs`, segments: [{ enter: R(0), evict: null }] },
    { kind: 'file', label: 'src/b.mjs', segments: [{ enter: R(1), evict: null }] },
    { kind: 'scaffold', label: 'CLAUDE.md', segments: [{ enter: R(0), evict: null }] },
    { kind: 'capability', label: 'srv', segments: [{ enter: R(0), evict: null }] },
  ].map((r) => ({ key: `${r.kind}:${r.label}`, ...r }))
  const seen = [`${cwd}/src/a.mjs`, 'src/a.mjs', `${cwd}/src/b.mjs`, `${cwd}/notes.md`, 'docs/x.md']
    .map((path, i) => ({ path, count: 1 + i, firstRid: R(i) }))
  const events = [{ type: 'compaction', rid: R(2), from: 10, to: 3 }]
  const steps = Array.from({ length: 6 }, (_, i) => ({ rid: R(i), parent: null, ops: [[1]], reply: [], attrs: {}, detail: null }))
  const s = stateOf(anchorOf({}), { meta: { project_path: cwd } })
  // the tail page carries half the ledger and names the rest by ledger_next
  applyLane(s.desk, { lane: key, base: null, prev: null, next: null, steps, defs: [], resources: res.slice(0, 2), seen: seen.slice(0, 3), events, ledger_next: 'c1' })
  const heads = (h) => new Map([...h.matchAll(/<div class="navrow head[^"]*"[^>]*data-navtoggle="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => [m[1], m[2]]))
  const ledgerKeys = ['life-file', 'life-load', 'life-seen', 'life-cap', 'life-dl', 'life-other', 'life-others']
  let hs = heads(resourcesHtml(s))
  assert.ok([...hs.keys()].some((k) => ledgerKeys.includes(k)), 'some ledger group is drawn while the chain is unread')
  for (const [k, inner] of hs) {
    if (!ledgerKeys.includes(k)) continue
    assert.match(inner, /<span class="navct" aria-busy="true"><\/span>/, `${k}: the count is a busy box`)
    assert.ok(!/\d/.test(inner.replace(/<[^>]*>/g, '')), `${k}: no digit while not known`)
  }
  assert.equal(grpCount(resourcesHtml(s), W.RES_GRP.comp), events.length, 'the compaction count is exact once the lane is held')
  applyLedger(s.desk, key, 'c1', { resources: res.slice(2), seen: seen.slice(3), ledger_next: null })
  const h = resourcesHtml(s)
  assert.ok(!/aria-busy/.test(h), 'the chain is read: nothing is busy')
  const shown = seenFiles(s.desk, key)
  assert.equal(grpCount(h, `${W.RES_GRP.seen} · ${W.GUESS}`), shown.length)
  for (const [kind, grp] of [['file', 'file'], ['scaffold', 'load'], ['capability', 'cap']]) assert.equal(grpCount(h, W.RES_GRP[grp]), res.filter((r) => r.kind === kind).length, kind)
  const chips = [...h.matchAll(/<span class="navchip[^"]*"[^>]*title="([^"]*)"/g)].map((m) => m[1])
  assert.equal(chips.length, shown.length)
  for (const r of res.filter((x) => x.kind === 'file')) {
    const base = r.label.split('/').pop()
    assert.ok(!chips.some((t) => t.includes(base)), `${r.label}: an opened file is not a name-only chip under any spelling`)
  }
})
