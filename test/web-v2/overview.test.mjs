// overview.test.mjs — the overview's model (1.7 §验收, web/src/screens/overview/model.mjs): the capture card is never blank, each
// 事项 class appears iff its trigger holds and links to its page, no false 「nothing to handle」, the stats' marks, the recent list,
// the first-use agent rows and the harness identity. The component's contracts (window, read-only, alert semantics, re-reads) are
// in OverviewScreen.test.tsx. Status documents are the C.3 sample of spec 1.6 with fields changed per case; the closed set of
// health.state is read off the same table. Assertions are on fields, hrefs, ids and labels/*.mjs words, never prose.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  overviewItems, recentRows, firstUse, capCard, itemsCard, statsCard, recentCard, agentRows,
} from '../../web/src/screens/overview/model.mjs'
import { capHealthPatch, captureVerdict } from '../../web/legacy/core/capture-verdict.mjs'
import { INTERVAL } from '../../web/legacy/core/poll.mjs'
import { ALIASES, HARNESS_ORDER, UNIDENTIFIED, harnessKey, harnessName } from '../../web/legacy/core/chips.mjs'
import { TITLE_FROM_WIRE } from '../../web/legacy/labels/replay.mjs'
import { FILES_NOT_READ } from '../../web/legacy/labels/overview.mjs'
import { UNTITLED, TITLE_PENDING, TITLE_PENDING_TIP } from '../../web/legacy/labels/common.mjs'
import { ERR_WHERE, COMMANDS } from '../../web/legacy/labels/capture.mjs'
import { fmtWhen, bytes } from '../../web/legacy/core/fmt.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const SAMPLE = JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const HEALTH_STATES = (() => {
  const row = C3.split('\n').find((l) => l.startsWith('| `health` |'))
  const seg = row.slice(row.indexOf('`state` ∈'), row.indexOf('另带'))
  return [...seg.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((s) => s !== 'state')
})()
const QUIET = ['ok', 'off', 'not-installed'] // 1.7 §事项目录: the states that need no item

const NOW = Date.parse('2026-10-20T12:00:00Z'), H = 3600e3
const iso = (ago) => new Date(NOW - ago).toISOString()
const [A, B] = HARNESS_ORDER
const [CLI] = Object.keys(ALIASES)
// a status document with nothing to handle: the sample with its one agent captured and no failure, condition or pending item
const quiet = () => {
  const d = structuredClone(SAMPLE)
  d.health = { state: 'ok', since: iso(5 * H) }
  for (const v of Object.values(d.harnesses)) Object.assign(v, { captured: true, reason: null, why: null })
  d.topology = {}
  d.failures = { problem: 0, expected: 0, note: 0, since: iso(24 * H), latest: null, groups: [] }
  d.critical = []
  return d
}
const session = (i, over = {}) => ({
  session_id: `s${i}`, project_slug: `p${i}`, harness: A, harness_inferred: false, title: `t${i}`, title_source: 'wire',
  calls: 2, probes: 0, last_ts: iso(i * H), ...over,
})
const ok = (data) => ({ data, ok: true, err: null })
const failed = (data = null) => ({ data, ok: false, err: 'HTTP 500' })
const stateOf = (status, over = {}) => ({
  w: '24h', caph: { data: status, okAt: NOW, err: null, ok: true },
  sessions: ok({ sessions: [session(1)], errors: [] }), classes: ok({ disk: { trocar_bytes: 1e6 } }), pricing: ok({ models: [] }),
  stats: { ...ok({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 2 }, harnesses: [], usage: { rows: [], coverage: {} } }), other: false },
  traffic: ok({ hosts: [], harness_since: {} }), segments: ok({ segments: [] }), ...over,
})
const statsOk = (doc) => ({ ...ok(doc), other: false })
const group = (o) => ({ level: 'problem', where: 'engine', code: 'trust-rejected', count: 2, first_ts: iso(2 * H), last_ts: iso(H), reason: 'r', ...o })
const BAD = /undefined|NaN|Invalid/

