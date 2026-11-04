// test/query/rules.test.mjs — `trocar query rules` against 附录 C.5 (RFC 1.6, V120's rules part). The keys come from the spec's own row; the counts from a
// rules-stats.json written by hand. No daemon exists in any of these: the answer comes from four files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runQuery, stampOf, QueryArgError } from '../../src/query/named/index.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'
import { armedKey } from '../../src/rules/state.mjs'
import { RULE_STATES, BUFFERS } from '../../src/rules/closed.mjs'
import { rulesFile, rulesState, rulesStats } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const SPEC = fileURLToPath(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url))
const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const AT = '2026-11-05T11:59:58.000Z'

// C.5 的 `rules` 行是键名的唯一出处:`rules:[{…}]` 里顶层的逗号分开各键,`limit:{…}` 这样的键只取名字。
const specRow = () => fs.readFileSync(SPEC, 'utf8').split('\n').find((l) => l.startsWith('| `rules` | `rules:[{'))
const splitTop = (text) => {
  const out = []
  let depth = 0, word = ''
  for (const ch of text) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) { out.push(word); word = '' } else word += ch
  }
  return [...out, word]
}
const specKeys = () => {
  const inner = /`rules:\[\{(.*?)\}\]`/.exec(specRow())[1]
  return splitTop(inner).map((k) => k.trim().split(':')[0])
}
const specLimitKeys = () => /limit:\{([^}]*)\}/.exec(specRow())[1].split(',').map((k) => k.trim())
const specTopKeys = () => specRow().split('|')[2].split('。')[0].split('·').slice(1).map((k) => /`(\w+)`/.exec(k)[1])

const header = { name: 'tag-header', note: 'marks the call', on: 'request', match: { harness: ['claude-code'], host: 'api.anthropic.com' }, do: [{ header: 'x-tag', set: '1' }], on_error: 'forward' }
const armedOn = (rule, seq = {}) => ({ ...rule, armed: { off: 5, rules: 0, ...seq }, armed_at: '2026-11-05T10:00:00.000Z' })
const script = { name: 'surgery', on: 'request', match: { harness: 'any', host: 'api.anthropic.com' }, do: [{ script: '/abs/surgery.mjs' }], on_error: 'drop', limit: { times: 5, until: '2026-11-06T00:00:00.000Z' } }
const stream = { name: 'scrub', on: 'response', match: { harness: ['codex'], host: '*.example' }, do: [{ replace: 'alpha', with: 'beta', literal: true }], on_error: 'forward' }

const statePath = (home) => path.join(home, 'collector', 'state.json')
const write = (home, { rules, stats, state, rulesStateDoc }) => {
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  if (rules !== undefined) fs.writeFileSync(rulesFile(home), typeof rules === 'string' ? rules : JSON.stringify({ max_delay_ms: 300, rules }))
  if (stats !== undefined) fs.writeFileSync(rulesStats(home), typeof stats === 'string' ? stats : JSON.stringify(stats))
  if (state !== undefined) fs.writeFileSync(statePath(home), JSON.stringify({ version: 2, harnesses: state }))
  if (rulesStateDoc !== undefined) fs.writeFileSync(rulesState(home), JSON.stringify(rulesStateDoc))
  return home
}
const homeWith = (files) => write(tmpDir('trocar-query-rules-'), files)
const ask = (home, params = {}) => runQuery('rules', params, { home, now: () => NOW })
const statsOf = (entries) => ({ at: AT, rules: entries })

test('the document has C.5\'s keys, and passes the common schema', async () => {
  const one = armedOn(header)
  const home = homeWith({ rules: [one, script], stats: statsOf({}), state: { 'claude-code': { desired: 'on', off_seq: 5 } } })
  const doc = await ask(home, { rule: 'tag-header' })
  assert.deepEqual(validateQueryDoc(doc, 'rules'), [])
  assert.deepEqual(Object.keys(doc.rules[0]).sort(), specKeys().sort())
  assert.deepEqual(Object.keys(doc.rules[0].limit).sort(), specLimitKeys().sort())
  for (const key of specTopKeys()) assert.ok(Object.hasOwn(doc, key), key)
})

