// test/collector/arch/win32/optin.test.mjs — the opt-in items of 4.8 §2.4 (Task 14): the catalog and the plan rows first (the apply, the scripts,
// the elevation, the undo and the check land in their own commits and their own tests here). The rows are computed over the REAL seven harness
// descriptors' Windows data, so a cell changed in harness/win32/*.mjs is red here before it is red anywhere else; everything else is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { OPTIN_ITEMS, OPTIN_MACHINE_KINDS, optinItemIds, optinFormsOf, planOptIns, isOptinKind, SCRIPTS_DIR } from '../../../../src/collector/arch/win32/optin.mjs'
import { KNOWN_KINDS, OPTIN_KINDS, OFF_VERSION } from '../../../../src/off/manifest.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import fs from 'node:fs'
import path from 'node:path'

const ALL = await loadHarnesses()
const GROUPS = groupsOf(ALL)

// 4.8 §2.4's table, as rows per form: what the plan offers. The impact text is the harness data's own (W63: 计划里的「影响」行 comes from here,
// word for word); a form that is not in the table has no rows and never shows up in 「要你点名的」.
const EXPECT = {
  'kimi-code.cli': [
    ['user-path-shim', 'user', ['optin-user-path']],
    ['machine-path-dispatcher', 'machine', ['optin-machine-path']],
  ],
  'kimi-code.vscode': [['vscode-settings-and-launcher', 'user', ['optin-vscode']]],
  'opencode.cli': [
    ['user-path-shim', 'user', ['optin-user-path']],
    ['machine-path-dispatcher', 'machine', ['optin-machine-path']],
  ],
  'opencode.desktop': [
    ['start-menu-launcher', 'user', ['optin-shortcut']],
    ['all-users-launcher', 'machine', ['optin-machine-shortcut']],
  ],
  'claude-code.desktop': [['cert-store-current-user', 'user', ['optin-cert-user', 'optin-claude-policy']]],
  'z-code.desktop': [['zcode-app-settings', 'user', ['optin-zcode']]],
}
const rowsOf = (rows) => {
  const byForm = {}
  for (const r of rows) (byForm[r.form] ||= []).push([r.item, r.scope, r.kinds])
  return byForm
}

