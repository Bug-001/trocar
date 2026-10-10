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

// ── the machine half: ONE self-contained elevated step, the OS's own prompt (W65, W66, V57, V63; elevate.mjs) ─────────────────────────────────────────────────────────────
import { dispatcherText, elevatedCommand, runElevated, readMachinePath, withPathItem, withoutPathItem, MACHINE_BIN, MACHINE_PATH_KEY } from '../../../../src/collector/arch/win32/elevate.mjs'

test('W65 the dispatcher (§6.3): no credential, one rule — the running user\'s own shim first when it exists, else the real binary recorded at opt-in; other users and services never go through this kernel', () => {
  const d = dispatcherText({ command: 'kimi', realBinary: 'C:\\Program Files\\kimi\\kimi.exe' })
  assert.equal(d.includes('HTTPS_PROXY') || d.includes('NODE_EXTRA_CA_CERTS'), false, 'the dispatcher holds no credential (the user\'s own shim has it, not the machine one)')
  assert.match(d, /if exist "%USERPROFILE%\\\.asight\\collector\\bin\\kimi\.cmd" \(/)
  assert.match(d, /call "%USERPROFILE%\\\.asight\\collector\\bin\\kimi\.cmd" %\*/)
  assert.match(d, /"C:\\Program Files\\kimi\\kimi\.exe" %\*/)
  assert.throws(() => dispatcherText({ command: 'kimi ../x', realBinary: 'C:\\a.exe' }), /needs a command name/)
  assert.throws(() => dispatcherText({ command: 'kimi' }), /real binary/)
})

test('W65 the machine-PATH step: one self-contained line — the admin-only directory with its three grants, the dispatcher inline, the PATH value with the directory first and never twice; nothing the step runs sits under a user-writable path', () => {
  const machinePath = 'C:\\Windows\\system32;C:\\Windows;%ProgramData%\\asight\\machine-bin;C:\\tools'
  const { command } = elevatedCommand({ item: 'machine-path-dispatcher', op: 'apply', values: { command: 'opencode', realBinary: 'C:\\Users\\bob\\AppData\\Roaming\\npm\\opencode.exe', machinePath } })
  assert.ok(!command.includes('\n'), 'one line')
  assert.match(command, /icacls "\$env:ProgramData\\asight\\machine-bin" \/inheritance:r \/grant 'SYSTEM:\(OI\)\(CI\)F' \/grant 'Administrators:\(OI\)\(CI\)F' \/grant 'Users:\(OI\)\(CI\)RX'/)
  assert.match(command, /Set-Content -Path "\$env:ProgramData\\asight\\machine-bin\\opencode\.cmd"/, 'the dispatcher is written from inline content')
  const written = /reg add 'HKLM[^']*' \/v Path \/t REG_EXPAND_SZ \/d '([^']*)' \/f/.exec(command)[1]
  assert.equal(written, `${MACHINE_BIN};C:\\Windows\\system32;C:\\Windows;C:\\tools`, 'the directory goes first, the existing entries keep their order, and it is not added twice')
  // the step references no script or executable under a user-writable directory: %APPDATA% / %LOCALAPPDATA% / %TEMP% never appear, and
  // %USERPROFILE% appears only inside the dispatcher's own runtime rule (the running user's shim, §6.3) — never as a file the step runs or reads
  assert.ok(!command.includes('%APPDATA%') && !command.includes('%LOCALAPPDATA%') && !command.includes('%TEMP%'), command)
  assert.equal((command.match(/%USERPROFILE%/g) || []).length, 2, 'the only %USERPROFILE% mentions are the dispatcher\'s own runtime lookup (if exist / call)')
  assert.ok(!/-File /.test(command) && !/Invoke-(Item|Expression)/.test(command), 'the step runs no script file: everything it does is inline')
  // the value is built on the PATH as read now, never on a guess
  assert.throws(() => elevatedCommand({ item: 'machine-path-dispatcher', op: 'apply', values: { command: 'kimi', realBinary: 'C:\\a', machinePath: null } }), /machine PATH could not be read/)
  assert.equal(withPathItem(null, 'x'), null)
  assert.equal(withPathItem('a;b', 'b'), 'b;a', 'only our entry moves; adding it twice is a no-op')
  assert.equal(withoutPathItem('a;b;A', 'a'), 'b', 'the drop is case-blind (a registry value holds one case, the compare must not care)')
})

test('W65 the undo steps: the dispatcher goes, the PATH item with it, and the directory only with the last one; the all-users launcher restores the recorded real binary; the machine certificate\'s bytes are inline, never a file under the user\'s home', () => {
  const machinePath = `${MACHINE_BIN};C:\\Windows`
  const last = elevatedCommand({ item: 'machine-path-dispatcher', op: 'undo', values: { command: 'opencode', machinePath, last: true } }).command
  assert.match(last, /reg add .*\/d 'C:\\Windows'/, 'the PATH item is dropped from the CURRENT value, never the pre-asight one written back wholesale (D28)')
  assert.match(last, /Remove-Item -Path "\$env:ProgramData\\asight\\machine-bin\\opencode\.cmd" -Force/)
  assert.match(last, /Remove-Item -Path "\$env:ProgramData\\asight\\machine-bin" -Recurse -Force/, 'with the last dispatcher the directory goes too')
  const notLast = elevatedCommand({ item: 'machine-path-dispatcher', op: 'undo', values: { command: 'opencode', machinePath, last: false } }).command
  assert.ok(!notLast.includes('-Recurse'), 'another item still holds the directory')
  const launcher = elevatedCommand({ item: 'all-users-launcher', op: 'apply', values: { command: 'opencode', realBinary: 'C:\\x\\OpenCode.exe', shortcuts: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\OpenCode.lnk'] } }).command
  assert.match(launcher, /\$s\.TargetPath="\$env:ProgramData\\asight\\machine-bin\\asight-opencode\.cmd"/)
  const undoLauncher = elevatedCommand({ item: 'all-users-launcher', op: 'undo', values: { command: 'opencode', realBinary: 'C:\\x\\OpenCode.exe', shortcuts: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\OpenCode.lnk'] } }).command
  assert.match(undoLauncher, /\$s\.TargetPath='C:\\x\\OpenCode\.exe'/, 'the all-users shortcuts point back at the real binary')
  const cert = elevatedCommand({ item: 'machine-cert', op: 'apply', values: { certB64: 'AAECAw==' } }).command
  assert.match(cert, /FromBase64String\('AAECAw=='\)/, 'the certificate bytes are inline (a file under the user\'s home could be swapped between the confirmation and the UAC click)')
  assert.ok(!cert.includes('-FilePath \'C:\\Users'), 'the import reads only the copy the step itself wrote into the admin-only directory')
  assert.match(elevatedCommand({ item: 'machine-cert', op: 'undo', values: { thumbprint: 'ab12' } }).command, /certutil -delstore Root 'ab12'/)
  assert.throws(() => elevatedCommand({ item: 'no-such' }), /knows no machine item/)
  assert.throws(() => elevatedCommand({ item: 'machine-cert', op: 'apply', values: {} }), /certB64/)
})

test('V63 runElevated hands the step to the OS\'s own prompt: Start-Process -Verb RunAs through the injected launcher, nothing of asight\'s is a password, no prompt means the command is NOT launched', () => {
  const seen = []
  const launch = (file, args) => { seen.push([file, args]); return { ok: true } }
  assert.deepEqual(runElevated({ command: "Set-Content -Path 'x' -Value 'y'", launch }), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'powershell', 'the prompt is PowerShell\'s own elevation, UAC under it')
  assert.equal(seen[0][1].some((a) => a.includes('Start-Process -Verb RunAs')), true, 'the OS\'s own prompt, exactly once per step')
  assert.equal(seen[0][1].some((a) => a.includes('-Command')), true)
  assert.equal(seen[0][1].join(' ').includes('password'), false, 'no password argument anywhere')
  assert.equal(seen[0][1].join(' ').includes('read-host'), false, 'and no prompt of asight\'s own (no password field, V63)')
  assert.deepEqual(runElevated({ command: 'x', launch: () => ({ declined: true }) }), { refused: true, outcome: 'uac-declined', reason: 'the UAC consent box was declined' })
  assert.equal(runElevated({ command: 'x', launch: () => ({ out: 'The operation was canceled by the user.' }) }).outcome, 'uac-declined')
  assert.equal(runElevated({ command: 'x', launch: () => ({ out: '', err: '' }) }).outcome, 'elevate-error', 'an answer that says neither yes nor no is not a success (a step nobody confirmed is not done)')
  const notLaunched = []
  assert.equal(runElevated({ command: 'x', launch: (f, a) => { notLaunched.push([f, a]); return { ok: true } }, canPrompt: () => false }).outcome, 'no-prompt')
  assert.deepEqual(notLaunched, [], 'no prompt can be shown: the command is not launched at all — the fallback is the caller printing it')
  assert.throws(() => runElevated({ command: 'x' }), /injected launcher/)
})

test('W66 / V57 (the on half) applyOptIn of a machine item: ledgered pending-admin FIRST, done only after the OS\'s prompt and the read-back; declined stays pending-admin; no prompt is needs-admin with the command; an unbuilt step fails without attempting anything', async () => {
  const { applyOptIn } = await import('../../../../src/collector/arch/win32/optin.mjs')
  const rig = (over = {}) => {
    const manifest = { entries: [] }
    const events = [], notes = [], failures = []
    const deps = {
      resolveCommand: (name) => ({ at: 'machine', path: `C:\\Program Files\\${name}\\${name}.exe` }),
      readMachinePath: () => 'C:\\Windows',
      machineCheck: () => true,
      launch: () => ({ ok: true }),
      canPrompt: () => true,
      ...over.deps,
    }
    const row = { form: 'opencode.cli', harness: 'opencode', item: 'machine-path-dispatcher', kinds: ['optin-machine-path'], scope: 'machine', admin: true, chosen: true, applicable: true, state: 'needed' }
    const groups = GROUPS.filter((x) => x.g === 'opencode.cli')
    const apply = () => applyOptIn({ row, groups, manifest, deps, save: () => {}, note: (r) => notes.push(r), failure: (r) => failures.push(r), state: (r) => events.push(r) })
    return { manifest, events, notes, failures, apply }
  }
  const ok = rig()
  assert.deepEqual(await ok.apply(), { state: 'done' })
  const e = ok.manifest.entries[0]
  assert.deepEqual([e.kind, e.harness, e.form, e.item, e.scope, e.pending_admin], ['optin-machine-path', 'opencode', 'opencode.cli', 'machine-path-dispatcher', 'machine', false], 'ledgered with scope machine and cleared by the read-back (pending_admin false)')
  assert.match(e.undo_by_hand, /asight off opencode/, 'the undo is the agent\'s switch (V64)')
  assert.deepEqual(e.values, { command: 'opencode', realBinary: 'C:\\Program Files\\opencode\\opencode.exe', machinePath: 'C:\\Windows' })
  assert.deepEqual(ok.events, [{ event: 'optin-applied', where: 'optin', form: 'opencode.cli', item: 'machine-path-dispatcher', scope: 'machine' }])
  assert.deepEqual(ok.failures, [])
  assert.ok(ok.notes.some((n) => n.outcome === 'ok'), 'the attempt and its outcome are recorded (D38)')

  const declined = rig({ deps: { launch: () => ({ declined: true }) } })
  assert.equal((await declined.apply()).state, 'pending-admin')
  assert.equal(declined.manifest.entries[0].pending_admin, true, 'a declined UAC leaves the entry pending-admin, offered again next time')
  assert.deepEqual(declined.events, [], 'not optin-applied')
  assert.deepEqual(declined.failures, [], 'and NOT optin-failed: a refused UAC is pending-admin, not a failure (§12)')

  const noPrompt = rig({ deps: { canPrompt: () => false } })
  const np = await noPrompt.apply()
  assert.equal(np.state, 'needs-admin')
  assert.match(np.elevated_command, /Start-Process|reg add/, 'the fallback carries the whole self-contained command')
  assert.equal(noPrompt.manifest.entries[0].pending_admin, true)

  const unconfirmed = rig({ deps: { machineCheck: () => false } })
  assert.equal((await unconfirmed.apply()).state, 'pending-admin')
  assert.equal(unconfirmed.manifest.entries[0].pending_admin, true, 'the step ran, the read-back did not confirm: still pending, said, not done')

  const unreadable = rig({ deps: { readMachinePath: () => null } })
  const r = await unreadable.apply()
  assert.equal(r.state, 'failed')
  assert.match(r.reason, /machine PATH could not be read/)
  assert.deepEqual(unreadable.manifest.entries, [], 'nothing was ledgered and nothing attempted (a step built on a guess is not built)')
  assert.ok(unreadable.failures.length === 1 && unreadable.failures[0].code === 'optin-failed')
})


test('readMachinePath reads the one value through execTool\'s injected runner and says null rather than guessing (reg.exe\'s own output shape)', () => {
  const regOut = (v) => ({ status: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_EXPAND_SZ    ${v}\r\n\r\n`, stderr: '' })
  const calls = []
  const run = (file, args) => { calls.push([file, ...args]); return regOut('C:\\Windows\\system32;C:\\Windows') }
  assert.equal(readMachinePath({ run }), 'C:\\Windows\\system32;C:\\Windows')
  assert.deepEqual(calls, [['reg', 'query', MACHINE_PATH_KEY, '/v', 'Path']], 'one read-only query of the one value')
  assert.equal(readMachinePath({ run: () => regOut('%SystemRoot%\\system32') }), '%SystemRoot%\\system32', 'the %…% form is kept: it is a REG_EXPAND_SZ, expanded by whatever reads it')
  assert.equal(readMachinePath({ run: () => ({ status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }) }), null)
  assert.equal(readMachinePath({ run: () => ({ status: 0, stdout: 'garbage', stderr: '' }) }), null, 'an answer that is not the value is null, never a guess')
})
