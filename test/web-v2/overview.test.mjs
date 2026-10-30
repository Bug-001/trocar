// overview.test.mjs — the overview (1.7 §验收): the capture card is never blank, each 事项 class appears iff its trigger holds and
// links to its page, no false 「nothing to handle」, the window moves only the stats, no alert semantics, read-only, first use,
// the recent list and the harness identity. Status documents are the C.3 sample of spec 1.6 with fields changed per case; the
// closed set of health.state is read off the same table. Assertions are on fields, hrefs, marks and element kinds, never prose.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  overviewItems, capCardHtml, itemsCardHtml, statsCardHtml, renderBody, recentRows, recentCardHtml, mount, SKELETON, headHtml,
} from '../../src/web/v2/overview/overview.mjs'
import { capHealthPatch } from '../../src/web/v2/core/capture-verdict.mjs'
import { backoffMs, INTERVAL } from '../../src/web/v2/core/poll.mjs'
import { within } from '../helpers/bounded.mjs'
import { ALIASES, HARNESS_ORDER, UNIDENTIFIED, UNKNOWN_ICON, harnessKey, harnessName } from '../../src/web/v2/core/chips.mjs'
import { TITLE_FROM_WIRE } from '../../src/web/v2/labels/replay.mjs'
import { TITLE_FROM_AGENT, FILES_NOT_READ } from '../../src/web/v2/labels/overview.mjs'
import * as W from '../../src/web/v2/labels/overview.mjs'
import { ERR_WHERE, SWITCH_WORD } from '../../src/web/v2/labels/capture.mjs'
import { esc, fmtWhen } from '../../src/web/v2/core/fmt.mjs'

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
  w: '24h', readAt: NOW, caph: { data: status, okAt: NOW, err: null, ok: true },
  sessions: ok({ sessions: [session(1)], errors: [] }), classes: ok({ disk: { trocar_bytes: 1e6 } }), pricing: ok({ models: [] }),
  stats: ok({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 2 }, harnesses: [], usage: { rows: [], coverage: {} } }),
  traffic: ok({ hosts: [], harness_since: {} }), segments: ok({ segments: [] }), ...over,
})
const norm = (h) => h.replace(/po-\d+/g, "po")
const sayOf = (html) => (/<p class="ovsay[^"]*">([^<]*)</.exec(html) || [])[1]
const group = (o) => ({ level: 'problem', where: 'engine', code: 'trust-rejected', count: 2, first_ts: iso(2 * H), last_ts: iso(H), reason: 'r', ...o })

