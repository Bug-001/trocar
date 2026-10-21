// test/web-v2/session-head.test.mjs — the session head and the step navigation over the desk model: one previous / one next
// control on the whole desk, the step position in one element, 1.2 #16's numbering (stepRef on rids), the head built only from
// 1.2 §会话头's parts, the read-state line (pending), and the 会话保真行's facts. String level: the desk's skeleton +
// sessionHeadHtml + stepBarHtml over generated desks (desk-world.mjs) and, once lane Q's routes are merged, the real face.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardHome, serveBoard } from './real-face.mjs'
import { world, deskFrom, ROUTES_READY } from './desk-world.mjs'
import { buildLanes, anchorLane, stepRef } from '../../src/web/v2/replay/lanes.mjs'
import { createDesk, applySession } from '../../src/web/v2/replay/model.mjs'
import { sessionHeadHtml, readStateHtml } from '../../src/web/v2/replay/header.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { SKELETON } from '../../src/web/v2/replay/replay.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'

const NOT_READY = ROUTES_READY ? false : "lane Q's routes are not merged (src/query/named/lane.mjs)"
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
test('on the real face: one control each, the head only from its parts', { skip: NOT_READY }, async () => {
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

// 1.5 K-29: after a failed read of a drawn session, one quiet stale line sits under the head with a Retry that reads at once
// (s.poll — the reader's path, not the timer's); a good answer drops it
import { renderSessionHead, wireSessionHead, staleLineHtml, fidelityFacts } from '../../src/web/v2/replay/header.mjs'
test('K-29: a stale session draws a Retry outside the head that reads again; no stale state, no line', () => {
  const meta = { session_id: 's1', harness: 'cc', project_slug: 'p', project_path: '/w/p' }
  let handler = null, polls = 0
  const el = { innerHTML: '', addEventListener: (t, f) => { handler = f }, removeEventListener() {} }
  const s = { meta, lanes: [], follow: true, A: null, ctx: {}, staleErr: { reason: 'x', since: Date.now() - 5000 }, poll: () => { polls++ } }
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

// V05: the visible stale line carries only the reason's first line; the whole reason (a native stack, say) is in 技术细节
test('V05: a multi-line stale reason shows its first line only; the rest lives in the tech details', () => {
  const token = 'TOKEN_<b>&_' + Math.random().toString(36).slice(2)
  const html = staleLineHtml({ since: new Date(Date.now() - 5000).toISOString(), reason: `read failed\n${token}\n    at frame (x.js:1:2)` })
  const tech = html.indexOf('class="disc"')
  assert.ok(tech > 0, 'a tech-details element')
  const escTok = token.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  assert.ok(!html.slice(0, tech).includes(escTok) && !html.slice(0, tech).includes(token), 'not in the visible line')
  assert.ok(html.slice(tech).includes(escTok), 'in the tech details, escaped')
  assert.ok(!html.includes(token), 'never unescaped')
})

// V05: while the desk is stale the follow chip says it is paused; its pressed state is the reader's choice and does not change
test('V05: a stale desk marks the follow chip paused, pressed state unchanged', () => {
  const meta = { session_id: 's1', harness: 'cc' }
  const chip = (html) => html.match(/<button[^>]*data-follow[^>]*>/)[0]
  const on = chip(sessionHeadHtml({ meta, lanes: [], follow: true, stale: true }))
  assert.match(on, /data-state="paused"/); assert.match(on, /aria-pressed="true"/)
  assert.ok(!/data-state=/.test(chip(sessionHeadHtml({ meta, lanes: [], follow: true, stale: false }))))
})

// V11: a slow read (an index-cold note) is not a loss — the 'files not read in full' fact counts only non-note errors;
// every entry, notes included, still lands in the tech pairs
test('V11: only non-note read errors make the files fact; all of them reach the tech pairs', () => {
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
  const { fidelityLineHtml } = await import('../../src/web/v2/replay/header.mjs')
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
