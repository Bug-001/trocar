// test/collector/arch/win32/optin-check.test.mjs — checkEntries, the read-only re-check that asight's opt-in entries are still the ones used
// (4.8 §2.4「入口还有没有效」, W68's unit cells; 1.6 §1.7). The plan's cells: a machine-PATH `kimi` → shim-not-on-path naming the entry; a
// rewritten shortcut or VS Code setting → entry-changed; a running agent whose parent is not the shim or launcher → not-via-entry; none of
// them → nothing. Plus the machine-bin dispatcher's recorded real binary (gone → entry-changed), the unknown verdicts a failed read earns
// instead of a guess, the loop guard over the checkable kinds, and recordEntryFindings (the daemon's 5 s half of the same check).
// The world is the apply tests' own rig (fixtures/optin-world.mjs): one fake Windows per test, the manifest filled by a REAL applyOptIn, the
// check reading the same world through the same injected `run`. No tool is spawned on this machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { checkEntries, recordEntryFindings, CHECK_KINDS, OPTIN_ITEMS, OPTIN_MACHINE_KINDS } from '../../../../src/collector/arch/win32/optin.mjs'
import { MACHINE_PATH_KEY } from '../../../../src/collector/arch/win32/elevate.mjs'
import { rig, nativeKimi, realCmd, writeShortcut, POLICY_KEY } from './fixtures/optin-world.mjs'

const winJoin = path.win32.join
const machinePathValue = (r, value) => { r.w.state[MACHINE_PATH_KEY].Path.value = value }
const userPathValue = (r, value) => { r.w.state['HKCU\\Environment'].Path.value = value }

test('W68 the PATH item: a command still resolving to asight\'s shim first (Windows\' own order) is nothing to report; a same-name command ahead on the MACHINE PATH is shim-not-on-path naming the entry, and so is one ahead on the user PATH', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r)
  realCmd(r, 'kimi', 'the real one')
  assert.equal((await r.apply()).state, 'done')
  assert.deepEqual(r.check(), [], 'the shim first on the user PATH, nothing ahead on the machine PATH: nothing to report')

  const mdir = winJoin(r.winHome, 'mt') // a directory of the MACHINE PATH, ahead of everything (§6.3「机器 PATH 在前」)
  r.wfs.mkdirSync(mdir, { recursive: true })
  r.wfs.writeFileSync(winJoin(mdir, 'kimi.cmd'), 'machine one')
  machinePathValue(r, `${mdir};C:\\Windows\\system32;C:\\Windows`)
  let f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].form, f[0].item, f[0].harness, f[0].code], ['kimi-code.cli', 'user-path-shim', 'kimi-code', 'shim-not-on-path'])
  assert.match(f[0].detail, new RegExp(`resolves first to .*mt\\\\kimi\\.cmd — the machine PATH's .*mt`), 'the detail names WHICH entry of the machine PATH wins (doctor\'s step needs it)')

  const udir = winJoin(r.winHome, 'first') // a directory ahead of asight's bin on the USER PATH (the user prepended their own)
  r.wfs.mkdirSync(udir, { recursive: true })
  r.wfs.writeFileSync(winJoin(udir, 'kimi.cmd'), 'user one')
  machinePathValue(r, 'C:\\Windows\\system32;C:\\Windows')
  userPathValue(r, `${udir};${winJoin(r.dir, 'bin')};${winJoin(r.winHome, 'npm')}`)
  f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual(f[0].code, 'shim-not-on-path')
  assert.match(f[0].detail, new RegExp(`resolves first to .*first\\\\kimi\\.cmd — the user PATH's .*first`))

  // both the shim and the real binary gone: the command resolves nowhere at all — still shim-not-on-path, saying which of the two is missing
  r.wfs.rmSync(winJoin(r.dir, 'bin', 'kimi.cmd'))
  r.wfs.rmSync(winJoin(r.winHome, 'npm', 'kimi.cmd'))
  userPathValue(r, `${winJoin(r.dir, 'bin')};${winJoin(r.winHome, 'npm')}`)
  f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual(f[0].code, 'shim-not-on-path')
  assert.match(f[0].detail, /kimi no longer resolves anywhere on the PATH \(asight's shim .* is gone\)/)
})

