// test/health/codes.test.mjs — the D38 closed sets (RFC 4.6 §记录「失败不静默」, src/health/codes.mjs): every name a
// collector writer puts in `event` / `where` / `code` / `not_captured` is in the set (a static scan of src/collector,
// proven able to fail on a planted file); the failure / expected split; checkRecord; and the 0.1 §2 dependency rule
// for src/health (node built-ins, src/paths.mjs, src/raw/ only).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_CAPTURED_FAILURE, NOT_CAPTURED_EXPECTED, FAILURE_EVENTS, STATE_EVENTS, WHERE, CODES, TRUST_REASONS, isFailure, isCode, notCapturedClass, checkRecord } from '../../src/health/codes.mjs'
import { EVENT, CODE, TRUST_REASON } from '../../src/collector/core/codes.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []))

// Literal names a writer puts on a record. `fail('…')` is the WebSocket recorder's own helper (other files use a
// `fail` for parse errors); `failure('…')` is the daemon's failure recorder (its first argument is `where`).
function literals(root) {
  const out = []
  // src/capture: the old capture's event writers (RFC 4.1 过渡期, D38) use the same names
  const legacy = fs.existsSync(path.join(root, 'src', 'capture')) ? walk(path.join(root, 'src', 'capture')) : []
  for (const f of [...walk(path.join(root, 'src', 'collector')), ...legacy]) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(root, f)
    const grab = (re, kind) => { for (const m of src.matchAll(re)) out.push({ kind, name: m[1], file: rel }) }
    grab(/\bevent:\s*'([^']+)'/g, 'event')
    grab(/\bwhere:\s*'([^']+)'/g, 'where')
    grab(/\bcode:\s*'([^']+)'/g, 'code')
    grab(/\bnot_captured(?:\s*=\s*|:\s*)'([^']+)'/g, 'not_captured')
    grab(/\bnotCaptured\(\s*'([^']+)'/g, 'not_captured') // the engine flow's helper: notCaptured('h2', reason)
    grab(/\bfailure\(\s*'([^']+)'/g, 'where')
    // a name written through the collector's name maps (src/collector/core/codes.mjs): `EVENT.agentTrusted`, `CODE.residue`
    for (const m of src.matchAll(/\bEVENT\.(\w+)/g)) out.push({ kind: 'event', name: EVENT[m[1]] ?? `EVENT.${m[1]} (not in the map)`, file: rel })
    for (const m of src.matchAll(/\bCODE\.(\w+)/g)) out.push({ kind: 'code', name: CODE[m[1]] ?? `CODE.${m[1]} (not in the map)`, file: rel })
    if (rel.endsWith(path.join('ws', 'recorder.mjs'))) grab(/\bfail\(\s*'([^']+)'/g, 'code')
  }
  return out
}
const outside = (lits) => lits.filter(({ kind, name }) => !(kind === 'event' ? [...FAILURE_EVENTS, ...STATE_EVENTS].includes(name)
  : kind === 'where' ? WHERE.includes(name) : kind === 'code' ? isCode(name) : [...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED].includes(name)))

test('D38 every event / where / code / not_captured a collector writer names is in the closed set (src/health/codes.mjs)', () => {
  const lits = literals(REPO)
  for (const [kind, name] of [['event', 'agent-untrusted'], ['where', 'engine'], ['not_captured', 'h2'], ['code', 'write-failed']]) {
    assert.ok(lits.some((l) => l.kind === kind && l.name === name), `the scan still sees ${kind} ${name} (else it proves nothing)`)
  }
  assert.deepEqual(outside(lits), [])
})

