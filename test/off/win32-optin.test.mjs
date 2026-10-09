// test/off/win32-optin.test.mjs — the inline undos of the user-level opt-in items (4.8 §2.4「撤销不用脚本」· §6.3; W64's undo cells, W21's
// reference count; plan Task 14's user half). The undos live in src/off alone (node:* and src/off, no script file: the standalone asight-off
// runs them with the source tree gone, 1.6 R3), so this test drives them through undoOptIns against the SAME fake Windows the apply tests use
// (fixtures/optin-world.mjs): apply through the real applyOptIn, then undo, and the world is compared byte for byte with what it held before.
// The world files are read and written through the fixture's mapping fs (`r.wfs`) so the Windows-shaped paths stay inside the sandbox. The
// registry-value / broadcast / shortcut-read argv are inline copies of arch/win32/userpath.mjs's — the first test holds the two to the same
// bytes, which is the guard against the apply and the undo drifting apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { UNDO_BY_KIND, undoOptIns, readUserPathArgs as inlineReadArgs, setUserPathArgs as inlineSetArgs, BROADCAST_ARGS as inlineBroadcast, readShortcutArgs as inlineShortcutArgs } from '../../src/off/win32-optin.mjs'
import { readUserPathArgs, setUserPathArgs, BROADCAST_ARGS, readShortcutArgs, USER_PATH_VALUE } from '../../src/collector/arch/win32/userpath.mjs'
import { OPTIN_KINDS, OPTIN_MACHINE_KINDS } from '../../src/off/manifest.mjs'
import { GROUPS, POLICY_KEY, rig, nativeKimi, realCmd, writeShortcut } from '../collector/arch/win32/fixtures/optin-world.mjs'

test('the inline argv are the same bytes as arch/win32/userpath.mjs\'s (the standalone cannot import the arch module; the copies ARE the contract)', () => {
  assert.deepEqual(inlineReadArgs(), readUserPathArgs())
  assert.deepEqual(inlineSetArgs('C:\\a;C:\\b', 'REG_SZ'), setUserPathArgs('C:\\a;C:\\b', 'REG_SZ'))
  assert.deepEqual(inlineBroadcast, BROADCAST_ARGS)
  assert.deepEqual(inlineShortcutArgs('C:\\Users\\a b\\Desktop\\Open\'Code.lnk'), readShortcutArgs('C:\\Users\\a b\\Desktop\\Open\'Code.lnk'))
  assert.equal(USER_PATH_VALUE, 'Path')
})

test('W54-style loop guard: every user-level opt-in kind has an undo — a kind with no undo is red (the standalone walks Object.keys(UNDO_BY_KIND))', async () => {
  assert.deepEqual([...Object.keys(UNDO_BY_KIND)].sort(), [...OPTIN_KINDS.filter((k) => !OPTIN_MACHINE_KINDS.includes(k))].sort(),
    'the registry covers exactly the user-level kinds; adding a kind to KNOWN_KINDS without its inline undo is red here first')
  // and the loop itself: a kind present in the manifest but not in the registry is unknown-kind, never a guess (the existing kernel test
  // lends a fake kind; here it is the real shape — a machine kind is never in the registry, it is needs-admin instead)
  const m = { entries: [{ kind: 'optin-machine-path', scope: 'machine', harness: 'opencode', path: 'HKLM\\x', elevated_command: 'the one line' }] }
  const o = await undoOptIns({ manifest: m })
  assert.deepEqual(o.results.map((r) => [r.kind, r.result]), [['optin-machine-path', 'needs-admin']])
  assert.deepEqual(o.needsAdmin.map((r) => r.command), ['the one line'], 'handed to the operator, never run here')
})

