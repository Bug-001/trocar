// test/web-v2/library.test.mjs — the session library's contract (1.8 §验收 1–13), DOM-free: real `sessions` documents from the real
// face, or constructed session objects in the C.5 shape. Marks are asserted by kind (data-mark), never by their words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFilters, filtersToParams, applyFilters, listEntries, captionFacts, listSignature, capShotMaker, emptyBoardState, filteredAgentLine, agentMenuModel, flattenSessions, loadSessions, freshSessions } from '../../web/legacy/library/logic.mjs'
import { rowHtml, captionHtml, readFailHtml, filteredEmptyHtml, SKELETON } from '../../web/legacy/library/library.mjs'
import { harnessKey, harnessName, isKnownHarness } from '../../web/legacy/core/chips.mjs'
import { captureVerdict, capHealthPatch } from '../../web/legacy/core/capture-verdict.mjs'
import { esc } from '../../web/legacy/core/fmt.mjs'
import * as W from '../../web/legacy/labels/library.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime()
const S = (o = {}) => ({ session_id: 'sess-1', project_slug: '_unresolved', project_path: null, harness: 'codex', harness_inferred: false, session_synthesized: false, title: null, title_source: null, entrypoint: null, calls: 3, probes: 0, logged: 0, has_subagent: false, last_ts: new Date(NOW - 60e3).toISOString(), ...o })
const kinds = (html) => new Set([...html.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]))
const titleCell = (html) => /<span class="lt(?: pend)?"([^>]*)>([^<]*)</.exec(html)
const callsCell = (html) => /<span class="ln"([^>]*)>([^<]*)</.exec(html)

test('(1) rows: agent name and icon are the chip lookup for harnessKey(harness); the calls cell is `calls`', async () => {
  const face = await serveBoard(boardHome({ bytes: 200000 }))
  try {
    const ss = flattenSessions((await face.get('sessions')).doc)
    assert.ok(ss.length > 1)
    for (const s of ss) {
      const html = rowHtml(s, '', NOW), k = harnessKey(s.harness)
      assert.equal(/class="lhn"[^>]*>([^<]*)</.exec(html)[1], esc(harnessName(k)), s.session_id)
      assert.equal(/data-hicon="([^"]*)"/.exec(html)[1], s.harness != null && isKnownHarness(s.harness) ? k : '?')
      if (!(s.calls === 0 && s.probes > 0)) assert.equal(callsCell(html)[2], String(s.calls))
    }
  } finally { await face.close() }
})

test('(2) title rules: the hover follows title_source, a pending title reads as not read yet; no title ever carries the inferred mark', () => {
  const tips = new Set()
  for (const [title, title_source, tip] of [['Fix the queue', 'wire', W.titleFromWire], [null, null, W.titleNoKey], [null, 'pending', W.titlePending]]) {
    for (const harness_inferred of [false, true]) {
      const html = rowHtml(S({ title, title_source, harness_inferred }), '', NOW), [, attrs, text] = titleCell(html)
      assert.equal(/title="([^"]*)"/.exec(attrs)[1], esc(tip('sess-1')))
      assert.equal(text, esc(title ?? (title_source === 'pending' ? W.TITLE_PENDING : W.UNTITLED))); assert.ok(!text.includes('sess-1'), 'the id rides in the hover only')
      assert.ok(!/data-mark|mk-inf/.test(attrs + text))
      tips.add(tip('sess-1'))
    }
  }
  assert.equal(tips.size, 3)
})

test('(3)(4)(5) row marks follow their fields, table-driven; nothing marks a false or absent field', () => {
  const cases = [
    [{}, []],
    [{ entrypoint: 'cli' }, ['entry']], [{ entrypoint: 'something-new' }, ['entry']],
    [{ logged: 2 }, ['logged']], [{ logged: 0 }, []],
    [{ has_subagent: true }, ['subagent']], [{ has_subagent: false }, []],
    [{ harness_inferred: true }, ['inferred']],
    [{ session_synthesized: true }, ['synthesized']],
    [{ harnesses: ['codex', 'cc'] }, ['multi']], [{ harnesses: ['codex'] }, []], [{ provider: 'mixed' }, []],
    [{ project_slug: 'demo', project_path: '/w/demo' }, ['project']],
    [{ calls: 0, probes: 4 }, ['probe-only']], [{ calls: 0, probes: 0 }, []],
  ]
  for (const [o, want] of cases) {
    const html = rowHtml(S(o), '', NOW)
    assert.deepEqual([...kinds(html)].sort(), [...want].sort(), JSON.stringify(o))
    const dim = o.calls === 0 && o.probes > 0
    assert.equal(/class="lrow[^"]*\bdim\b/.test(html), dim)
    if (dim) assert.equal(callsCell(html)[2], esc(W.PROBE_ONLY)) // token-count only, no number
  }
})

