// test/web-v2/session-head.test.mjs — the session head and the step navigation over the desk model: one previous / one next
// control on the whole desk, the step position in one element, 1.2 #16's numbering (stepRef on rids), the head built only from
// 1.2 §会话头's parts, the read-state line (pending), and the 会话保真行's facts. String level: the desk's skeleton +
// sessionHeadHtml + stepBarHtml over generated desks (desk-world.mjs) and over the real face.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardHome, serveBoard } from './real-face.mjs'
import { world, deskFrom } from './desk-world.mjs'
import { buildLanes, anchorLane, stepRef } from '../../web/legacy/replay/lanes.mjs'
import { createDesk, applySession } from '../../web/legacy/replay/model.mjs'
import { sessionHeadHtml, readStateHtml } from '../../web/legacy/replay/header.mjs'
import { FOLD_STOPS } from '../../src/health/codes.mjs'
import { stepBarHtml } from '../../web/legacy/replay/stepbar.mjs'
import { SKELETON } from '../../web/legacy/replay/replay.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'

const SEEDS = [1, 7, 19, 42]
const worldDesk = (seed) => { const w = world(seed); return deskFrom(w.get(), 'S').then((desk) => ({ w, desk })) }
async function realDesk() {
  const face = await serveBoard(boardHome())
  try {
    const get = (name, p) => face.get(name, p).then((r) => r.doc)
    const id = (await get('sessions')).sessions[0].session_id
    return await deskFrom(get, id)
  } finally { await face.close() }
}
const deskHtml = (desk, playhead) => {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  const s = { desk, meta: desk.meta, lanes, anchor, playhead, pricing: null, pricingErr: null, diffRef: null }
  return { anchor, h: SKELETON + sessionHeadHtml({ meta: desk.meta, lanes, follow: false, libraryHash: '#/sessions' }) + stepBarHtml(s) }
}

// the top-level elements of an HTML string: [{tag, cls}] (void elements close themselves)
function topLevel(html) {
  const out = []
  let depth = 0
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m
    if (close) { depth--; continue }
    if (depth === 0) out.push({ tag: tag.toLowerCase(), cls: ((attrs.match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean) })
    if (!self && !/^(img|input|br|hr|meta|link|source|wbr)$/i.test(tag)) depth++
  }
  return out
}

function oneControlEach(desk) {
  const { anchor } = deskHtml(desk, 0)
  assert.ok(anchor && anchor.calls.length > 1, 'the session has steps to move between')
  for (const playhead of [0, anchor.calls.length - 1]) {
    const { h } = deskHtml(desk, playhead)
    const count = (label) => (h.match(new RegExp(`aria-label="${label}"`, 'g')) || []).length
    assert.equal(count(W.STEP_PREV), 1, 'one previous-step control')
    assert.equal(count(W.STEP_NEXT), 1, 'one next-step control')
    assert.equal((h.match(/class="sb-no"/g) || []).length, 1, 'the position is written in one element')
  }
}
function headParts(desk) {
  const head = sessionHeadHtml({ meta: desk.meta, lanes: buildLanes(desk), follow: false, libraryHash: '#/sessions' })
  const parts = topLevel(head)
  const ALLOWED = new Set(['sh-back', 'sh-name', 'sh-chip', 'sh-multi', 'sh-proj', 'spacer', 'sh-follow', 'sh-info'])
  for (const p of parts) assert.ok(ALLOWED.has(p.cls[0]), `an element outside the head's table: <${p.tag} class="${p.cls.join(' ')}">`)
  const kinds = parts.map((p) => p.cls[0])
  for (const must of ['sh-back', 'sh-name', 'sh-chip', 'sh-follow', 'sh-info']) assert.equal(kinds.filter((k) => k === must).length, 1, `exactly one ${must}`)
  assert.ok(kinds.indexOf('sh-back') < kinds.indexOf('sh-name') && kinds.indexOf('sh-name') < kinds.indexOf('sh-chip') && kinds.indexOf('sh-follow') < kinds.indexOf('sh-info'), 'in the table\'s order')
}

test('the desk draws exactly one previous-step and one next-step control, and the step position in one element', async () => {
  for (const seed of SEEDS) oneControlEach((await worldDesk(seed)).desk)
})
test('the session head is built only from 1.2 §会话头 parts: back, title, agent chip (entry word inside), project, follow, ⓘ', async () => {
  for (const seed of SEEDS) headParts((await worldDesk(seed)).desk)
})
test('on the real face: one control each, the head only from its parts', async () => {
  const desk = await realDesk()
  oneControlEach(desk); headParts(desk)
})