test('W64 round-trip, the PATH item: apply then inline undo is byte-identical — the shim and the directory gone, the PATH value and its type back, one broadcast each way', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r)
  const npmDir = path.win32.join(r.winHome, 'npm')
  realCmd(r, 'kimi', 'the real one')
  const before = { value: r.w.state['HKCU\\Environment'].Path.value, kind: r.w.state['HKCU\\Environment'].Path.kind }
  assert.deepEqual(await r.apply(), { state: 'done' })
  const o = await undoOptIns({ manifest: r.manifest, exec: r.w.run, env: r.env, fs: r.wfs })
  assert.deepEqual(o.results.map((x) => [x.kind, x.result]), [['optin-user-path', 'undone']])
  assert.deepEqual(r.w.state['HKCU\\Environment'].Path, before, 'the value and its type, byte for byte')
  const binDir = path.win32.join(r.dir, 'bin')
  assert.equal(r.wfs.existsSync(path.win32.join(binDir, 'kimi.cmd')), false, 'the shim file is gone')
  assert.equal(r.wfs.existsSync(binDir), false, 'with the last shim the directory goes too')
  assert.equal(r.w.broadcasts.length, 2, 'one broadcast at the apply, one at the undo')
  assert.equal(r.w.calls.some((c) => c[0] === 'setx'), false, 'never setx, in either direction')
})

test('W21/W64 the reference count: kimi and opencode both opted in — off kimi-code leaves opencode\'s shim and the PATH item; then off opencode takes both (one `off` walking both does the same)', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', forms: ['kimi-code.cli', 'opencode.cli'] })
  nativeKimi(r)
  const npmDir = path.win32.join(r.winHome, 'npm')
  realCmd(r, 'kimi')
  realCmd(r, 'opencode')
  assert.deepEqual(await r.applyAs('kimi-code.cli', 'user-path-shim'), { state: 'done' })
  assert.deepEqual(await r.applyAs('opencode.cli', 'user-path-shim'), { state: 'done' })
  const binDir = path.win32.join(r.dir, 'bin')
  assert.deepEqual([r.wfs.existsSync(path.win32.join(binDir, 'kimi.cmd')), r.wfs.existsSync(path.win32.join(binDir, 'opencode.cmd'))], [true, true])

  const kimi = await undoOptIns({ manifest: r.manifest, ids: ['kimi-code'], exec: r.w.run, env: r.env, fs: r.wfs })
  assert.deepEqual(kimi.results.map((x) => [x.kind, x.result]), [['optin-user-path', 'undone']])
  assert.deepEqual([r.wfs.existsSync(path.win32.join(binDir, 'kimi.cmd')), r.wfs.existsSync(path.win32.join(binDir, 'opencode.cmd'))], [false, true], 'off kimi-code removed only kimi\'s shim')
  assert.equal(r.wfs.existsSync(binDir), true, 'the shim directory stays')
  assert.match(r.w.state['HKCU\\Environment'].Path.value, new RegExp(`^${binDir.replace(/\\/g, '\\\\').replace(/\./g, '\\.')};`), 'the PATH item stays (opencode still holds it)')

  const both = await undoOptIns({ manifest: r.manifest, ids: ['opencode'], exec: r.w.run, env: r.env, fs: r.wfs })
  assert.equal(both.results[0].result, 'undone')
  assert.equal(r.wfs.existsSync(path.win32.join(binDir, 'opencode.cmd')), false)
  assert.equal(r.wfs.existsSync(binDir), false, 'the last shim takes the directory')
  assert.equal(r.w.state['HKCU\\Environment'].Path.value, npmDir, 'and the PATH item')

  // one `off` walking both entries in a single pass lands in the same place: the count is by shim files that still exist, not by entries
  const r2 = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', forms: ['kimi-code.cli', 'opencode.cli'] })
  nativeKimi(r2)
  const npmDir2 = path.win32.join(r2.winHome, 'npm')
  realCmd(r2, 'kimi')
  realCmd(r2, 'opencode')
  await r2.applyAs('kimi-code.cli', 'user-path-shim')
  await r2.applyAs('opencode.cli', 'user-path-shim')
  const one = await undoOptIns({ manifest: r2.manifest, exec: r2.w.run, env: r2.env, fs: r2.wfs })
  assert.deepEqual(one.results.map((x) => x.result), ['undone', 'undone'])
  const binDir2 = path.win32.join(r2.dir, 'bin')
  assert.deepEqual([r2.wfs.existsSync(path.win32.join(binDir2, 'kimi.cmd')), r2.wfs.existsSync(path.win32.join(binDir2, 'opencode.cmd')), r2.wfs.existsSync(binDir2)], [false, false, false])
  assert.equal(r2.w.state['HKCU\\Environment'].Path.value, npmDir2)
})