test('W68 the machine dispatcher item: the dispatcher resolving first (its %ProgramData% name expanded the way where.exe does) is nothing to report; displaced → shim-not-on-path; the recorded real binary gone → entry-changed', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'machine-path-dispatcher' })
  r.env.ProgramData = winJoin(r.winHome, 'ProgramData') // the rig's %…% names expand into its mapped sandbox
  const dispatcherDir = winJoin(r.env.ProgramData, 'asight', 'machine-bin')
  r.wfs.mkdirSync(dispatcherDir, { recursive: true })
  r.wfs.writeFileSync(winJoin(dispatcherDir, 'kimi.cmd'), 'the dispatcher')
  const real = winJoin(r.winHome, 'mt', 'kimi.exe')
  r.wfs.mkdirSync(winJoin(r.winHome, 'mt'), { recursive: true })
  r.wfs.writeFileSync(real, 'exe')
  machinePathValue(r, `%ProgramData%\\asight\\machine-bin;C:\\Windows\\system32;C:\\Windows`) // the PATH value the elevated step writes (REG_EXPAND_SZ, the raw name)
  r.manifest.entries.push({ kind: 'optin-machine-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'machine-path-dispatcher', scope: 'machine', pending_admin: false,
    values: { command: 'kimi', realBinary: real, machinePath: 'C:\\Windows\\system32;C:\\Windows' } })
  assert.deepEqual(r.check(), [], 'the dispatcher is the first hit: nothing to report')

  r.wfs.rmSync(real)
  let f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].code, f[0].item], ['entry-changed', 'machine-path-dispatcher'])
  assert.match(f[0].detail, new RegExp(`the real binary the dispatcher falls back to \\(${real.replace(/\\/g, '\\\\')}\\) is gone`), 'the plan\'s own check of the recorded binary')

  r.wfs.writeFileSync(real, 'exe')
  const mdir2 = winJoin(r.winHome, 'mt2') // a same-name command ahead of machine-bin on the machine PATH (its own directory, so the real binary in mt does not shadow it: PATH_EXTS tries .exe before .cmd inside ONE directory)
  r.wfs.mkdirSync(mdir2, { recursive: true })
  r.wfs.writeFileSync(winJoin(mdir2, 'kimi.cmd'), 'ahead')
  machinePathValue(r, `${mdir2};%ProgramData%\\asight\\machine-bin;C:\\Windows`)
  f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual(f[0].code, 'shim-not-on-path')
  assert.match(f[0].detail, new RegExp(`resolves first to .*mt2\\\\kimi\\.cmd — the machine PATH's .*mt2 — not asight's dispatcher`))
})

test('W68 a rewritten shortcut → entry-changed (the shortcut named, what it starts now); a gone launcher too; a gone shortcut is entry-changed, not a silent skip', async () => {
  const r = await rig({ form: 'opencode.desktop', item: 'start-menu-launcher' })
  const exe = winJoin(r.winHome, 'AppData', 'Local', 'Programs', 'OpenCode', 'OpenCode.exe')
  const startMenu = winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCode.lnk')
  const desktop = winJoin(r.winHome, 'Desktop', 'OpenCode.lnk')
  for (const p of [startMenu, desktop]) writeShortcut(r, p, exe)
  assert.equal((await r.apply()).state, 'done')
  assert.deepEqual(r.check(), [], 'both shortcuts at asight\'s launcher: nothing to report')

  r.wfs.writeFileSync(startMenu, exe) // the user (or an updater) pointed it back at the app
  let f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].form, f[0].item, f[0].code], ['opencode.desktop', 'start-menu-launcher', 'entry-changed'])
  assert.match(f[0].detail, new RegExp(`the shortcut OpenCode\\.lnk now starts .*OpenCode\\.exe, not asight's launcher .*asight-opencode\\.cmd`))

  r.wfs.writeFileSync(startMenu, winJoin(r.dir, 'launchers', 'asight-opencode.cmd')) // back at the launcher
  r.wfs.rmSync(winJoin(r.dir, 'launchers', 'asight-opencode.cmd')) // ... but the launcher itself is gone
  f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual(f[0].code, 'entry-changed')
  assert.match(f[0].detail, /asight's launcher .* is gone/)

  r.wfs.writeFileSync(winJoin(r.dir, 'launchers', 'asight-opencode.cmd'), 'back')
  r.wfs.rmSync(desktop) // a shortcut deleted: the entry no longer covers that place
  f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual(f[0].code, 'entry-changed')
  assert.match(f[0].detail, /the shortcut OpenCode\.lnk is gone/)
})