test('D38 the scan fails on a name outside the set (planted tree)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-codes-'))
  try {
    fs.mkdirSync(path.join(root, 'src', 'collector', 'core', 'ws'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'collector', 'a.mjs'), "w({ event: 'agent-wandered', where: 'nowhere', code: 'oops-code' }); failure('elsewhere', e); r.not_captured = 'shrug'; notCaptured('hmm', why)\n")
    fs.writeFileSync(path.join(root, 'src', 'collector', 'core', 'ws', 'recorder.mjs'), "fail('made-up', e)\n")
    assert.deepEqual(outside(literals(root)).map((l) => `${l.kind} ${l.name}`).sort(), ['code made-up', 'code oops-code', 'event agent-wandered', 'not_captured hmm', 'not_captured shrug', 'where elsewhere', 'where nowhere'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('D38 failure vs expected: only failure classes and failure events turn the indicator', () => {
  for (const nc of NOT_CAPTURED_FAILURE) { assert.equal(notCapturedClass(nc), 'failure'); assert.equal(isFailure({ flow_id: 'f', not_captured: nc }), true, nc) }
  for (const nc of NOT_CAPTURED_EXPECTED) { assert.equal(notCapturedClass(nc), 'expected'); assert.equal(isFailure({ flow_id: 'f', not_captured: nc }), false, nc) }
  assert.equal(isFailure({ flow_id: 'f', decision: 'decrypt', error: { type: 'ECONNRESET' } }), false, 'a connection error alone is the expected class')
  assert.equal(isFailure({ flow_id: 'f', reason: 'client-rejected-leaf' }), true)
  assert.equal(isFailure({ flow_id: null, decision: 'direct', not_captured: 'untrusted' }), true, 'a kernel-reported direct row of an untrusted agent')
  for (const e of FAILURE_EVENTS) assert.equal(isFailure({ event: e, reason: 'r' }), true, e)
  for (const e of STATE_EVENTS) assert.equal(isFailure({ event: e }), false, e)
  assert.equal(new Set([...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED]).size, NOT_CAPTURED_FAILURE.length + NOT_CAPTURED_EXPECTED.length, 'no name in both classes')
})

test('D38 checkRecord: names outside the set, a failure without a reason; errno codes pass as they are', () => {
  assert.deepEqual(checkRecord({ event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'r' }), [])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'record', code: 'ENOSPC', reason: 'r' }), [])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'engine', code: 'ERR_SSL_WRONG_VERSION_NUMBER', reason: 'r' }), [])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'engine' }), ['failure without a reason', 'failure without where and code'])
  assert.deepEqual(checkRecord({ event: 'boom', where: 'mars', code: 'nope', reason: 'r' }), ['event "boom"', 'where "mars"', 'code "nope"'])
  assert.deepEqual(checkRecord({ flow_id: 'f', not_captured: 'shrug' }), ['not_captured "shrug"'])
  assert.ok(CODES.includes('lookup-miss') && CODES.includes('ca-invalid'))
})

test('0.1 §2 src/health imports only node built-ins, src/paths.mjs and src/raw/', () => {
  const dir = path.join(REPO, 'src', 'health')
  for (const f of walk(dir)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bfrom\s*'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1] || m[2]
      if (spec.startsWith('node:')) continue
      const to = path.relative(REPO, path.resolve(path.dirname(f), spec)).split(path.sep).join('/')
      assert.ok(to === 'src/paths.mjs' || to.startsWith('src/raw/') || to.startsWith('src/health/'), `${path.relative(REPO, f)} imports ${to}`)
    }
  }
})

// The harness lane's name maps (src/collector/core/codes.mjs) hold no name that is not in the closed set, and a trust
// reason a descriptor defines (its `trust.hints` keys) is one of TRUST_REASONS (core names no harness: they are listed in
// the closed set once, and this test is what keeps the list whole).
test('D38 the collector name maps and every harness trust reason are in the closed set', async () => {
  for (const [k, v] of Object.entries(EVENT)) assert.ok([...FAILURE_EVENTS, ...STATE_EVENTS].includes(v), `EVENT.${k} = ${v}`)
  for (const [k, v] of Object.entries(CODE)) assert.ok(isCode(v), `CODE.${k} = ${v}`)
  for (const r of Object.keys(TRUST_REASON)) assert.ok(TRUST_REASONS.includes(r), `core trust reason ${r}`)
  const unlisted = []
  for (const h of await loadHarnesses()) for (const r of Object.keys((h.trust && h.trust.hints) || {})) if (!TRUST_REASONS.includes(r)) unlisted.push(`${h.name}: ${r}`)
  assert.deepEqual(unlisted, [], 'a harness defines a trust reason that src/health/codes.mjs TRUST_REASONS does not list')
  for (const r of TRUST_REASONS) assert.ok(isCode(r), r)
})
