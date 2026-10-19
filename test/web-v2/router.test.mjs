// core/router.mjs — every route and parameter of 1.2 §路由, #/session/<id>, the prototype's #/system/... routes mapped onto the new ones, an
// unknown route landing on 总览 (carrying the flag main.mjs turns into a toast), document.title per route, and the history writer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHash, formatHash, documentTitle } from '../../src/web/v2/core/router.mjs'
import { SCREEN_NAME } from '../../src/web/v2/labels/shell.mjs'

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

// ── A-M4: scrubbing must not hammer history.replaceState ─────────────────────────────────────────────────────────────
// Holding ← / → fires dozens of URL writes a second. Safari throws a SecurityError after ~100 calls in 30 s and Chromium drops
// the excess silently, so the URL step could end stale. Replace-writes coalesce into one trailing write; the last value always lands.
import { mock } from 'node:test'
import * as router from '../../src/web/v2/core/router.mjs'

test('trailing writer: only the last value of a burst is written, after the quiet period; flush and cancel are exact', () => {
  const log = [], timers = new Map(); let nextId = 1
  const w = router.createTrailingWriter({
    write: (v) => log.push(v), delay: 120,
    setTimer: (f, ms) => { const id = nextId++; timers.set(id, { f: () => { timers.delete(id); f() }, ms }); return id }, clearTimer: (id) => timers.delete(id),
  })
  w.set('a'); w.set('b'); w.set('c')
  assert.deepEqual(log, []); assert.equal(timers.size, 1, 'one timer for the whole burst'); assert.equal([...timers.values()][0].ms, 120)
  assert.deepEqual(w.pending(), { value: 'c' })
  ;[...timers.values()][0].f()
  assert.deepEqual(log, ['c']); assert.equal(w.pending(), null)
  w.set('d'); w.flush(); assert.deepEqual(log, ['c', 'd']); assert.equal(timers.size, 0, 'flush drops the timer'); w.flush(); assert.deepEqual(log, ['c', 'd'], 'nothing pending: nothing written')
  w.set('e'); w.cancel(); assert.equal(timers.size, 0); assert.equal(w.pending(), null); w.flush(); assert.deepEqual(log, ['c', 'd'])
})

// a window the router can run against in Node: history / location are what it touches
const LISTENERS = {} // the router wires its window listeners once per process (the first window it sees): later fake windows reuse them
function fakeWindow() {
  const calls = [], listeners = LISTENERS
  const loc = { hash: '', get href() { return 'http://x/v2/' + this.hash } }
  const hist = {
    fail: { replaceState: false, pushState: false },
    replaceState(s, t, h) { if (hist.fail.replaceState) throw new Error('SecurityError'); calls.push(['replace', h]); loc.hash = h },
    pushState(s, t, h) { if (hist.fail.pushState) throw new Error('SecurityError'); calls.push(['push', h]); loc.hash = h },
  }
  globalThis.window = { addEventListener: (type, fn) => { listeners[type] = fn } }; globalThis.location = loc; globalThis.history = hist
  return { calls, loc, hist, listeners }
}

test('router: a burst of replace-writes becomes one write of the last value; current() and subscribers see each value at once', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const win = fakeWindow(), seen = []
    router.onRoute((r) => seen.push(r.params.step))
    router.go({ area: 'replay', screen: 'replay', project: 'p', id: 'i', params: {} }, { replace: true }); win.calls.length = 0; mock.timers.tick(500); win.calls.length = 0
    for (let k = 1; k <= 40; k++) router.setParams({ step: String(k) }) // 40 scrubs: setParams merges onto the PENDING route, not the stale hash
    assert.equal(win.calls.length, 0, 'nothing written while the burst is on')
    assert.equal(router.current().params.step, '40', 'the route is the latest one even though the URL has not caught up')
    assert.equal(seen[seen.length - 1], '40')
    mock.timers.tick(119); assert.equal(win.calls.length, 0)
    mock.timers.tick(1)
    assert.deepEqual(win.calls, [['replace', '#/replay/p/i?step=40']], 'one write, the last value')
    assert.equal(router.current().params.step, '40'); assert.equal(win.loc.hash, '#/replay/p/i?step=40')
  } finally { mock.timers.reset() }
})

test('router: a navigation (push) first lands the pending replace on the entry it leaves, then pushes', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const win = fakeWindow()
    router.go({ area: 'sessions', screen: 'library', params: {} }, { replace: true }); mock.timers.tick(500); win.calls.length = 0
    router.setParams({ sel: 'p::s1' }) // pending replace
    router.go({ area: 'replay', screen: 'replay', project: 'p', id: 's1', params: {} }) // the user opens the row
    assert.deepEqual(win.calls, [['replace', '#/sessions?sel=p%3A%3As1'], ['push', '#/replay/p/s1']])
    win.calls.length = 0; mock.timers.tick(500); assert.deepEqual(win.calls, [], 'the flushed write does not run a second time')
  } finally { mock.timers.reset() }
})

test('router: Back / Forward cancels a pending replace (it belongs to the entry the reader left); leaving the page flushes it', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const win = fakeWindow()
    router.go({ area: 'sessions', screen: 'library', params: {} }, { replace: true }); mock.timers.tick(500); win.calls.length = 0
    router.setParams({ q: 'x' })
    win.loc.hash = '#/capture' // the browser moved to another entry
    win.listeners.popstate(); mock.timers.tick(500)
    assert.deepEqual(win.calls, [], 'a stale replace must not overwrite the entry Back landed on'); assert.equal(router.current().screen, 'capture')
    router.setParams({ h: 'cc' }); win.listeners.pagehide()
    assert.deepEqual(win.calls, [['replace', '#/capture?h=cc']], 'the last value lands even when the page goes away first')
  } finally { mock.timers.reset() }
})

test('router: a replaceState / pushState that throws (a rate-limited Safari) never throws out of go, and the route still changes', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const win = fakeWindow(), seen = []
    const off = router.onRoute((r) => seen.push(r.screen))
    router.go({ area: 'sessions', screen: 'library', params: {} }, { replace: true }); mock.timers.tick(500)
    win.hist.fail.replaceState = true
    router.setParams({ q: 'a' }); assert.doesNotThrow(() => mock.timers.tick(500))
    win.hist.fail.pushState = true
    assert.doesNotThrow(() => router.go({ area: 'traffic', screen: 'traffic', params: {} }))
    assert.equal(seen[seen.length - 1], 'traffic', 'subscribers were told')
    assert.equal(win.loc.hash, '#/traffic', 'the URL still follows (the fallback assigns the hash)'); assert.equal(router.current().screen, 'traffic')
    off()
  } finally { mock.timers.reset() }
})