test('#1 the capture card says the verdict\'s sentence for every capture state, an unreadable health, a stale read and an unknown state — never blank (D38②)', () => {
  assert.ok(HEALTH_STATES.length >= 8, String(HEALTH_STATES))
  const cases = []
  for (const state of HEALTH_STATES) cases.push([state, { data: { ...quiet(), health: { state, since: iso(H), n: 2 } }, okAt: NOW }])
  cases.push(['not-running + signal', { data: { ...quiet(), health: { state: 'not-running', since: iso(H), signal: 'SIGKILL' } }, okAt: NOW }])
  cases.push(['unknown without reason', { data: { ...quiet(), health: { state: 'unknown' } }, okAt: NOW }])
  cases.push(['unknown with reason', { data: { ...quiet(), health: { state: 'unknown', reason: 'lock unreadable' } }, okAt: NOW }])
  const p = capHealthPatch({ ok: true, status: 200, data: { errors: [{ where: 'capture health', reason: 'health unreadable' }] } }, NOW)
  cases.push(['unreadable', { data: p.capH, okAt: p.capHOkAt }])
  cases.push(['stale', { data: quiet(), okAt: NOW - 2 * INTERVAL.status - 1 }])
  cases.push(['never read, failed', { data: null, okAt: null, err: 'ECONNREFUSED' }])
  cases.push(['unrecognized state', { data: { ...quiet(), health: { state: 'zz-new' } }, okAt: NOW }])
  cases.push(['read_errors', { data: { ...quiet(), health: { state: 'ok', since: iso(H), read_errors: 2 } }, okAt: NOW }])
  cases.push(['all errors', { data: { ok: false, errors: [{ where: 'status', reason: 'x' }] }, okAt: NOW }])
  for (const [name, caph] of cases) {
    const c = { err: null, ok: true, ...caph }
    const card = capCard(c, NOW)
    assert.ok(card.text && card.text.trim(), name)
    // the capture page's service row says the same sentence (1.7 §采集卡: one function)
    assert.equal(card.text, captureVerdict(c.data, { okAt: c.okAt, err: c.err, now: NOW }).text, name)
    assert.doesNotMatch(JSON.stringify(card), BAD, name)
  }
})

// each case: a change to the quiet state → the classes that must appear, each with the href of the 1.7 table
const CASES = [
  ['nothing', () => {}, {}],
  ['O1 · a condition on an agent (two on one agent, CLI and read-side id → one item)', (s) => { s.caph.data.critical = [{ kind: 'trust-rejected', harness: CLI, reason: 'r' }, { kind: 'x', harness: harnessKey(CLI), reason: 'r2' }] }, { O1: [`#/capture?h=${harnessKey(CLI)}`] }],
  ['O1 · captured false while desired on', (s) => { Object.assign(Object.values(s.caph.data.harnesses)[0], { captured: false, reason: 'config-after-start' }) }, { O1: [`#/capture?h=${harnessKey(Object.keys(SAMPLE.harnesses)[0])}`] }],
  ['O1 · captured false while desired off → none', (s) => { Object.assign(Object.values(s.caph.data.harnesses)[0], { desired: 'off', captured: false, reason: 'config-after-start' }) }, {}],
  ['O1′ · agent-less condition, the certificate, the agent list', (s) => {
    s.caph.data.critical = [{ kind: 'k', reason: 'r' }]
    s.caph.data.cert.root = { state: 'bad', code: 'ca-invalid', reason: 'r' }
    s.caph.data.agent_list.problems = [{ code: 'bad-json', reason: 'r' }]
  }, { O1p: ['#/capture', '#/capture', '#/capture'] }],
  ['O2 · stopped', (s) => { s.caph.data.health = { state: 'not-running', since: iso(H) }; Object.assign(s.caph.data.daemon, { running: false }) }, { O2: ['#/capture'] }],
  ['O2 · not responding', (s) => { s.caph.data.health = { state: 'not-responding', since: iso(H) }; Object.assign(s.caph.data.daemon, { responding: false }) }, { O2: ['#/capture'] }],
  ['O2 · daemon.error', (s) => { s.caph.data.health = { state: 'unknown', reason: 'lock unreadable' }; s.caph.data.daemon.error = 'lock unreadable' }, { O2: ['#/capture'] }],
  ['O2 · unreadable', (s) => { s.caph.data = capHealthPatch({ ok: true, status: 200, data: { errors: [{ where: 'capture health', reason: 'e' }] } }, NOW).capH }, { O2: ['#/capture'] }],
  ['O3 · groups with and without an agent; expected-level groups are not items', (s) => {
    s.caph.data.failures.groups = [group({ harness: B }), group({ where: 'daemon', code: 'start-failed' }), group({ level: 'expected', harness: A })]
  }, { O3: [`#/capture?h=${harnessKey(B)}`, '#/capture/log'] }],
  ['O3 · raw-layer groups from segments of the last 24 h; an older segment says nothing', (s) => {
    s.segments = ok({ segments: [{ segment: 'a', to: iso(H), problems: [{ code: 'record-unparseable', reason: 'r' }] }, { segment: 'b', to: iso(30 * H), problems: [{ code: 'segment-unreadable', reason: 'r' }] }] })
  }, { O3: ['#/capture/log'] }],
  ['O4 · install not complete', (s) => { s.caph.data.install = { state: 'incomplete', harnesses: [], pending: [] } }, { O4: ['#/capture/log'] }],
  ['O4 · the install manifest cannot be read', (s) => { s.caph.data.errors = [{ where: ERR_WHERE.manifest, reason: 'r' }] }, { O4: ['#/capture/log'] }],
  ['O5 · pending items', (s) => { s.caph.data.install = { state: 'incomplete', harnesses: [], pending: [{ what: 'x' }] } }, { O5: ['#/capture'] }],
  ['O6 · capture files not read whole', (s) => { s.sessions = ok({ sessions: [session(1)], errors: [{ where: 'a', reason: 'r' }, { where: 'b', reason: 'r' }] }) }, { O6: ['#/settings/storage'] }],
]

