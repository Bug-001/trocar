// test/cli/schema.test.mjs — RFC 1.6 R5 (`--json`): the keys every receipt carries, the exit codes of R4, and validateReceipt, the
// check V9 runs over every command's output. Each rule has a bad input that makes it say so (0.1 §3: a check must be able to fail).
import test from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt, validateReceipt, validateTopology, ROUTING, TOPOLOGY_KINDS, TOPOLOGY_VIA, UNKNOWN_REASONS, FINDING_CLASSES } from '../../src/cli/schema.mjs'
import * as off from '../../src/off/schema.mjs'

const mutate = (fn, command = 'off') => { const r = newReceipt(command); fn(r); return r }
const problems = (fn) => validateReceipt(mutate(fn))

test('receipt schema: the keys, the exit codes and the version are the 1.6 R5 / R4 ones, and src/cli re-exports src/off', () => {
  assert.equal(SCHEMA_VERSION, 2)
  assert.deepEqual(RECEIPT_KEYS, ['schema', 'command', 'ok', 'changed', 'created', 'removed', 'skipped', 'restart', 'relayed', 'undo', 'log'])
  assert.deepEqual({ ...EXIT }, { ok: 0, incomplete: 1, usage: 2, unknown: 3, crash: 70 })
  assert.ok(Object.isFrozen(EXIT))
  assert.equal(off.EXIT, EXIT); assert.equal(off.newReceipt, newReceipt); assert.equal(off.RECEIPT_KEYS, RECEIPT_KEYS); assert.equal(off.SCHEMA_VERSION, SCHEMA_VERSION)
})

test('receipt schema: newReceipt is the empty receipt in key order, a fresh object each time, and it validates', () => {
  const r = newReceipt('off')
  assert.deepEqual(r, { schema: 2, command: 'off', ok: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: 'unknown', undo: [], log: null })
  assert.deepEqual(Object.keys(r), RECEIPT_KEYS)
  assert.notEqual(newReceipt('off').changed, r.changed, 'no list shared between receipts')
  assert.deepEqual(validateReceipt(r), [])
  for (const c of ['on', 'off', 'status', 'uninstall', 'doctor']) assert.deepEqual(validateReceipt(newReceipt(c)), [], c)
})

// R5 / R11 (V10): what was not read is "unknown", never 0. A command that forgets to write `relayed` must not print a confident zero.
test('receipt schema: a fresh receipt does not claim zero relayed connections: relayed is "unknown" until a command measures it', () => {
  for (const c of ['on', 'off', 'status', 'uninstall', 'doctor']) {
    const r = newReceipt(c)
    assert.equal(r.relayed, 'unknown', c)
    assert.notDeepEqual(r.relayed, { closing: 0, waiting: 0, cut: 0 })
    assert.deepEqual(validateReceipt(r), [], `${c}: "unknown" is a valid answer`)
  }
  const measured = newReceipt('off'); measured.relayed = { closing: 0, waiting: 0, cut: 0 }
  assert.deepEqual(validateReceipt(measured), [], 'zeros a command wrote on purpose are valid too')
})

test('receipt schema: a missing key is named', () => {
  for (const key of RECEIPT_KEYS) {
    const r = newReceipt('off'); delete r[key]
    const p = validateReceipt(r)
    assert.ok(p.some((s) => s.includes(key)), `${key}: ${JSON.stringify(p)}`)
  }
})

test('receipt schema: not an object at all', () => {
  for (const v of [null, undefined, 'receipt', 7, [], [newReceipt('off')]]) assert.ok(validateReceipt(v).length > 0, JSON.stringify(v))
})

test('receipt schema: schema is the current integer, command a non-empty string, ok a boolean', () => {
  assert.ok(problems((r) => { r.schema = 3 }).some((s) => s.includes('schema')), 'another integer than this manual\'s shape (2) is a problem')
  assert.ok(problems((r) => { r.schema = '2' }).some((s) => s.includes('schema')))
  assert.ok(problems((r) => { r.command = '' }).some((s) => s.includes('command')))
  assert.ok(problems((r) => { r.command = 7 }).some((s) => s.includes('command')))
  assert.ok(problems((r) => { r.ok = 'yes' }).some((s) => s.includes('ok')))
  assert.ok(problems((r) => { r.ok = 0 }).some((s) => s.includes('ok')))
  assert.deepEqual(problems((r) => { r.ok = false }), [])
})