test('#1 the capture card says a sentence for every capture state, an unreadable capture health, a stale read and an unknown state — never blank (D38②)', () => {
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
    const html = capCardHtml({ caph: { err: null, ok: true, ...caph } }, NOW)
    const say = sayOf(html)
    assert.ok(say && say.trim(), `${name}: ${html}`)
    assert.doesNotMatch(html, /undefined|NaN|Invalid/, name)
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

test('#2 each item class appears iff its trigger holds, and links to the page of the 1.7 table', () => {
  for (const [name, change, want] of CASES) {
    const s = stateOf(quiet()); change(s)
    const items = overviewItems(s, NOW)
    const got = {}
    for (const r of items.rows) (got[r.cls] ||= []).push(r.href)
    assert.deepEqual(got, want, name)
  }
  const s = stateOf(quiet()); s.caph.data.health = { state: 'unknown' }; s.caph.data.daemon.error = 'lock file is not JSON'
  assert.ok(overviewItems(s, NOW).rows.find((r) => r.cls === 'O2').text.includes('lock file is not JSON'), 'O2 carries daemon.error')
})

// 1.7 §事项目录 · 1.5 一件事只说一处: the chip is the item's subject — the sentence after it never starts with the agent's name again; an
// O1 item's sentence is the capture page row's own (agentVerdicts), word for word
test('an item with an agent chip does not name the agent again: O1 is the capture row\'s sentence itself, O9 starts with the host', async () => {
  const { agentVerdicts } = await import('../../src/web/v2/core/capture-verdict.mjs')
  const s = stateOf(quiet())
  const [id] = Object.keys(s.caph.data.harnesses)
  Object.assign(s.caph.data.harnesses[id], { captured: false, reason: 'config-after-start' })
  s.caph.data.critical = [{ kind: 'untrusted', harness: B, code: 'var-missing', since: iso(H) }]
  s.caph.data.failures.groups = [group({ harness: B })]
  s.traffic = ok({ hosts: [{ harness: A, host: 'h.example', first_seen: iso(H), requests: 1 }, { harness: null, host: 'n.example', first_seen: iso(H), requests: 1 }], harness_since: { [A]: iso(48 * H), null: iso(48 * H) } })
  const rows = overviewItems(s, NOW).rows
  const said = new Map(agentVerdicts(s.caph.data).map((r) => [r.harness, r.text]))
  assert.ok(rows.some((r) => r.cls === 'O1') && rows.some((r) => r.cls === 'O9'), JSON.stringify(rows.map((r) => r.cls)))
  for (const r of rows) {
    if (r.chip != null) assert.ok(!r.text.startsWith(harnessName(r.chip)), `${r.cls}: ${r.text}`)
    if (r.cls === 'O1') assert.equal(r.text, said.get(r.chip))
    if (r.cls === 'O9') assert.ok(r.chip != null || r.subject, `${r.cls} without a chip names its subject: ${JSON.stringify(r)}`)
  }
})

test('#2 a class with more than five items shows five and one 「N more」 link', () => {
  const s = stateOf(quiet())
  s.caph.data.critical = Array.from({ length: 7 }, (_, i) => ({ kind: `k${i}`, reason: 'r' }))
  s.caph.data.failures.groups = Array.from({ length: 8 }, (_, i) => group({ code: `c${i}` }))
  const items = overviewItems(s, NOW)
  assert.equal(items.rows.filter((r) => r.cls === 'O1p').length, 5); assert.equal(items.more.O1p, 2)
  assert.equal(items.rows.filter((r) => r.cls === 'O3').length, 5); assert.equal(items.more.O3, 3)
  const html = itemsCardHtml(s, NOW)
  assert.equal((html.match(/class="ovitem more"/g) || []).length, 2)
})

test('#3 no false 「nothing to handle」: a failed source draws the partial note; a capture state that is not fine has an item', () => {
  for (const slot of ['sessions', 'classes', 'pricing', 'stats', 'traffic', 'segments']) {
    for (const v of [failed(), failed(stateOf(quiet())[slot].data)]) {
      const html = itemsCardHtml(stateOf(quiet(), { [slot]: v }), NOW)
      assert.doesNotMatch(html, /class="ovempty"/, slot); assert.match(html, /ovpart/, slot)
    }
  }
  const s = stateOf(quiet()); s.caph = { data: quiet(), okAt: NOW, err: 'HTTP 500', ok: false }
  assert.doesNotMatch(itemsCardHtml(s, NOW), /class="ovempty"/); assert.match(itemsCardHtml(s, NOW), /ovpart/)
  assert.match(itemsCardHtml(stateOf(quiet()), NOW), /class="ovempty"/, 'all read and nothing triggered → the empty line')
  for (const state of [...HEALTH_STATES.filter((x) => !QUIET.includes(x)), 'zz-new']) {
    for (const health of [{ state, since: iso(H), n: 1 }, { state, since: iso(H), reason: 'r' }]) {
      const items = overviewItems(stateOf({ ...quiet(), health }), NOW)
      assert.ok(items.rows.length >= 1, `${JSON.stringify(health)} has an item`)
    }
  }
  const items = overviewItems(stateOf(capHealthPatch({ ok: true, status: 200, data: { errors: [{ where: 'capture health', reason: 'e' }] } }, NOW).capH), NOW)
  assert.ok(items.rows.length >= 1, 'an unreadable capture health has an item')
})

// a mounted overview on a fake element and a fake api that logs every call
// hold(name, params, opts) → a promise to wait on before answering (the test decides when a read answers), or null to answer at once
function fakeMount({ status = quiet(), sessions = { sessions: [session(1)], errors: [], next: null }, window = '24h', control = {}, answer = { ok: true }, hold = null } = {}) {
  const log = [], on = {}
  const docs = { status, sessions, classes: { disk: { trocar_bytes: 1 } }, pricing: { models: [] }, traffic: { hosts: [], harness_since: {} }, segments: { segments: [] } }
  const api = {
    now: () => NOW,
    get: async (name, params, opts) => {
      log.push({ method: 'GET', name, params: params || {} })
      const held = hold && hold(name, params || {}, opts || {})
      if (held) return held
      return name === 'overview' ? { ok: true, status: 200, data: stateOf(quiet()).stats.data } : { ok: true, status: 200, data: docs[name] }
    },
    post: async (p) => { log.push({ method: 'POST', name: p }); return { ok: true } },
    control: async (v, body) => { log.push({ method: 'POST', name: v, body }); return answer },
    controlStatus: async () => { log.push({ method: 'GET', name: 'control/status' }); return { ok: true, data: control } },
  }
  const zones = {}
  const el = {
    set innerHTML(v) { for (const id of v.match(/id="([^"]+)"/g).map((x) => x.slice(4, -1))) zones[id] = { innerHTML: '', classList: { toggle() {} } } },
    querySelector: (sel) => zones[sel.slice(1)],
    addEventListener(type, fn) { on[type] = fn }, removeEventListener() {}, replaceChildren() {},
  }
  const router = { current: () => ({ params: { window } }) }
  const inst = mount(el, { api, router, store: {}, toast: () => {} })
  return { inst, log, zones, on }
}
const settle = () => new Promise((r) => setTimeout(r, 60))

// 4.4 §存下的答案: only the Sessions page shows a stored answer; the overview reads the list again until it is fresh
test('a stored sessions answer is not shown: the overview reads the list again and shows the fresh one', async () => {
  let reads = 0
  const fresh = { sessions: [session(7, { title: 'fresh-title' })], errors: [], next: null }
  const old = { sessions: [session(9, { title: 'stored-title' })], errors: [], next: null, stored: { at: iso(0) } }
  const { inst, zones } = fakeMount({ hold: (name) => (name === 'sessions' ? Promise.resolve({ ok: true, status: 200, data: ++reads === 1 ? old : fresh }) : null) })
  const html = () => Object.values(zones).map((z) => z.innerHTML).join('')
  try {
    await settle()
    assert.ok(!html().includes('stored-title'), 'the stored list is not shown')
    await within((async () => { while (!html().includes('fresh-title')) await new Promise((d) => setTimeout(d, 50)) })(), 10_000, 'the fresh list')
    assert.ok(!html().includes('stored-title'))
    assert.ok(reads >= 2, `read again (${reads})`)
  } finally { inst.unmount() }
})

test('#4 the window only moves the stats: items are identical across 24h / 7d / all; the overview read carries since=24h / 7d / none', async () => {
  const s = quiet(); s.failures.groups = [group({ harness: A })]
  const { inst, log, zones } = fakeMount({ status: s })
  try {
    const seen = {}
    for (const w of ['24h', '7d', 'all']) {
      const from = log.length
      inst.update({ params: { window: w } }); await settle()
      const ov = log.slice(from).filter((x) => x.name === 'overview')
      if (w !== '24h') assert.equal(ov.length, 1, w)
      for (const x of ov) assert.equal(x.params.since ?? null, w === 'all' ? null : w)
      seen[w] = norm(zones.ovitems.innerHTML)
    }
    assert.ok(seen['24h'].includes('ovitem'))
    assert.equal(seen['7d'], seen['24h']); assert.equal(seen.all, seen['24h'])
  } finally { inst.unmount() }
})

test('#9 read-only: a full poll of a mounted overview, first use included, sends only GETs', async () => {
  for (const sessions of [undefined, { sessions: [], errors: [], next: null }]) {
    const { inst, log } = fakeMount({ sessions })
    try {
      await settle()
      for (const w of ['7d', 'all']) { inst.update({ params: { window: w } }); await settle() }
      assert.ok(['status', 'sessions', 'overview', 'classes', 'pricing'].every((n) => log.some((x) => x.name === n)), JSON.stringify(log))
      assert.deepEqual(log.filter((x) => x.method !== 'GET'), [])
    } finally { inst.unmount() }
  }
})

test('#5 the hit carries the 「?」 mark when a main row\'s cache figures are not known; no priced row → the unknown mark, never $0', () => {
  const row = (o) => ({ harness: A, model: 'zz-unpriced-model', lane: 'main', sessions: 1, calls: 3, failed: 0, no_usage: 0, input: 10, output: 5, cache_read: 30, cache_write: 10, cache_known: true, ...o })
  const doc = { as_of: iso(H), sessions: { total: 1 }, calls: { llm: 3 }, harnesses: [{ harness: A, sessions: 1, calls: 3, last_ts: iso(H) }], usage: { rows: [row(), row({ cache_known: false })], coverage: { sessions_read: 1, sessions_in_window: 1 } } }
  const html = statsCardHtml(stateOf(quiet(), { stats: ok(doc) }), NOW)
  assert.match(html, /\d+%\?/)
  assert.doesNotMatch(html, /\$0(?![.\d]*[1-9])/)
  assert.match(html, /≈ —/)
})

test('#6 the coverage line names the agents with sessions in the window that the overview document lacks, and only those', () => {
  const stats = ok({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 1 }, harnesses: [{ harness: HARNESS_ORDER[2], sessions: 1, calls: 1, last_ts: iso(H) }], usage: { rows: [], coverage: {} } })
  const sessions = ok({ sessions: [session(1, { harness: A }), session(30, { harness: B }), session(2, { harness: HARNESS_ORDER[2] })], errors: [] })
  const warn = (w) => (statsCardHtml({ ...stateOf(quiet(), { stats, sessions }), w }, NOW).match(/<p class="ovsub warn">[^<]*/g) || []).join(' ')
  assert.ok(warn('24h').includes(esc(harnessName(A)))); assert.ok(!warn('24h').includes(esc(harnessName(B))))
  assert.ok(warn('all').includes(esc(harnessName(B)))); assert.ok(!warn('all').includes(esc(harnessName(HARNESS_ORDER[2]))))
})

test('#8 no alert semantics: no alert role, live region, badge, unread count or dismiss control; the only buttons are disclosures and retry', () => {
  const s = quiet(); s.failures.groups = [group({ harness: A })]; s.critical = [{ kind: 'k', reason: 'r' }]
  const bodies = [
    stateOf(s), stateOf(quiet(), { sessions: ok({ sessions: [], errors: [] }) }), stateOf(quiet(), { stats: failed(), sessions: failed() }),
    stateOf({ ...quiet(), health: { state: 'not-installed' } }, { sessions: ok({ sessions: [], errors: [] }) }),
  ]
  for (const st of bodies) {
    const b = renderBody(st, NOW)
    const html = Object.values(b).filter((x) => typeof x === 'string').join('')
    assert.doesNotMatch(html, /role="alert"|aria-live|badge|unread|dismiss|data-close/)
    for (const btn of html.match(/<button[^>]*>/g) || []) assert.match(btn, /data-act="retry"|data-disc=|data-copy=|data-pop=/, btn)
  }
})

test('#10 first use: no session → the capture card and the start card only; no install / uninstall control, no disabled control', () => {
  for (const state of HEALTH_STATES) {
    const b = renderBody(stateOf({ ...quiet(), health: { state, since: iso(H) } }, { sessions: ok({ sessions: [], errors: [] }) }), NOW)
    assert.equal(b.first, true, state)
    assert.equal(b.items, ''); assert.equal(b.stats, '')
    assert.match(b.cap, /class="ovcard cap"/); assert.match(b.recent, /class="ovcard start"/)
    const html = b.cap + b.recent + b.agents
    assert.doesNotMatch(html, /disabled|data-act="(install|uninstall)"/)
    for (const btn of html.match(/<button[^>]*>/g) || []) assert.match(btn, /data-disc=|data-copy=/, btn)
  }
  assert.equal(renderBody(stateOf(quiet()), NOW).first, false, 'a session → the normal page')
})

test('#11 recent sessions: the five newest by last_ts, the hover by title_source, untitled without a time, the probe-only mark, the replay href', () => {
  const rows = [session(3), session(1, { title: null, title_source: null }), session(6), session(2, { title_source: 'harness-local-store' }),
    session(4, { calls: 0, probes: 3 }), session(7), session(5)]
  const want = [...rows].sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts)).slice(0, 5)
  assert.deepEqual(recentRows({ sessions: rows }).map((r) => r.id), want.map((r) => r.session_id))
  const html = recentCardHtml(stateOf(quiet(), { sessions: ok({ sessions: rows, errors: [] }) }), NOW)
  const items = html.split('<a class="ovitem"').slice(1)
  assert.equal(items.length, 5)
  want.forEach((m, i) => {
    const it = items[i]
    assert.ok(it.includes(`href="#/replay/${m.project_slug}/${m.session_id}"`), it)
    if (m.title != null) assert.ok(it.includes(esc(m.title_source === 'wire' ? TITLE_FROM_WIRE : TITLE_FROM_AGENT)), it)
    else assert.doesNotMatch(it, /title="[^"]*title from/)
    if (m.calls === 0 && m.probes > 0) assert.match(it, /ovnum"><span title=/)
  })
  const u = want.findIndex((m) => m.title == null)
  const titleCell = /<span class="ovtx"[^>]*>([^<]*)</.exec(items[u])[1]
  assert.ok(!titleCell.includes(esc(fmtWhen(Date.parse(want[u].last_ts), NOW))), 'the untitled title carries no time: the row has its last-active column')
  assert.doesNotMatch(html, /[0-9a-f]{6,}<\/span>/)
})