test('#2 each item class appears iff its trigger holds, and links to the page of the 1.7 table; the card rows keep the hrefs under unique ids', () => {
  for (const [name, change, want] of CASES) {
    const s = stateOf(quiet()); change(s)
    const got = {}
    for (const r of overviewItems(s, NOW).rows) (got[r.cls] ||= []).push(r.href)
    assert.deepEqual(got, want, name)
    const card = itemsCard(s, NOW), cardGot = {}
    for (const r of card.rows) (cardGot[r.cls] ||= []).push(r.href)
    assert.deepEqual(cardGot, want, name)
    assert.equal(new Set(card.rows.map((r) => r.id)).size, card.rows.length, `${name}: ids are unique`)
  }
  const s = stateOf(quiet()); s.caph.data.health = { state: 'unknown' }; s.caph.data.daemon.error = 'lock file is not JSON'
  assert.ok(overviewItems(s, NOW).rows.find((r) => r.cls === 'O2').text.includes('lock file is not JSON'), 'O2 carries daemon.error')
})

// 1.7 §事项目录 · 1.5 一件事只说一处: the chip is the item's subject — the sentence after it never starts with the agent's name again; an
// O1 item's sentence is the capture page row's own (agentVerdicts), word for word
test('an item with an agent chip does not name the agent again: O1 is the capture row\'s sentence itself, O9 starts with the host', async () => {
  const { agentVerdicts } = await import('../../web/legacy/core/capture-verdict.mjs')
  const s = stateOf(quiet())
  const [id] = Object.keys(s.caph.data.harnesses)
  Object.assign(s.caph.data.harnesses[id], { captured: false, reason: 'config-after-start' })
  s.caph.data.critical = [{ kind: 'untrusted', harness: B, code: 'var-missing', since: iso(H) }]
  s.caph.data.failures.groups = [group({ harness: B })]
  s.traffic = ok({ hosts: [{ harness: A, host: 'h.example', first_seen: iso(H), requests: 1 }, { harness: null, host: 'n.example', first_seen: iso(H), requests: 1 }], harness_since: { [A]: iso(48 * H), null: iso(48 * H) } })
  const rows = itemsCard(s, NOW).rows
  const said = new Map(agentVerdicts(s.caph.data).map((r) => [r.harness, r.text]))
  assert.ok(rows.some((r) => r.cls === 'O1') && rows.some((r) => r.cls === 'O9'), JSON.stringify(rows.map((r) => r.cls)))
  for (const r of rows) {
    if (r.chip != null) assert.ok(!r.text.startsWith(harnessName(r.chip)), `${r.cls}: ${r.text}`)
    if (r.cls === 'O1') assert.equal(r.text, said.get(r.chip))
    if (r.cls === 'O9') assert.ok(r.chip != null || r.subject, `${r.cls} without a chip names its subject: ${JSON.stringify(r)}`)
  }
})