test('receipt schema: changed[] items are {path, change, backup: string|null}', () => {
  assert.deepEqual(problems((r) => { r.changed.push({ path: '/h/.codex/.env', change: 'adds the asight block', backup: '/h/.asight/backup/ab-1' }, { path: '/h/.bashrc', change: 'x', backup: null }) }), [])
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 'x' }) }).some((s) => s.includes('changed[0].backup')), 'backup must be there, null when there is none')
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 'x', backup: 3 }) }).some((s) => s.includes('changed[0].backup')))
  assert.ok(problems((r) => { r.changed.push({ change: 'x', backup: null }) }).some((s) => s.includes('changed[0].path')))
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 7, backup: null }) }).some((s) => s.includes('changed[0].change')))
  assert.ok(problems((r) => { r.changed.push('/h/a') }).some((s) => s.includes('changed[0]')))
  assert.ok(problems((r) => { r.changed = {} }).some((s) => s.includes('changed')))
})

test('receipt schema: skipped[] items are {what, reason} strings', () => {
  assert.deepEqual(problems((r) => { r.skipped.push({ what: 'hermes', reason: '~/.hermes does not exist' }) }), [])
  assert.ok(problems((r) => { r.skipped.push({ what: 'hermes' }) }).some((s) => s.includes('skipped[0].reason')))
  assert.ok(problems((r) => { r.skipped.push({ what: 3, reason: 'x' }) }).some((s) => s.includes('skipped[0].what')))
  assert.ok(problems((r) => { r.skipped.push('hermes') }).some((s) => s.includes('skipped[0]')))
})

test('receipt schema: restart[] items are {harness: canonical id, pid: integer}; an alias is not an id', () => {
  assert.deepEqual(problems((r) => { r.restart.push({ harness: 'claude-code', pid: 4121 }) }), [])
  assert.ok(problems((r) => { r.restart.push({ harness: 'claude', pid: 1 }) }).some((s) => s.includes('restart[0].harness')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'nope', pid: 1 }) }).some((s) => s.includes('restart[0].harness')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex', pid: '12' }) }).some((s) => s.includes('restart[0].pid')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex', pid: 1.5 }) }).some((s) => s.includes('restart[0].pid')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex' }) }).some((s) => s.includes('restart[0].pid')))
})

test('receipt schema: relayed is "unknown" or three non-negative integers', () => {
  assert.deepEqual(problems((r) => { r.relayed = 'unknown' }), [])
  assert.deepEqual(problems((r) => { r.relayed = { closing: 2, waiting: 1, cut: 0 } }), [])
  assert.ok(problems((r) => { r.relayed = 'none' }).some((s) => s.includes('relayed')), 'only "unknown" is a word for not knowing')
  assert.ok(problems((r) => { r.relayed = null }).some((s) => s.includes('relayed')))
  assert.ok(problems((r) => { r.relayed = 0 }).some((s) => s.includes('relayed')))
  const counted = (r) => { r.relayed = { closing: 0, waiting: 0, cut: 0 }; return r.relayed } // a fresh receipt's relayed is the string "unknown"
  for (const k of ['closing', 'waiting', 'cut']) {
    assert.ok(problems((r) => { delete counted(r)[k] }).some((s) => s.includes(`relayed.${k}`)), `${k} missing`)
    assert.ok(problems((r) => { counted(r)[k] = -1 }).some((s) => s.includes(`relayed.${k}`)), `${k} negative`)
    assert.ok(problems((r) => { counted(r)[k] = 1.5 }).some((s) => s.includes(`relayed.${k}`)), `${k} fractional`)
    assert.ok(problems((r) => { counted(r)[k] = '2' }).some((s) => s.includes(`relayed.${k}`)), `${k} a string`)
    assert.ok(problems((r) => { counted(r)[k] = null }).some((s) => s.includes(`relayed.${k}`)), `${k} null (not 0: R11)`)
  }
})

