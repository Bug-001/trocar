// test/health/codes.test.mjs — the D38 closed sets (RFC 4.6 §记录「失败不静默」, src/health/codes.mjs): every name a
// collector writer puts in `event` / `where` / `code` / `not_captured` is in the set (a static scan of src/collector,
// proven able to fail on a planted file); the failure / expected split; checkRecord; and the 0.1 §2 dependency rule
// for src/health (node built-ins, src/paths.mjs, src/raw/ and src/off/proc.mjs only). The Windows collector's names (RFC 4.8 §12, W38): ROUTE_*,
// the NET_* names it shares with 4.7 / 1.6, CAPTURE_KINDS.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as closedSets from '../../src/health/codes.mjs'
import { NOT_CAPTURED_FAILURE, NOT_CAPTURED_EXPECTED, FAILURE_EVENTS, STATE_EVENTS, CODES, TRUST_REASONS, OFF_WHERE, OFF_EVENTS, OFF_CODES, ROUTE_WHERE, ROUTE_EVENTS, ROUTE_CODES, ROUTE_FAILURE_CODES, ROUTE_TRUST_REASONS, ROUTE_STATUS_REASONS, NET_WHERE, NET_EVENTS, NET_CODES, NET_FAILURE_CODES, STATUS_REASONS, CAPTURE_KINDS, isFailure, isCode, isEvent, isWhere, notCapturedClass, checkRecord } from '../../src/health/codes.mjs'
import { WHERE_OFF, EVENT_OFF_NOTE, CODE_OFF } from '../../src/off/names.mjs'
import { EVENT, CODE, TRUST_REASON } from '../../src/collector/core/codes.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []))

// Literal names a writer puts on a record. `fail('…')` is the WebSocket recorder's own helper (other files use a
// `fail` for parse errors); `failure('…')` is the daemon's failure recorder (its first argument is `where`).
function literals(root) {
  const out = []
  // src/capture: the old capture's event writers (RFC 4.1 过渡期, D38) use the same names; src/off and src/cli (RFC 1.6, D39⑦) write `off`'s;
  // src/netenv (RFC 4.7, 4.8 §12) writes the drift and routing failures of the VPN / forwarder side, and `netenv-change` (1.6 §9.7)
  const more = ['capture', 'off', 'cli', 'netenv'].flatMap((d) => (fs.existsSync(path.join(root, 'src', d)) ? walk(path.join(root, 'src', d)) : []))
  for (const f of [...walk(path.join(root, 'src', 'collector')), ...more]) {
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
    // and through src/off/names.mjs, the undo side's own copy (D39⑦): `CODE_OFF.backupKept`, `EVENT_OFF_NOTE`, `WHERE_OFF`
    for (const m of src.matchAll(/\bCODE_OFF\.(\w+)/g)) out.push({ kind: 'code', name: CODE_OFF[m[1]] ?? `CODE_OFF.${m[1]} (not in the map)`, file: rel })
    for (const m of src.matchAll(/\bEVENT_OFF_NOTE\b/g)) out.push({ kind: 'event', name: EVENT_OFF_NOTE, file: rel })
    for (const m of src.matchAll(/\bWHERE_OFF\b/g)) out.push({ kind: 'where', name: WHERE_OFF, file: rel })
    if (rel.endsWith(path.join('ws', 'recorder.mjs'))) grab(/\bfail\(\s*'([^']+)'/g, 'code')
  }
  return out
}
// the same sets checkRecord() judges by (isEvent / isWhere / isCode), so a name the scan lets through is one the check lets through
const outside = (lits) => lits.filter(({ kind, name }) => !(kind === 'event' ? isEvent(name)
  : kind === 'where' ? isWhere(name) : kind === 'code' ? isCode(name) : [...NOT_CAPTURED_FAILURE, ...NOT_CAPTURED_EXPECTED].includes(name)))