test('(6) filters: search, multi-select agents with aliases and h=-, inclusive window, sort ties, groups only in recent, params round-trip', () => {
  const H = 3600e3
  const list = [
    S({ session_id: 'A1', harness: 'cc', title: 'Queue RETRY', calls: 5, last_ts: new Date(NOW - 1 * H).toISOString() }),
    S({ session_id: 'b2', harness: 'codex', project_slug: 'shop', project_path: '/w/Shop', calls: 5, last_ts: new Date(NOW - 50 * H).toISOString() }),
    S({ session_id: 'c3', harness: null, calls: 9, last_ts: new Date(NOW - 24 * H).toISOString() }),
    S({ session_id: 'd4', harness: 'cc', calls: 1, last_ts: null }),
  ].map((s) => flattenSessions({ sessions: [s] })[0])
  const ids = (p) => applyFilters(list, parseFilters(p), NOW).map((s) => s.session_id)
  assert.deepEqual(ids({ q: 'retry' }), ['A1']); assert.deepEqual(ids({ q: 'SHOP' }), ['b2']); assert.deepEqual(ids({ q: 'C3' }), ['c3'])
  assert.deepEqual(ids({ h: 'claude-code' }), ids({ h: 'cc' })); assert.deepEqual(ids({ h: 'cc' }).sort(), ['A1', 'd4'])
  assert.deepEqual(ids({ h: 'cc,codex' }).sort(), ['A1', 'b2', 'd4']); assert.deepEqual(ids({ h: '-' }), ['c3'])
  assert.deepEqual(ids({ window: '24h' }), ['A1', 'c3'], 'exactly 24 h old is inside; no time is outside')
  assert.ok(ids({ window: 'all' }).includes('d4')); assert.ok(!ids({ window: '7d' }).includes('d4'))
  assert.deepEqual(ids({ sort: 'calls' }), ['c3', 'A1', 'b2', 'd4'], 'a calls tie goes to the more recent')
  const groups = (sort) => listEntries(applyFilters(list, parseFilters({ sort }), NOW), sort === 'calls' ? 'calls' : 'recent', NOW).filter((e) => 'g' in e).map((e) => e.g)
  assert.deepEqual(groups(undefined), ['today', 'yesterday', 'earlier', 'none']); assert.deepEqual(groups('calls'), [])
  const p = { q: 'x', h: 'cc,kimi', project: 'shop', window: '7d', sort: 'calls', sel: 'shop::b2' }
  assert.deepEqual(filtersToParams(parseFilters(p)), p)
  assert.deepEqual(filtersToParams(parseFilters({})), {})
  assert.deepEqual(filtersToParams(parseFilters({ window: '30d', sort: 'steps' })), {})
})

test('(7) no number or sentence in the skeleton head or tool row, no window control outside the page head, menu items carry no count', () => {
  const text = SKELETON.replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ')
  assert.ok(!/\d/.test(text)); assert.ok(!/class="seg"|data-window|name="window"/.test(SKELETON))
  const m = agentMenuModel([S(), S({ harness: 'cc' }), S({ harness: null })], parseFilters({}))
  for (const item of m) assert.deepEqual(Object.keys(item).sort(), ['id', 'on'])
})

test('(8) caption: clean errors[] → none; N errors → a link to #/settings/storage and every where · reason, escaped', () => {
  assert.equal(captionHtml([], null, null), '')
  for (const n of [1, 3]) {
    const errors = Array.from({ length: n }, (_, i) => ({ where: `seg-${i}.ndjson`, reason: `<script>x${i}</script>` }))
    const html = captionHtml(errors, null, null)
    assert.equal(captionFacts(errors).facts[0].n, n)
    assert.ok(html.includes('href="#/settings/storage"'))
    assert.ok(!html.includes('<script>'))
    for (const e of errors) { assert.ok(html.includes(esc(e.where))); assert.ok(html.includes(esc(e.reason))) }
  }
})

