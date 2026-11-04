// core/router.mjs — every route and parameter of 1.2 §路由, #/session/<id>, the prototype's #/system/... routes mapped onto the new ones, an
// unknown route landing on 总览 (carrying the flag main.mjs turns into a toast), document.title per route, and the history writer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHash, formatHash, documentTitle } from '../../web/legacy/core/router.mjs'
import { SCREEN_NAME } from '../../web/legacy/labels/shell.mjs'

const OVERVIEW = { area: 'overview', screen: 'overview', params: {} }

test('the landing routes: an empty hash, #, #/ and #/overview are 总览, and none of them is "unknown"', () => {
  for (const h of ['', '#', '#/', '#/overview', undefined, null]) assert.deepEqual(parseHash(h), OVERVIEW, String(h))
  assert.deepEqual(parseHash('#/overview?window=7d'), { ...OVERVIEW, params: { window: '7d' } })
})
test('every route of 1.2 §路由 parses to its screen and its parameters', () => {
  const cases = [
    ['#/overview?window=24h', { area: 'overview', screen: 'overview', params: { window: '24h' } }],
    ['#/sessions?h=cc&project=orbit&window=7d&q=hello', { area: 'sessions', screen: 'library', params: { h: 'cc', project: 'orbit', window: '7d', q: 'hello' } }],
    ['#/replay/orbit-planner/s-0001?step=12&call=rec-9', { area: 'replay', screen: 'replay', project: 'orbit-planner', id: 's-0001', params: { step: '12', call: 'rec-9' } }],
    ['#/session/s-0001?step=3&call=rec-9', { area: 'replay', screen: 'session-link', id: 's-0001', params: { step: '3', call: 'rec-9' } }],
    ['#/capture?h=codex', { area: 'capture', screen: 'capture', params: { h: 'codex' } }],
    ['#/capture/log?h=kimi', { area: 'capture', screen: 'capture-log', params: { h: 'kimi' } }],
    ['#/traffic?window=1h&h=cc&class=llm', { area: 'traffic', screen: 'traffic', params: { window: '1h', h: 'cc', class: 'llm' } }],
    ['#/traffic/host/codex/chatgpt.test?window=7d&class=llm&ref=raw-1', { area: 'traffic', screen: 'traffic-host', harness: 'codex', host: 'chatgpt.test', params: { window: '7d', class: 'llm', ref: 'raw-1' } }],
    ['#/settings/storage?h=cc&class=telemetry', { area: 'settings', screen: 'settings-storage', params: { h: 'cc', class: 'telemetry' } }],
    ['#/settings/prices', { area: 'settings', screen: 'settings-prices', params: {} }],
    ['#/settings/appearance', { area: 'settings', screen: 'settings-appearance', params: {} }],
  ]
  for (const [h, want] of cases) assert.deepEqual(parseHash(h), want, h)
})
test('#/settings alone is the storage page; a replay link needs a project and a session', () => {
  assert.equal(parseHash('#/settings').screen, 'settings-storage')
  for (const h of ['#/replay', '#/replay/p', '#/replay/p/i/extra', '#/session', '#/session/a/b']) assert.equal(parseHash(h).unknown, true, h)
})
test('the `h` parameter repeats, and every harness id in a route is the read-side id after harnessKey()', () => {
  assert.equal(parseHash('#/sessions?h=cc&h=codex').params.h, 'cc,codex', 'repeated h joins into the list the library writes')
  assert.equal(parseHash('#/sessions?h=cc,codex').params.h, 'cc,codex')
  assert.equal(parseHash('#/sessions?h=claude-code&h=cc').params.h, 'cc', 'an alias and its id are one agent')
  assert.equal(parseHash('#/capture?h=claude-code').params.h, 'cc')
  assert.equal(parseHash('#/capture/log?h=kimi-code,deepseek-dsh,z-code').params.h, 'kimi,dsh,zcode')
  assert.equal(parseHash('#/traffic?h=claude-code').params.h, 'cc')
  assert.equal(parseHash('#/settings/storage?h=z-code').params.h, 'zcode')
  assert.equal(parseHash('#/traffic/host/claude-code/api.example.test').harness, 'cc'); assert.equal(parseHash('#/traffic/host/deepseek-dsh/h.test').harness, 'dsh')
  assert.equal(parseHash('#/traffic/host/some-new-agent/h.test').harness, 'some-new-agent', 'an id the table does not know passes through')
  assert.equal(parseHash('#/sessions?q=claude-code').params.q, 'claude-code', 'only harness parameters are folded, never free text')
})
test('an empty value is the same as an absent one; a malformed escape never throws', () => {
  assert.deepEqual(parseHash('#/sessions?q=&h=cc').params, { h: 'cc' })
  assert.doesNotThrow(() => parseHash('#/replay/%E0%A4%A/%zz?step=%'))
  assert.equal(parseHash('#/replay/%E0%A4%A/x').project, '%E0%A4%A')
})
test('an unknown route is 总览 carrying unknown:true (main.mjs says so in a toast), with the junk and its query dropped', () => {
  for (const h of ['#/nope', '#/nope/zzz?step=3', '#/capture/x', '#/traffic/host/cc', '#/traffic/host/cc/h/extra', '#/settings/colors', '#/overview/x', '#/sessions/p']) {
    const r = parseHash(h)
    assert.deepEqual(r, { ...OVERVIEW, unknown: true }, h); assert.equal(formatHash(r), '#/overview', 'formatting it writes the canonical landing hash')
  }
})
test('the prototype\'s #/system/... routes map onto the new ones (w becomes window)', () => {
  assert.deepEqual(parseHash('#/system/capture?h=kimi'), { area: 'capture', screen: 'capture', params: { h: 'kimi' } })
  assert.deepEqual(parseHash('#/system/traffic?w=24h'), { area: 'traffic', screen: 'traffic', params: { window: '24h' } })
  assert.deepEqual(parseHash('#/system/retention?w=7d'), { area: 'settings', screen: 'settings-storage', params: { window: '7d' } })
  assert.equal(parseHash('#/system').screen, 'capture'); assert.equal(parseHash('#/system/whatever').screen, 'capture')
  assert.equal(formatHash(parseHash('#/system/traffic?w=24h')), '#/traffic?window=24h', 'and they are rewritten, not kept')
})
test('format ∘ parse round-trips, with escaping, parameters sorted', () => {
  for (const h of ['#/overview?window=7d', '#/sessions?h=cc%2Ccodex&q=%E8%B0%83%E5%BA%A6', '#/replay/_unresolved/a%2Fb?step=3', '#/session/s-1?call=r%2F1', '#/capture?h=kimi', '#/capture/log',
    '#/traffic?class=llm&window=24h', '#/traffic/host/cc/api.example.test%3A443?ref=r1', '#/settings/storage?class=telemetry&h=cc', '#/settings/prices', '#/settings/appearance'])
    assert.equal(formatHash(parseHash(h)), h)
  assert.equal(formatHash(null), '#/overview'); assert.equal(formatHash({ screen: 'replay' }), '#/overview', 'a replay route without a session cannot be written')
})
test('document.title is the screen\'s name and the product\'s — a host page also names its host — and never carries a statistic', () => {
  const titles = ['#/overview', '#/sessions', '#/replay/p/i?step=40', '#/session/i', '#/capture', '#/capture/log', '#/traffic', '#/settings/storage', '#/settings/prices', '#/settings/appearance'].map((h) => documentTitle(parseHash(h)))
  assert.match(documentTitle(parseHash('#/traffic/host/cc/api.example.test')), /api\.example\.test/)
  assert.ok(titles.every((t) => !/\d/.test(t)), 'no digit: no count, no step')
  assert.equal(documentTitle(parseHash('#/nope')), documentTitle(parseHash('#/overview'))); assert.equal(documentTitle(null), documentTitle(parseHash('#/overview')))
  assert.deepEqual(Object.keys(SCREEN_NAME).sort(), ['capture', 'capture-log', 'library', 'overview', 'replay', 'session-link', 'settings-appearance', 'settings-prices', 'settings-storage', 'traffic', 'traffic-host'])
})

