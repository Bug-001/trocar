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

// 1.5 K-29: after a failed read of a drawn session, the 会话保真行 carries one quiet stale line with the reason and a Retry that
// reads at once (s.poll — the reader's path, not the timer's); a good answer drops it
import { renderSessionHead, wireSessionHead } from '../../src/web/v2/replay/header.mjs'
test('K-29: a stale session says why under the head and its Retry reads again; no stale state, no line', () => {
  const meta = { session_id: 's1', harness: 'cc', project_slug: 'p', project_path: '/w/p' }
  let handler = null, polls = 0
  const el = { innerHTML: '', addEventListener: (t, f) => { handler = f }, removeEventListener() {} }
  const s = { meta, lanes: [], follow: true, A: null, ctx: {}, staleErr: { reason: 'the answer did not arrive in full', since: Date.now() - 5000 }, poll: () => { polls++ } }
  renderSessionHead(el, s)
  assert.match(el.innerHTML, /data-retry/); assert.ok(el.innerHTML.includes('the answer did not arrive in full'))
  assert.ok(!el.innerHTML.split('class="sesshead"')[1].split('</div>')[0].includes('data-retry'), 'not inside the session head itself')
  wireSessionHead(el, s)
  handler({ target: { closest: (sel) => (sel === '[data-retry]' ? {} : null) } })
  assert.equal(polls, 1)
  s.staleErr = null; renderSessionHead(el, s)
  assert.ok(!/data-retry/.test(el.innerHTML))
})