test('#2 a class with more than five items shows five and one 「N more」 link to its page', () => {
  const s = stateOf(quiet())
  s.caph.data.critical = Array.from({ length: 7 }, (_, i) => ({ kind: `k${i}`, reason: 'r' }))
  s.caph.data.failures.groups = Array.from({ length: 8 }, (_, i) => group({ code: `c${i}` }))
  const card = itemsCard(s, NOW)
  assert.equal(card.rows.filter((r) => r.cls === 'O1p').length, 5)
  assert.equal(card.rows.filter((r) => r.cls === 'O3').length, 5)
  assert.deepEqual(card.more.map((m) => m.href).sort(), ['#/capture', '#/capture/log'])
  assert.equal(new Set(card.more.map((m) => m.id)).size, 2)
})

test('#3 no false 「nothing to handle」: a failed source draws the partial note; a capture state that is not fine has an item', () => {
  for (const slot of ['sessions', 'classes', 'pricing', 'stats', 'traffic', 'segments']) {
    for (const v of [failed(), failed(stateOf(quiet())[slot].data)]) {
      const card = itemsCard(stateOf(quiet(), { [slot]: v }), NOW)
      assert.equal(card.empty, null, slot); assert.ok(card.partial, slot)
    }
  }
  const s = stateOf(quiet()); s.caph = { data: quiet(), okAt: NOW, err: 'HTTP 500', ok: false }
  assert.equal(itemsCard(s, NOW).empty, null); assert.ok(itemsCard(s, NOW).partial)
  const all = itemsCard(stateOf(quiet()), NOW)
  assert.equal(all.empty, 'none', 'all read and nothing triggered → the empty line'); assert.equal(all.partial, null)
  assert.notEqual(itemsCard(stateOf(quiet(), { traffic: { data: null, ok: null, err: null } }), NOW).empty, 'none', 'a source not answered yet is not 「none」')
  for (const state of [...HEALTH_STATES.filter((x) => !QUIET.includes(x)), 'zz-new']) {
    for (const health of [{ state, since: iso(H), n: 1 }, { state, since: iso(H), reason: 'r' }]) {
      assert.ok(itemsCard(stateOf({ ...quiet(), health }), NOW).rows.length >= 1, `${JSON.stringify(health)} has an item`)
    }
  }
  const items = overviewItems(stateOf(capHealthPatch({ ok: true, status: 200, data: { errors: [{ where: 'capture health', reason: 'e' }] } }, NOW).capH), NOW)
  assert.ok(items.rows.length >= 1, 'an unreadable capture health has an item')
})

test('#5 the hit carries the 「?」 mark when a main row\'s cache figures are not known; no priced row → the unknown mark, never $0', () => {
  const row = (o) => ({ harness: A, model: 'zz-unpriced-model', lane: 'main', sessions: 1, calls: 3, failed: 0, no_usage: 0, input: 10, output: 5, cache_read: 30, cache_write: 10, cache_known: true, ...o })
  const doc = { as_of: iso(H), sessions: { total: 1 }, calls: { llm: 3 }, harnesses: [{ harness: A, sessions: 1, calls: 3, last_ts: iso(H) }], usage: { rows: [row(), row({ cache_known: false })], coverage: { sessions_read: 1, sessions_in_window: 1 } } }
  const card = statsCard(stateOf(quiet(), { stats: statsOk(doc) }), NOW)
  assert.equal(card.kind, 'shown')
  assert.match(card.hit.text, /^\d+%\?$/); assert.ok(card.hit.tip)
  assert.equal(card.cost.text, '≈ —')
  assert.doesNotMatch(JSON.stringify(card), /\$0(?![.\d]*[1-9])/)
  assert.ok(card.asOf.includes(fmtWhen(Date.parse(doc.as_of), NOW)), 'the card says 截至 <as_of>')
})

