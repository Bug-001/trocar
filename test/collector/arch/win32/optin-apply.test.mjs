// test/collector/arch/win32/optin-apply.test.mjs — applyOptIn's user-level half (4.8 §2.4「执行」, W64's apply cells; plan Task 14's user half).
// One fake Windows per rig: a fake registry and certificate store behind one injected `run`, and the six fixed scripts SIMULATED by it —
// the simulation is each script's own logic read off its source (write the base64 bytes, repoint the shortcut, add the certificate to the
// store), applied to a real sandbox HOME, so the read-backs run against the same world the "script" changed. No real tool is spawned on this
// Mac (0.1 §3): powershell, reg and certutil are all the one fake. Windows paths are opaque strings here (backslashes and all), created and
// read back consistently; the backups land under the sandbox HOME's real POSIX paths.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { applyOptIn, planOptIns, optinFormsOf, OPTIN_NEVER, SCRIPTS_DIR } from '../../../../src/collector/arch/win32/optin.mjs'
import { loadIngressConfig } from '../../../../src/collector/arch/win32/ingress-config.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { createCa } from '../../../../src/collector/core/tls/ca.mjs'
import { MACHINE_PATH_KEY } from '../../../../src/collector/arch/win32/elevate.mjs'
import { SAC_KEY } from '../../../../src/collector/arch/win32/userpath.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const GROUPS = groupsOf(await loadHarnesses())
const POLICY_KEY = 'HKCU\\SOFTWARE\\Policies\\Claude'
const sha1Thumb = (pem) => crypto.createHash('sha1').update(new crypto.X509Certificate(pem).raw).digest('hex').toUpperCase()
const b64dec = (s) => Buffer.from(s, 'base64').toString('utf8')

/** One fake Windows: registry (reg.exe), certificate store (certutil), and the six fixed scripts. `declineCert` is the user clicking No on
 *  Windows' own confirmation box. Shortcut files are real files whose CONTENT is their target (the fake's WScript.Shell reads it back). */