test('D38 every event / where / code / not_captured a collector writer names is in the closed set (src/health/codes.mjs)', () => {
  const lits = literals(REPO)
  for (const [kind, name] of [['event', 'agent-untrusted'], ['where', 'engine'], ['not_captured', 'h2'], ['code', 'write-failed']]) {
    assert.ok(lits.some((l) => l.kind === kind && l.name === name), `the scan still sees ${kind} ${name} (else it proves nothing)`)
  }
  assert.ok(lits.some((l) => l.kind === 'where' && l.name === 'off' && l.file.startsWith(path.join('src', 'off'))), 'and it reaches src/off (D39⑦), where `off` names its records')
  assert.deepEqual(outside(lits), [])
})

test('D38 the scan fails on a name outside the set (planted tree)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-codes-'))
  try {
    fs.mkdirSync(path.join(root, 'src', 'collector', 'core', 'ws'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'collector', 'a.mjs'), "w({ event: 'agent-wandered', where: 'nowhere', code: 'oops-code' }); failure('elsewhere', e); r.not_captured = 'shrug'; notCaptured('hmm', why)\n")
    fs.writeFileSync(path.join(root, 'src', 'collector', 'core', 'ws', 'recorder.mjs'), "fail('made-up', e)\n")
    fs.mkdirSync(path.join(root, 'src', 'off')); fs.mkdirSync(path.join(root, 'src', 'cli')); fs.mkdirSync(path.join(root, 'src', 'netenv'))
    fs.writeFileSync(path.join(root, 'src', 'off', 'b.mjs'), "w({ event: 'off-notes', where: 'offf', code: 'backup-lost' }); w({ event: 'off-note', where: 'off', code: 'backup-kept' }); x = CODE_OFF.backupLost; y = CODE_OFF.backupKept\n")
    fs.writeFileSync(path.join(root, 'src', 'cli', 'c.mjs'), "w({ event: 'failure', where: 'cli', code: 'cli-broke' })\n")
    fs.writeFileSync(path.join(root, 'src', 'netenv', 'd.mjs'), "w({ event: 'failure', where: 'netenvv', code: 'route-lost' }); w({ event: 'failure', where: 'netenv', code: 'route-loop' }); w({ event: 'route-applied', where: 'routing', code: 'ingress-unknown' })\n")
    assert.deepEqual(outside(literals(root)).map((l) => `${l.kind} ${l.name}`).sort(), ['code CODE_OFF.backupLost (not in the map)', 'code backup-lost', 'code cli-broke', 'code made-up', 'code oops-code', 'code route-lost', 'event agent-wandered', 'event off-notes', 'not_captured hmm', 'not_captured shrug', 'where cli', 'where elsewhere', 'where netenvv', 'where nowhere', 'where offf'].sort())
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

test('0.1 §2 src/health imports only node built-ins, src/paths.mjs, src/raw/ and src/off/proc.mjs', () => {
  const dir = path.join(REPO, 'src', 'health')
  for (const f of walk(dir)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bfrom\s*'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1] || m[2]
      if (spec.startsWith('node:')) continue
      const to = path.relative(REPO, path.resolve(path.dirname(f), spec)).split(path.sep).join('/')
      assert.ok(to === 'src/paths.mjs' || to === 'src/off/proc.mjs' || to.startsWith('src/raw/') || to.startsWith('src/health/'), `${path.relative(REPO, f)} imports ${to}`)
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
  for (const h of await loadHarnesses()) for (const r of Object.keys((h.trust && h.trust.hints) || {})) if (!TRUST_REASONS.includes(r) && !ROUTE_TRUST_REASONS.includes(r)) unlisted.push(`${h.name}: ${r}`)
  assert.deepEqual(unlisted, [], 'a harness defines a trust reason that src/health/codes.mjs TRUST_REASONS (or the Windows ROUTE_TRUST_REASONS) does not list')
  for (const r of [...TRUST_REASONS, ...ROUTE_TRUST_REASONS]) assert.ok(isCode(r), r)
})

// D39⑦ (RFC 1.6 §涉及源文件与接口「闭集」): the names `asight off` writes. src/off may import nothing outside itself (0.1 §2), so
// it keeps its own copy (src/off/names.mjs); this is what keeps the two copies the same list.
test('D39 the off names (where off, event off-note, codes backup-failed / backup-kept / undone-by-marker) are in the closed sets', () => {
  assert.deepEqual(checkRecord({ event: 'off-note', where: 'off', code: 'backup-kept', reason: 'x' }), [])
  assert.deepEqual(checkRecord({ event: 'off-note', where: 'off', code: 'undone-by-marker', reason: 'x' }), [])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'off', code: 'backup-failed', reason: 'could not write the backup' }), [])
  assert.deepEqual(checkRecord({ event: 'off-note', where: 'off', kind: 'result', outcome: 'done' }), [])
  for (const c of OFF_CODES) { assert.ok(isCode(c), c); assert.deepEqual(checkRecord({ event: 'off-note', where: 'off', code: c }), [], c) }
  assert.deepEqual(OFF_CODES, ['backup-failed', 'backup-kept', 'undone-by-marker'])
  assert.deepEqual(OFF_WHERE, ['off']); assert.deepEqual(OFF_EVENTS, ['off-note'])
  // the sets still reject a name next to them (the check can fail)
  assert.deepEqual(checkRecord({ event: 'off-notes', where: 'offf', code: 'backup-lost' }), ['event "off-notes"', 'where "offf"', 'code "backup-lost"'])
})