// ── scrubbing must not hammer history.replaceState (1.2 §路由 createUrlWriter) ──────────────────────────────────
// Holding ← / → fires dozens of URL writes a second; WebKit throws after 100 history calls in 30 s. A write ≥ gap after the last one
// lands in the same task (a reload right after a lone step change carries it); denser ones are ≥ gap apart; the last value always lands.
import * as router from '../../web/legacy/core/router.mjs'

// a writer on an injected clock: `at(t)` runs every timer due by t, in order, then sets the clock to t
function rig(gap) {
  let now = 0, nextId = 1
  const timers = new Map(), log = []
  const w = router.createUrlWriter({
    write: (v) => log.push({ v, t: now }), gap, now: () => now,
    setTimer: (f, ms) => { const id = nextId++; timers.set(id, { f, due: now + ms }); return id }, clearTimer: (id) => timers.delete(id),
  })
  const at = (t) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.due <= t).sort((p, q) => p[1].due - q[1].due)[0]
      if (!due) break
      timers.delete(due[0]); now = Math.max(now, due[1].due); due[1].f()
    }
    now = t
  }
  return { w, log, at, timers }
}

test('1.2 #13 createUrlWriter: a set ≥ gap after the last write lands before set() returns; writes are ≥ gap apart; the last value lands by lastSet + gap', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 }
  const gap = router.WRITE_GAP_MS
  for (let round = 0; round < 200; round++) {
    const { w, log, at } = rig(gap)
    const sets = []
    let t = 0
    for (let k = 0, n = 1 + Math.floor(rnd() * 40); k < n; k++) {
      t += rnd() < 0.3 ? gap + Math.floor(rnd() * 3 * gap) : Math.floor(rnd() * gap / 2)
      at(t)
      const lastWrite = log.length ? log[log.length - 1].t : -Infinity, before = log.length, v = `v${k}`
      const idle = w.pending() == null
      w.set(v); sets.push({ v, t })
      if (idle && t - lastWrite >= gap) assert.deepEqual(log.slice(before), [{ v, t }], `round ${round}: written in the same task`)
    }
    at(t + gap)
    for (let i = 1; i < log.length; i++) assert.ok(log[i].t - log[i - 1].t >= gap, `round ${round}: writes ${gap} ms apart`)
    assert.equal(log.at(-1).v, sets.at(-1).v, 'the last value lands'); assert.ok(log.at(-1).t <= sets.at(-1).t + gap)
    let j = 0
    for (const x of log) { while (j < sets.length && sets[j].v !== x.v) j++; assert.ok(j < sets.length, 'writes are a subsequence of the sets'); j++ }
    assert.equal(w.pending(), null)
  }
})