// 1.2 #16: 「第 N 步」 names only a main-lane call (N = its place in the main lane's step order + 1, M = the header's count);
// any other lane's call is that lane + its own k. Expected positions from the reference server's lanes, not the model's.
test('1.2 #16 numbering: stepRef on a main-lane rid is step n of M; on another lane\'s rid it is that lane and k', async () => {
  for (const seed of SEEDS) {
    const { w, desk } = await worldDesk(seed)
    const lanes = buildLanes(desk), byLane = w.laneRidsAt()
    const mainKey = [...desk.lanes.values()].find((h) => h.kind === 'main')?.lane
    for (const [key, rids] of byLane) rids.forEach((rid, i) => {
      const r = stepRef(lanes, rid)
      if (key === mainKey) assert.deepEqual(r, { step: true, n: i + 1, m: rids.length }, rid)
      else { assert.equal(r.step, false, rid); assert.equal(r.lane.id, key); assert.equal(r.k, i + 1); assert.equal(r.m, rids.length) }
    })
    assert.equal(stepRef(lanes, 'no-such-rid'), null, 'a rid in no lane is not numbered')
  }
})

// 1.2 §会话头 读取状态: present iff the session answer carries `pending`; a quiet line, never a control
test('the read-state line is present iff the answer is pending, and holds no button / link / focusable', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
  const CONTROL = /<(button|a)\b|tabindex=|role="button"/
  const desk = createDesk()
  applySession(desk, fx.session_pending)
  const first = readStateHtml(desk)
  assert.match(first, /data-read-state/, 'first read, pending: the line')
  assert.ok(!CONTROL.test(first))
  applySession(desk, { ...fx.session_pending, mark: 'later', pending: { done: 5, total: 9 } })
  const later = readStateHtml(desk)
  assert.match(later, /data-read-state/, 'a later pending answer: the line')
  assert.ok(!CONTROL.test(later))
  applySession(desk, fx.session_full)
  assert.equal(readStateHtml(desk), '', 'no pending: no line')
  assert.equal(readStateHtml(createDesk()), '', 'nothing read: no line')
})

// 1.5 K-31 · 3.5 #37: a head whose background fold stopped (pending.stopped) says reading stopped, its code in the technical details;
// for every FOLD_STOPS code, at a first read and a later one
test('a stopped fold: the read-state line is the stopped one, its code in the technical details; without the stop it is the reading line', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
  for (const code of FOLD_STOPS) {
    for (const answer of [fx.session_pending, { ...fx.session_pending, mark: 'later', pending: { done: 5, total: 9 } }]) {
      const desk = createDesk()
      applySession(desk, { ...answer, pending: { ...answer.pending, stopped: { code, reason: 'why it stopped' } } })
      const html = readStateHtml(desk)
      assert.match(html, /data-read-state="stopped"/, code)
      const tech = html.slice(html.indexOf('class="tech"'))
      assert.ok(html.includes('class="tech"') && tech.includes(code), `${code}: the code is in the technical details`)
      assert.ok(!html.slice(0, html.indexOf('class="tech"')).includes(code), `${code}: the code is not in the visible line`)
      applySession(desk, answer)
      assert.match(readStateHtml(desk), /data-read-state="(reading|catching-up)"/, 'without the stop: reading or catching up')
    }
  }
})

// 1.5 K-29: after a failed read of a drawn session, one quiet stale line sits under the head with a Retry that reads at once
// (s.poll — the reader's path, not the timer's); a good answer drops it
import { renderSessionHead, wireSessionHead, staleLineHtml, fidelityFacts } from '../../web/legacy/replay/header.mjs'
import { hidesReason, reasonsWith, visibleOf, outsideCollapsed } from './visible.mjs'
test('K-29: a stale session draws a Retry outside the head that reads again; no stale state, no line', () => {
  const meta = { session_id: 's1', harness: 'cc', project_slug: 'p', project_path: '/w/p' }
  let handler = null, polls = 0
  const el = { innerHTML: '', addEventListener: (t, f) => { if (t === 'click') handler = f }, removeEventListener() {} }
  const s = { meta, lanes: [], follow: true, A: null, ctx: {}, staleErr: { r: { ok: false, status: 500, error: 'x' }, since: Date.now() - 5000 }, poll: () => { polls++ } }
  renderSessionHead(el, s)
  assert.match(el.innerHTML, /data-retry/)
  assert.ok(!el.innerHTML.split('class="sesshead"')[1].split('</div>')[0].includes('data-retry'), 'not inside the session head itself')
  wireSessionHead(el, s)
  handler({ target: { closest: (sel) => (sel === '[data-retry]' ? {} : null) } })
  assert.equal(polls, 1)
  s.staleErr = null; renderSessionHead(el, s)
  assert.ok(!/data-retry/.test(el.innerHTML))
  assert.equal(staleLineHtml(null), '')
})