test('D39 an off-note is a state change, not a failure: the indicator turns on a failure event only', () => {
  assert.equal(isFailure({ event: 'off-note', where: 'off', code: 'backup-kept', reason: 'x' }), false)
  assert.equal(isFailure({ event: 'failure', where: 'off', code: 'backup-failed', reason: 'x' }), true)
  assert.ok(!FAILURE_EVENTS.includes('off-note'), 'a state change: it is not on the failure list')
})

test('D39 src/off/names.mjs is the same list as the closed set (src/off cannot import src/health)', () => {
  assert.deepEqual([WHERE_OFF], OFF_WHERE)
  assert.deepEqual([EVENT_OFF_NOTE], OFF_EVENTS)
  assert.deepEqual(Object.values(CODE_OFF), OFF_CODES)
  assert.deepEqual(Object.keys(CODE_OFF), ['backupFailed', 'backupKept', 'undoneByMarker'])
  assert.ok(Object.isFrozen(CODE_OFF))
})

// ---- D42 (RFC 4.8 §12, W38): the names the Windows collector writes --------------------------------------------------------
// The table below is the spec's §12 table written out by hand (code, where, class), not read back from the module, so a name
// added, dropped or moved in codes.mjs and not in the RFC turns this red.
const SPEC_12_FAILURES = [
  ['ingress-auth-failed', 'ingress'], ['ingress-unknown', 'ingress'], ['engine-port-taken', 'ingress'], ['upstream-unavailable', 'ingress'],
  // the kernel family (fallback-active, forwarder-*) retired with the kernel on both arches (D47 and its win32 twin): no producer anywhere
  ['optin-failed', 'optin'],
  ['socktable-unavailable', 'helper'], ['helper-start-failed', 'helper'],
  ['task-register-failed', 'install'], ['launchd-register-failed', 'install'], // the darwin autostart (4.9 §12)
  ['elevated-token', 'start'], ['root-token', 'start'], // elevated-token's darwin name (4.9 §12)
] // every row of the §12 table is the class 失败
// the names §12 says it does not define again: 1.6 §9.7 (`NET_*`) and 4.7 §5 own them (D43 withdrew the other 4.7 §5 names)
const SHARED_WITH_NET = ['forwarder-down', 'egress-differs', 'route-loop']
// the names D43 withdrew (4.8 §12, 4.7 §5) were all of these families: the block's drift codes, the proxy software's mode and find-process cases, the re-entry credential
const WITHDRAWN_FAMILY = /^(vpn-|clash-mode|find-process|reenter)/
const CODES_SRC = fs.readFileSync(path.join(REPO, 'src', 'health', 'codes.mjs'), 'utf8')
const quotedCount = (name) => CODES_SRC.split(`'${name}'`).length - 1