test('#12 · R1–R3: one disk line, no per-day figure, no theme control, no list of unpriced models', () => {
  const doc = { as_of: iso(H), sessions: { total: 1 }, calls: { llm: 3 }, harnesses: [], usage: { rows: [{ harness: A, model: 'zz-unpriced-model', lane: 'main', calls: 3, failed: 0, no_usage: 0, input: 1, output: 1, cache_read: 1, cache_write: 1, cache_known: true }], coverage: {} } }
  const b = renderBody(stateOf(quiet(), { stats: ok(doc) }), NOW)
  const html = Object.values(b).filter((x) => typeof x === 'string').join('')
  assert.equal((html.match(/href="#\/settings\/storage"/g) || []).length, 1)
  assert.doesNotMatch(html, /\/\s*day|per day|data-theme/i)
  assert.doesNotMatch(html, /zz-unpriced-model/)
  assert.match(html, /href="#\/settings\/prices"/)
})

test('#13 a CLI harness id renders the read-side chip; an unknown id renders the unidentified chip', () => {
  const card = (id) => itemsCardHtml(stateOf({ ...quiet(), critical: [{ kind: 'k', harness: id, reason: 'r' }] }), NOW)
  const table = (id) => statsCardHtml(stateOf(quiet(), { stats: ok({ as_of: iso(H), sessions: { total: 1 }, calls: { llm: 1 }, harnesses: [{ harness: id, sessions: 1, calls: 1, last_ts: iso(H) }], usage: { rows: [], coverage: {} } }) }), NOW)
  for (const [cli, read] of Object.entries(ALIASES)) {
    assert.equal(norm(card(cli)), norm(card(read)), cli)
    assert.equal(table(cli), table(read), cli)
  }
  for (const html of [card('zz-agent'), table('zz-agent')]) { assert.ok(html.includes(UNIDENTIFIED)); assert.ok(html.includes(UNKNOWN_ICON) || html.includes('ovsubj')) }
})