test('rows follow the file, and say what the rule file says', async () => {
  const home = homeWith({ rules: [stream, armedOn(header), script] })
  const doc = await ask(home)
  assert.deepEqual(doc.rules.map((r) => r.name), ['scrub', 'tag-header', 'surgery'])
  assert.equal(doc.max_delay_ms, 300)
  assert.equal('rule' in doc, false)
  const [scrub, tag, surgery] = doc.rules
  for (const row of doc.rules) {
    assert.match(row.summary, /\S/)
    assert.ok(RULE_STATES.includes(row.state))
    assert.ok(BUFFERS.includes(row.buffers))
    assert.match(row.sha256, /^[0-9a-f]{64}$/)
  }
  assert.deepEqual([scrub.on_error, tag.on_error, surgery.on_error], ['forward', 'forward', 'drop'])
  assert.deepEqual([scrub.script, tag.script, surgery.script], [false, false, true])
  assert.deepEqual([scrub.resend_ok, tag.resend_ok, surgery.resend_ok], [false, true, true])
  assert.deepEqual([scrub.tier, tag.tier, surgery.tier], [1, 0, 2])
  assert.deepEqual([scrub.buffers, tag.buffers, surgery.buffers], ['stream', 'none', 'request'])
  assert.deepEqual([scrub.on, tag.harness, surgery.harness], ['response', ['claude-code'], 'any'])
  assert.deepEqual([tag.note, surgery.note], ['marks the call', null])
  assert.deepEqual([tag.armed_at, surgery.armed_at], ['2026-11-05T10:00:00.000Z', null])
  assert.deepEqual(surgery.limit, { times: 5, used: 0, until: '2026-11-06T00:00:00.000Z' })
  assert.deepEqual([scrub.limit.times, scrub.limit.until], [null, null])
})

test('--rule answers that one row and the whole rule as the file has it', async () => {
  const one = armedOn(header)
  const home = homeWith({ rules: [script, one], stats: statsOf({}) })
  const doc = await ask(home, { rule: 'tag-header' })
  assert.deepEqual(doc.rules.map((r) => r.name), ['tag-header'])
  assert.deepEqual(doc.rule, one)
})

test('--rule naming no rule is an argument error (exit 2)', async () => {
  await assert.rejects(() => ask(homeWith({ rules: [script] }), { rule: 'nope' }), QueryArgError)
  await assert.rejects(() => ask(homeWith({}), { rule: 'nope' }), QueryArgError)
})

test('changes and not_applied are the counts of a hand-written rules-stats.json, with no daemon', async () => {
  const one = armedOn(script)
  const home = homeWith({
    rules: [one],
    state: { 'claude-code': { desired: 'on' } },
    stats: statsOf({ surgery: {
      armed_key: armedKey(one), changes: 4, last_change: AT, not_applied_by: { timeout: 2, cooling: 1 }, last_not_applied: AT, resting_until: '2026-11-05T12:00:40.000Z', limit_used: 3,
    } }),
  })
  const doc = await ask(home)
  const [row] = doc.rules
  assert.equal(doc.ok, true)
  assert.equal(doc.stats_at, AT)
  assert.deepEqual([row.changes, row.last_change, row.not_applied, row.last_not_applied], [4, AT, 3, AT])
  assert.deepEqual(row.not_applied_by, { timeout: 2, cooling: 1 })
  assert.equal(row.limit.used, 3)
  assert.equal(row.resting_until, '2026-11-05T12:00:40.000Z')
  assert.equal(row.state, 'resting')
})

test('a stats file that cannot be read is unknown, never 0, and the document says so', async () => {
  for (const rules of [[script], [armedOn(script)]]) {
    const home = homeWith({ rules, stats: '{not json' })
    const doc = await ask(home)
    assert.deepEqual([doc.rules[0].changes, doc.rules[0].not_applied], ['unknown', 'unknown'])
    assert.equal(doc.stats_at, null)
    assert.equal(doc.ok, false)
    assert.ok(doc.errors.length > 0)
    assert.deepEqual(validateQueryDoc(doc, 'rules'), [])
  }
})

