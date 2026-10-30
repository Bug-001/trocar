// read-fail.test.mjs — 1.5 K-29: a failed /api read says, in the board's own words, what could not be read and the cause class;
// the server's `error` text and thrown messages live only in the collapsed technical details (escaped). Invariants only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFailure } from '../../src/web/v2/core/ui.mjs'
import { statsCardHtml, recentCardHtml, capCardHtml } from '../../src/web/v2/overview/overview.mjs'
import { capHealthPatch } from '../../src/web/v2/core/capture-verdict.mjs'
import * as trafficPage from '../../src/web/v2/traffic/traffic.mjs'
import * as hostPage from '../../src/web/v2/traffic/host.mjs'
import * as prices from '../../src/web/v2/settings/prices.mjs'
import * as storage from '../../src/web/v2/settings/storage.mjs'
import { readFailHtml, captionHtml, emptyBoardHtml } from '../../src/web/v2/library/library.mjs'
import { capShotMaker } from '../../src/web/v2/library/logic.mjs'
import { pageLogHtml } from '../../src/web/v2/capture/capture-log.mjs'
import { captureVerdict } from '../../src/web/v2/core/capture-verdict.mjs'
import { screenErrorHtml } from '../../src/web/v2/shell/safemount.mjs'
import { hidesReason, reasonsWith, visibleOf, outsideCollapsed } from './visible.mjs'
import { esc } from '../../src/web/v2/core/fmt.mjs'
import * as LW from '../../src/web/v2/labels/library.mjs'
import { trafficWorld } from './traffic-world.mjs'
import { boardHome } from './real-face.mjs'

let n = 0
const tok = () => `tok-${++n}-q7`

test('readFailure: the visible line holds none of the reason; the reason is escaped in collapsed technical details', () => {
  for (const status of [0, 404, 500, 503, undefined, 'bare']) {
    for (const make of [0, 1, 2, 3]) {
      const t = tok(), reason = reasonsWith(t)[make]
      const r = status === 'bare' ? reason : { ok: false, status, error: reason }
      const { line, tech } = readFailure('Stats', r, { id: `f-${n}` })
      const where = `${status} · ${make}`
      assert.equal(typeof line, 'string', where)
      assert.ok(line.trim(), where)
      assert.ok(!line.includes('\n'), where)
      assert.ok(!line.includes(t), where)
      assert.ok(/<div class="disc-b"[^>]*\shidden>/.test(tech), `${where}: details are collapsed`)
      hidesReason(tech, t, reason !== '', where)
    }
  }
  const none = readFailure('Stats', null)
  assert.ok(none.line.trim() && !none.line.includes('\n'))
  // the cause class (K-29): a returned status is in the line; unreachable (0) and a server error are told apart
  for (const status of [404, 500, 503]) assert.ok(readFailure('Stats', { status }).line.includes(String(status)), `status ${status} in the line`)
  assert.notEqual(readFailure('Stats', { status: 0 }).line, readFailure('Stats', { status: 500 }).line)
})