test('receipt schema: linger is optional, and true | false | "unknown" when there', () => {
  for (const v of [true, false, 'unknown']) assert.deepEqual(problems((r) => { r.linger = v }), [], String(v))
  for (const v of ['maybe', null, 0, 1, 'true', {}]) assert.ok(problems((r) => { r.linger = v }).some((s) => s.includes('linger')), JSON.stringify(v))
})

test('receipt schema: created, removed and undo are lists; log is a path or null', () => {
  assert.deepEqual(problems((r) => { r.created.push('/h/.asight/bin/asight-off'); r.removed.push('/h/.config/systemd/user/asight-collector.service'); r.undo.push('asight on'); r.log = '/h/.asight/collector/flows/' }), [])
  for (const key of ['created', 'removed', 'undo']) {
    assert.ok(problems((r) => { r[key] = 'x' }).some((s) => s.includes(key)), key)
    assert.ok(problems((r) => { r[key] = [3] }).some((s) => s.includes(`${key}[0]`)), `${key} item`)
    assert.ok(problems((r) => { r[key] = [''] }).some((s) => s.includes(`${key}[0]`)), `${key} empty item`)
  }
  assert.ok(problems((r) => { r.log = 7 }).some((s) => s.includes('log')))
  assert.ok(problems((r) => { r.log = {} }).some((s) => s.includes('log')))
})

test('receipt schema: a harness field anywhere in the receipt is a canonical id (1.6 R5: harness 印代码 id)', () => {
  assert.deepEqual(problems((r) => { r.still_trusting = [{ harness: 'z-code', pid: 9 }]; r.daemon = { pid: 1, state: 'draining' } }), [], 'extra keys are allowed: R5 lists the least a receipt has')
  assert.ok(problems((r) => { r.still_trusting = [{ harness: 'dsh', pid: 9 }] }).some((s) => s.includes('still_trusting[0].harness')))
  assert.ok(problems((r) => { r.status = { agents: { x: [{ harness: 'zcode' }] } } }).some((s) => s.includes('status.agents.x[0].harness')))
  assert.ok(problems((r) => { r.harness = 'kimi' }).some((s) => s.includes('harness')))
  assert.ok(problems((r) => { r.harnesses = ['claude-code', 'kimi'] }).some((s) => s.includes('harnesses[1]')), 'a list of names too')
  assert.deepEqual(problems((r) => { r.harnesses = ['claude-code', 'codex'] }), [])
})

test('receipt schema: a receipt that went through JSON.stringify and back still validates (what --json prints)', () => {
  const r = newReceipt('status'); r.linger = 'unknown'; r.relayed = 'unknown'; r.restart.push({ harness: 'codex', pid: 1 })
  assert.deepEqual(validateReceipt(JSON.parse(JSON.stringify(r))), [])
})

// ── the topology (1.6 §9.4, V43): the closed sets are the spec's, and each rule of validateTopology has an input that breaks it ─────────────────────────────────────────────────────────────────────────
test('topology schema: the closed sets are the ones of 1.6 §9.4, proxy mode and the old capture included, so the Windows branch adds none', () => {
  assert.deepEqual([...ROUTING], ['driver', 'proxy', 'legacy', 'none', 'unknown'])
  assert.deepEqual([...TOPOLOGY_KINDS], ['agent', 'proxy', 'asight-engine', 'asight-forwarder', 'legacy-mitm', 'upstream', 'egress', 'unknown'])
  assert.deepEqual([...TOPOLOGY_VIA], ['direct', 'proxy-http', 'proxy-socks', 'proxy-https', 'system-proxy', 'ebpf', 'forward', 'egress', 'unknown'])
  assert.deepEqual([...UNKNOWN_REASONS], ['denied', 'timeout', 'absent', 'unparseable', 'owner-unreadable', 'pac', 'kernel-filter-invisible', 'env-unreadable'])
  assert.deepEqual([...FINDING_CLASSES], ['problem', 'expected', 'note'])
})