test('(9) a failed read with no list is the read-failure state with retry, never the empty library', () => {
  const html = readFailHtml({ ok: false, status: 500, error: '<b>boom</b>' })
  assert.ok(html.includes('data-act="retry"')); assert.ok(!html.includes(esc(W.NO_SESSIONS))); assert.ok(!html.includes('<b>boom'))
  const cap = captionHtml([], { ok: false, status: 500, error: 'boom' }, NOW - 5000) // with an older list, the caption carries retry
  assert.ok(cap.includes('data-act="retry"'))
})

test('(10) empty state: the line is the capture verdict of the status read once; status is read exactly once however often it is asked', async () => {
  const docs = {
    'not-installed': { status: 200, data: { health: { state: 'not-installed' } } },
    stopped: { status: 200, data: { health: { state: 'not-running', since: new Date(NOW - 3 * 3600e3).toISOString() } } },
    failing: { status: 200, data: { health: { state: 'failing', n: 1 }, harnesses: { codex: { captured: false } } } },
    ok: { status: 200, data: { health: { state: 'ok' } } },
    unreadable: { status: 200, data: { errors: [{ where: 'capture health', reason: 'health file unreadable' }] } },
  }
  for (const [name, r] of Object.entries(docs)) {
    let reads = 0
    const shot = capShotMaker(async () => { reads++; return { ok: r.status === 200, ...r } }, () => NOW)
    await Promise.all([shot.read(), shot.read()]); await shot.read(); await shot.read()
    assert.equal(reads, 1, name)
    const want = name === 'ok' ? W.CAPTURING_HINT : captureVerdict(capHealthPatch({ ok: true, ...r }, NOW).capH, { okAt: NOW, now: NOW }).text
    assert.equal(emptyBoardState(shot.settled).line, want, name)
  }
})

test('(11) a filtered agent that is not captured links #/capture?h=<id>; otherwise only the filter-empty state', () => {
  const doc = (captured) => ({ health: { state: 'ok' }, harnesses: { 'kimi-code': { captured, ...(captured ? {} : { reason: 'not-steered' }) } } })
  const f = parseFilters({ h: 'kimi' })
  const off = filteredEmptyHtml({ h: doc(false), asOf: NOW }, f)
  assert.ok(off.includes('href="#/capture?h=kimi"')); assert.ok(off.includes('data-act="clear"'))
  assert.deepEqual(filteredAgentLine({ h: doc(false), asOf: NOW }, 'kimi').href, '#/capture?h=kimi')
  for (const d of [doc(true), { health: { state: 'ok' } }]) {
    const on = filteredEmptyHtml({ h: d, asOf: NOW }, f)
    assert.ok(!on.includes('#/capture')); assert.ok(on.includes('data-act="clear"'))
  }
})

test('(12) the repaint signature moves with every displayed field and holds for identical lists', () => {
  const base = S({ title: 't', title_source: 'wire', project_slug: 'p', project_path: '/w/p' })
  const sig = (o) => listSignature({ sessions: [{ ...base, ...o }], errors: [] }, null)
  assert.equal(sig({}), listSignature({ sessions: [{ ...base }], errors: [] }, null))
  const changes = { title: 'u', title_source: 'pending', harnesses: ['codex', 'cc'], logged: 1, calls: 4, probes: 2, has_subagent: true, last_ts: new Date(NOW).toISOString(), entrypoint: 'cli', harness_inferred: true, session_synthesized: true, project_slug: 'q', project_path: '/w/q' }
  for (const [k, v] of Object.entries(changes)) assert.notEqual(sig({ [k]: v }), sig({}), k)
})

test('(13) each row is one <a> with no nested focusable; truncated cells carry a title; the id is escaped in the href', () => {
  const html = rowHtml(S({ session_id: 'a"<b>', title: 'x'.repeat(300), project_slug: 'demo', project_path: '/w/demo', logged: 1, harnesses: ['codex', 'cc'] }), '', NOW)
  assert.equal(html.match(/<a\b/g).length, 1)
  assert.ok(!/<(button|input|select|textarea)\b|tabindex=/.test(html))
  assert.ok(!html.includes('a"<b>'))
  for (const cls of ['lt', 'lhn']) assert.match(html, new RegExp(`class="${cls}" title="[^"]+"`))
  assert.match(html, /data-mark="project" title="[^"]+"/)
})