// first use with agent rows (1.7 #10, #8 / #9 as amended; 1.9 §开关): the status document lists two harnesses (CLI ids, read through chips)
const TWO = Object.keys(ALIASES).slice(0, 2)
const twoAgents = (o = {}) => {
  const d = quiet(), [h0] = Object.values(SAMPLE.harnesses)
  d.harnesses = Object.fromEntries(TWO.map((id) => [id, { ...structuredClone(h0), forms: [], processes: [], ...(o[id] || {}) }]))
  Object.assign(d, { install: { state: 'complete', harnesses: TWO, pending: [] }, changed: [], holders: [] })
  return d
}
const CTL_ON = { ok: true, status: 200, data: { control: true } }
const NONE = { sessions: [], errors: [], next: null }
const firstWith = (status, control, sessions = NONE) => ({ ...stateOf(status, { sessions: ok(sessions) }), control, ui: new Map() })
const hctls = (html) => [...html.matchAll(/<[^>]*data-hctl="([^"]*)"[^>]*>/g)].map((m) => ({ kind: m[1], h: /data-h="([^"]*)"/.exec(m[0])[1] }))
const rowHtml = (html, h) => html.split('class="ovitem ovagent"').find((x) => x.startsWith(` data-h="${h}"`)) || ''
const rowsOf = (html) => [...new Set([...html.matchAll(/data-h="([^"]*)"/g)].map((m) => m[1]))].sort()

test('#10 first use: one row per listed agent with exactly one control (switch, or Set up when setup is needed); none and nothing disabled where the board cannot act', () => {
  const keys = TWO.map(harnessKey).sort()
  const a = renderBody(firstWith(twoAgents(), CTL_ON), NOW).agents
  assert.deepEqual(hctls(a).map((x) => x.h).sort(), keys)
  assert.ok(hctls(a).every((x) => x.kind === 'switch'))
  const s = renderBody(firstWith(twoAgents({ [TWO[0]]: { setup: { state: 'needed', missing: [] } } }), CTL_ON), NOW).agents
  assert.deepEqual(hctls(s).find((x) => x.h === harnessKey(TWO[0])).kind, 'setup')
  const cannot = [
    firstWith(twoAgents(), { ok: true, status: 200, data: { control: false } }),
    firstWith(twoAgents(), { ok: true, status: 200, data: { control: false, root: true } }),
    firstWith({ ...twoAgents(), health: { state: 'not-installed', since: iso(H) } }, CTL_ON),
    firstWith(twoAgents(), null),
  ]
  for (const st of cannot) {
    const b = renderBody(st, NOW), html = b.cap + b.agents + b.recent
    assert.deepEqual(rowsOf(b.agents), keys)
    assert.deepEqual(hctls(html), [])
    assert.doesNotMatch(html, /disabled/)
    // each row still says what it can't do here: the command (1.6's usage: install, or on / off <the document's key>)
    const installed = !(st.caph.data.health && st.caph.data.health.state === 'not-installed')
    for (const id of TWO) {
      const row = rowHtml(b.agents, harnessKey(id))
      assert.ok(row.includes(installed ? `trocar on ${id}` : 'trocar install'), row)
    }
  }
  for (const st of [firstWith(twoAgents(), CTL_ON), ...cannot]) {
    const b = renderBody(st, NOW), html = b.cap + b.agents + b.recent
    assert.doesNotMatch(html, /data-act="(install|uninstall)"/)
    // every row writes the desired state as text, whatever control it gets (1.9 §开关)
    for (const [id, v] of Object.entries(st.caph.data.harnesses)) {
      if (SWITCH_WORD[v.desired]) assert.match(rowHtml(b.agents, harnessKey(id)), new RegExp(`class="ovtx">${SWITCH_WORD[v.desired]}<`))
    }
    assert.ok(hctls(html).every((x) => x.kind === 'switch' || x.kind === 'setup'))
  }
})

test('#9 first use: until a control is clicked only GETs go out; a click goes through planConfirm, its first control call carries no confirm', async () => {
  const answer = { ok: false, status: 409, data: { need: 'confirm', plan: [], plan_id: 'p1' } }
  const { inst, log, zones, on } = fakeMount({ status: twoAgents(), sessions: NONE, control: { control: true }, answer })
  try {
    await settle()
    assert.deepEqual(log.filter((x) => x.method !== 'GET'), [])
    assert.ok(log.some((x) => x.name === 'control/status'))
    const [m] = [...zones.ovagents.innerHTML.matchAll(/<[^>]*data-hctl="[^"]*"[^>]*>/g)]
    const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(m[0]) || [])[1] ?? null
    const btn = { getAttribute: attr, setAttribute() {}, removeAttribute() {}, isConnected: true }
    await on.click({ target: { closest: (sel) => sel === '[data-hctl]' ? btn : null }, preventDefault() {} }); await settle()
    const posts = log.filter((x) => x.method !== 'GET')
    assert.ok(posts.length >= 1)
    assert.equal(posts[0].name, 'harness')
    assert.equal(posts[0].body.harness, attr('data-cli'))
    assert.equal('confirm' in posts[0].body, false)
  } finally { inst.unmount() }
})

test('#10 the first session arrives → no agent control and no start card are left on the overview', () => {
  const b = renderBody(firstWith(twoAgents(), CTL_ON, { sessions: [session(1)], errors: [], next: null }), NOW)
  const html = Object.values(b).filter((x) => typeof x === 'string').join('')
  assert.equal(b.first, false)
  assert.deepEqual(hctls(html), [])
  assert.doesNotMatch(html, /class="ovcard start"/)
})

// ── level notes, partial coverage, agent links, page head, window reads ──────────────────────────────────────────────────────────────────────────
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
const pricedState = (doc) => stateOf(quiet(), { stats: ok(doc), pricing: ok({ models: [{ model: 'zz-priced', input: 1, output: 2, cache_write: 1, cache_read: 0.1 }] }) })
const spanOf = (html, cls) => (new RegExp(`<span class="${cls}"[^>]*>([^<]*)<`).exec(html) || [])[1]

test('partial coverage puts a floor on the money only: the hit text is the same, the cost text differs', () => {
  const full = statsCardHtml(pricedState(usageDoc({ sessions_read: 2, sessions_in_window: 2 })), NOW)
  const part = statsCardHtml(pricedState(usageDoc({ sessions_read: 1, sessions_in_window: 2 })), NOW)
  assert.ok(spanOf(full, 'ovhit') != null && spanOf(full, 'ovcost') != null, full)
  assert.equal(spanOf(part, 'ovhit'), spanOf(full, 'ovhit'))
  assert.notEqual(spanOf(part, 'ovcost'), spanOf(full, 'ovcost'))
})

test('the coverage note never prints the reason code; it reads the calls pair, else the sessions pair', () => {
  const html = (cov) => statsCardHtml(pricedState(usageDoc(cov)), NOW)
  const bySessions = html({ sessions_read: 1, sessions_in_window: 2, reason: 'byte-budget' })
  assert.ok(!bySessions.includes('byte-budget')); assert.match(bySessions, /class="[^"]*\bovcov\b/)
  assert.match(html({ sessions_read: 2, sessions_in_window: 2, calls_read: 5, calls_in_window: 9, reason: 'byte-budget' }), /class="[^"]*\bovcov\b/)
  assert.doesNotMatch(html({ sessions_read: 2, sessions_in_window: 2 }), /\bovcov\b/)
})