test('1.2 #13 createUrlWriter: flush writes the pending value now; cancel drops it', () => {
  const { w, log, at, timers } = rig(350)
  w.set('a'); at(10); w.set('b')
  assert.deepEqual(w.pending(), { value: 'b' })
  w.flush(); assert.deepEqual(log.map((x) => x.v), ['a', 'b']); assert.equal(timers.size, 0); w.flush(); assert.equal(log.length, 2)
  at(20); w.set('c'); w.cancel(); at(2000); assert.equal(log.length, 2); assert.equal(w.pending(), null)
})

// 4.4 §存下的答案: #/session/<id> finds the session's project in the list; a stored (older) list that lacks a newer session is not
// "not listed": the list is read again until it is fresh
test('#/session/<id> resolves a session newer than a stored list: no "not listed" from the stored answer', async () => {
  const { mount } = await import('../../web/legacy/replay/session-link.mjs')
  const row = (id) => ({ session_id: id, project_slug: `p-${id}`, harness: 'codex', title: null, last_ts: '2026-10-18T10:00:00.000Z' })
  let reads = 0, went = null
  const api = { get: async () => ({ ok: true, status: 200, data: ++reads === 1
    ? { sessions: [row('old')], errors: [], next: null, stored: { at: '2026-10-18T09:00:00.000Z' } }
    : { sessions: [row('old'), row('new')], errors: [], next: null } }) }
  const el = { innerHTML: '', replaceChildren() {} }
  const inst = mount(el, { api, router: { current: () => ({ id: 'new', params: {} }), go: (r) => { went = r } } })
  try {
    const end = Date.now() + 10_000
    while (!went && !el.innerHTML.includes('notlisted') && Date.now() < end) await new Promise((d) => setTimeout(d, 50))
    assert.ok(!el.innerHTML.includes('notlisted'), 'not said to be missing')
    assert.equal(went && went.project, 'p-new')
  } finally { inst.unmount() }
})