test('the catalog is 4.8 §2.4\'s table: every item\'s kinds and scope, and the seven harnesses\' real data offers exactly those items to exactly those forms', () => {
  assert.deepEqual(optinItemIds(), ['user-path-shim', 'machine-path-dispatcher', 'start-menu-launcher', 'all-users-launcher', 'cert-store-current-user', 'vscode-settings-and-launcher', 'zcode-app-settings'], 'the item ids, in the spec table\'s order')
  assert.deepEqual(OPTIN_MACHINE_KINDS, ['optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])
  for (const [item, def] of Object.entries(OPTIN_ITEMS)) for (const p of def.parts) assert.ok(isOptinKind(p.kind), `${item}: ${p.kind} is an opt-in kind`)
  assert.equal(OPTIN_ITEMS['cert-store-current-user'].parts.length, 2, 'Claude Desktop\'s one item is ledgered as two kinds: the certificate and the policy value')
  const rows = planOptIns({ groups: GROUPS })
  assert.deepEqual(rowsOf(rows), EXPECT, 'per form: item, scope and manifest kinds, nothing else offered (a form without a row never appears)')
  assert.deepEqual([...optinFormsOf(GROUPS)].sort(), Object.keys(EXPECT).sort(), 'the forms --opt-in may name')
})

test('a row is what the plan prints (1.6 §1.7): the exact command, the impact text of the harness data, admin where the scope is machine, chosen where the user named the form', () => {
  const rows = planOptIns({ groups: GROUPS, optIns: ['kimi-code.cli', 'z-code.desktop'] })
  const kimi = rows.find((r) => r.form === 'kimi-code.cli' && r.item === 'user-path-shim')
  const kimiData = GROUPS.find((x) => x.g === 'kimi-code.cli').group.optIn.find((o) => o.item === 'user-path-shim')
  assert.equal(kimi.command, 'asight on kimi-code --opt-in kimi-code.cli')
  assert.equal(kimi.impact, kimiData.impact, 'the 「影响」 line is the harness data\'s own text, word for word (V56: 与计划里的那一行逐字相同)')
  assert.deepEqual([kimi.scope, kimi.admin, kimi.chosen, kimi.applicable, kimi.state], ['user', false, true, true, 'needed'])
  // the unit of an opt-in is the FORM (1.6 §1.7「一个形态要几项就一起做」): naming kimi-code.cli chooses both its items, machine one included
  const machine = rows.find((r) => r.form === 'kimi-code.cli' && r.item === 'machine-path-dispatcher')
  assert.deepEqual([machine.scope, machine.admin, machine.chosen], ['machine', true, true], 'admin is true exactly when the scope is machine (§9.4)')
  assert.equal(rows.find((r) => r.form === 'opencode.desktop').chosen, false, 'a form the user did not name is not chosen')
  for (const r of rows) {
    assert.match(r.command, /^asight on [\w-]+ --opt-in [\w.-]+$/)
    assert.ok(typeof r.impact === 'string' && r.impact.length > 10, `${r.form}/${r.item}: an impact line that says something`)
  }
})

test('the machine dispatcher item is offered only when the real binary resolves on the machine PATH (§2.4「同上,真二进制在机器 PATH 里时」; §6.3「机器 PATH 在前」)', () => {
  const at = (resolve) => planOptIns({ groups: GROUPS, optIns: [], resolve }).filter((r) => r.item === 'machine-path-dispatcher').map((r) => r.applicable)
  assert.deepEqual(at(() => 'user'), [false, false], 'the real binary is on the user PATH (or nowhere): the user-PATH shim wins, the dispatcher is not offered')
  assert.deepEqual(at(() => 'machine'), [true, true], 'the real binary is on the machine PATH: only the dispatcher can win')
  assert.deepEqual(at(null), [true, true], 'no resolver given (a test, or the daemon has none bound yet): the item is offered, never silently hidden')
  const user = planOptIns({ groups: GROUPS, resolve: () => 'user' }).filter((r) => r.item === 'user-path-shim').map((r) => r.applicable)
  assert.deepEqual(user, [true, true], 'the user-level item is offered whatever the resolver says — it is the default of the two')
})

test('a row\'s state comes from the manifest: an entry of this form and item is done, a pending_admin one is pending-admin, and done rows are not re-offered as needed', () => {
  const m = { entries: [
    { kind: 'optin-user-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user' },
    { kind: 'optin-machine-path', harness: 'opencode', form: 'opencode.cli', item: 'machine-path-dispatcher', scope: 'machine', pending_admin: true },
  ] }
  const rows = planOptIns({ groups: GROUPS, manifest: m })
  assert.equal(rows.find((r) => r.form === 'kimi-code.cli' && r.item === 'user-path-shim').state, 'done')
  assert.equal(rows.find((r) => r.form === 'opencode.cli' && r.item === 'machine-path-dispatcher').state, 'pending-admin')
  assert.equal(rows.find((r) => r.form === 'opencode.cli' && r.item === 'user-path-shim').state, 'needed', 'the harness\'s other item is untouched by its sibling\'s record')
  assert.equal(rows.find((r) => r.form === 'kimi-code.vscode').state, 'needed', 'another form of the same harness has no record')
  // the ledger is by form AND item: an entry of another form does not make this one done
  const wrong = { entries: [{ kind: 'optin-user-path', harness: 'opencode', form: 'opencode.cli', item: 'user-path-shim', scope: 'user' }] }
  assert.equal(planOptIns({ groups: GROUPS, manifest: wrong }).find((r) => r.form === 'kimi-code.cli' && r.item === 'user-path-shim').state, 'needed')
  assert.equal(planOptIns({ groups: GROUPS, manifest: { entries: [] } }).find((r) => r.form === 'kimi-code.cli').state, 'needed', 'an empty manifest: everything needed')
})

test('a group whose data names an item the catalog does not know is a TypeError, not a silent row (the catalog and 4.8 §2.4 are the same list)', () => {
  const bad = [{ g: 'x.cli', harness: 'x', group: { optIn: [{ item: 'no-such-item', scope: 'user', impact: 'x' }] }, forms: [{ id: 'x.cli', supported: true }] }]
  assert.throws(() => planOptIns({ groups: bad }), /unknown opt-in item "no-such-item"/)
})

test('the manifest side (1.6 §1.7, Task 14(e)): the opt-in kinds are known, scope rides on entries, and OFF_VERSION moved past the copy that knows none of it', async () => {
  assert.deepEqual(OPTIN_KINDS, ['optin-user-path', 'optin-shortcut', 'optin-cert-user', 'optin-vscode', 'optin-zcode', 'optin-claude-policy', 'optin-machine-path', 'optin-machine-shortcut', 'optin-cert-machine'])
  for (const k of OPTIN_KINDS) assert.ok(KNOWN_KINDS.includes(k), `${k} is in KNOWN_KINDS: an entry of it is undone, not left as unknown`)
  assert.ok(OFF_VERSION >= 3, 'the bump that carries scope and the opt-in kinds (a copy written by 2 undoes none of them)')
  // a round trip through the real manifest file: parse keeps scope and fills it for a manifest of before the field, machine kinds read machine
  const dir = tmpDir('asight-optin-manifest-')
  const file = path.join(dir, 'install-manifest.json')
  fs.writeFileSync(file, JSON.stringify({ version: 2, entries: [
    { kind: 'optin-user-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user', undo_by_hand: 'x' },
    { kind: 'optin-machine-path', harness: 'opencode', form: 'opencode.cli', item: 'machine-path-dispatcher', scope: 'machine' },
    { kind: 'json-key', harness: 'cc', path: 'C:\\a', keys: ['env', 'HTTPS_PROXY'] },
  ], files: [] }))
  const { readManifestAt } = await import('../../../../src/off/manifest.mjs')
  const m = readManifestAt(file)
  assert.deepEqual(m.entries.map((e) => [e.kind, e.scope]), [['optin-user-path', 'user'], ['optin-machine-path', 'machine'], ['json-key', 'agent']], 'scope is kept, and an entry of before the field reads as agent')
  assert.match(m.entries[1].undo_by_hand, /asight off opencode/, 'an opt-in entry\'s undo_by_hand names the agent\'s switch, never a per-entry command (V64)')
})

test('SCRIPTS_DIR is the fixed scripts directory of the arch (applyOptIn names them by file; W64\'s scan reads them from here)', () => {
  assert.equal(path.basename(SCRIPTS_DIR), 'optin')
  assert.equal(path.basename(path.dirname(SCRIPTS_DIR)), 'win32')
})
