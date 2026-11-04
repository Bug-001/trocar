// capture-model.test.mjs — the capture page and the capture log as data (1.9 §采集服务行 · §每个 agent 一行 · §展开 · §条件的话 ·
// §采集记录): the framework-free models the React screens render. Documents are the C.3 sample of spec 1.6 with the fields each axis
// varies; expected values come from the labels, the shared CLI catalogs and the collector's own fold. Data fields only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pageModel, holdOrder } from '../../web/src/screens/capture/model.mjs'
import { logModel } from '../../web/src/screens/capture/log-model.mjs'
import { captureVerdict } from '../../web/legacy/core/capture-verdict.mjs'
import { ALIASES, harnessKey } from '../../web/legacy/core/chips.mjs'
import { COMMANDS, CHANGE_REMOVAL, UNKNOWN_REASON, CONDITION_KIND, LOG } from '../../web/legacy/labels/capture.mjs'
import { redactUrlCredentials } from '../../web/legacy/core/sensitive.mjs'
import { failureWord, FAILURE_WORDS } from '../../src/cli/words.mjs'
import { STATUS_REASONS } from '../../src/health/codes.mjs'
import { foldFlows } from '../../src/health/flows.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const T = '2026-10-20T09:00:00Z'

// a C.3 document: the daemon up, health `state`, one harness per entry of `hs` ({desired, setup, captured, reason})
function doc({ state = 'ok', hs = { codex: {} }, topology = {}, extra = {} } = {}) {
  const d = sample()
  d.daemon = { running: true, responding: true, pid: 4012, since: T, error: null }
  d.health = { state, since: T }
  d.harnesses = Object.fromEntries(Object.entries(hs).map(([id, v]) => [id, { desired: 'on', captured: true, updated_at: T, ...v }]))
  d.topology = topology; d.critical = []; d.changed = []; d.failures = { since: T, groups: [] }; d.errors = []; d.install = { state: 'installed', pending: [] }
  return Object.assign(d, extra)
}
const CONTROL = { ok: true, status: 200, data: { control: true, user: 'u', root: false, harnesses: [] } }
const ROOT = { ok: true, status: 200, data: { control: false, user: 'root', root: true, harnesses: [] } }
const UNREADABLE = { ok: false, status: 503, error: 'HTTP 503' }
const model = (d, control = CONTROL, o = {}) => pageModel(d, captureVerdict(d), { control, ...o })
const rowOf = (m, id) => m.rows.find((r) => r.id === harnessKey(id))
const plain = (v) => (v.parts ? v.parts.map(plain).join('') : v.mono ?? v.text)
const monos = (pairs) => pairs.flatMap(({ v }) => (v.parts ? v.parts : [v])).filter((x) => x.mono != null).map((x) => x.mono)
// a seeded generator, so a failing case replays
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

test('M1: setup × desired × control plane × health — the control kind per rule, Set up only when needed, desired as text only without a control', () => {
  for (const setup of ['ready', 'needed', 'unknown']) for (const desired of ['on', 'off', 'mixed', null]) for (const [cname, control] of [['ok', CONTROL], ['root', ROOT], ['unreadable', UNREADABLE]]) for (const state of ['ok', 'not-installed', 'residue']) {
    const r = rowOf(model(doc({ state, hs: { codex: { desired, setup: { state: setup, missing: [] } } } }), control), 'codex')
    const where = `${setup} ${desired} ${cname} ${state}`
    const acts = cname === 'ok' && state === 'ok'
    assert.equal(r.control.kind, acts ? (setup === 'needed' ? 'setup' : 'switch') : null, where)
    assert.equal(r.desired !== '', !r.control.kind && (desired === 'on' || desired === 'off'), where)
  }
})

