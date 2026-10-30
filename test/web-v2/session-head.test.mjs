// test/web-v2/session-head.test.mjs — the session head and the step navigation on a real /api/session answer (the real face,
// test/web-v2/real-face.mjs): one previous / one next control on the whole desk, the step position in one element, and the head
// built only from 1.2 §会话头's parts. String level: the desk's skeleton + sessionHeadHtml + stepBarHtml.
import test from 'node:test'
import assert from 'node:assert/strict'
import { boardHome, serveBoard } from './real-face.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { sessionHeadHtml } from '../../src/web/v2/replay/header.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { SKELETON } from '../../src/web/v2/replay/replay.mjs'
import * as W from '../../src/web/v2/labels/replay.mjs'

const face = await serveBoard(boardHome())
const id = (await face.get('sessions')).doc.sessions[0].session_id
const doc = (await face.get('session', { id })).doc
await face.close()

const lanes = buildLanes(doc.analyzed, doc.probes)
const anchor = anchorLane(lanes)
const desk = (playhead) => {
  const s = { meta: doc.meta, lanes, anchor, playhead, pricing: null, pricingErr: null, diffRef: null }
  return SKELETON + sessionHeadHtml({ meta: doc.meta, lanes, follow: false, libraryHash: '#/sessions' }) + stepBarHtml(s)
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

test('the desk draws exactly one previous-step and one next-step control, and the step position in one element', () => {
  assert.ok(anchor && anchor.calls.length > 1, 'the real session has steps to move between')
  for (const playhead of [0, anchor.calls.length - 1]) {
    const h = desk(playhead)
    const count = (label) => (h.match(new RegExp(`aria-label="${label}"`, 'g')) || []).length
    assert.equal(count(W.STEP_PREV), 1, 'one previous-step control')
    assert.equal(count(W.STEP_NEXT), 1, 'one next-step control')
    const n = playhead + 1, M = anchor.calls.length
    assert.equal(h.split(W.stepNo(n, M)).length - 1, 1, 'the position is written once')
    assert.equal((h.match(new RegExp(`\\b${n}\\s*/\\s*${M}\\b`, 'g')) || []).length, 1, 'no second n / M anywhere on the desk')
  }
})

test('the session head is built only from 1.2 §会话头 parts: back, title, agent chip (entry word inside), project, follow, ⓘ', () => {
  const head = sessionHeadHtml({ meta: doc.meta, lanes, follow: false, libraryHash: '#/sessions' })
  const parts = topLevel(head)
  const ALLOWED = new Set(['sh-back', 'sh-name', 'sh-chip', 'sh-multi', 'sh-proj', 'spacer', 'sh-follow', 'sh-info'])
  for (const p of parts) assert.ok(ALLOWED.has(p.cls[0]), `an element outside the head's table: <${p.tag} class="${p.cls.join(' ')}">`)
  const kinds = parts.map((p) => p.cls[0])
  for (const must of ['sh-back', 'sh-name', 'sh-chip', 'sh-follow', 'sh-info']) assert.equal(kinds.filter((k) => k === must).length, 1, `exactly one ${must}`)
  assert.ok(kinds.indexOf('sh-back') < kinds.indexOf('sh-name') && kinds.indexOf('sh-name') < kinds.indexOf('sh-chip') && kinds.indexOf('sh-follow') < kinds.indexOf('sh-info'), 'in the table\'s order')
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
    const { facts, tech } = fidelityFacts({ errors, analyzed: {} })
    const files = facts.filter((f) => f.html.includes('href="#/settings/storage"'))
    assert.equal(files.length, k2 > 0 ? 1 : 0, `k1=${k1} k2=${k2}`)
    assert.equal(tech.length, k1 + k2)
  }
})