test('#6 the coverage line names the agents with sessions in the window that the overview document lacks, and only those', () => {
  const stats = statsOk({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 1 }, harnesses: [{ harness: HARNESS_ORDER[2], sessions: 1, calls: 1, last_ts: iso(H) }], usage: { rows: [], coverage: {} } })
  const sessions = ok({ sessions: [session(1, { harness: A }), session(30, { harness: B }), session(2, { harness: HARNESS_ORDER[2] })], errors: [] })
  const missing = (w) => statsCard({ ...stateOf(quiet(), { stats, sessions }), w }, NOW).missing || ''
  assert.ok(missing('24h').includes(harnessName(A))); assert.ok(!missing('24h').includes(harnessName(B)))
  assert.ok(missing('all').includes(harnessName(B))); assert.ok(!missing('all').includes(harnessName(HARNESS_ORDER[2])))
})

test('#7 no session in the window: the empty line, never a row of 0s or a cost', () => {
  const card = statsCard(stateOf(quiet(), { stats: statsOk({ as_of: iso(H), sessions: { total: 0 }, calls: { llm: 0 }, harnesses: [], usage: { rows: [], coverage: {} } }) }), NOW)
  assert.equal(card.kind, 'shown'); assert.equal(card.empty, true)
  assert.equal(card.cost, null); assert.equal(card.sessions, null); assert.deepEqual(card.agents, [])
  assert.deepEqual(statsCard(stateOf(quiet(), { stats: { data: null, ok: null, err: null, other: false } }), NOW), { kind: 'reading' })
  assert.equal(statsCard(stateOf(quiet(), { stats: { ...failed(), other: false } }), NOW).kind, 'failed')
})

test('#11 recent sessions: the five newest by last_ts, the hover by title_source, untitled without a time, a pending title as not read yet, the probe-only mark, the replay href', () => {
  const rows = [session(3), session(1, { title: null, title_source: null }), session(6), session(2),
    session(4, { calls: 0, probes: 3 }), session(7), session(5, { title: null, title_source: 'pending' })]
  const want = [...rows].sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts)).slice(0, 5)
  assert.deepEqual(recentRows({ sessions: rows }).map((r) => r.id), want.map((r) => r.session_id))
  const card = recentCard(stateOf(quiet(), { sessions: ok({ sessions: rows, errors: [] }) }), NOW)
  assert.equal(card.kind, 'shown'); assert.equal(card.rows.length, 5)
  want.forEach((m, i) => {
    const r = card.rows[i]
    assert.equal(r.id, `${m.project_slug}::${m.session_id}`)
    assert.equal(r.href, `#/replay/${m.project_slug}/${m.session_id}`)
    if (m.title != null) assert.ok(r.titleTip.includes(TITLE_FROM_WIRE), r.titleTip)
    else if (m.title_source === 'pending') {
      assert.equal(r.title, TITLE_PENDING, 'a title not read yet is not drawn as untitled')
      assert.equal(r.pending, true)
      assert.ok(r.titleTip.includes(TITLE_PENDING_TIP), r.titleTip)
    } else {
      assert.equal(r.title, UNTITLED)
      assert.equal(r.pending, false)
      assert.ok(!r.title.includes(fmtWhen(Date.parse(m.last_ts), NOW)), 'the untitled title carries no time: the row has its last-active column')
    }
    assert.equal(r.calls.tip != null, m.calls === 0 && m.probes > 0, `probe-only mark · ${m.session_id}`)
    assert.doesNotMatch(r.title, /[0-9a-f]{6,}/)
  })
  assert.ok(want.some((m) => m.title_source === 'pending'), 'the five newest hold the pending row')
  assert.equal(recentCard(stateOf(quiet(), { sessions: ok({ sessions: [], errors: [] }) }), NOW).kind, 'none')
})

test('#12 · R1–R3: one disk line from classes.disk.trocar_bytes, none when classes failed; no per-day figure; no list of unpriced models', () => {
  const doc = { as_of: iso(H), sessions: { total: 1 }, calls: { llm: 3 }, harnesses: [], usage: { rows: [{ harness: A, model: 'zz-unpriced-model', lane: 'main', calls: 3, failed: 0, no_usage: 0, input: 1, output: 1, cache_read: 1, cache_write: 1, cache_known: true }], coverage: {} } }
  const s = stateOf(quiet(), { stats: statsOk(doc) })
  const card = statsCard(s, NOW)
  assert.equal(card.disk.href, '#/settings/storage')
  assert.ok(card.disk.text.includes(bytes(s.classes.data.disk.trocar_bytes)), card.disk.text)
  assert.equal(statsCard({ ...s, classes: failed(s.classes.data) }, NOW).disk, null)
  const json = JSON.stringify(card)
  assert.doesNotMatch(json, /\/\s*day|per day/i)
  assert.doesNotMatch(json, /zz-unpriced-model/)
  assert.equal(card.unpriced.href, '#/settings/prices')
})