test('W38 every §12 code is a code, and a failure event naming it with its where passes checkRecord and counts as a failure', () => {
  assert.deepEqual([...ROUTE_CODES].sort(), SPEC_12_FAILURES.map(([c]) => c).sort(), 'ROUTE_CODES is the §12 table, no more and no less')
  assert.deepEqual([...ROUTE_FAILURE_CODES].sort(), [...ROUTE_CODES].sort(), 'every §12 row is the failure class')
  for (const [code, where] of SPEC_12_FAILURES) {
    assert.ok(isCode(code), code)
    assert.ok(isWhere(where), where)
    const rec = { event: 'failure', where, code, reason: 'why' }
    assert.deepEqual(checkRecord(rec), [], `${where}/${code}`)
    assert.equal(isFailure(rec), true, code)
  }
  // the case the plan names
  assert.deepEqual(checkRecord({ event: 'failure', where: 'ingress', code: 'ingress-auth-failed', reason: 'token mismatch' }), [])
  // the kernel family is gone from every closed set (D47's twin): the reverse assertion — no arch produces one, no set holds one
  for (const gone of ['forwarder-download-failed', 'forwarder-start-failed', 'forwarder-restart', 'forwarder-digest-mismatch', 'forwarder-binary-missing', 'fallback-active', 'pid-unresolved-mixed', 'kernel-not-off']) {
    assert.ok(!isCode(gone) && !ROUTE_CODES.includes(gone) && !CODES.includes(gone), `${gone} retired with the kernel`)
    assert.deepEqual(checkRecord({ event: 'failure', where: 'routing', code: gone, reason: 'x' }), ['where "routing"' === '' ? undefined : `code "${gone}"`].filter(Boolean))
  }
  assert.ok(!ROUTE_WHERE.includes('forwarder') && !isWhere('forwarder'), 'the where retired too')
  // Windows codes sit beside the Linux ones, not inside the lists D40 edits
  for (const c of ROUTE_CODES) assert.ok(!CODES.includes(c), `${c} is defined once: ROUTE_CODES, not also CODES`)
})

test('W38 the where / state events / trust reasons / status reasons / capture kinds are the §12 lists', () => {
  assert.deepEqual(ROUTE_WHERE, ['routing', 'ingress', 'optin'])
  assert.deepEqual(ROUTE_EVENTS, ['route-applied', 'optin-applied', 'optin-removed'])
  assert.deepEqual(ROUTE_TRUST_REASONS, ['smart-app-control', 'env-unreadable-fill'])
  assert.deepEqual(ROUTE_STATUS_REASONS, ['form-unsupported', 'form-path-unknown'])
  assert.deepEqual(CAPTURE_KINDS, ['transparent', 'proxy'], 'the envelope `capture` closed set (4.8 §5.6, 4.1 信封表): Windows has the one proxy mode (D43)')
  for (const l of [ROUTE_WHERE, ROUTE_EVENTS, ROUTE_CODES, ROUTE_FAILURE_CODES, ROUTE_TRUST_REASONS, ROUTE_STATUS_REASONS, CAPTURE_KINDS, NET_WHERE, NET_CODES, NET_FAILURE_CODES]) assert.ok(Object.isFrozen(l))
  for (const w of ROUTE_WHERE) assert.ok(isWhere(w), w)
  for (const r of ROUTE_TRUST_REASONS) {
    assert.ok(isCode(r), r)
    assert.ok(!CODES.includes(r) && !TRUST_REASONS.includes(r), `${r} stays in ROUTE_TRUST_REASONS, the block of its own`)
    assert.deepEqual(checkRecord({ event: 'agent-untrusted', where: 'tracker', code: r, reason: 'why' }), [], r)
  }
})

test('W38 the route events are state changes: they pass checkRecord with their fields and never turn the indicator', () => {
  const recs = [
    { event: 'route-applied', where: 'routing', form: 'claude-code.cli', upstream_kind: 'user-proxy', verified: true },
    { event: 'optin-applied', where: 'optin', form: 'codex.app', item: 'cert-store', scope: 'user' },
    { event: 'optin-removed', where: 'optin', form: 'codex.app', item: 'cert-store', scope: 'user' },
  ]
  assert.deepEqual(recs.map((r) => r.event), ROUTE_EVENTS)
  for (const r of recs) {
    assert.ok(isEvent(r.event), r.event)
    assert.deepEqual(checkRecord(r), [], r.event)
    assert.equal(isFailure(r), false, r.event)
    assert.ok(!FAILURE_EVENTS.includes(r.event) && !STATE_EVENTS.includes(r.event), `${r.event}: in ROUTE_EVENTS, not in the lists D40 edits`)
  }
})