test('caption: a note is not counted as an unread file, yet it stays in technical details', () => {
  const cf = captionFacts([{ where: 'a', reason: 'r', level: 'note' }, { where: 'b', reason: 'r' }, { where: 'c', reason: 'r' }])
  assert.equal(cf.facts[0].n, 2); assert.equal(cf.tech.length, 3)
  const only = captionFacts([{ where: 'a', reason: 'r', level: 'note' }])
  assert.deepEqual(only.facts, []); assert.equal(only.tech.length, 1)
})

test('the library skeleton holds no <header> landmark of its own', () => {
  assert.ok(!SKELETON.includes('<header'))
})

// 1.8 §说明行 「在刷新」 · §数据与刷新 · assertion 17 (unit part): the fact is an element, asserted by its hook, never its words
test('(17) caption: the refreshing fact is there exactly when the list carries `stored`', () => {
  const at = new Date(NOW - 90e3).toISOString()
  for (const errors of [[], [{ where: 'a', reason: 'r' }]]) {
    assert.match(captionHtml(errors, null, null, { stored: at, now: NOW }), /data-stored/)
    assert.doesNotMatch(captionHtml(errors, null, null, { stored: null, now: NOW }), /data-stored/)
  }
})

test('(17) the repaint signature moves when `stored` comes or goes', () => {
  const doc = { sessions: [S()], errors: [] }
  const at = new Date(NOW - 90e3).toISOString()
  assert.notEqual(listSignature({ ...doc, stored: at }, null), listSignature({ ...doc, stored: null }, null))
  assert.notEqual(listSignature({ ...doc, stored: at }, null), listSignature(doc, null))
})

// 4.4 §存下的答案: a screen that draws a conclusion from the list (not the Sessions page) waits for a fresh answer
test('(17) freshSessions: an answer that carries stored is read again 1.5 s later until fresh; a screen gone stops it', async () => {
  const fresh = { sessions: [S({ session_id: 'b' })], errors: [], next: null }
  const old = { sessions: [S({ session_id: 'a' })], errors: [], next: null, stored: { at: new Date(NOW - 60e3).toISOString() } }
  let reads = 0
  const api = { get: async () => ({ ok: true, status: 200, data: ++reads === 1 ? old : fresh }) }
  const r = await freshSessions(api)
  assert.deepEqual(r.data.sessions.map((s) => s.session_id), ['b'])
  assert.equal(r.data.stored, null)
  assert.equal(reads, 2)
  reads = 0
  const gone = await freshSessions(api, { alive: () => false })
  assert.equal(reads, 1, 'no read after the screen is gone')
  assert.equal(gone.data.stored, old.stored.at)
})

test('(17) loadSessions: a list with a stored page carries the oldest stored at; a session on two pages is listed once', async () => {
  const t1 = new Date(NOW - 120e3).toISOString(), t2 = new Date(NOW - 60e3).toISOString()
  const a = S({ session_id: 'a' }), b = S({ session_id: 'b' }), c = S({ session_id: 'c' })
  const run = async (pages) => {
    const api = { get: async (name, { after }) => ({ ok: true, status: 200, data: pages[after == null ? 0 : Number(after)] }) }
    return (await loadSessions(api, { limit: 2 })).data
  }
  const p1 = (o) => ({ sessions: [a, b], errors: [], next: '1', ...o }), p2 = (o) => ({ sessions: [b, c], errors: [], next: null, ...o })
  for (const [pages, want] of [[[p1({}), p2({})], null], [[p1({ stored: { at: t2 } }), p2({})], t2], [[p1({}), p2({ stored: { at: t1 } })], t1], [[p1({ stored: { at: t2 } }), p2({ stored: { at: t1 } })], t1], [[p1({ stored: { at: t1 } }), p2({ stored: { at: t2 } })], t1]]) {
    const d = await run(pages)
    assert.equal(d.stored, want)
    assert.deepEqual(d.sessions.map((s) => s.session_id).sort(), ['a', 'b', 'c'])
  }
})
