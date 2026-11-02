// test/web-v2/library.test.mjs — the session library's contract (1.8 §验收), DOM-free: constructed session objects in the C.5
// shape. Marks are asserted by kind, never by their words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFilters, filtersToParams, applyFilters, listEntries, captionFacts, capShotMaker, emptyBoardState, filteredAgentLine, flattenSessions, rowModel, sessionKey } from '../../web/src/screens/library/model.mjs'
import { loadSessions, freshSessions } from '../../web/legacy/library/logic.mjs'
import { captureVerdict, capHealthPatch } from '../../web/legacy/core/capture-verdict.mjs'
import * as W from '../../web/legacy/labels/library.mjs'

const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime()
const S = (o = {}) => ({ session_id: 'sess-1', project_slug: '_unresolved', project_path: null, harness: 'codex', harness_inferred: false, session_synthesized: false, title: null, title_source: null, entrypoint: null, calls: 3, probes: 0, logged: 0, has_subagent: false, last_ts: new Date(NOW - 60e3).toISOString(), ...o })

test('(3)(4)(5) row marks follow their fields, table-driven; nothing marks a false or absent field; probe-only is dim', () => {
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
    const m = rowModel(S(o), NOW)
    assert.deepEqual(m.marks.map((x) => x.kind).sort(), want.filter((k) => k !== 'probe-only').sort(), JSON.stringify(o))
    assert.equal(m.dim, want.includes('probe-only'), JSON.stringify(o))
  }
  const all = rowModel(S({ entrypoint: 'cli', logged: 2, has_subagent: true, harness_inferred: true, session_synthesized: true, harnesses: ['codex', 'cc'], project_slug: 'demo', project_path: '/w/demo' }), NOW)
  assert.deepEqual(all.marks.map((x) => x.kind), ['entry', 'project', 'inferred', 'synthesized', 'multi', 'subagent', 'logged'], 'the marks keep one order')
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
  for (const sort of ['recent', 'calls']) {
    const es = listEntries(applyFilters(list, parseFilters({ sort }), NOW), sort, NOW)
    assert.equal(new Set(es.map((e) => e.key)).size, es.length, 'every entry key is unique')
    for (const e of es) if (e.s) assert.equal(e.key, sessionKey(e.s))
  }
  const p = { q: 'x', h: 'cc,kimi', project: 'shop', window: '7d', sort: 'calls', sel: 'shop::b2' }
  assert.deepEqual(filtersToParams(parseFilters(p)), p)
  assert.deepEqual(filtersToParams(parseFilters({})), {})
  assert.deepEqual(filtersToParams(parseFilters({ window: '30d', sort: 'steps' })), {})
})

test('(8) caption: n counts the non-note errors; tech lists every entry, notes too; a stored fact exactly when stored is given', () => {
  const at = new Date(NOW - 90e3).toISOString()
  for (const errs of [0, 1, 3]) for (const notes of [0, 2]) for (const stored of [null, at]) {
    const errors = [...Array.from({ length: errs }, (_, i) => ({ where: `seg-${i}.ndjson`, reason: 'r' })), ...Array.from({ length: notes }, (_, i) => ({ where: `n-${i}`, reason: 'slow', level: 'note' }))]
    const cf = captionFacts(errors, stored), why = JSON.stringify({ errs, notes, stored })
    assert.deepEqual(cf.facts.filter((x) => x.kind === 'not-all').map((x) => x.n), errs ? [errs] : [], why)
    assert.deepEqual(cf.facts.filter((x) => x.kind === 'stored').map((x) => x.at), stored ? [stored] : [], why)
    assert.equal(cf.tech.length, errors.length, why)
  }
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

test('(11) a filtered agent that is not captured links #/capture?h=<id>; captured, or no entry for it, adds nothing', () => {
  const doc = (captured) => ({ health: { state: 'ok' }, harnesses: { 'kimi-code': { captured, ...(captured ? {} : { reason: 'not-steered' }) } } })
  assert.equal(filteredAgentLine({ h: doc(false), asOf: NOW }, 'kimi').href, '#/capture?h=kimi')
  for (const d of [doc(true), { health: { state: 'ok' } }]) assert.equal(filteredAgentLine({ h: d, asOf: NOW }, 'kimi'), null)
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