function fakeWin({ home, reg = {}, sac = 0, declineCert = false }) {
  const state = {
    'HKCU\\Environment': reg.userPath ? { Path: { kind: 'REG_EXPAND_SZ', value: reg.userPath } } : {},
    [MACHINE_PATH_KEY]: { Path: { kind: 'REG_EXPAND_SZ', value: reg.machinePath ?? 'C:\\Windows\\system32;C:\\Windows' } },
    ...(sac === null ? {} : { [SAC_KEY]: { VerifiedAndReputablePolicyState: { kind: 'REG_DWORD', value: sac } } }),
    ...(reg.policy != null ? { [POLICY_KEY]: { egressProxyUrl: { kind: 'REG_SZ', value: reg.policy } } } : {}),
  }
  const store = new Set()
  const calls = [], broadcasts = [], scripts = []
  const out = (v = '') => ({ status: 0, stdout: v, stderr: '' })
  const params = (args) => { // -File <script> then -Name value…  → { script, params: {Name: [values]} }
    const at = args.indexOf('-File')
    if (at < 0) return null
    const p = { script: path.basename(args[at + 1]), params: {} }
    for (let i = at + 2; i < args.length; i++) {
      if (String(args[i]).startsWith('-')) { const name = args[i]; const v = []; p.params[name] = v; for (let j = i + 1; j < args.length && !String(args[j]).startsWith('-'); j++) v.push(args[j]) }
    }
    return p
  }
  const shortcutRead = (args) => { const m = /CreateShortcut\('(.*)'\)/.exec(args[args.length - 1]); if (!m) return null; try { return out(fs.readFileSync(m[1], 'utf8')) } catch { return out('') } }
  const run = (file, args) => {
    calls.push([file, ...args])
    if (file === 'reg') {
      const key = args[1], name = args[args.indexOf('/v') + 1]
      if (args[0] === 'query') {
        const hive = state[key], v = hive && hive[name]
        if (!v) return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
        const text = v.kind === 'REG_DWORD' ? `0x${v.value.toString(16)}` : v.value
        return out(`\r\n${key}\r\n    ${name}    ${v.kind}    ${text}\r\n\r\n`)
      }
      if (args[0] === 'add') { state[key] = state[key] || {}; state[key][args[args.indexOf('/v') + 1]] = { kind: args[args.indexOf('/t') + 1], value: args[args.indexOf('/d') + 1] }; return out('') }
    }
    if (file === 'certutil') {
      if (args.includes('-addstore')) { if (declineCert) return { status: 1, stdout: '', stderr: 'The user cancelled the certificate import.' }; store.add(sha1Thumb(fs.readFileSync(args[args.length - 1], 'utf8'))); return out('') }
      if (args.includes('-store')) return store.has(args[args.length - 1]) ? out('matched') : { status: 1, stdout: '', stderr: 'not found' }
    }
    if (file === 'powershell') {
      if (args.includes('-File')) {
        const p = params(args)
        scripts.push(p)
        if (p.script === 'user-path.ps1') { fs.mkdirSync(p.params['-BinDir'][0], { recursive: true }); fs.writeFileSync(path.win32.join(p.params['-BinDir'][0], `${p.params['-Command'][0]}.cmd`), b64dec(p.params['-ShimB64'][0])); return out('') }
        if (p.script === 'shortcut.ps1') { fs.mkdirSync(path.dirname(p.params['-Launcher'][0]), { recursive: true }); fs.writeFileSync(p.params['-Launcher'][0], b64dec(p.params['-LauncherB64'][0])); for (const s of p.params['-Shortcut']) fs.writeFileSync(s, p.params['-Launcher'][0]); return out('') }
        if (p.script === 'cert-user.ps1') { if (declineCert) return { status: 1, stdout: '', stderr: 'The user cancelled the certificate import.' }; store.add(sha1Thumb(fs.readFileSync(p.params['-CertFile'][0], 'utf8'))); return out('') }
        if (p.script === 'claude-policy.ps1') { state[POLICY_KEY] = state[POLICY_KEY] || {}; state[POLICY_KEY].egressProxyUrl = { kind: 'REG_SZ', value: p.params['-Url'][0] }; return out('') }
        if (p.script === 'vscode.ps1') { fs.writeFileSync(p.params['-Settings'][0], b64dec(p.params['-SettingsB64'][0])); fs.mkdirSync(path.dirname(p.params['-Launcher'][0]), { recursive: true }); fs.writeFileSync(p.params['-Launcher'][0], b64dec(p.params['-LauncherB64'][0])); for (const s of p.params['-Shortcut'] || []) fs.writeFileSync(s, p.params['-Launcher'][0]); return out('') }
        if (p.script === 'zcode-desktop.ps1') { fs.writeFileSync(p.params['-File'][0], b64dec(p.params['-ContentB64'][0])); return out('') }
      }
      if (/SendMessageTimeout/.test(args[args.length - 1])) { broadcasts.push(1); return out('') }
      const lnk = shortcutRead(args)
      if (lnk) return lnk
    }
    return out('')
  }
  return { run, state, store, calls, broadcasts, scripts }
}

/** One sandbox HOME with the world a user-level opt-in needs: the collector CA, a real ingress.json (through loadIngressConfig itself),
 *  kimi's native install, the real binary on the user PATH, the shortcuts and settings files. */
async function rig({ form, item, over = {}, win = {} } = {}) {
  const home = tmpDir('asight-optin-apply-')
  const dir = path.win32.join(home, '.asight', 'collector') // the Windows shape turnOn hands the apply; opaque here, one string everywhere
  const ca = createCa({ commonName: 'asight test CA' })
  fs.mkdirSync(dir, { recursive: true }) // ingress.json is read back through path.join of this same string
  fs.mkdirSync(path.win32.join(dir, 'ca'), { recursive: true })
  fs.writeFileSync(path.win32.join(dir, 'ca', 'asight-ca.pem'), ca.certPem)
  const g = GROUPS.find((x) => x.forms.some((f) => f.id === form))
  const ingress = await loadIngressConfig({ dir, groups: [g.g], isFree: async () => true, random: (n) => crypto.randomBytes(n), fs })
  // the world's Windows paths are the same strings the apply builds: opaque here, consistent everywhere
  const env = { APPDATA: path.win32.join(home, 'AppData', 'Roaming'), USERPROFILE: home }
  const npmDir = path.win32.join(home, 'npm')
  fs.mkdirSync(npmDir, { recursive: true })
  const w = fakeWin({ home, reg: { userPath: win.userPath ?? npmDir, policy: win.policy ?? null, machinePath: win.machinePath }, sac: win.sac ?? 0, declineCert: win.declineCert ?? false })
  const manifest = { entries: [] }
  const notes = [], events = [], failures = []
  const row = { form, harness: g.harness, item, kinds: [], scope: 'user', admin: false, chosen: true, applicable: true, state: 'needed' }
  const deps = { run: w.run, sac: () => (win.sac === null ? 'off' : win.sac === 1 ? 'on' : win.sac === 2 ? 'evaluation' : 'off'), ...over.deps }
  const apply = () => applyOptIn({ row, groups: GROUPS, manifest, dir, home, env, fs, deps,
    save: () => {}, note: (r) => notes.push(r), failure: (r) => failures.push(r), state: (r) => events.push(r) })
  return { home, dir, ca, g, ingress, env, w, manifest, notes, events, failures, row, deps, apply }
}
const nativeKimi = (home) => { const p = path.win32.join(home, '.kimi-code', 'bin', 'kimi.exe'); fs.mkdirSync(path.win32.dirname(p), { recursive: true }); fs.writeFileSync(p, 'exe') }
const writeShortcut = (p, target) => { fs.mkdirSync(path.win32.dirname(p), { recursive: true }); fs.writeFileSync(p, target) }