test('#13 a CLI harness id gives the read-side chip; an unknown id gives the unidentified chip', () => {
  const items = (id) => itemsCard(stateOf({ ...quiet(), critical: [{ kind: 'k', harness: id, reason: 'r' }] }), NOW)
  const table = (id) => statsCard(stateOf(quiet(), { stats: statsOk({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 1 }, harnesses: [{ harness: id, sessions: 1, calls: 1, last_ts: iso(H) }], usage: { rows: [], coverage: {} } }) }), NOW)
  for (const [cli, read] of Object.entries(ALIASES)) {
    assert.deepEqual(items(cli), items(read), cli)
    assert.deepEqual(table(cli), table(read), cli)
  }
  const o1 = items('zz-agent').rows.find((r) => r.cls === 'O1')
  assert.equal(harnessName(o1.chip), UNIDENTIFIED)
  for (const a of table('zz-agent').agents) assert.equal(harnessName(a.chip), UNIDENTIFIED)
  assert.equal(statsCard(stateOf(quiet(), { stats: statsOk({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 1 }, harnesses: [{ harness: null, sessions: 1, calls: 1, last_ts: iso(H) }], usage: { rows: [], coverage: {} } }) }), NOW).agents[0].href, null, 'the unidentified row links nowhere')
})

// first use with agent rows (1.7 #10; 1.9 §开关): the status document lists two harnesses (CLI ids, read through chips)
const TWO = Object.keys(ALIASES).slice(0, 2)
const twoAgents = (o = {}) => {
  const d = quiet(), [h0] = Object.values(SAMPLE.harnesses)
  d.harnesses = Object.fromEntries(TWO.map((id) => [id, { ...structuredClone(h0), forms: [], processes: [], ...(o[id] || {}) }]))
  Object.assign(d, { install: { state: 'complete', harnesses: TWO, pending: [] }, changed: [], holders: [] })
  return d
}
const CTL_ON = { ok: true, status: 200, data: { control: true } }
const NONE = { sessions: [], errors: [], next: null }
const firstWith = (status, control, sessions = NONE) => ({ ...stateOf(status, { sessions: ok(sessions) }), control })

test('#10 first use: one row per listed agent with one control (switch, or setup when setup is needed); where the board cannot act, the command instead — never a disabled control', () => {
  const keys = TWO.map(harnessKey).sort()
  const on = agentRows(firstWith(twoAgents(), CTL_ON))
  assert.deepEqual(on.map((r) => r.id).sort(), keys)
  assert.ok(on.every((r) => r.control.kind === 'switch' && r.commands === null))
  const setup = agentRows(firstWith(twoAgents({ [TWO[0]]: { setup: { state: 'needed', missing: [] } } }), CTL_ON))
  assert.equal(setup.find((r) => r.id === harnessKey(TWO[0])).control.kind, 'setup')
  const cannot = [
    firstWith(twoAgents(), { ok: true, status: 200, data: { control: false } }),
    firstWith(twoAgents(), { ok: true, status: 200, data: { control: false, root: true } }),
    firstWith({ ...twoAgents(), health: { state: 'not-installed', since: iso(H) } }, CTL_ON),
    firstWith(twoAgents(), null),
  ]
  for (const st of cannot) {
    const rows = agentRows(st)
    assert.deepEqual(rows.map((r) => r.id).sort(), keys)
    const installed = st.caph.data.health.state !== 'not-installed'
    for (const id of TWO) {
      const r = rows.find((x) => x.id === harnessKey(id))
      assert.equal(r.control.kind, null)
      const cmds = r.commands.map(([, c]) => c)
      assert.ok(installed ? cmds.includes(COMMANDS.on.replace('<id>', id)) : cmds.includes(COMMANDS.install), JSON.stringify(cmds))
    }
  }
  for (const st of [firstWith(twoAgents(), CTL_ON), ...cannot]) {
    assert.equal(firstUse(st), true)
    // every row carries the desired state, whatever control it gets (1.9 §开关), and is either a control or commands
    for (const r of agentRows(st)) {
      const [, v] = Object.entries(st.caph.data.harnesses).find(([id]) => harnessKey(id) === r.id)
      assert.equal(r.desired, v.desired)
      assert.ok(r.control.kind != null || (r.commands && r.commands.length), JSON.stringify(r))
    }
  }
  assert.equal(firstUse(firstWith(twoAgents(), CTL_ON, { sessions: [session(1)], errors: [], next: null })), false, 'a session → the normal page')
})