test('no stats file: a rule that never ran counts 0, an armed one is unknown', async () => {
  const off = await ask(homeWith({ rules: [script] }))
  assert.deepEqual([off.rules[0].changes, off.rules[0].not_applied, off.stats_at, off.ok], [0, 0, null, true])
  assert.deepEqual(off.errors, [])
  const on = await ask(homeWith({ rules: [script, armedOn(header)] }))
  assert.deepEqual(on.rules.map((r) => r.changes), [0, 'unknown'])
  assert.deepEqual(on.rules.map((r) => r.not_applied), [0, 'unknown'])
  assert.equal(on.stats_at, null)
  assert.equal(on.ok, false)
  assert.ok(on.errors.length > 0)
})

test('a rules.json that cannot be read: no rows, the reason in errors', async () => {
  for (const text of ['{not json', '{"rules":[{"name":"BAD"}]}']) {
    const doc = await ask(homeWith({ rules: text }))
    assert.deepEqual(doc.rules, [])
    assert.equal(doc.ok, false)
    assert.ok(doc.errors.length > 0)
    assert.deepEqual(validateQueryDoc(doc, 'rules'), [])
  }
  const named = await ask(homeWith({ rules: '{not json' }), { rule: 'surgery' })
  assert.deepEqual(named.rules, [])
  assert.equal(named.ok, false)
})

test('no rules.json is an empty answer, not a problem', async () => {
  const doc = await ask(homeWith({}))
  assert.deepEqual([doc.rules, doc.ok, doc.stats_at, doc.tripped], [[], true, null, false])
})

test('tripped comes from two unclean stops, and turns every armed rule to tripped', async () => {
  const rules = [armedOn(header), script]
  const one = await ask(homeWith({ rules, stats: statsOf({}), rulesStateDoc: { unclean_stops: 1 } }))
  assert.equal(one.tripped, false)
  const two = await ask(homeWith({ rules, stats: statsOf({}), rulesStateDoc: { unclean_stops: 2 } }))
  assert.equal(two.tripped, true)
  assert.deepEqual(two.rules.map((r) => r.state), ['tripped', 'disabled'])
})

test('stopped_on names the harnesses off went past, by sequence', async () => {
  const rule = armedOn({ ...header, match: { harness: ['claude-code', 'codex'] } })
  const doc = await ask(homeWith({
    rules: [rule], stats: statsOf({}),
    state: { 'claude-code': { desired: 'on', off_seq: 6 }, codex: { desired: 'on', off_seq: 5 } },
  }))
  assert.deepEqual(doc.rules[0].stopped_on, ['claude-code'])
  assert.equal(doc.rules[0].state, 'live')
})

test('the answer writes nothing', async () => {
  const home = homeWith({ rules: [armedOn(header)], stats: statsOf({}) })
  const snapshot = () => fs.readdirSync(home, { recursive: true }).sort().map((f) => { const p = path.join(home, f); return [f, fs.statSync(p).mtimeMs] })
  const before = snapshot()
  await ask(home)
  assert.deepEqual(snapshot(), before)
})

test('the stamp moves with each of the four files and with the minute', () => {
  const home = homeWith({ rules: [script], stats: statsOf({}), state: {}, rulesStateDoc: {} })
  const stamp = (now = NOW) => stampOf('rules', {}, { home, now: () => now })
  const changes = [
    () => fs.appendFileSync(rulesFile(home), ' '),
    () => fs.appendFileSync(rulesStats(home), ' '),
    () => fs.appendFileSync(statePath(home), ' '),
    () => fs.appendFileSync(rulesState(home), ' '),
  ]
  for (const change of changes) {
    const before = stamp()
    change()
    assert.notEqual(stamp(), before)
  }
  assert.notEqual(stamp(NOW + 60e3), stamp())
})