test('overview cards: stats and recent read failures, the price line and a 503 capture card keep the reason out of the visible text', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z')
  const stats = { as_of: new Date(NOW - 3600e3).toISOString(), sessions: { total: 1 }, calls: { llm: 2 }, harnesses: [], usage: { rows: [], coverage: {} } }
  for (const status of [0, 500, 503]) {
    for (const make of [0, 1, 2, 3]) {
      const t = tok(), reason = reasonsWith(t)[make], given = reason !== ''
      const ans = { ok: false, status, error: reason }
      const where = (card) => `${card} · ${status} · ${make}`
      const st = statsCardHtml({ w: '24h', stats: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(st, t, given, where('stats'))
      assert.ok(st.includes('data-act="retry"'), where('stats'))
      const rc = recentCardHtml({ sessions: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(rc, t, given, where('recent'))
      assert.ok(rc.includes('data-act="retry"'), where('recent'))
      const pr = statsCardHtml({ w: '24h', stats: { data: stats, ok: true, err: null, w: '24h' }, pricing: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(pr, t, given, where('price line'))
      if (status === 503 && given) {
        const p = capHealthPatch(ans, NOW)
        const cap = capCardHtml({ caph: { data: p.capH, okAt: p.capHOkAt, err: null, ok: true } }, NOW)
        hidesReason(cap, t, true, where('capture'))
      }
    }
  }
})

const world = (async () => {
  const w = await trafficWorld({ home: boardHome({ bytes: 2e5 }) })
  const T = (await w.face.get('traffic', { limit: 500 })).doc
  const h = T.hosts.find((r) => r.host && r.harness && r.requests > 0)
  const calls = (await w.face.get('calls', { harness: h.harness, host: h.host, limit: 50 })).doc
  return { w, host: `#/traffic/host/${encodeURIComponent(h.harness)}/${encodeURIComponent(h.host)}`, ref: calls.records[0].ref }
})()
test.after(async () => { (await world).w.close() })

test('a failed read on traffic, a host page (list and request detail), Settings › Prices and Settings › Storage shows the token only in hidden technical details, with a retry control', async () => {
  const { w, host, ref } = await world
  const q = (url) => new URL(url, 'http://x')
  const sites = [
    ['traffic', trafficPage, '#/traffic', (u) => u.pathname === '/api/traffic', 'data-act="retry"'],
    ['host list', hostPage, host, (u) => u.pathname === '/api/calls' && u.searchParams.has('host'), 'data-act="retry"'],
    ['request detail', hostPage, `${host}?ref=${encodeURIComponent(ref)}`, (u) => u.pathname === '/api/calls' && u.searchParams.has('ref'), 'data-act="retry-detail"'],
    ['prices', prices, '#/settings/prices', (u) => u.pathname === '/api/pricing', 'href="#/settings/prices"'],
    ['storage', storage, '#/settings/storage', (u) => u.pathname === '/api/classes', 'href="#/settings/storage"'],
    ['storage files', storage, '#/settings/storage', (u) => u.pathname === '/api/segments', 'href="#/settings/storage"'], // never zero problems (D38)
  ]
  for (const [name, mod, hash, hit, retry] of sites) {
    for (const fail of [500, 503, 'throw']) {
      for (const make of [0, 1, 2, 3]) {
        const t = tok(), reason = reasonsWith(t)[make], where = `${name} · ${fail} · ${make}`
        w.tamper((url, doc) => {
          if (!hit(q(url))) return doc
          if (fail === 'throw') throw new Error(reason)
          return { status: fail, body: { error: reason } }
        })
        try {
          const s = await w.mount(mod, hash)
          const html = s.html()
          hidesReason(html, t, reason !== '', where)
          assert.ok(html.includes(retry), `${where}: retry control`)
          s.inst.unmount()
        } finally { w.tamper(null) }
      }
    }
  }
})

test('library, capture log and the shell keep a failed read\'s reason out of the visible text', async () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z')
  for (const status of [0, 500, 503]) {
    for (const make of [0, 1, 2, 3]) {
      const t = tok(), reason = reasonsWith(t)[make], given = reason !== ''
      const r = { ok: false, status, error: reason }
      const where = (site) => `${site} · ${status} · ${make}`
      const lf = readFailHtml(r)
      hidesReason(lf, t, given, where('library read failure'))
      assert.ok(lf.includes('data-act="retry"'), where('library read failure'))
      const cap = captionHtml([], r, NOW - 5000)
      hidesReason(cap, t, given, where('stale caption'))
      assert.ok(cap.includes('data-act="retry"'), where('stale caption'))
      // the empty board's capture-health line, from the one-shot read: answered, thrown, or a 503 verdict
      for (const [how, fetch] of [['answer', async () => r], ['throw', async () => { throw new Error(reason) }]]) {
        const shot = capShotMaker(fetch, () => NOW)
        await shot.read()
        const eb = emptyBoardHtml(shot.settled)
        hidesReason(eb, t, given, where(`empty board ${how}`))
        // a failed answer keeps its cause class on the line: the same line any board read failure with that status says
        const st = how === 'throw' ? 0 : status
        if (!(st === 503 && given)) assert.ok(outsideCollapsed(eb).includes(esc(readFailure(LW.CAPTURE_HEALTH, { status: st }).line)), where(`empty board ${how} cause`))
      }
      if (!given) continue // the rest take a bare reason; an empty one is no failure there
      hidesReason(pageLogHtml({ unreadable: reason }), t, true, where('capture log'))
      assert.ok(!visibleOf(captureVerdict({ unreadable: reason }, { okAt: NOW, now: NOW }).text).includes(t), where('verdict'))
      hidesReason(screenErrorHtml(reason), t, true, where('screen error'))
    }
  }
})