// ── level notes, partial coverage, agent links ──────────────────────────────────────────────────────────────────────────────────────
test('entries with level note are not counted: no O3 raw row for them, O6 counts only the rest', () => {
  const segs = ok({ segments: [{ to: iso(H), problems: [{ code: 'zz-note', level: 'note', reason: 'r' }, { code: 'zz-real', reason: 'r' }] }] })
  const keys = overviewItems(stateOf(quiet(), { segments: segs }), NOW).rows.filter((r) => r.cls === 'O3').map((r) => r.key)
  assert.deepEqual(keys, ['raw/zz-real'])
  const errs = (errors) => overviewItems(stateOf(quiet(), { sessions: ok({ sessions: [session(1)], errors }) }), NOW).rows.filter((r) => r.cls === 'O6')
  const o6 = errs([{ where: 'a', reason: 'r', level: 'note' }, { where: 'b', reason: 'r' }])
  assert.equal(o6.length, 1); assert.equal(o6[0].text, FILES_NOT_READ(1))
  assert.equal(errs([{ where: 'a', reason: 'r', level: 'note' }]).length, 0)
})

const usageDoc = (coverage, harnesses = [{ harness: A, sessions: 1, calls: 3, last_ts: iso(H) }]) => ({
  as_of: iso(H), sessions: { total: 1 }, calls: { llm: 3 }, harnesses,
  usage: { rows: [{ harness: A, model: 'zz-priced', lane: 'main', sessions: 1, calls: 3, failed: 0, no_usage: 0, input: 1000, output: 500, cache_read: 3000, cache_write: 100, cache_known: true }], coverage },
})
const pricedState = (doc) => stateOf(quiet(), { stats: statsOk(doc), pricing: ok({ models: [{ model: 'zz-priced', input: 1, output: 2, cache_write: 1, cache_read: 0.1 }] }) })

test('partial coverage puts a floor on the money only: the hit text is the same, the cost text differs', () => {
  const full = statsCard(pricedState(usageDoc({ sessions_read: 2, sessions_in_window: 2 })), NOW)
  const part = statsCard(pricedState(usageDoc({ sessions_read: 1, sessions_in_window: 2 })), NOW)
  assert.notEqual(full.cost.text, '≈ —')
  assert.equal(part.hit.text, full.hit.text)
  assert.notEqual(part.cost.text, full.cost.text)
})

test('the coverage note never prints the reason code; it reads the calls pair, else the sessions pair', () => {
  const cov = (c) => statsCard(pricedState(usageDoc(c)), NOW).coverage
  const bySessions = cov({ sessions_read: 1, sessions_in_window: 2, reason: 'byte-budget' })
  assert.ok(bySessions && !bySessions.includes('byte-budget'))
  assert.ok(cov({ sessions_read: 2, sessions_in_window: 2, calls_read: 5, calls_in_window: 9, reason: 'byte-budget' }))
  assert.equal(cov({ sessions_read: 2, sessions_in_window: 2 }), null)
})

test('an agent row with no session and no model call links to its traffic, not to sessions', () => {
  const doc = usageDoc({}, [{ harness: A, sessions: 1, calls: 3, last_ts: iso(H) }, { harness: B, sessions: 0, calls: 0, last_ts: iso(H) }])
  for (const w of ['24h', '7d', 'all']) {
    const agents = statsCard({ ...pricedState(doc), w }, NOW).agents
    const by = (h) => agents.find((a) => a.chip === h)
    assert.equal(by(B).trafficOnly, true); assert.equal(by(B).href, `#/traffic?h=${encodeURIComponent(B)}&window=${w}`)
    assert.equal(by(A).href, `#/sessions?h=${encodeURIComponent(A)}&window=${w}`)
  }
})