test('M2: the service row\'s commands carry no <id> and no bare on / off; not installed adds install; under root every alias row keeps its own on command', () => {
  const bare = /\btrocar (?:on|off)\s*$/
  for (const state of ['ok', 'not-installed', 'failing', 'residue']) {
    const d = doc({ state, extra: { linger: false, critical: [{ kind: 'degraded', since: T }] } })
    const s = model(d).service
    for (const c of monos(s.tech)) { assert.ok(!c.includes('<id>'), c); assert.ok(!bare.test(c), c) }
    if (state === 'not-installed') assert.ok(monos(s.tech).includes(COMMANDS.install), state)
  }
  for (const alias of Object.keys(ALIASES)) {
    const r = rowOf(model(doc({ hs: { [alias]: {} } }), ROOT), alias)
    assert.equal(r.control.kind, null, alias)
    assert.ok(monos(r.tech).includes(COMMANDS.on.replace('<id>', alias)), `${alias}: ${JSON.stringify(r.tech)}`)
  }
})

test('M3: a proxy URL\'s userinfo is hidden everywhere in the model, product and VPN fields never reach it', () => {
  const d = doc({
    hs: { codex: {} },
    topology: { codex: { at: T, routing: 'proxy', captured: true, nodes: [{ id: 'a', name: 'codex' }, { id: 'p', name: 'http://alice:pw@proxy.example:8080' }], branches: [{ path: ['a', 'p'] }], vpn: 'PlantedVpnName' } },
  })
  d.harnesses.codex.forms = [{ form: 'codex.cli', proxy: { upstream: { url_redacted: 'http://***@proxy.example:8080', product: 'PlantedProductName' } } }]
  d.proxy = { upstream: { product: 'PlantedProductName' } }
  const m = model(d)
  const all = JSON.stringify(m), r = rowOf(m, 'codex')
  assert.ok(all.includes('***@'))
  for (const s of [r.copy, r.diag]) assert.ok(s.includes('***@'), s)
  for (const s of [all, r.copy, r.diag, m.service.copy, m.service.diag]) for (const bad of ['alice:pw', 'PlantedVpnName', 'PlantedProductName']) assert.equal(s.includes(bad), false, bad)
})

// the userinfo a proxy URL can carry: [userinfo as written, the parts that must not show]
const USERINFO = [['alice:pw-41f9', ['alice', 'pw-41f9']], ['alice', ['alice']], [':pw-41f9', ['pw-41f9']], ['alice:p@ss-41f9', ['alice', 'p@ss', 'ss-41f9']],
  ['claude-code:settings:pw-41f9', ['claude-code', 'pw-41f9']], ['al%40ice:p%3Aw-41f9', ['al%40ice', 'p%3Aw-41f9']], ['alice:', ['alice']],
  ["alice:it's!$&()*+,;=-41f9", ['alice', "it's", '-41f9']]]
const AROUND = [(u) => u, (u) => `upstream ${u} (adopted)`, (u) => JSON.stringify({ url: u }), (u) => `${u}\n${u}`, (u) => `${u} ${u}`]

test('M3: the page hides every userinfo form a proxy URL can carry and keeps the host; text that holds no userinfo passes as it is', () => {
  for (const scheme of ['http', 'https', 'socks5', 'socks5h', 'HTTP']) for (const [ui, secret] of USERINFO) for (const tail of [':8080', ':8080/x', '']) for (const around of AROUND) {
    const text = around(`${scheme}://${ui}@proxy.example${tail}`)
    const out = redactUrlCredentials(text)
    for (const s of secret) assert.equal(out.includes(s), false, `${text} → ${out}`)
    assert.equal(out, around(`${scheme}://***@proxy.example${tail}`), text)
  }
  for (const plain of ['http://proxy.example:8080', 'http://proxy.example/a@b', 'http://proxy.example?x=a@b', 'http://proxy.example#a@b',
    'http://proxy.example a@b', 'mailto:alice@example.com', 'mail alice@example.com', JSON.stringify({ a: 'http://proxy.example', b: 'x@y' }), 'http://***@proxy.example'])
    assert.equal(redactUrlCredentials(plain), plain)
})