test('validateTopology: a topology is valid, and every rule has a bad input that says so', () => {
  const good = () => ({ 'claude-code': {
    routing: 'driver', on_path: true, captured: true, reason: null,
    nodes: [{ id: 'a', kind: 'agent', name: 'claude', pid: 4121 }, { id: 'e', kind: 'asight-engine', name: 'asight 引擎', port: 47123, asight: true }, { id: 'p', kind: 'proxy', name: 'mihomo', product: 'mihomo', port: 7890 }, { id: 'x', kind: 'egress', name: '出口' }],
    edges: [{ from: 'a', to: 'e', via: 'ebpf' }, { from: 'e', to: 'p', via: 'proxy-http' }, { from: 'a', to: 'p', via: 'proxy-http' }, { from: 'p', to: 'x', via: 'egress' }],
    branches: [{ name: 'all', path: ['a', 'e', 'p', 'x'], off_path: ['a', 'p', 'x'], on_path: true, captured: true, reason: null }],
    running: [{ pid: 3990, path: ['a', 'p', 'x'], note: 'start-time-settings' }],
  } })
  assert.deepEqual(validateTopology(good()), [])
  const bad = (name, fn, re) => { const t = good(); fn(t['claude-code']); assert.match(validateTopology(t).join('; '), re, name) }
  bad('routing', (x) => { x.routing = 'mixed' }, /routing: "mixed"/)
  bad('node kind', (x) => { x.nodes[1].kind = 'vpn-block' }, /kind: "vpn-block"/)
  bad('node name', (x) => { x.nodes[0].name = '' }, /name: empty/)
  bad('edge to nowhere', (x) => { x.edges[0].to = 'zz' }, /from \/ to is not a node/)
  bad('edge via', (x) => { x.edges[0].via = 'wormhole' }, /via: "wormhole"/)
  bad('unknown reason', (x) => { x.nodes[2].unknown = { reason: 'because' } }, /unknown\.reason: "because"/)
  bad('first node of a path', (x) => { x.branches[0].path = [x.branches[0].path[1], x.branches[0].path[0]] }, /first node is not the agent/)
  bad('a node twice', (x) => { x.branches[0].path = [...x.branches[0].path, x.branches[0].path[1]] }, /a node is on the path twice/)
  bad('a path through a missing node', (x) => { x.branches[0].off_path = ['a', 'nope'] }, /nope is not a node/)
  bad('branch name', (x) => { x.branches[0].name = 'tcp' }, /branches\[0\]\.name/)
  bad('a running process', (x) => { x.running[0].note = 'sleeping' }, /running\[0\]: needs pid and a note/)
  bad('on_path', (x) => { x.on_path = 'maybe' }, /on_path: not true, false or null/)
  bad('reason', (x) => { x.reason = 'because' }, /reason: "because" is not null or a status reason/)
  const t = good(); t.claude = t['claude-code']; delete t['claude-code']
  assert.match(validateTopology(t).join('; '), /"claude" is not a harness id/)
  assert.deepEqual(validateTopology(null), ['topology: not an object'])
})

test('validateFinding (1.6 §9.6, V49): a code in the closed sets, a class, a what and a why that say something, commands that are whole lines with a known shell and no <…>, a verify; a hint may have no command, a failure may not', async () => {
  const { validateFinding } = await import('../../src/cli/schema.mjs')
  const ok = { code: 'proxy-dead', class: 'problem', harness: 'codex', what: 'w', why: 'y', commands: [{ run: 'asight status codex', shell: 'sh' }], verify: 'v' }
  assert.deepEqual(validateFinding(ok), [])
  assert.deepEqual(validateFinding({ ...ok, class: 'note', commands: [] }), [])
  const bad = (over) => validateFinding({ ...ok, ...over })
  assert.match(bad({ code: 'nope' })[0], /code/)
  assert.match(bad({ class: 'loud' })[0], /class/)
  assert.match(bad({ harness: 'cod' })[0], /harness/)
  assert.match(bad({ what: ' ' })[0], /what/)
  assert.match(bad({ verify: '' })[0], /verify/)
  assert.match(bad({ commands: [] })[0], /says what to do/)
  assert.match(bad({ commands: [{ run: 'kill <pid>', shell: 'sh' }] })[0], /placeholder/)
  assert.match(bad({ commands: [{ run: 'x', shell: 'zsh' }] })[0], /shell/)
  assert.match(validateFinding(null)[0], /not an object/)
})
