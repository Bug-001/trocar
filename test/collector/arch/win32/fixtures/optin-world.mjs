// fixtures/optin-world.mjs — the fake Windows of the opt-in tests (plan Task 14; 4.8 s2.4). One injected `run` answers reg.exe, certutil,
// the WM_SETTINGCHANGE broadcast and the shortcut read, AND simulates the six fixed optin/*.ps1 scripts' own logic (write the base64 bytes,
// repoint the shortcut, add the certificate to the store) — against a sandbox HOME. The Windows half of the world lives under a
// Windows-shaped home (`C:\Users\alice`): a path-mapping fs wrapper carries every such path into the sandbox, so NOTHING a test writes can
// land outside it (a win32.join of a POSIX-absolute path loses the leading slash on a POSIX machine and would land in the CWD). A fixture,
// not a test: node --test counts it as one file with no tests of its own.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadIngressConfig } from '../../../../../src/collector/arch/win32/ingress-config.mjs'
import { loadHarnesses } from '../../../../../src/collector/harness/index.mjs'
import { groupsOf } from '../../../../../src/collector/arch/win32/route-plan.mjs'
import { MACHINE_PATH_KEY } from '../../../../../src/collector/arch/win32/elevate.mjs'
import { SAC_KEY } from '../../../../../src/collector/arch/win32/userpath.mjs'
import { createCa } from '../../../../../src/collector/core/tls/ca.mjs'
import { applyOptIn, checkEntries } from '../../../../../src/collector/arch/win32/optin.mjs'
import { tmpDir } from '../../../../helpers/tmp.mjs'

export const GROUPS = groupsOf(await loadHarnesses())
export const POLICY_KEY = 'HKCU\\SOFTWARE\\Policies\\Claude'
export const sha1Thumb = (pem) => crypto.createHash('sha1').update(new crypto.X509Certificate(pem).raw).digest('hex').toUpperCase()
const b64dec = (s) => Buffer.from(s, 'base64').toString('utf8')

/** The mapping fs: every path under `winHome` (either slash, any case) is carried into `sandbox` before it reaches the real fs — mixed
 *  separators included, because the harness data path.joins a win32-joined APPDATA on a POSIX machine. Every other path goes through
 *  untouched (the sandbox HOME's own POSIX paths, e.g. the backups under ~/.asight/backup, are real already). */
export function mappedFs(winHome, sandbox) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  const winRoot = norm(winHome).toLowerCase() + '/'
  const map = (p) => {
    const n = norm(p).toLowerCase()
    if (!n.startsWith(winRoot)) return p
    return path.join(sandbox, norm(p).slice(winHome.length + 1))
  }
  const wrap = {}
  const TWO_PATHS = new Set(['renameSync', 'copyFileSync']) // these take two paths; both must be carried into the sandbox
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'openSync', 'statSync', 'lstatSync', 'chmodSync', 'renameSync', 'unlinkSync']) {
    if (typeof fs[name] !== 'function') continue
    wrap[name] = TWO_PATHS.has(name) ? (a, b, ...rest) => fs[name](map(a), map(b), ...rest) : (p, ...a) => fs[name](map(p), ...a)
  }
  wrap.realpathSync = (p, ...a) => fs.realpathSync(map(p), ...a)
  return { ...fs, ...wrap, __map: map } // fd-based ops (writeSync on an open fd) need no mapping
}

/** One fake Windows: registry (reg.exe), certificate store (certutil), and the six fixed scripts. `declineCert` is the user clicking No on
 *  Windows' own confirmation box. Shortcut files are real files whose CONTENT is their target (the fake's WScript.Shell reads it back). */
export function fakeWin({ reg = {}, sac = 0, declineCert = false, fs: wfs = fs }) {
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
  const shortcutRead = (args) => { const m = /CreateShortcut\('(.*)'\)/.exec(args[args.length - 1]); if (!m) return null; try { return out(wfs.readFileSync(m[1], 'utf8')) } catch { return out('') } }
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
      if (args[0] === 'delete') { if (state[key]) delete state[key][args[args.indexOf('/v') + 1]]; return out('') }
    }
    if (file === 'certutil') {
      if (args.includes('-addstore')) { if (declineCert) return { status: 1, stdout: '', stderr: 'The user cancelled the certificate import.' }; store.add(sha1Thumb(wfs.readFileSync(args[args.length - 1], 'utf8'))); return out('') }
      if (args.includes('-store')) return store.has(args[args.length - 1]) ? out('matched') : { status: 1, stdout: '', stderr: 'not found' }
      if (args.includes('-delstore')) { store.delete(args[args.length - 1]); return out('') }
    }
    if (file === 'powershell') {
      if (args.includes('-File')) {
        const p = params(args)
        scripts.push(p)
        if (p.script === 'user-path.ps1') { wfs.mkdirSync(p.params['-BinDir'][0], { recursive: true }); wfs.writeFileSync(path.win32.join(p.params['-BinDir'][0], `${p.params['-Command'][0]}.cmd`), b64dec(p.params['-ShimB64'][0])); if (p.params['-MarkerName']) wfs.writeFileSync(path.win32.join(p.params['-BinDir'][0], p.params['-MarkerName'][0]), b64dec(p.params['-MarkerB64'][0])); return out('') }
        if (p.script === 'shortcut.ps1') { wfs.mkdirSync(path.win32.dirname(p.params['-Launcher'][0]), { recursive: true }); wfs.writeFileSync(p.params['-Launcher'][0], b64dec(p.params['-LauncherB64'][0])); for (const s of p.params['-Shortcut']) wfs.writeFileSync(s, p.params['-Launcher'][0]); return out('') }
        if (p.script === 'cert-user.ps1') { if (declineCert) return { status: 1, stdout: '', stderr: 'The user cancelled the certificate import.' }; store.add(sha1Thumb(wfs.readFileSync(p.params['-CertFile'][0], 'utf8'))); return out('') }
        if (p.script === 'claude-policy.ps1') { state[POLICY_KEY] = state[POLICY_KEY] || {}; state[POLICY_KEY].egressProxyUrl = { kind: 'REG_SZ', value: p.params['-Url'][0] }; return out('') }
        if (p.script === 'vscode.ps1') { wfs.mkdirSync(path.win32.dirname(p.params['-Settings'][0]), { recursive: true }); wfs.writeFileSync(p.params['-Settings'][0], b64dec(p.params['-SettingsB64'][0])); wfs.mkdirSync(path.win32.dirname(p.params['-Launcher'][0]), { recursive: true }); wfs.writeFileSync(p.params['-Launcher'][0], b64dec(p.params['-LauncherB64'][0])); for (const s of p.params['-Shortcut'] || []) wfs.writeFileSync(s, p.params['-Launcher'][0]); return out('') }
        if (p.script === 'zcode-desktop.ps1') { wfs.mkdirSync(path.win32.dirname(p.params['-File'][0]), { recursive: true }); wfs.writeFileSync(p.params['-File'][0], b64dec(p.params['-ContentB64'][0])); return out('') }
      }
      if (/SendMessageTimeout/.test(args[args.length - 1])) { broadcasts.push(1); return out('') }
      const lnk = shortcutRead(args)
      if (lnk) return lnk
    }
    return out('')
  }
  return { run, state, store, calls, broadcasts, scripts }
}