// 1.5 K-29: the stale line's visible words are the board's own (readFailure); the failed answer's reason (any status, a
// native stack, markup) stays escaped in the collapsed technical details; Retry is there
test('a stale line keeps every reason out of its visible text, escaped in collapsed details, with a Retry', () => {
  let n = 0
  for (const status of [0, 404, 500, undefined]) {
    for (const reason of reasonsWith('TOKEN')) {
      const t = `tok-${++n}-s9`, error = reason.replace('TOKEN', t)
      const r = status === undefined ? { ok: false, error } : { ok: false, status, error }
      const html = staleLineHtml({ since: new Date(Date.now() - 5000).toISOString(), r })
      const where = `${status} · ${n}`
      assert.ok(visibleOf(html).trim(), `${where}: a visible line`)
      assert.ok(/<div class="disc-b"[^>]*\shidden>/.test(html), `${where}: details are collapsed`)
      hidesReason(html, t, error.includes(t), where)
      assert.match(outsideCollapsed(html), /data-retry/, `${where}: a Retry control`)
    }
  }
})

// while the desk is stale the follow chip says it is paused; its pressed state is the reader's choice and does not change
test('a stale desk marks the follow chip paused, pressed state unchanged', () => {
  const meta = { session_id: 's1', harness: 'cc' }
  const chip = (html) => html.match(/<button[^>]*data-follow[^>]*>/)[0]
  const on = chip(sessionHeadHtml({ meta, lanes: [], follow: true, stale: true }))
  assert.match(on, /data-state="paused"/); assert.match(on, /aria-pressed="true"/)
  assert.ok(!/data-state=/.test(chip(sessionHeadHtml({ meta, lanes: [], follow: true, stale: false }))))
})

// a slow read (an index-cold note) is not a loss — the 'files not read in full' fact counts only non-note errors;
// every entry, notes included, still lands in the tech pairs
test('only non-note read errors make the files fact; all of them reach the tech pairs', () => {
  for (let k1 = 0; k1 <= 3; k1++) for (let k2 = 0; k2 <= 3; k2++) {
    const errors = [
      ...Array.from({ length: k1 }, (_, i) => ({ where: `f${i}.ndjson`, code: 'index-cold', level: 'note', reason: 'slow' })),
      ...Array.from({ length: k2 }, (_, i) => ({ where: `g${i}.ndjson`, reason: 'EIO' })),
    ]
    const { facts, tech } = fidelityFacts({ errors })
    const files = facts.filter((f) => f.html.includes('href="#/settings/storage"'))
    assert.equal(files.length, k2 > 0 ? 1 : 0, `k1=${k1} k2=${k2}`)
    assert.equal(tech.length, k1 + k2)
  }
})

// 1.5 K-20 / 1.2 §会话保真行: the fact is there iff `unknown.records > 0`; the reason and the endpoints only in 技术细节
test('K-20: the unreadable-records fact appears iff unknown.records > 0; reason and endpoints only in the tech details', async () => {
  const { fidelityLineHtml } = await import('../../web/legacy/replay/header.mjs')
  const reason = 'REASON_' + Math.random().toString(36).slice(2), ep = 'EP_' + Math.random().toString(36).slice(2)
  for (const unknown of [null, undefined, { records: 0 }, { records: 0, reason, endpoints: [ep] }, { records: 1, reason, endpoints: [ep] }, { records: 37, reason, endpoints: [ep, ep + 'b'] }, { records: 2 }]) {
    const on = !!unknown && unknown.records > 0
    assert.equal(fidelityFacts({ unknown }).facts.length, on ? 1 : 0, JSON.stringify(unknown))
    const html = fidelityLineHtml({ unknown })
    if (!on) { assert.equal(html, '', 'no fact: no row'); continue }
    const tech = html.indexOf('class="disc"')
    for (const t of [unknown.reason, ...(unknown.endpoints || [])].filter(Boolean)) {
      assert.ok(tech > 0 && html.indexOf(t) > tech, `${t} only after the tech-details element`)
    }
  }
})