test('M4: every status reason code, as the verdict\'s reason and as a condition, gives a whole sentence and a why — never reason unknown', () => {
  for (const code of STATUS_REASONS.filter((c) => c !== 'desired-off')) {
    const viaVerdict = doc({ hs: { codex: { captured: false, reason: code } } })
    const viaCondition = doc({ extra: { critical: [{ kind: 'untrusted', harness: 'codex', code, since: T }] } })
    for (const [how, d] of [['verdict', viaVerdict], ['condition', viaCondition]]) {
      const r = rowOf(model(d), 'codex'), where = `${code} via ${how}`
      assert.ok(r.sentence.text.trim() && !/:\s*$/.test(r.sentence.text) && !r.sentence.text.includes(UNKNOWN_REASON), `${where}: ${r.sentence.text}`)
      assert.ok(r.why && r.why.lines.length > 0, where)
      for (const l of r.why.lines) assert.ok(!l.includes(UNKNOWN_REASON), `${where}: ${l}`)
    }
  }
})

test('M5: a negative-cache condition is worded by its cause on its own agent row and in the service conditions, not on another row', () => {
  const causes = Object.keys(FAILURE_WORDS).filter((k) => k.startsWith('negative-cache/')).map((k) => k.slice(k.indexOf('/') + 1))
  assert.ok(causes.length > 0)
  for (const cause of causes) {
    const nc = { kind: 'negative-cache', where: 'engine', code: 'negative-cache', cause, since: T }
    const m = model(doc({ hs: { codex: {}, opencode: {} }, extra: { critical: [{ ...nc, harness: 'codex', pid: 7 }, nc] } }))
    const w = failureWord('engine', 'negative-cache', '', cause)
    assert.ok(rowOf(m, 'codex').sentence.text.includes(w), cause)
    assert.ok(m.service.conds.some((c) => c.includes(w)), cause)
    assert.equal(JSON.stringify(rowOf(m, 'opencode')).includes(w), false, cause)
  }
})

test('M6: the removal sentence is said once in the agent row\'s changes and never in the machine-wide block', () => {
  const changed = [
    { harness: 'codex', path: '/h/.codex/config.toml', what: 'proxy-entry', undo: 'trocar off codex' },
    { harness: 'codex', path: '/h/.codex/config.toml', what: 'json-key a.b' },
    { path: '/h/.trocar/ca.pem', what: 'owned-file' },
  ]
  const m = model(doc({ hs: { codex: {}, opencode: {} }, extra: { changed, install: { state: 'installed', pending: [{ path: '/h/x', result: 'install did not finish' }] } } }))
  const n = (s) => s.split(CHANGE_REMOVAL).length - 1
  assert.equal(n(JSON.stringify(rowOf(m, 'codex'))), 1)
  assert.equal(rowOf(m, 'opencode').changes, null)
  assert.ok(m.changes)
  assert.equal(n(JSON.stringify(m.changes)), 0)
})

test('M7: holdOrder — nothing open follows the rule; something open keeps the shown order, drops the gone, appends the new in rule order', () => {
  const next = rng(7), ids = Array.from({ length: 9 }, (_, i) => `h${i}`)
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }
  for (let i = 0; i < 500; i++) {
    const prev = shuffle(ids).slice(0, Math.floor(next() * 10)), rule = shuffle(ids).slice(0, Math.floor(next() * 10))
    assert.deepEqual(holdOrder(prev, rule, false), rule)
    const out = holdOrder(prev, rule, true), kept = prev.filter((x) => rule.includes(x))
    assert.deepEqual(new Set(out), new Set(rule)); assert.equal(out.length, rule.length)
    assert.deepEqual(out.slice(0, kept.length), kept)
    assert.deepEqual(out.slice(kept.length), rule.filter((x) => !prev.includes(x)))
  }
})