test('W38 the names shared with 1.6 §9.7 and 4.7 §5 are defined once: one block, one literal in the file, no copy in the Windows block', () => {
  for (const name of SHARED_WITH_NET) {
    assert.equal(quotedCount(name), 1, `'${name}' is written once in src/health/codes.mjs`)
    assert.ok(NET_CODES.includes(name), `${name} in NET_CODES`)
    assert.ok(!ROUTE_CODES.includes(name) && !CODES.includes(name), `${name} is not also defined by ROUTE_CODES or CODES`)
    assert.ok(isCode(name), name)
  }
  // D43 withdrew the rest of 4.7 §5's names (and `reenter-*`): no closed set holds one, and the source does not write one
  for (const name of [...CODES, ...OFF_CODES, ...ROUTE_CODES, ...ROUTE_STATUS_REASONS, ...ROUTE_TRUST_REASONS, ...NET_CODES, ...CAPTURE_KINDS]) assert.ok(!WITHDRAWN_FAMILY.test(name), name)
  assert.deepEqual(CODES_SRC.match(/'(vpn-|clash-mode|find-process|reenter)[a-z-]*'/g), null, 'and src/health/codes.mjs does not write one')
  assert.ok(WITHDRAWN_FAMILY.test('vpn-x') && WITHDRAWN_FAMILY.test('reenter-y') && !WITHDRAWN_FAMILY.test('route-loop'), 'the pattern can fail')
  const all = [...ROUTE_CODES, ...NET_CODES, ...ROUTE_TRUST_REASONS]
  assert.deepEqual(all.filter((n, i) => all.indexOf(n) !== i), [], 'no name is in two of the blocks')
  assert.deepEqual(NET_WHERE, ['netenv'], '4.7 §5:都写 where:\'netenv\'')
  assert.ok(isWhere('netenv'))
})

test('W38 the three names 4.7 §5 and 1.6 §9.7 share: route-loop and forwarder-down are the failure class (a failure event), egress-differs the notice class (status and doctor only, never a failure event)', () => {
  assert.deepEqual(['route-loop', 'forwarder-down'].filter((c) => !NET_FAILURE_CODES.includes(c)), [], 'the failure class')
  assert.ok(NET_CODES.includes('egress-differs') && !NET_FAILURE_CODES.includes('egress-differs'), '提示 class: status / doctor only')
  for (const code of ['route-loop', 'forwarder-down']) assert.deepEqual(checkRecord({ event: 'failure', where: 'netenv', code, reason: 'why' }), [], code)
  assert.deepEqual(checkRecord({ event: 'netenv-change', where: 'netenv', harness: 'codex', code: 'egress-differs', from: 'a', to: 'b' }), [], 'a notice rides a state change, which is no failure')
  assert.equal(isFailure({ event: 'netenv-change', where: 'netenv', code: 'egress-differs' }), false)
})

test('W38 the sets still reject a name beside the Windows ones (the check can fail)', () => {
  assert.deepEqual(checkRecord({ event: 'route-apply', where: 'route', reason: 'x' }), ['event "route-apply"', 'where "route"'])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'ingres', code: 'ingress-auth-fail', reason: 'x' }), ['where "ingres"', 'code "ingress-auth-fail"'])
  assert.deepEqual(checkRecord({ event: 'failure', where: 'routing', code: 'forwarder-restarted', reason: 'x' }), ['code "forwarder-restarted"'], 'the kernel family is no code any more')
  assert.deepEqual(checkRecord({ event: 'failure', where: 'netenv', code: 'route-lost', reason: 'x' }), ['code "route-lost"'])
})

// The status reason set (1.6 §2, CLI plan task 9): its list takes the Windows status reasons and trust reasons in (4.8 §2.3, §5.4, §6.3, §12).
test('W38: STATUS_REASONS includes the Windows status reasons and trust reasons', () => {
  assert.ok(Array.isArray(closedSets.STATUS_REASONS) && closedSets.STATUS_REASONS === STATUS_REASONS)
  for (const r of [...ROUTE_STATUS_REASONS, ...ROUTE_TRUST_REASONS]) assert.ok(STATUS_REASONS.includes(r), r)
  for (const r of ['not-routed', 'desired-off', 'negative-cache']) assert.ok(STATUS_REASONS.includes(r), `${r} is still one`)
  assert.equal(new Set(STATUS_REASONS).size, STATUS_REASONS.length, 'no name twice')
})