// 2.3 归约前沿: the session-info popover's numbers walk every call, so they are drawn when it opens (`v2:popopen`, core/ui.mjs), from the
// lanes held then — an answer that lands while it is shut does not pay for them
test('the session-info popover is filled when it opens, from the lanes held then; the head drawn with an answer leaves it empty', async () => {
  const w = world(3), desk = await deskFrom(w.get(), 'S')
  const lanes = buildLanes(desk, { count: 0, series: [] })
  const handlers = {}, body = { innerHTML: '' }
  const el = { innerHTML: '', querySelector: (sel) => (sel === '.sipb' ? body : null), addEventListener: (t, f) => { handlers[t] = f }, removeEventListener() {} }
  const s = { meta: desk.meta, lanes, desk, follow: true, ctx: {}, staleErr: null }
  renderSessionHead(el, s)
  assert.equal(s.totals, null) // nothing counted over the whole session until the popover opens
  wireSessionHead(el, s)
  handlers['v2:popopen']()
  assert.ok(body.innerHTML.length > 0, 'the popover body is drawn on open')
  assert.ok(s.totals && s.totals.cost, 'the totals are worked out on open')
})

// ── the new desk's session head as data (web/src/screens/replay/models.mjs : sessionHeadModel) ─────────────────────────
import { sessionHeadModel } from '../../web/src/screens/replay/models.mjs'
import { deskOf } from './desk-world.mjs'
import { sessionTotals, priceMatch } from '../../web/legacy/core/metrics.mjs'
import { L } from '../../web/legacy/core/labels.mjs'

const PRICES = { m: [3, 15, 3.75, 0.3] }
const U = (read, create, fresh, out = 10) => ({ read, create, fresh, out })
// a desk of hand-made lanes and its state object as the controller holds it
const headState = (lanes, answer = {}, extra = {}) => {
  const desk = deskOf(lanes, answer)
  return { desk, meta: desk.meta, lanes: buildLanes(desk, desk.probes), pricing: PRICES, follow: false, ...extra }
}
const mainRows = () => [{ usage: U(0, 100, 10), cacheBreak: { firstCall: true } }, { usage: U(0, 120, 10), cacheBreak: { cause: 'content-changed' } }, { error: 'boom', usage: null }, { usage: U(100, 30, 5), cacheBreak: { cause: 'append' } }]
const HEAD_PARTS = ['back', 'title', 'chip', 'entry', 'project', 'start', 'follow', 'read', 'stale', 'facts', 'info'] // 1.2 §会话头's table + the 保真行 + ⓘ
const INFO_KEYS = new Set(['truncated', 'cost', 'hit', 'breaks', 'failed', 'compactions', 'counts', 'duration', 'id', 'project', 'calls']) // 1.2 §信息弹出层

test('1.2 #17 · model: the title falls back to 未命名会话 only; the start is chapters[0].ts0 and absent at tier 0; the tip follows title_source', () => {
  const chapters = [{ k: 0, s0: 0, s1: 4, ts0: '2026-10-07T00:00:00.000Z', inferred: false }]
  for (const [meta, tier, want] of [[{ session_id: 'S-1' }, 1, W.TITLE_UNTITLED_NEXT_TIP], [{ session_id: 'S-1', title: 'T', title_source: 'wire' }, 1, W.TITLE_FROM_WIRE], [{ session_id: 'S-1', title: 'T', title_source: null }, 0, W.TITLE_FROM_META]]) {
    const s = headState([{ kind: 'main', rows: mainRows() }], { meta })
    s.desk.head = { tier, steps: 4, chapters: tier ? chapters : [] }
    const m = sessionHeadModel(s)
    assert.equal(m.title.text, meta.title ?? null)
    assert.equal(m.title.fallback, meta.title == null ? W.UNTITLED : null, 'the fallback is the fixed word alone')
    assert.ok(!String(m.title.text ?? m.title.fallback).includes(meta.session_id), 'no title is made from the id')
    assert.equal(m.title.sourceTip, want)
    assert.equal(m.start ? m.start.ts : null, tier ? chapters[0].ts0 : null, tier ? 'the start is the first chapter\'s ts0' : 'no start at tier 0')
  }
})