test('W68 a changed VS Code setting → entry-changed naming the key and what it holds now; the user\'s own edits to the same file are not; Z-Code\'s own settings and the policy value and the certificate answer the same way', async () => {
  const r = await rig({ form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher' })
  const settings = path.join(r.env.APPDATA, 'Code', 'User', 'settings.json')
  r.wfs.mkdirSync(path.dirname(settings), { recursive: true })
  r.wfs.writeFileSync(settings, '{\n  "editor.fontSize": 13,\n  "http.proxy": "http://user-proxy:8080"\n}\n')
  const code = winJoin(r.winHome, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe')
  writeShortcut(r, winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk'), code)
  assert.equal((await r.apply()).state, 'done')

  const withOwnEdit = JSON.parse(r.wfs.readFileSync(settings, 'utf8'))
  withOwnEdit['workbench.zoomLevel'] = 1 // the user's own key, added after asight's
  r.wfs.writeFileSync(settings, JSON.stringify(withOwnEdit, null, 2))
  assert.deepEqual(r.check(), [], 'a user edit outside asight\'s keys is not the entry having changed (the undo side\'s own rule)')

  withOwnEdit['http.proxy'] = 'http://elsewhere:1'
  r.wfs.writeFileSync(settings, JSON.stringify(withOwnEdit, null, 2))
  let f = r.check()
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].form, f[0].item, f[0].code], ['kimi-code.vscode', 'vscode-settings-and-launcher', 'entry-changed'])
  assert.match(f[0].detail, new RegExp(`http\\.proxy in .*settings\\.json now holds "http://elsewhere:1", not what asight wrote`))

  r.wfs.writeFileSync(settings, 'not json anymore') // the file itself is beyond parsing: the entry cannot be in effect
  f = r.check()
  assert.equal(f.length, 1)
  assert.match(f[0].detail, /is no longer JSON, so the entry cannot be in effect/)

  const z = await rig({ form: 'z-code.desktop', item: 'zcode-app-settings' })
  const setting = path.join(z.winHome, '.zcode', 'v2', 'setting.json') // the harness data's own path.join (mixed separators on a POSIX machine)
  z.wfs.mkdirSync(path.dirname(setting), { recursive: true })
  z.wfs.writeFileSync(setting, '{\n  "theme": "dark"\n}\n')
  z.wfs.writeFileSync(winJoin(z.dir, 'ca', 'combined-z-code.pem'), z.ca.certPem)
  assert.equal((await z.apply()).state, 'done')
  const zd = JSON.parse(z.wfs.readFileSync(setting, 'utf8'))
  zd.httpProxy = 'http://elsewhere:2'
  z.wfs.writeFileSync(setting, JSON.stringify(zd, null, 2))
  const zf = z.check()
  assert.equal(zf.length, 1)
  assert.deepEqual([zf[0].code, zf[0].item], ['entry-changed', 'zcode-app-settings'])
  assert.match(zf[0].detail, /httpProxy in .*setting\.json now holds "http:\/\/elsewhere:2"/)

  const c = await rig({ form: 'claude-code.desktop', item: 'cert-store-current-user', win: { policy: 'http://user-proxy:8080' } })
  assert.equal((await c.apply()).state, 'done')
  assert.deepEqual(c.check(), [])
  c.w.store.clear() // the certificate removed from CurrentUser\Root
  c.w.state[POLICY_KEY].egressProxyUrl.value = 'http://elsewhere:3' // ... and the policy value rewritten
  const cf = c.check()
  assert.equal(cf.length, 2, 'the item is two entries (the certificate and the policy value); each answers for itself')
  assert.ok(cf.every((x) => x.code === 'entry-changed' && x.item === 'cert-store-current-user'))
  assert.match(cf.find((x) => /certificate/.test(x.detail)).detail, /no longer in CurrentUser\\Root/)
  assert.match(cf.find((x) => /policy/.test(x.detail)).detail, /the policy value egressProxyUrl now holds http:\/\/elsewhere:3/)
})

/** Kimi with both of its forms opted in: the CLI's shim and VS Code's launcher (a harness whose every form has a start entry is the one W68 can judge). */
async function bothKimiForms() {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', forms: ['kimi-code.cli', 'kimi-code.vscode'] })
  nativeKimi(r)
  realCmd(r, 'kimi')
  assert.equal((await r.apply()).state, 'done')
  const code = winJoin(r.winHome, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe')
  writeShortcut(r, winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk'), code)
  assert.equal((await r.applyAs('kimi-code.vscode', 'vscode-settings-and-launcher')).state, 'done')
  return { r, code, launcher: r.manifest.entries.find((e) => e.kind === 'optin-vscode').values.launcher }
}

test('W68 not-via-entry is said only when every form of the harness has a start entry: with only one form opted in, a process cannot be put in a form, so nothing is said (D25)', async () => {
  const r = await rig({ form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher' })
  const code = winJoin(r.winHome, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe')
  writeShortcut(r, winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk'), code)
  assert.equal((await r.apply()).state, 'done')
  const kimiExe = winJoin(r.winHome, '.kimi-code', 'bin', 'kimi.exe')
  const procs = [{ pid: 20, ppid: 4, exe: 'C:\\Windows\\explorer.exe' }, { pid: 21, ppid: 20, exe: kimiExe }, { pid: 22, ppid: 20, exe: code }]
  assert.deepEqual(r.check(procs), [], 'the CLI kimi.exe is not compared with the VS Code launcher; Code.exe alone does not make the CLI form judged')
})

test('W68 not-via-entry: the host program (Code.exe, named by the form\'s hosts.processes) is its harness\'s process too — started around the launcher, it is reported', async () => {
  const { r, code, launcher } = await bothKimiForms()
  const procs = [{ pid: 20, ppid: 4, exe: 'C:\\Windows\\explorer.exe' }, { pid: 50, ppid: 51, exe: code }, { pid: 51, ppid: 4, exe: 'C:\\Windows\\System32\\wscript.exe', cmdline: `wscript "${launcher}"` }]
  assert.deepEqual(r.check(procs), [], 'Code.exe started by the launcher')
  const f = r.check([...procs, { pid: 52, ppid: 20, exe: code }])
  assert.equal(f.length, 1)
  assert.equal(f[0].code, 'not-via-entry')
  assert.match(f[0].detail, /pid 52 \(parent .*explorer\.exe\)/)
})

test('W68 not-via-entry: a running agent whose parent is the shim (by command line), the launcher, or a process of its own harness is nothing to report; any other parent — explorer, a gone parent — is not-via-entry, one finding naming the pids', async () => {
  const { r } = await bothKimiForms()
  const shim = winJoin(r.dir, 'bin', 'kimi.cmd')
  const kimiExe = winJoin(r.winHome, '.kimi-code', 'bin', 'kimi.exe')
  const via = [
    { pid: 10, ppid: 2, exe: 'C:\\Windows\\System32\\cmd.exe', cmdline: `cmd /c "${shim}"` }, // the cmd.exe the .cmd runs in
    { pid: 11, ppid: 10, exe: kimiExe }, // started through it
    { pid: 30, ppid: 11, exe: kimiExe }, // a child of the agent itself: the entry question is the top process's
  ]
  assert.deepEqual(r.check(via), [], 'the entry used, and the agent\'s own children: nothing to report')

  const around = [
    ...via,
    { pid: 20, ppid: 4, exe: 'C:\\Windows\\explorer.exe' },
    { pid: 21, ppid: 20, exe: kimiExe }, // a taskbar pin / login autostart: started by the shell, not the entry
    { pid: 40, ppid: 99, exe: kimiExe }, // its parent is gone (the entry's cmd.exe lives as long as the agent it started)
  ]
  const f = r.check(around)
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].form, f[0].item, f[0].code], ['kimi-code.cli', 'user-path-shim', 'not-via-entry'])
  assert.match(f[0].detail, /2 running kimi-code process\(es\) were not started through the entry/)
  assert.match(f[0].detail, /pid 21 \(parent .*explorer\.exe\)/)
  assert.match(f[0].detail, /pid 40 \(parent no longer running\)/)

  // the entry itself displaced: the parent question is noise next to that (the finding of the PATH half is the one row the item gets)
  const mdir = winJoin(r.winHome, 'mt')
  r.wfs.mkdirSync(mdir, { recursive: true })
  r.wfs.writeFileSync(winJoin(mdir, 'kimi.cmd'), 'machine one')
  machinePathValue(r, `${mdir};C:\\Windows\\system32;C:\\Windows`)
  const f2 = r.check(around)
  assert.equal(f2.length, 1)
  assert.equal(f2[0].code, 'shim-not-on-path', 'the entry\'s own displacement wins the row; not-via-entry is not piled on top')
})

test('a read that failed is an unknown finding (a reason of 1.6 §9.4\'s closed set), never a guess and never silence: an unreadable user PATH is not "the shim is off the PATH"', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r)
  realCmd(r, 'kimi')
  assert.equal((await r.apply()).state, 'done')
  const failing = (file, args) => (file === 'reg' && args.includes('HKCU\\Environment') ? { status: 5, stdout: '', stderr: 'access denied' } : r.w.run(file, args))
  const f = r.check([], { deps: { run: failing } })
  assert.equal(f.length, 1)
  assert.deepEqual([f[0].code, f[0].reason], [null, 'denied'])
  assert.match(f[0].detail, /user PATH could not be read/)
})

test('the loop guard: CHECK_KINDS is exactly the kinds the apply can produce — every user item\'s parts plus the one machine kind machineValuesOf builds; a kind gained on either side without a check arm is red (the W54 pattern)', () => {
  assert.deepEqual([...CHECK_KINDS], ['optin-user-path', 'optin-machine-path', 'optin-shortcut', 'optin-cert-user', 'optin-claude-policy', 'optin-vscode', 'optin-zcode'])
  const producible = new Set(Object.values(OPTIN_ITEMS).filter((x) => x.scope !== 'machine').flatMap((x) => x.parts.map((p) => p.kind))) // the user items: applyUserOne runs every part of each
  for (const k of producible) assert.ok(CHECK_KINDS.includes(k), `${k} (a user item's part) has a check arm`)
  assert.deepEqual(CHECK_KINDS.filter((k) => OPTIN_MACHINE_KINDS.includes(k)), ['optin-machine-path'], 'of the machine kinds, the one machineValuesOf builds has an arm; machine-shortcut and machine-cert have no producer yet (no entry of theirs can be in a manifest, pinned in optin.test.mjs)')
  assert.deepEqual([...producible].sort(), ['optin-cert-user', 'optin-claude-policy', 'optin-shortcut', 'optin-user-path', 'optin-vscode', 'optin-zcode'], 'the user items\' parts, spelled out (a new part without an arm fails the loop above)')
})

test('recordEntryFindings: one failure record per finding not already reported, only for 1.6 §9.7\'s netenv codes (shim-not-on-path, not-via-entry); entry-changed and unknown findings are no event; the same finding twice fires once, a changed one fires again', () => {
  const events = []
  const state = { seen: new Set() }
  const findings = [
    { form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: 'shim-not-on-path', detail: 'kimi resolves first to C:\\npm\\kimi.cmd — the machine PATH\'s C:\\npm' },
    { form: 'opencode.desktop', item: 'start-menu-launcher', harness: 'opencode', code: 'entry-changed', detail: 'the shortcut OpenCode.lnk now starts the app' },
    { form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: null, reason: 'denied', detail: 'the user PATH could not be read' },
    { form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: 'not-via-entry', detail: '1 running kimi-code.cli process(es) were not started through the entry' },
  ]
  const first = recordEntryFindings({ findings, state, appendEvent: (rec) => events.push(rec) })
  assert.equal(first.length, 4, 'every finding is "recorded this time" (the caller\'s view); only two become events')
  assert.deepEqual(events, [
    { event: 'failure', where: 'netenv', harness: 'kimi-code', code: 'shim-not-on-path', form: 'kimi-code.cli', item: 'user-path-shim', reason: 'kimi resolves first to C:\\npm\\kimi.cmd — the machine PATH\'s C:\\npm' },
    { event: 'failure', where: 'netenv', harness: 'kimi-code', code: 'not-via-entry', form: 'kimi-code.cli', item: 'user-path-shim', reason: '1 running kimi-code.cli process(es) were not started through the entry' },
  ], 'the two codes 1.6 §9.7 lists as where:"netenv" failures, with the detail as the reason (it names the PATH entry / the pids)')
  events.length = 0
  assert.deepEqual(recordEntryFindings({ findings, state, appendEvent: (rec) => events.push(rec) }), [], 'the same findings again: nothing new (driftCheck\'s once-per-occurrence)')
  assert.deepEqual(events, [])
  const moved = recordEntryFindings({ findings: [{ ...findings[0], detail: 'kimi resolves first to D:\\tools\\kimi.cmd — the machine PATH\'s D:\\tools' }], state, appendEvent: (rec) => events.push(rec) })
  assert.equal(moved.length, 1)
  assert.equal(events.length, 1, 'a finding that CHANGED (a different entry now wins) is one new record, once')
})

test('checkEntries with nothing in effect answers nothing: no manifest, no entries, a pending-admin machine entry and a confirmed:false apply are all outside the check', async () => {
  assert.deepEqual(checkEntries({ manifest: null, procs: [] }), [])
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r)
  realCmd(r, 'kimi')
  assert.equal((await r.apply()).state, 'done')
  r.manifest.entries.push({ kind: 'optin-machine-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'machine-path-dispatcher', scope: 'machine', pending_admin: true, values: { command: 'kimi', realBinary: 'C:\\x.exe', machinePath: 'C:\\Windows' } })
  r.manifest.entries.push({ kind: 'optin-user-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user', confirmed: false, values: { command: 'kimi', binDir: 'C:\\nowhere', realBinary: 'C:\\x.exe' } })
  assert.deepEqual(r.check(), [], 'a pending-admin machine item is not in effect (its own state says pending-admin), and a failed apply is not a broken entry — the one real entry is intact')
})

test('the arch\'s optIn.check needs the caller\'s identify (registry.match, agents.json in it): no silent judge built from the presets alone', async () => {
  const { loadArch } = await import('../../../../src/collector/arch/index.mjs')
  const A = await loadArch('win32')
  assert.throws(() => A.optIn.check({ harnesses: [], manifest: null, procs: [] }), /needs identify/)
  assert.deepEqual(A.optIn.check({ harnesses: [], manifest: null, procs: [], identify: () => ({ agent: null, reason: 'no-match' }) }), [])
})