// D39⑩ / D43 (RFC 1.6 §9.7, V53): the names the network topology and `doctor` use. A block of its own, like OFF_* and ROUTE_*.
const NET_LIST = ['not-routed', 'proxy-changed', 'proxy-dead', 'proxy-unsupported', 'netenv-changed', 'elevated-agent', 'forwarder-down', 'upstream-unreachable', 'egress-differs', 'opt-in-needed', 'shim-not-on-path', 'not-via-entry', 'needs-admin', 'linger-off', 'system-proxy-pac', 'other-redirector', 'fake-ip', 'inferred-behaviour', 'cause-unknown', 'route-loop']
test('V53: the net names are the 1.6 §9.7 list (route-loop, shared with 4.7, once), isCode knows each, and the records they go on pass checkRecord', () => {
  assert.deepEqual(NET_WHERE, ['netenv'])
  assert.deepEqual(NET_EVENTS, ['netenv-change'])
  assert.deepEqual([...NET_CODES].sort(), [...NET_LIST].sort())
  for (const c of NET_CODES) {
    assert.ok(isCode(c), c)
    assert.deepEqual(checkRecord({ event: 'netenv-change', where: 'netenv', harness: 'codex', code: c, from: 'a', to: 'b' }), [], c)
  }
  for (const c of NET_FAILURE_CODES) assert.deepEqual(checkRecord({ event: 'failure', where: 'netenv', code: c, reason: 'x' }), [], c)
  assert.deepEqual([...NET_FAILURE_CODES].sort(), ['elevated-agent', 'forwarder-down', 'not-routed', 'not-via-entry', 'proxy-dead', 'proxy-unsupported', 'route-loop', 'shim-not-on-path', 'upstream-unreachable'])
  for (const c of NET_FAILURE_CODES) assert.ok(NET_CODES.includes(c), `${c} is a net code`)
  assert.equal(isFailure({ event: 'netenv-change', where: 'netenv', code: 'proxy-changed' }), false, 'a netenv-change is a state change: the indicator turns on a failure event only')
  assert.ok(!FAILURE_EVENTS.includes('netenv-change'))
  assert.deepEqual(checkRecord({ event: 'netenv-chang', where: 'netenvv', code: 'proxy-lost' }), ['event "netenv-chang"', 'where "netenvv"', 'code "proxy-lost"'], 'the check can still fail')
})

test('V53: the status reasons gain the nine 1.6 §9.7 names (the proxy-mode ones are the Windows branch\'s)', () => {
  for (const r of ['not-routed', 'proxy-changed', 'elevated-agent', 'forwarder-down', 'upstream-unreachable', 'route-loop', 'opt-in-needed', 'shim-not-on-path', 'not-via-entry']) assert.ok(STATUS_REASONS.includes(r), r)
  for (const r of ['desired-off', 'config-after-start', 'negative-cache']) assert.ok(STATUS_REASONS.includes(r), `${r} is still one`)
})

test('V53 (D43): the names 4.7 and 4.8 share are defined once in src/health/codes.mjs, and the withdrawn VPN-block names are nowhere in src/', () => {
  const text = fs.readFileSync(path.join(REPO, 'src', 'health', 'codes.mjs'), 'utf8')
  for (const name of ['route-loop', 'forwarder-down', 'egress-differs']) assert.equal(text.split(`'${name}'`).length - 1, 1, `${name} occurs once in src/health/codes.mjs`)
  const all = walk(path.join(REPO, 'src')).map((f) => [path.relative(REPO, f), fs.readFileSync(f, 'utf8')])
  assert.ok(all.length > 50, 'the scan sees src/')
  for (const needle of ['clash-mode-bypass', 'vpn-block-']) assert.deepEqual(all.filter(([, t]) => t.includes(needle)).map(([f]) => f), [], `${needle} is withdrawn (D43): in no set, in no file`)
})