test('1.2 #15 · model: 多个 agent iff the sessions multi-harness field has more than one entry; provider mixed never says it', () => {
  for (const hs of [undefined, [], [{ harness: 'claude-code' }], [{ harness: 'claude-code' }, { harness: 'codex', inferred: true }]]) {
    const s = headState([{ kind: 'main', rows: mainRows() }], { meta: { session_id: 'S', harness: 'claude-code', provider: 'mixed', ...(hs ? { harnesses: hs } : {}) } })
    const m = sessionHeadModel(s)
    assert.equal(!!m.chip.multi, !!hs && hs.length > 1, JSON.stringify(hs))
    if (m.chip.multi) assert.equal(m.chip.multi.text, W.MULTIPLE_AGENTS)
  }
})

test('1.2 #3 · model: two sessions with one title carry no same-name word; the head is only its parts; a sub-agent is only a count', () => {
  for (const id of ['S-a', 'S-b']) {
    const s = headState([{ kind: 'main', rows: mainRows() }, { kind: 'subagent', rows: [{ usage: U(0, 50, 5) }] }], { meta: { session_id: id, title: 'Same title', title_source: 'wire' } })
    const m = sessionHeadModel(s)
    assert.deepEqual(Object.keys(m), HEAD_PARTS)
    const rows = m.info()
    for (const r of rows) assert.ok(INFO_KEYS.has(r.key), r.key)
    assert.equal(rows.find((r) => r.key === 'counts').sub, 1, 'the sub-agent is counted, not named')
  }
})

test('1.2 #7 · model: every info number is core/metrics.mjs\'s on the same answer; estimates carry ≈; no field name in any word', () => {
  const s = headState([{ kind: 'main', rows: mainRows() }, { kind: 'monitor', rows: [{ usage: U(0, 20, 5) }, { error: 'x', usage: null }] }], { meta: { session_id: 'S', calls: 6 }, truncated: { shown: 6, total: 9, file_mb: 1 } })
  const t = sessionTotals(s.lanes, (m) => priceMatch(PRICES, m)), rows = sessionHeadModel(s).info()
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(rows[0].key, 'truncated', 'a truncated view says so first')
  assert.equal(by.cost.usd, t.cost.total.usd)
  assert.deepEqual(by.cost.buckets.map((b) => b.usd), ['main', 'sub', 'bg'].map((k) => (t.cost[k].priced ? t.cost[k].usd : null)))
  assert.equal(by.hit.pct, Math.round(t.hit * 100))
  assert.equal(by.breaks.n, t.breaks.length)
  assert.equal(by.breaks.usd, t.breakCost.counted ? t.breakCost.usd : null)
  assert.equal(by.failed.n, t.failed)
  for (const k of ['cost', 'breaks']) assert.ok(by[k].approx && by[k].text.includes('≈') || by[k].notes.some((x) => x.includes('≈')), `${k} carries ≈`)
  assert.ok(by.breaks.text.includes(L.STRUCT_EST), 'a break count carries its structural mark')
  const words = JSON.stringify(rows.map((r) => [r.text, r.notes || []]))
  assert.doesNotMatch(words, /\b(usage|cacheBreak|session_id|title_source|harness|ctx|cache_read|rid)\b/)
})

test('1.2 #18 · model: background calls = the server lanes outside main and sub-agents; token counts = probes.count, never a background call', () => {
  const probes = { count: 7, series: [{ ts: '2026-10-07T00:00:01.000Z', tokens: 10 }, { ts: '2026-10-07T00:00:02.000Z', tokens: 12 }] }
  const lanes = [{ kind: 'main', rows: mainRows() }, { kind: 'monitor', rows: [{}, {}], head: { count: 5 } }, { kind: 'probe', rows: [{}] }, { kind: 'subagent', rows: [{}] }]
  const s = headState(lanes, { meta: { session_id: 'S' }, probes })
  s.lanes = buildLanes(s.desk, probes)
  assert.ok(s.lanes.some((l) => l.kind === 'token-count'), 'the front end built its token-count lane')
  const c = sessionHeadModel(s).info().find((r) => r.key === 'counts')
  assert.equal(c.bg, 5 + 1, 'the server lanes\' full counts')
  assert.equal(c.probe, probes.count)
  assert.equal(c.sub, 1)
})