test('the PATH changed after asight: only asight\'s directory is dropped (never the old value written back, D28), and the receipt says undone-but-not-byte-for-byte', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r)
  const npmDir = path.win32.join(r.winHome, 'npm')
  realCmd(r, 'kimi')
  await r.apply()
  r.w.state['HKCU\\Environment'].Path.value = `${path.win32.join(r.dir, 'bin')};C:\\user-added;${npmDir}` // the user edited it after asight
  const o = await undoOptIns({ manifest: r.manifest, exec: r.w.run, env: r.env, fs: r.wfs })
  assert.equal(o.results[0].result, 'undone')
  assert.equal(r.w.state['HKCU\\Environment'].Path.value, `C:\\user-added;${npmDir}`, 'only our item went; the user\'s edit stays')
  assert.match(o.results[0].reason, /not byte for byte/)
})

test('W64 round-trip, the shortcuts: restored from the backups byte for byte; a shortcut the user repointed since is left alone and said (「你改过,没动」); the launcher goes', async () => {
  const r = await rig({ form: 'opencode.desktop', item: 'start-menu-launcher' })
  const exe = path.win32.join(r.winHome, 'AppData', 'Local', 'Programs', 'OpenCode', 'OpenCode.exe')
  const places = [path.win32.join(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCode.lnk'), path.win32.join(r.winHome, 'Desktop', 'OpenCode.lnk')]
  for (const p of places) writeShortcut(r, p, exe)
  await r.apply()
  const launcher = path.win32.join(r.dir, 'launchers', 'asight-opencode.cmd')
  r.wfs.writeFileSync(places[1], path.win32.join(r.winHome, 'NewOpenCode.exe')) // the user (or an updater) repointed the desktop one
  const o = await undoOptIns({ manifest: r.manifest, exec: r.w.run, env: r.env, fs: r.wfs })
  assert.equal(o.results[0].result, 'left', 'one of the two was changed since: the row says what stayed')
  assert.equal(r.wfs.readFileSync(places[0], 'utf8'), exe, 'the untouched one is restored byte for byte from its backup')
  assert.equal(r.wfs.readFileSync(places[1], 'utf8'), path.win32.join(r.winHome, 'NewOpenCode.exe'), 'the changed one is not touched')
  assert.equal(r.wfs.existsSync(launcher), false, 'the launcher — asight\'s own file — goes')

  const clean = await rig({ form: 'opencode.desktop', item: 'start-menu-launcher' })
  for (const p of [path.win32.join(clean.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCode.lnk'), path.win32.join(clean.winHome, 'Desktop', 'OpenCode.lnk')]) {
    writeShortcut(clean, p, path.win32.join(clean.winHome, 'AppData', 'Local', 'Programs', 'OpenCode', 'OpenCode.exe'))
  }
  await clean.apply()
  const o2 = await undoOptIns({ manifest: clean.manifest, exec: clean.w.run, env: clean.env, fs: clean.wfs })
  assert.equal(o2.results[0].result, 'undone')
  for (const p of [path.win32.join(clean.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCode.lnk'), path.win32.join(clean.winHome, 'Desktop', 'OpenCode.lnk')]) {
    assert.equal(clean.wfs.readFileSync(p, 'utf8'), path.win32.join(clean.winHome, 'AppData', 'Local', 'Programs', 'OpenCode', 'OpenCode.exe'), 'both back to the app they pointed at')
  }
})

test('W64 round-trip, Claude Desktop: the certificate deleted by thumbprint, the policy value back to the user\'s own (or gone when there was none)', async () => {
  const withPrior = await rig({ form: 'claude-code.desktop', item: 'cert-store-current-user', win: { policy: 'http://user-proxy:8080' } })
  await withPrior.apply()
  assert.equal(withPrior.w.store.size, 1)
  const o = await undoOptIns({ manifest: withPrior.manifest, exec: withPrior.w.run, env: withPrior.env, fs: withPrior.wfs })
  assert.deepEqual(o.results.map((x) => [x.kind, x.result]), [['optin-cert-user', 'undone'], ['optin-claude-policy', 'undone']])
  assert.equal(withPrior.w.store.size, 0, 'the certificate is out of the store')
  assert.equal(withPrior.w.state[POLICY_KEY].egressProxyUrl.value, 'http://user-proxy:8080', 'the prior policy value is back')

  const noPrior = await rig({ form: 'claude-code.desktop', item: 'cert-store-current-user' })
  await noPrior.apply()
  const o2 = await undoOptIns({ manifest: noPrior.manifest, exec: noPrior.w.run, env: noPrior.env, fs: noPrior.wfs })
  assert.equal(o2.results[1].result, 'undone')
  assert.equal(noPrior.w.state[POLICY_KEY].egressProxyUrl, undefined, 'there was no prior: the value is deleted, not left empty')
  // an already-gone certificate is absent, not a failure
  const again = await undoOptIns({ manifest: noPrior.manifest, exec: noPrior.w.run, env: noPrior.env, fs: noPrior.wfs })
  assert.equal(again.results[0].result, 'absent')
})

test('W64 round-trip, VS Code and Z-Code: the settings files byte-identical through reverseOps; a file edited since keeps the user\'s edits and loses only asight\'s keys; the shortcuts and the launcher as above', async () => {
  const settingsOf = (r) => path.join(r.env.APPDATA, 'Code', 'User', 'settings.json') // the harness data's own POSIX join of the Windows APPDATA
  const lnkOf = (r) => path.win32.join(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk')
  const userText = '{\n  "editor.fontSize": 13,\n  "http.proxy": "http://user-proxy:8080"\n}\n'
  const r = await rig({ form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher' })
  r.wfs.mkdirSync(path.dirname(settingsOf(r)), { recursive: true })
  r.wfs.writeFileSync(settingsOf(r), userText)
  writeShortcut(r, lnkOf(r), path.win32.join(r.winHome, 'Code.exe'))
  await r.apply()
  const o = await undoOptIns({ manifest: r.manifest, exec: r.w.run, env: r.env, fs: r.wfs })
  assert.equal(o.results[0].result, 'undone')
  assert.equal(r.wfs.readFileSync(settingsOf(r), 'utf8'), userText, 'byte for byte what the file held before asight')
  assert.equal(r.wfs.readFileSync(lnkOf(r), 'utf8'), path.win32.join(r.winHome, 'Code.exe'))
  assert.equal(r.wfs.existsSync(path.win32.join(r.dir, 'launchers', 'asight-code.cmd')), false)

  // the user edited the file after asight: only asight's keys go, their own edits (and their prior proxy) stay
  const edited = await rig({ form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher' })
  edited.wfs.mkdirSync(path.dirname(settingsOf(edited)), { recursive: true })
  edited.wfs.writeFileSync(settingsOf(edited), userText)
  writeShortcut(edited, lnkOf(edited), path.win32.join(edited.winHome, 'Code.exe'))
  await edited.apply()
  edited.wfs.writeFileSync(settingsOf(edited), `${edited.wfs.readFileSync(settingsOf(edited), 'utf8').slice(0, -2)},\n  "editor.fontSize": 15\n}\n`) // the user's own edit, after asight
  const o2 = await undoOptIns({ manifest: edited.manifest, exec: edited.w.run, env: edited.env, fs: edited.wfs })
  assert.equal(o2.results[0].result, 'undone')
  const after = JSON.parse(edited.wfs.readFileSync(settingsOf(edited), 'utf8'))
  assert.deepEqual([after['editor.fontSize'], after['http.proxy'], after['http.systemCertificates']], [15, 'http://user-proxy:8080', undefined],
    'the user\'s edit kept, their prior proxy back, asight\'s two keys gone')

  const z = await rig({ form: 'z-code.desktop', item: 'zcode-app-settings' })
  const setting = path.join(z.winHome, '.zcode', 'v2', 'setting.json') // the harness data's own path.join
  z.wfs.mkdirSync(path.dirname(setting), { recursive: true })
  z.wfs.writeFileSync(setting, '{\n  "theme": "dark"\n}\n')
  z.wfs.writeFileSync(path.win32.join(z.dir, 'ca', 'combined-z-code.pem'), z.ca.certPem)
  await z.apply()
  const o3 = await undoOptIns({ manifest: z.manifest, exec: z.w.run, env: z.env, fs: z.wfs })
  assert.equal(o3.results[0].result, 'undone')
  assert.equal(z.wfs.readFileSync(setting, 'utf8'), '{\n  "theme": "dark"\n}\n', 'byte for byte')
})

test('a settings file asight CREATED is deleted with its empty parents (existed_before: false); a file the user deleted is not an error', async () => {
  const z = await rig({ form: 'z-code.desktop', item: 'zcode-app-settings' })
  z.wfs.writeFileSync(path.win32.join(z.dir, 'ca', 'combined-z-code.pem'), z.ca.certPem)
  await z.apply() // no setting.json existed: asight created it
  const setting = path.join(z.winHome, '.zcode', 'v2', 'setting.json')
  assert.ok(z.wfs.existsSync(setting))
  const o = await undoOptIns({ manifest: z.manifest, exec: z.w.run, env: z.env, fs: z.wfs })
  assert.equal(o.results[0].result, 'undone')
  assert.equal(z.wfs.existsSync(setting), false, 'asight created the file: it goes')
  const deleted = await rig({ form: 'z-code.desktop', item: 'zcode-app-settings' })
  deleted.wfs.writeFileSync(path.win32.join(deleted.dir, 'ca', 'combined-z-code.pem'), deleted.ca.certPem)
  deleted.wfs.mkdirSync(path.dirname(path.join(deleted.winHome, '.zcode', 'v2', 'setting.json')), { recursive: true })
  deleted.wfs.writeFileSync(path.join(deleted.winHome, '.zcode', 'v2', 'setting.json'), '{"theme":"dark"}')
  await deleted.apply()
  deleted.wfs.rmSync(path.join(deleted.winHome, '.zcode', 'v2', 'setting.json')) // the user deleted the whole file afterwards
  const o2 = await undoOptIns({ manifest: deleted.manifest, exec: deleted.w.run, env: deleted.env, fs: deleted.wfs })
  assert.equal(o2.results[0].result, 'undone', 'nothing of asight\'s is left in a file that is gone; the row says it, not an error')
  assert.match(o2.results[0].reason, /you deleted it/)
})

test('an entry without its values, or an undo that throws, is a failed row, never a crash of the whole off', async () => {
  const bad = { entries: [{ kind: 'optin-user-path', scope: 'user', harness: 'kimi-code', path: 'x' }] }
  const o = await undoOptIns({ manifest: bad, exec: () => ({ status: 0, stdout: '', stderr: '' }) })
  assert.equal(o.results[0].result, 'failed')
  assert.match(o.results[0].reason, /no shim to undo/)
  const boom = { entries: [{ kind: 'optin-zcode', scope: 'user', harness: 'z-code', path: 'C:\\x', values: { keys: [['httpProxy']] }, existed_before: true, post_sha256: 'deadbeef', ops: [{ offset: 0, removed: '', inserted: '{"x"' }] }] }
  const o2 = await undoOptIns({ manifest: boom, exec: () => ({ status: 0, stdout: '', stderr: '' }), fs: { existsSync: () => true, readFileSync: () => 'not json at all', writeFileSync: () => {}, rmSync: () => {}, rmdirSync: () => {} } })
  assert.equal(o2.results[0].result, 'left')
  assert.match(o2.results[0].reason, /no longer JSON/)
})