/** One sandbox with the world a user-level opt-in needs: the collector CA, a real ingress.json (through loadIngressConfig itself), the
 *  real binary on the user PATH, the shortcuts and settings files. `home` is the sandbox (real, POSIX, tmpDir-cleaned); `winHome` is the
 *  Windows-shaped home the apply sees — every path under it maps into the sandbox. */
export async function rig({ form, item, forms = null, over = {}, win = {} } = {}) {
  const home = tmpDir('asight-optin-apply-') // the sandbox: real files, cleaned by tmpDir
  const winHome = `C:\\Users\\alice${crypto.randomBytes(4).toString('hex')}` // a fresh Windows home per rig, no cross-rig path collisions
  const wfs = mappedFs(winHome, home)
  const dir = path.win32.join(winHome, '.asight', 'collector')
  const ca = createCa({ commonName: 'asight test CA' })
  wfs.mkdirSync(dir, { recursive: true }) // ingress.json is read back through path.join of this same string (mapped into the sandbox)
  wfs.mkdirSync(path.win32.join(dir, 'ca'), { recursive: true })
  wfs.writeFileSync(path.win32.join(dir, 'ca', 'asight-ca.pem'), ca.certPem)
  const g = GROUPS.find((x) => x.forms.some((f) => f.id === form))
  const ingress = await loadIngressConfig({ dir, groups: (forms || [form]).map((f) => GROUPS.find((x) => x.forms.some((y) => y.id === f)).g), isFree: async () => true, random: (n) => crypto.randomBytes(n), fs: wfs })
  const env = { APPDATA: path.win32.join(winHome, 'AppData', 'Roaming'), USERPROFILE: winHome }
  const npmDir = path.win32.join(winHome, 'npm')
  const w = fakeWin({ reg: { userPath: win.userPath ?? npmDir, policy: win.policy ?? null, machinePath: win.machinePath }, sac: win.sac ?? 0, declineCert: win.declineCert ?? false, fs: wfs })
  const manifest = { entries: [] }
  const notes = [], events = [], failures = []
  const deps = { run: w.run, sac: () => (win.sac === null ? 'off' : win.sac === 1 ? 'on' : win.sac === 2 ? 'evaluation' : 'off'), ...over.deps }
  const applyAs = (f, i) => { const gg = GROUPS.find((x) => x.forms.some((y) => y.id === f)); return applyOptIn({ row: { form: f, harness: gg.harness, item: i, kinds: [], scope: 'user', admin: false, chosen: true, applicable: true, state: 'needed' }, groups: GROUPS, manifest, dir, home: winHome, env, fs: wfs, deps, save: () => {}, note: (r) => notes.push(r), failure: (r) => failures.push(r), state: (r) => events.push(r) }) }
  const apply = () => applyAs(form, item)
  /** checkEntries over this rig's world (the manifest the apply filled, the fake registry / store / scripts behind `w.run`): `procs` is the
   *  process table the agents half sees; `over.deps` rides checkEntries' own deps. */
  const check = (procs = [], over = {}) => checkEntries({ groups: GROUPS, manifest, procs, deps: { run: w.run, env, fs: wfs, ...(over.deps || {}) } })
  return { home, winHome, dir, ca, g, ingress, env, w, wfs, manifest, notes, events, failures, deps, apply, applyAs, check }
}
export const nativeKimi = (r) => { const p = path.win32.join(r.winHome, '.kimi-code', 'bin', 'kimi.exe'); r.wfs.mkdirSync(path.win32.dirname(p), { recursive: true }); r.wfs.writeFileSync(p, 'exe') }
/** The real `<command>.cmd` on the user PATH (npm style): `<winHome>\npm\<command>.cmd`, the directory made. */
export const realCmd = (r, command, text = 'x') => { const d = path.win32.join(r.winHome, 'npm'); r.wfs.mkdirSync(d, { recursive: true }); r.wfs.writeFileSync(path.win32.join(d, `${command}.cmd`), text) }
export const writeShortcut = (r, p, target) => { r.wfs.mkdirSync(path.win32.dirname(p), { recursive: true }); r.wfs.writeFileSync(p, target) }