test('an agent row with no session and no model call links to its traffic, not to sessions', () => {
  const doc = usageDoc({}, [{ harness: A, sessions: 1, calls: 3, last_ts: iso(H) }, { harness: B, sessions: 0, calls: 0, last_ts: iso(H) }])
  for (const w of ['24h', '7d', 'all']) {
    const html = statsCardHtml({ ...pricedState(doc), w }, NOW)
    assert.ok(html.includes(`href="${esc(`#/traffic?h=${encodeURIComponent(B)}&window=${w}`)}"`), html)
    assert.ok(!html.includes(esc(`#/sessions?h=${encodeURIComponent(B)}`)))
    assert.ok(html.includes(esc(`#/sessions?h=${encodeURIComponent(A)}&window=${w}`)))
  }
})

test('the page head is drawn once: the skeleton holds no <header>, headHtml one', () => {
  assert.ok(!SKELETON.includes('<header'))
  assert.equal((headHtml({ w: '24h', readAt: NOW }).match(/<header/g) || []).length, 1)
})

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const statsDoc = (total) => ({ ok: true, status: 200, data: { ...stateOf(quiet()).stats.data, sessions: { total } } })
const tabOn = (html, w) => new RegExp(`href="#/overview\\?window=${w}"[^>]*aria-current`).test(html)

test('right after mount, before any answer: the head has its window tab, the stats and recent cards say reading, no card zone is blank', () => {
  const { inst, zones } = fakeMount({ hold: () => new Promise(() => {}) })
  try {
    assert.ok(tabOn(zones.ovhead.innerHTML, '24h'))
    for (const z of ['ovstats', 'ovrecent']) assert.match(zones[z].innerHTML, /class="ovcard[^"]*\breading\b/, z)
    for (const z of ['ovhead', 'ovcap', 'ovitems', 'ovstats', 'ovrecent']) assert.notEqual(zones[z].innerHTML, '', z)
  } finally { inst.unmount() }
})

test('a window change moves the tab at once and an answer for another window never reaches the stats card', async () => {
  const held = []
  const { inst, zones } = fakeMount({ hold: (name, params) => { if (name !== 'overview') return null; const d = deferred(); held.push({ since: params.since ?? null, d }); return d.promise } })
  try {
    inst.update({ params: { window: '7d' } }); inst.update({ params: { window: 'all' } })
    assert.ok(tabOn(zones.ovhead.innerHTML, 'all'))
    const of = (since) => held.find((x) => x.since === since)
    const n = (k) => esc(W.SESSIONS_N(k))
    of(null).d.resolve(statsDoc(9)); await settle()
    assert.ok(zones.ovstats.innerHTML.includes(n(9)))
    assert.doesNotMatch(zones.ovstats.innerHTML, /\breading\b/)
    of('7d').d.resolve(statsDoc(4)); if (of('24h')) of('24h').d.resolve(statsDoc(1)); await settle()
    assert.ok(zones.ovstats.innerHTML.includes(n(9)))
    assert.ok(!zones.ovstats.innerHTML.includes(n(4)) && !zones.ovstats.innerHTML.includes(n(1)))
  } finally { inst.unmount() }
})

test('the slow reads go at most two at a time, a window change included, and all five are read in the end', async () => {
  const SLOW = ['classes', 'pricing', 'overview', 'segments', 'traffic']
  const pending = [], asked = new Set()
  let most = 0
  const { inst } = fakeMount({
    hold: (name, params, opts) => {
      if (!SLOW.includes(name)) return null
      asked.add(name); const d = deferred(); const x = { name, d, done: false }; pending.push(x)
      // an aborted read frees its socket at once in a browser, so it no longer counts as in flight
      if (opts.signal) opts.signal.addEventListener('abort', () => { x.done = true }, { once: true })
      most = Math.max(most, pending.filter((p) => !p.done).length)
      return d.promise.then((v) => { x.done = true; return v })
    },
  })
  try {
    await settle()
    inst.update({ params: { window: '7d' } }); await settle() // the window's own read joins while two slow reads are out
    for (let i = 0; i < 10 && pending.some((p) => !p.done); i++) {
      const next = pending.find((p) => !p.done)
      next.d.resolve(next.name === 'overview' ? statsDoc(1) : { ok: true, status: 200, data: {} }); await settle()
    }
    assert.ok(most <= 2, `most in flight ${most}`)
    assert.deepEqual([...asked].sort(), [...SLOW].sort())
  } finally { inst.unmount() }
})

test('K-29 on the overview: every GET fails for 120 s → each name\'s reads are at least its back-off apart; none while hidden', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const listeners = new Map(), had = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = { hidden: false, addEventListener: (k, f) => listeners.set(k, f), removeEventListener: (k) => listeners.delete(k) }
  t.after(() => { mock.timers.reset(); if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document })
  const at = {}
  const { inst } = fakeMount({ hold: (name) => { (at[name] ||= []).push(Date.now()); return Promise.resolve({ ok: false, status: 500, error: 'down' }) } })
  const idle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  const run = async (ms) => { for (let i = 0; i < ms; i += 250) { mock.timers.tick(250); await idle() } }
  try {
    await idle(); await run(120000)
    for (const name of ['status', 'sessions', 'classes', 'pricing', 'segments', 'traffic', 'overview']) {
      const reads = at[name] || [], base = INTERVAL[name] ?? INTERVAL.other
      assert.ok(reads.length >= 2, `${name}: ${reads.length} reads`)
      for (let k = 1; k < reads.length; k++) {
        const gap = reads[k] - reads[k - 1]
        assert.ok(gap >= backoffMs(k, base), `${name}: read ${k + 1} came ${gap} ms after failure ${k}; the back-off is ${backoffMs(k, base)}`)
      }
    }
    const before = Object.values(at).flat().length
    globalThis.document.hidden = true
    await run(120000)
    assert.equal(Object.values(at).flat().length, before, 'no read while hidden')
  } finally { inst.unmount() }
})