test('M8: the log filter keeps the groups whose own agent folds to it and says the rule; expected groups only in the foot; unreadable draws no rows', () => {
  const g = (o) => ({ level: 'problem', where: 'engine', count: 2, first_ts: T, last_ts: T, ...o })
  const groups = [g({ code: 'trust-rejected', harness: 'claude-code' }), g({ code: 'ca-invalid', harness: 'codex', last_ts: '2026-10-20T10:00:00Z' }),
    g({ code: 'helper-down' }), g({ level: 'expected', where: 'connection', code: 'policy', harness: 'claude-code' })]
  const d = doc({ extra: { failures: { since: T, groups } } })
  for (const filter of [harnessKey('claude-code'), harnessKey('codex'), 'nobody']) {
    const m = logModel(d, { filter })
    assert.equal(m.state, 'ready')
    assert.equal(m.rows.length, groups.filter((x) => x.level !== 'expected' && x.harness != null && harnessKey(x.harness) === filter).length, filter)
    for (const r of m.rows) assert.equal(r.who && r.who.id, filter)
    assert.ok(m.say.includes(LOG.filterRule), filter)
  }
  const all = logModel(d)
  assert.equal(all.say.includes(LOG.filterRule), false)
  assert.equal(all.rows.length, 3)
  assert.equal(all.rows.some((r) => r.key.startsWith('expected/')), false)
  assert.equal(all.foot.expected.length, 1)
  const reason = 'flows-is-not-a-directory-5c1e'
  const u = logModel({ unreadable: reason })
  assert.equal(u.state, 'unreadable'); assert.deepEqual(u.rows, [])
  assert.equal(u.say.join(' ').includes(reason), false)
})

test('M9: the conditions the collector folds land on their agent row or in the service conditions with their own words; an unknown kind says reason unknown and names the kind', () => {
  const at = (s) => new Date(Date.parse(T) + s * 1000).toISOString()
  const recs = [
    { ts: at(0), event: 'daemon-start' },
    { ts: at(1), event: 'agent-untrusted', pid: 11, harness: 'codex', code: STATUS_REASONS[0] },
    { ts: at(2), event: 'failure', where: 'engine', code: 'negative-cache', cause: 'client-rejected-leaf', harness: 'codex', pid: 12, host: 'api.example' },
    { ts: at(3), event: 'helper-down' },
    { ts: at(4), event: 'helper-version-mismatch' },
    { ts: at(5), event: 'switch', desired: 'on', actual: 'off' },
    { ts: at(6), event: 'failure', where: 'engine', code: 'ca-invalid' },
    { ts: at(7), event: 'failure', where: 'classes', code: 'classes-unparsable' },
  ]
  const critical = foldFlows(recs, { now: Date.parse(T) + 60e3 }).conditions
  const kinds = new Set(critical.map((c) => c.kind))
  assert.ok(kinds.size >= 7, [...kinds].join())
  const m = model(doc({ hs: { codex: {} }, extra: { critical: [...critical, { kind: 'made-up-kind-3f2a', since: T }] } }))
  const r = rowOf(m, 'codex')
  for (const c of critical) {
    if (c.harness != null) { assert.ok(r.tech.some((p) => p.k === `condition ${c.kind}`), c.kind); continue }
    const word = c.kind === 'state-mismatch' ? null : failureWord(c.where, c.code ?? c.kind, '', c.cause) || CONDITION_KIND[c.kind]
    assert.ok(c.kind === 'state-mismatch' || word, `${c.kind} has words`)
    assert.ok(m.service.conds.some((s) => !s.includes(UNKNOWN_REASON) && (!word || s.includes(word))), `${c.kind}: ${m.service.conds}`)
  }
  assert.equal(m.service.conds.length, critical.filter((c) => c.harness == null).length + 1)
  assert.ok(m.service.conds.some((s) => s.includes(UNKNOWN_REASON)))
  assert.ok(m.service.tech.some((p) => plain(p.v) === 'made-up-kind-3f2a'))
})