test('W64 the PATH item: through its fixed .ps1 and read back — the shim file with the proxy and the CA, the directory first on the user PATH, ledgered with scope, prior and undo_by_hand (W21: one broadcast, zero setx, the type kept)', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' })
  nativeKimi(r.home)
  fs.writeFileSync(`${path.win32.join(r.home, 'npm')}\\kimi.cmd`, 'the real one') // the real binary, on the user PATH (npm style)
  const out = await r.apply()
  assert.deepEqual(out, { state: 'done' })
  const binDir = path.win32.join(r.dir, 'bin')
  const shim = fs.readFileSync(path.win32.join(binDir, 'kimi.cmd'), 'utf8')
  const port = r.ingress.groupPorts['kimi-code.cli']
  assert.match(shim, new RegExp(`if not defined HTTPS_PROXY set "HTTPS_PROXY=http://kimi-code\\.cli:${r.ingress.listenerToken}@127\\.0\\.0\\.1:${port}"`), 'the proxy is this form\'s kernel listener, with credentials (§6.3)')
  assert.match(shim, new RegExp(`set "NODE_EXTRA_CA_CERTS=.*asight-ca\\.pem"`), 'the CA file Node reads (the extra-kimi.pem rule: the extra bundle when there is one, else the collector CA)')
  assert.ok(shim.includes(`"${path.win32.join(r.home, 'npm', 'kimi.cmd')}" %*`), 'the real binary forwards the arguments')
  assert.equal(r.w.state['HKCU\\Environment'].Path.value, `${binDir};${path.win32.join(r.home, 'npm')}`, 'the directory is first, the rest keeps its order')
  assert.equal(r.w.state['HKCU\\Environment'].Path.kind, 'REG_EXPAND_SZ', 'the type is kept')
  assert.equal(r.w.broadcasts.length, 1, 'ONE WM_SETTINGCHANGE')
  assert.equal(r.w.calls.some((c) => c[0] === 'setx'), false, 'never setx')
  assert.equal(r.w.scripts.length, 1)
  assert.equal(r.w.scripts[0].script, 'user-path.ps1')
  assert.equal(r.w.scripts[0].params['-Command'][0], 'kimi')
  const e = r.manifest.entries[0]
  assert.deepEqual([e.kind, e.scope, e.harness, e.form, e.item, e.confirmed], ['optin-user-path', 'user', 'kimi-code', 'kimi-code.cli', 'user-path-shim', true])
  assert.deepEqual(e.prior_value, { kind: 'REG_EXPAND_SZ', value: path.win32.join(r.home, 'npm') }, 'the prior is what the ledger records')
  assert.match(e.undo_by_hand, /asight off kimi-code/, 'the undo is the agent\'s switch (V64)')
  assert.deepEqual([e.values.command, e.values.binDir], ['kimi', binDir])
  assert.deepEqual(r.events, [{ event: 'optin-applied', where: 'optin', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user' }])
  assert.ok(r.notes.some((n) => n.outcome === 'ok'))
})

test('W21 Smart App Control on → no shim, reason smart-app-control; Kimi not the native install → no shim; nothing written in either case', async () => {
  const sac = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', win: { sac: 1 } })
  nativeKimi(sac.home)
  fs.writeFileSync(`${path.win32.join(sac.home, 'npm')}\\kimi.cmd`, 'x')
  const out = await sac.apply()
  assert.equal(out.state, 'failed')
  assert.match(out.reason, /Smart App Control is on/)
  assert.deepEqual([sac.w.scripts.length, sac.w.broadcasts.length, sac.manifest.entries.length, fs.existsSync(path.win32.join(sac.dir, 'bin'))], [0, 0, 0, false], 'zero writes, zero entries')
  const npmOnly = await rig({ form: 'kimi-code.cli', item: 'user-path-shim' }) // kimi via npm: no native install
  fs.writeFileSync(`${path.win32.join(npmOnly.home, 'npm')}\\kimi.cmd`, 'x')
  const out2 = await npmOnly.apply()
  assert.equal(out2.state, 'failed')
  assert.match(out2.reason, /not the native install/)
  assert.deepEqual([npmOnly.w.scripts.length, npmOnly.manifest.entries.length], [0, 0])
})

test('a real binary that resolves nowhere is an honest error with zero writes (a shim forwards to it, so without it there is nothing to forward to)', async () => {
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', win: { userPath: 'C:\\somewhere-else' } })
  nativeKimi(r.home)
  const out = await r.apply()
  assert.equal(out.state, 'failed')
  assert.match(out.reason, /did not resolve on the PATH/)
  assert.deepEqual([r.w.scripts.length, r.manifest.entries.length], [0, 0])
  const noIngress = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', over: { deps: { ingress: { missing: true } } } })
  nativeKimi(noIngress.home)
  fs.writeFileSync(`${path.win32.join(noIngress.home, 'npm')}\\kimi.cmd`, 'x')
  const out2 = await noIngress.apply()
  assert.equal(out2.state, 'failed')
  assert.match(out2.reason, /ingress config could not be read/)
  assert.deepEqual([noIngress.w.scripts.length, noIngress.manifest.entries.length], [0, 0], 'run asight on first: the shim has no port to point at')
})

test('W64 the shortcuts item: asight\'s launcher written, every shortcut repointed and read back, a backup of each before the change, the prior target recorded', async () => {
  const r = await rig({ form: 'opencode.desktop', item: 'start-menu-launcher' })
  const exe = path.win32.join(r.home, 'AppData', 'Local', 'Programs', 'OpenCode', 'OpenCode.exe')
  const places = [path.win32.join(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCode.lnk'), path.win32.join(r.home, 'Desktop', 'OpenCode.lnk')]
  for (const p of places) writeShortcut(p, exe)
  const out = await r.apply()
  assert.deepEqual(out, { state: 'done' })
  const launcher = path.win32.join(r.dir, 'launchers', 'asight-opencode.cmd')
  const text = fs.readFileSync(launcher, 'utf8')
  assert.match(text, new RegExp(`if not defined HTTPS_PROXY set "HTTPS_PROXY=http://opencode\\.desktop:${r.ingress.listenerToken}@127\\.0\\.0\\.1:${r.ingress.groupPorts['opencode.desktop']}"`))
  assert.ok(text.includes(`"${exe}" %*`), 'the launcher forwards to the app the shortcut pointed at')
  for (const p of places) assert.equal(fs.readFileSync(p, 'utf8'), launcher, 'repointed, and the read-back confirmed it')
  const e = r.manifest.entries[0]
  assert.deepEqual([e.kind, e.scope, e.confirmed], ['optin-shortcut', 'user', true])
  assert.deepEqual(e.values.shortcuts.map((s) => s.path), places)
  assert.equal(e.values.realBinary, exe)
  for (const s of e.values.shortcuts) {
    assert.ok(fs.existsSync(s.backup), `the backup of ${path.win32.basename(s.path)} exists`)
    assert.equal(fs.readFileSync(s.backup, 'utf8'), exe, 'and holds the original bytes')
  }
})

test('no shortcut in either place is an honest error with zero writes', async () => {
  const r = await rig({ form: 'opencode.desktop', item: 'start-menu-launcher' })
  const out = await r.apply()
  assert.equal(out.state, 'failed')
  assert.match(out.reason, /no OpenCode\.lnk found/)
  assert.deepEqual([r.w.scripts.length, r.manifest.entries.length], [0, 0])
})

test('W64 Claude Desktop: the CA into CurrentUser\\Root through Windows\' own confirmation box, then the policy value — two entries; a DECLINED box is optin-failed (the user\'s own no, never pending-admin) and the policy half never runs', async () => {
  const r = await rig({ form: 'claude-code.desktop', item: 'cert-store-current-user', win: { policy: 'http://user-proxy:8080' } })
  const out = await r.apply()
  assert.deepEqual(out, { state: 'done' })
  const [cert, policy] = r.manifest.entries
  assert.deepEqual([cert.kind, cert.scope, cert.confirmed], ['optin-cert-user', 'user', true])
  assert.equal(cert.values.thumbprint, sha1Thumb(r.ca.certPem))
  assert.ok(r.w.store.has(cert.values.thumbprint), 'the certificate is in the (fake) store, confirmed by the read-back')
  assert.deepEqual([policy.kind, policy.scope, policy.confirmed, policy.prior_value], ['optin-claude-policy', 'user', true, 'http://user-proxy:8080'], 'the prior policy value is ledgered')
  assert.equal(r.w.state[POLICY_KEY].egressProxyUrl.value, `http://127.0.0.1:${r.ingress.groupPorts['claude-code.desktop']}`, 'an address only — the listener takes no credentials (auth:false)')

  const declined = await rig({ form: 'claude-code.desktop', item: 'cert-store-current-user', win: { declineCert: true } })
  const out2 = await declined.apply()
  assert.equal(out2.state, 'failed')
  assert.match(out2.reason, /confirmation box for the certificate was declined/)
  assert.equal(declined.manifest.entries.length, 1, 'the certificate entry stays (undoable), and the policy half never ran')
  assert.equal(declined.manifest.entries[0].confirmed, false)
  assert.equal(declined.w.state[POLICY_KEY], undefined, 'no policy write after the user\'s no')
  assert.equal(declined.w.store.size, 0)
  assert.ok(declined.failures.some((f) => f.code === 'optin-failed'), 'optin-failed, NOT pending-admin: nobody was asked for administrator rights')
})

test('W64 the VS Code item: the two settings keys through a minimal text edit (the user\'s own file keeps its bytes outside them), the launcher with the CA, the editor\'s shortcut repointed; the entry carries ops, pre/post sha and the prior', async () => {
  const r = await rig({ form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher' })
  const settings = path.join(r.env.APPDATA, 'Code', 'User', 'settings.json') // exactly what the harness data's file(ctx) builds
  const userText = '{\n  "editor.fontSize": 13,\n  "http.proxy": "http://user-proxy:8080",\n  "workbench.colorTheme": "dark"\n}\n'
  fs.mkdirSync(path.win32.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, userText)
  const code = path.win32.join(r.home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe')
  const lnk = path.win32.join(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk') // shortcutPlaces builds it win32-joined
  writeShortcut(lnk, code)
  const out = await r.apply()
  assert.deepEqual(out, { state: 'done' })
  const after = fs.readFileSync(settings, 'utf8')
  assert.ok(after.includes('"editor.fontSize": 13,'), 'the user\'s own keys keep their bytes and order')
  assert.ok(after.includes(`"http.proxy": "http://kimi-code.vscode:${r.ingress.listenerToken}@127.0.0.1:${r.ingress.groupPorts['kimi-code.vscode']}"`), 'the proxy at this form\'s kernel listener, with credentials')
  assert.ok(after.includes('"http.systemCertificates": false'), 'a boolean, spelled without quotes')
  const launcher = path.win32.join(r.dir, 'launchers', 'asight-code.cmd')
  assert.match(fs.readFileSync(launcher, 'utf8'), /set "NODE_EXTRA_CA_CERTS=/)
  assert.equal(fs.readFileSync(lnk, 'utf8'), launcher)
  const e = r.manifest.entries[0]
  assert.deepEqual([e.kind, e.scope, e.confirmed], ['optin-vscode', 'user', true])
  assert.deepEqual(e.values.prior, { 'http.proxy': 'http://user-proxy:8080', 'http.systemCertificates': null })
  assert.equal(e.pre_sha256, crypto.createHash('sha256').update(userText).digest('hex'))
  assert.equal(e.post_sha256, crypto.createHash('sha256').update(after).digest('hex'))
  assert.ok(e.ops.length >= 2, 'the ops of both keys, for the inline undo\'s byte-exact reversal')
  assert.equal(fs.readFileSync(e.backup, 'utf8'), userText, 'the settings backup holds the original')
})

test('W64 the Z-Code Desktop item: the two keys of its own settings file, the CA key at the combined bundle (replacement semantics — never an asight-only file)', async () => {
  const r = await rig({ form: 'z-code.desktop', item: 'zcode-app-settings' })
  const setting = path.join(r.home, '.zcode', 'v2', 'setting.json') // the harness data's own path.join
  fs.mkdirSync(path.win32.dirname(setting), { recursive: true })
  fs.writeFileSync(setting, '{\n  "theme": "dark"\n}\n')
  const missingBundle = await r.apply()
  assert.equal(missingBundle.state, 'failed')
  assert.match(missingBundle.reason, /combined-z-code\.pem is not there/, 'the CLI form\'s trust entry builds the bundle; without it this item is not done')
  assert.deepEqual([r.w.scripts.length, r.manifest.entries.length], [0, 0])

  const bundle = path.win32.join(r.dir, 'ca', 'combined-z-code.pem')
  fs.writeFileSync(bundle, r.ca.certPem)
  const out = await r.apply()
  assert.deepEqual(out, { state: 'done' })
  const after = JSON.parse(fs.readFileSync(setting, 'utf8'))
  assert.equal(after.httpProxy, `http://z-code.desktop:${r.ingress.listenerToken}@127.0.0.1:${r.ingress.groupPorts['z-code.desktop']}`)
  assert.equal(after.httpProxyCaCertPath, bundle, 'the combined bundle, not the asight-only CA')
  assert.equal(after.theme, 'dark')
  const e = r.manifest.entries[0]
  assert.deepEqual([e.kind, e.scope, e.confirmed], ['optin-zcode', 'user', true])
  assert.deepEqual(e.values.prior, { httpProxy: null, httpProxyCaCertPath: null })
})

test('an injected form that would need a login-env HTTPS_PROXY gets a plan note and zero writes (1.6 §1.7「点名也不做」)', async () => {
  const groups = [{ g: 'lab.cli', harness: 'lab', group: { g: 'lab.cli', auth: true, proxyEntry: { kind: 'shim', command: 'lab' }, optIn: [
    { item: 'user-path-shim', scope: 'user', impact: 'the PATH order of every one of your programs changes' },
    { item: 'login-env-proxy', scope: 'user', impact: 'a proxy variable in your login environment would capture everything you start' },
  ] }, forms: [{ id: 'lab.cli', supported: true }] }]
  const rows = planOptIns({ groups })
  const never = rows.find((x) => x.item === 'login-env-proxy')
  assert.deepEqual([never.state, never.applicable, never.command, never.scope], ['never', false, null, 'never'])
  assert.match(never.note, /never writes HTTPS_PROXY/)
  assert.deepEqual(optinFormsOf(groups), ['lab.cli'], 'the form stays nameable (its real item is); the never item is not a thing to name')
  assert.ok(!OPTIN_NEVER['user-path-shim'], 'the category holds only the declared-never items')
  // the apply refuses it even if a future wiring hands it in: zero writes, an honest failure
  const home = tmpDir('asight-optin-never-')
  const manifest = { entries: [] }
  const failures = []
  const refused = await applyOptIn({ row: { form: 'lab.cli', harness: 'lab', item: 'login-env-proxy', kinds: [], scope: 'never', admin: false, chosen: true, applicable: false, state: 'never' },
    groups: GROUPS, manifest, dir: path.win32.join(home, '.asight', 'collector'), home, env: {}, fs, save: () => {}, note: () => {}, failure: (x) => failures.push(x), state: () => {} })
  assert.equal(refused.state, 'failed')
  assert.match(refused.reason, /never writes HTTPS_PROXY/)
  assert.deepEqual([manifest.entries.length, failures.length], [0, 1], 'zero entries, one honest failure record')
})

test('the plan\'s never rows are the real formatPlan\'s 「点名也不做」 lines (the CLI renders them; 1.6 §1.7)', async () => {
  const { formatPlan } = await import('../../../../src/cli/receipt.mjs')
  const text = formatPlan({ files: [], entries: [], optIn: [{ form: 'lab.cli', item: 'login-env-proxy', scope: 'never', admin: false, impact: 'x', note: 'asight never writes HTTPS_PROXY into the login environment', command: null, chosen: false, applicable: false, state: 'never' }] })
  assert.match(text, /lab\.cli: login-env-proxy 点名也不做 — asight never writes HTTPS_PROXY into the login environment/)
  assert.ok(!text.includes('点名: '), 'an explanation only — no command to name it with')
})
