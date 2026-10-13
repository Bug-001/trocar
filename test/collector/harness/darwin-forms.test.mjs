// test/collector/harness/darwin-forms.test.mjs — the macOS forms of the harnesses (RFC 4.9 §2.3 · §2.4; the group table and the entry gate inherit 4.8 §2.3 · §2.4, acceptance W23).
// A form is the unit of an entry group, an opt-in item and a matrix row; which process is a harness is the name list's (D51), tested on the presets in
// test/collector/core/. Here the REAL darwin data is: groups, forms, entries, the proxy export. The darwin port of test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { entryGate } from '../../../src/collector/arch/darwin/forms.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const MAC = Object.fromEntries(ALL.filter((d) => d.darwin).map((d) => [d.name, d.darwin]))
const formsOf = () => Object.values(MAC).flatMap((w) => w.forms)
const groupsOf = () => Object.values(MAC).flatMap((w) => w.groups)

// ── what 4.9 §2.3 says each harness has: its groups (form lists) and its forms — whether the user must name one, and which are listed unmeasured. Which PROCESS is a
// harness is the name list's (D51, the base descriptors' `processes`; test/collector/core/identity-presets.test.mjs), never a form's ──
const EXPECT = {
  'claude-code': {
    groups: { 'claude-code.settings': ['claude-code.native', 'claude-code.cli', 'claude-code.vscode'], 'claude-code.desktop': ['claude-code.desktop'] },
    forms: { 'claude-code.native': {}, 'claude-code.cli': {}, 'claude-code.vscode': {}, 'claude-code.desktop': { optIn: true } },
  },
  'codex': {
    groups: { 'codex.env': ['codex.cli', 'codex.vscode'] },
    forms: { 'codex.cli': {}, 'codex.vscode': {}, 'codex.app': { unmeasured: true } }, // the desktop app's codex (4.6 OPEN ①)
  },
  'opencode': {
    groups: { 'opencode.cli': ['opencode.cli', 'opencode.desktop'] },
    forms: { 'opencode.cli': { optIn: true }, 'opencode.desktop': { optIn: true } },
  },
  'deepseek-dsh': {
    groups: { 'deepseek-dsh.env': ['deepseek-dsh.cli'], 'deepseek-dsh.desktop': ['deepseek-dsh.desktop'] },
    forms: { 'deepseek-dsh.cli': {}, 'deepseek-dsh.desktop': { optIn: true } },
  },
  'hermes': {
    groups: { 'hermes.cli': ['hermes.cli'] },
    forms: { 'hermes.cli': {}, 'hermes.desktop': { unmeasured: true } },
  },
  'kimi-code': {
    groups: { 'kimi-code.cli': ['kimi-code.cli'] },
    forms: { 'kimi-code.cli': { optIn: true }, 'kimi-code.vscode': { unmeasured: true } }, // the VS Code extension (4.6 OPEN ⑦'s darwin half)
  },
  'z-code': {
    groups: { 'z-code.cli': ['z-code.cli', 'z-code.desktop'] },
    forms: { 'z-code.cli': {}, 'z-code.desktop': {} },
  },
}

test('all seven harnesses have macOS data, and the table above covers every one of them', () => {
  const seven = ['claude-code', 'codex', 'deepseek-dsh', 'hermes', 'kimi-code', 'opencode', 'z-code']
  assert.deepEqual(Object.keys(MAC).sort(), seven)
  assert.deepEqual(Object.keys(EXPECT).sort(), seven)
  assert.equal(formsOf().length, 17, 'the 17 forms the darwin data carries (claude-code.native is the version-named file\'s path-only shape; dsh\'s desktop is the dmg app, measured 2026-10-12; the five unmeasured ones are listed so status says unknown · not measured)')
})

test('loadHarnesses attaches darwin/<name>.mjs as desc.darwin, skips the darwin directory and its helpers, and leaves a harness without macOS data as it was', async () => {
  const dir = tmpDir('asight-load-')
  fs.mkdirSync(path.join(dir, 'darwin'))
  // a descriptor owes `asight status` / `doctor` its `proxy` export (1.6 §9.7): loadHarnesses checks the shape, so a stub has one
  const proxy = { env: ['HTTPS_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: {}, branches: ['all'], measured: { win32: 'inferred', linux: 'inferred', darwin: 'inferred' }, restart: { hint: 'restart it', processes: 'the stub' } }
  const desc = (n) => `export default { name: ${JSON.stringify(n)}, proxy: ${JSON.stringify(proxy)} }\n`
  for (const n of ['one', 'two']) fs.writeFileSync(path.join(dir, `${n}.mjs`), desc(n))
  fs.writeFileSync(path.join(dir, 'darwin', 'one.mjs'), 'export default { forms: [] }\n')
  fs.writeFileSync(path.join(dir, 'darwin', '_paths.mjs'), 'export default { notAHarness: true }\n')
  fs.writeFileSync(path.join(dir, 'darwin', 'three.mjs'), 'export default { orphan: true }\n') // macOS data of a harness that is not there
  const got = await loadHarnesses(new URL(`file://${dir}/`))
  assert.deepEqual(got.map((d) => d.name), ['one', 'two'])
  assert.deepEqual(got[0].darwin, { forms: [] })
  assert.ok(!('darwin' in got[1]), 'no data file, no property')
  const none = tmpDir('asight-load-')
  fs.writeFileSync(path.join(none, 'only.mjs'), desc('only'))
  assert.deepEqual((await loadHarnesses(new URL(`file://${none}/`))).map((d) => d.name), ['only'], 'no darwin directory at all')
})

test('every darwin data file has the shape the later tasks read: groups, forms, trust injection, the proxy export; ids and the group table are consistent', () => {
  assert.ok(Object.keys(MAC).length > 0)
  for (const [h, w] of Object.entries(MAC)) {
    assert.equal(typeof w.inject, 'function', `${h}: inject(ctx) gives the trust entries`)
    assert.ok(Array.isArray(w.groups) && w.groups.length && Array.isArray(w.forms) && w.forms.length, h)
    const gids = new Set()
    for (const g of w.groups) {
      assert.ok(!gids.has(g.g), `${h}: group ${g.g} once`)
      gids.add(g.g)
      assert.match(g.g, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${g.g}: a group id is a Basic user name and a probe path: no colon, no space`)
      assert.ok(g.g.startsWith(`${h}.`), `${g.g}: named after its harness`)
      assert.ok(g.proxyEntry && ['file', 'shim', 'launcher', 'unmeasured'].includes(g.proxyEntry.kind), `${g.g}: a known darwin entry kind ('launcher' is Claude Desktop's measured door, 4.9 §6.4; 'unmeasured' is the honest marker of a proxy door nobody has measured)`)
      assert.equal(typeof g.auth, 'boolean', `${g.g}: auth`)
      assert.ok(g.followsSystemProxy && [true, false, 'unknown'].includes(g.followsSystemProxy.http) && [true, false, 'unknown'].includes(g.followsSystemProxy.ws), `${g.g}: followsSystemProxy (1.6 §9.7's third value 'unknown' is a darwin cell)`)
      const automatic = g.proxyEntry.kind === 'file'
      if (automatic) { // what proxyEntries() reads: the files the agent reads, and either one JSON key or the variables of a dotenv block
        assert.equal(typeof g.proxyEntry.files, 'function', `${g.g}: files(ctx)`)
        if (g.proxyEntry.format === 'json-key') assert.ok(Array.isArray(g.proxyEntry.key) && g.proxyEntry.key.every((k) => typeof k === 'string'), `${g.g}: key`)
        else assert.deepEqual([g.proxyEntry.format, typeof g.proxyEntry.block.urlVar, typeof g.proxyEntry.block.fixed], ['dotenv-block', 'string', 'object'], `${g.g}: block`)
      }
      assert.equal(!!(g.optIn && g.optIn.length), !automatic, `${g.g}: only a file entry is automatic; every other kind is named by the user (4.8 §2.4 · 4.9 §2.4)`)
      for (const o of g.optIn || []) assert.ok(o.item && ['user', 'machine'].includes(o.scope) && typeof o.impact === 'string' && o.impact.length > 20, `${g.g}: an opt-in item says what it is, its scope and its impact`)
    }
    const ids = new Set()
    for (const f of w.forms) {
      assert.ok(!ids.has(f.id), `${f.id} once`)
      ids.add(f.id)
      assert.ok(f.id.startsWith(`${h}.`), f.id)
      if (f.supported !== true) { // a form nobody could install: listed so status says "unknown · not measured", with no group (4.8 §2.3, §6.4; the darwin rows 4.6 OPEN ① ② ⑥ ⑦)
        assert.deepEqual([f.supported, f.g], [{ reason: 'not-measured' }, null], f.id)
        continue
      }
      assert.ok(gids.has(f.g), `${f.id}: its group ${f.g} exists`)
    }
    const proxy = w.proxy
    assert.deepEqual(Object.keys(proxy).sort(), ['branches', 'env', 'files', 'measured', 'restart', 'schemes', 'systemProxy', 'unsupported'], `${h}: the proxy export has the 1.6 §9.7 fields`)
    // cc and codex measured live on macOS (the 4.9 smoke: the trust door written, the agent's CONNECT through the pinned kernel, the decrypted flow row); kimi's env
    // door measured 2026-10-12 (kimi 2.1.1 darwin: HTTPS_PROXY at spawn moves the client — CONNECT with Basic proxy-authorization, the credentialed door URL honored);
    // the other four still ride the Linux/Windows labs' rows read through the darwin doors — nothing more of them is measured on macOS (MA4)
    assert.deepEqual(proxy.measured, { darwin: h === 'claude-code' || h === 'codex' || h === 'kimi-code' ? 'lab' : 'inferred' }, `${h}: measured on macOS only where the lab smoke ran it`)
  }
})

test('the group table: the one shared group holds its forms, the env groups of codex and dsh hold their measured forms (an unmeasured form has no group)', () => {
  const shared = { 'claude-code.settings': ['claude-code.native', 'claude-code.cli', 'claude-code.vscode'], 'codex.env': ['codex.cli', 'codex.vscode'], 'deepseek-dsh.env': ['deepseek-dsh.cli'], 'deepseek-dsh.desktop': ['deepseek-dsh.desktop'], 'z-code.cli': ['z-code.cli', 'z-code.desktop'], 'opencode.cli': ['opencode.cli', 'opencode.desktop'] }
  for (const [h, w] of Object.entries(MAC)) {
    for (const g of w.groups) {
      const members = w.forms.filter((f) => f.g === g.g).map((f) => f.id)
      assert.deepEqual(members, shared[g.g] || [g.g], `${g.g}: its forms`)
      assert.ok(members.length >= 1)
    }
    assert.deepEqual(Object.fromEntries(w.groups.map((g) => [g.g, w.forms.filter((f) => f.g === g.g).map((f) => f.id)])), EXPECT[h].groups, `${h}: the table of 4.9 §2.3`)
  }
})

test('the forms of 4.9 §2.3: each harness lists exactly these, an unmeasured one says so, and a form needs naming exactly when its group has an opt-in item', () => {
  for (const [h, e] of Object.entries(EXPECT)) {
    assert.deepEqual(MAC[h].forms.map((f) => f.id).sort(), Object.keys(e.forms).sort(), `${h}: the forms of 4.9 §2.3`)
    for (const [id, row] of Object.entries(e.forms)) {
      const f = MAC[h].forms.find((x) => x.id === id)
      if (row.unmeasured) { assert.equal(f.supported.reason, 'not-measured', id); continue }
      assert.equal(!!(MAC[h].groups.find((g) => g.g === f.g).optIn || []).length, !!row.optIn, `${id}: whether the user must name it`)
    }
  }
})

test('no darwin form carries a host set (the Kimi extension that has one on Windows — the editor it lives in — is not measured on macOS, 4.6 OPEN ⑦)', () => {
  assert.deepEqual(formsOf().filter((f) => f.hosts).map((f) => f.id), [], 'a host tree is only the editor Kimi lives in on Windows (4.8 §3.5); on macOS no measured form has one')
})

test('W23: a form that needs naming has an opt-in item and no automatic entry; the Claude Desktop shell takes no credentialed upstream (no door is measured that could carry one, so it must not sit on one)', () => {
  const desktop = groupsOf().find((g) => g.g === 'claude-code.desktop')
  assert.deepEqual(entryGate(desktop), { ok: false, reason: 'opt-in-needed' })
  assert.deepEqual(entryGate(desktop, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(desktop, { optedIn: true, upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' }, 'no measured door could carry the listener\'s credentials, and a port without credentials is open to every process of the machine (4.8 §3.2 · 4.9 §6.4)')
  assert.equal(desktop.auth, false)
  for (const g of groupsOf().filter((x) => !(x.optIn && x.optIn.length))) assert.deepEqual(entryGate(g), { ok: true }, g.g)
})

// ── the data Tasks 6b, 8 and 10 read, pinned to 4.9 §2.3 (the darwin rows of the 「跟随系统代理」 and entry columns), §2.4 (the opt-in items) and to the CLI plan's proxy table (T13, 1.6 §9.7) ──
// A shape check (above) cannot tell `followsSystemProxy.http: true` from `false` — or from darwin's 'unknown': this table can, so a flipped cell is red. Every cell is a row of one of those tables.
const GROUPS = {
  // [follows system proxy http, ws] · noProxyKey · auth · the entry (4.9 §2.3; the entry shapes are 4.8 §2.3's, plus darwin's 'unmeasured')
  'claude-code.settings': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['env', 'HTTPS_PROXY'] } },
  'claude-code.desktop': { follows: [true, true], auth: false, entry: { kind: 'launcher' } }, // measured 2026-10-12 (4.9 §6.4): the Chromium network service follows the system proxy, and the door is the named launcher
  'codex.env': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'opencode.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'opencode' } },
  'kimi-code.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'kimi' } },
  'deepseek-dsh.env': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: {} } } },
  'deepseek-dsh.desktop': { follows: ['unknown', 'unknown'], auth: false, entry: { kind: 'launcher' } }, // the dmg app, measured 2026-10-12: .env is not its door (launcher keys fatal, proxy keys ignored), Chromium's --proxy-server at a credential-less launcher is — the Claude Desktop §6.4 shape; whether it follows the SYSTEM proxy is unmeasured
  'hermes.cli': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'z-code.cli': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['network', 'httpProxy'] } },
}
const OPT_IN = { // 4.8 §2.4 · 4.9 §2.4 · §6.4: the item, its scope, and when a machine-level item applies; an automatic group has none. v1 macOS has no machine-level item at all (4.9 §2.4: the win32 dispatcher items have no macOS counterpart; the two launcher items are Claude Desktop's measured door and dsh's, §6.4's shape measured 2026-10-12)
  'claude-code.desktop': [['keychain-login', 'user'], ['desktop-launcher', 'user']],
  'deepseek-dsh.desktop': [['desktop-launcher', 'user']],
  'opencode.cli': [['user-path-shim', 'user']],
  'kimi-code.cli': [['user-path-shim', 'user']],
}
// the `proxy` export per harness (CLI plan T13): system proxy, the schemes the agent takes, what it does with a SOCKS proxy, which branches follow the entry
const PROXY_EXPORT = {
  'claude-code': { env: ['HTTPS_PROXY', 'HTTP_PROXY'], files: [{ path: '~/.claude/settings.json', key: 'env.HTTPS_PROXY', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'codex': { env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'], files: [{ path: '$CODEX_HOME/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['http', 'ws'] },
  'opencode': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'kimi-code': { env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'deepseek-dsh': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: '~/.dsh/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['all'] },
  'hermes': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: '~/.hermes/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'z-code': { env: ['ZCODE_HTTP_PROXY'], files: [{ path: '~/.zcode/cli/config.json', key: 'network.httpProxy', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5h'], unsupported: {}, branches: ['all'] },
}

test('the groups, cell by cell: follows the system proxy (HTTP / WebSocket, or not known yet), the no-proxy key, credentials, the entry itself, and the opt-in items with their scope — as 4.9 §2.3 and §2.4 say', () => {
  assert.deepEqual(groupsOf().map((g) => g.g).sort(), Object.keys(GROUPS).sort(), 'every group of the table, no other')
  for (const g of groupsOf()) {
    const want = GROUPS[g.g]
    assert.deepEqual([g.followsSystemProxy.http, g.followsSystemProxy.ws], want.follows, `${g.g}: follows the system proxy (http, ws)`)
    assert.equal(g.noProxyKey, want.noProxyKey, `${g.g}: the key of the user's own bypass list`)
    assert.equal(g.auth, want.auth, `${g.g}: takes credentials`)
    const { files, file, ...entry } = g.proxyEntry // the file locations are asserted by the tests below, with a home to resolve them against
    assert.deepEqual(entry, want.entry, `${g.g}: the entry`)
    assert.deepEqual((g.optIn || []).map((o) => [o.item, o.scope, ...(o.when ? [o.when] : [])]), OPT_IN[g.g] || [], `${g.g}: the items the user must name`)
    for (const o of g.optIn || []) if (o.scope === 'machine') assert.match(o.impact, /administrator/i, `${g.g}/${o.item}: a machine-level item says it needs the administrator`)
  }
})

test('the proxy export of each harness is 4.9 §2.3 and the CLI plan\'s proxy table, value by value (system proxy, schemes, SOCKS behaviour, branches, where the setting is read from)', () => {
  assert.deepEqual(Object.keys(MAC).sort(), Object.keys(PROXY_EXPORT).sort())
  for (const [h, w] of Object.entries(MAC)) {
    const { env, files, systemProxy, schemes, unsupported, branches } = w.proxy
    assert.deepEqual({ env, files, systemProxy, schemes, unsupported, branches }, PROXY_EXPORT[h], h)
  }
  // the group's own cell and the harness's row agree where the harness has one form class (Claude Code's desktop shell is the one apart, as its own group: its cell is the measured Chromium one, 4.9 §6.4)
  for (const [h, w] of Object.entries(MAC)) for (const g of w.groups.filter((x) => !x.g.endsWith('.desktop') || h === 'hermes')) {
    if (g.proxyEntry.kind === 'app-setting' || g.proxyEntry.kind === 'policy') continue
    assert.deepEqual([g.followsSystemProxy.http, g.followsSystemProxy.ws], [w.proxy.systemProxy.http, w.proxy.systemProxy.ws], `${g.g}: the group's cell is the harness's row`)
  }
})

// ── where each entry lives, and that the proxy entry and the trust entry go to the same files ──
function world(...sub) {
  const home = path.join(tmpDir('asight-pe-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const mk = (rel, text = '') => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const ctx = (env = {}) => ({
    os: 'darwin', home, env: new Map(Object.entries(env)), running: [], collectorDir: path.join(home, '.asight', 'collector'), caPem: path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'),
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' ? null : { code: e.code, message: e.message } } } },
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
  })
  return { home, mk, ctx }
}
const groupOf = (h, g) => MAC[h].groups.find((x) => x.g === g)

test('a group\'s proxy entry goes into the files its trust entry does (Claude Code, Codex, Hermes, Z-Code), wherever the agent\'s home was moved to: CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME; dsh\'s trust entry is a patch row, so its .env is its own', () => {
  const w = world('John Smith')
  const cfg = path.join(w.home, 'D', 'claude-cfg')
  w.mk('.codex/x'); w.mk('D/codex-home/x'); w.mk('.hermes/profiles/work/config.yaml', 'x: 1\n'); w.mk('D/hermes/profiles/alt/config.yaml', 'x: 1\n'); w.mk('.zcode/cli/config.json', '{}')
  const trustFiles = (h, ctx) => (MAC[h].inject(ctx).entries || []).map((e) => e.path)
  const same = (h, g, env, expect) => {
    const ctx = w.ctx(env)
    const got = groupOf(h, g).proxyEntry.files(ctx)
    assert.deepEqual(got, trustFiles(h, ctx), `${g} ${JSON.stringify(env)}: the proxy entry's files are the trust entry's`)
    assert.deepEqual(got, expect, `${g} ${JSON.stringify(env)}: the files`)
  }
  same('claude-code', 'claude-code.settings', {}, [path.join(w.home, '.claude', 'settings.json')])
  same('claude-code', 'claude-code.settings', { CLAUDE_CONFIG_DIR: cfg }, [path.join(cfg, 'settings.json')])
  same('codex', 'codex.env', {}, [path.join(w.home, '.codex', '.env')])
  same('codex', 'codex.env', { CODEX_HOME: path.join(w.home, 'D', 'codex-home') }, [path.join(w.home, '.codex', '.env'), path.join(w.home, 'D', 'codex-home', '.env')])
  same('hermes', 'hermes.cli', {}, [path.join(w.home, '.hermes', '.env'), path.join(w.home, '.hermes', 'profiles', 'work', '.env')])
  same('hermes', 'hermes.cli', { HERMES_HOME: path.join(w.home, 'D', 'hermes', 'profiles', 'alt') }, [path.join(w.home, 'D', 'hermes', '.env'), path.join(w.home, 'D', 'hermes', 'profiles', 'alt', '.env')])
  same('z-code', 'z-code.cli', {}, [path.join(w.home, '.zcode', 'cli', 'config.json')])
  assert.deepEqual(groupOf('z-code', 'z-code.cli').proxyEntry.files(world().ctx()), [], 'Z-Code has not run for this user: no file')
  const dsh = groupOf('deepseek-dsh', 'deepseek-dsh.env').proxyEntry
  assert.deepEqual(dsh.files(w.ctx()), [path.join(w.home, '.dsh', '.env')])
  assert.deepEqual(dsh.files(w.ctx({ DSH_HOME: path.join(w.home, 'D', 'dsh') })), [path.join(w.home, 'D', 'dsh', '.env')], 'DSH_HOME moves the .env with the patch file: one home')
  assert.deepEqual((MAC['deepseek-dsh'].inject(w.ctx({ DSH_HOME: path.join(w.home, 'D', 'dsh') })).entries || []).map((e) => e.path), [path.join(w.home, 'D', 'dsh', 'cordis.patch.yml')], 'the trust entry — the patch row that loads the plugin — moves with it')
  // the darwin delta of Hermes (4.9 §2.3): an OpenAI wire-format route's ssl_ca_cert line in config.yaml is a trust entry of that route, not a proxy door — the proxy files stay the .env files
  const rw = world('Jane Doe')
  rw.mk('.hermes/profiles/work/config.yaml', 'providers:\n  relay:\n    api_mode: chat_completions\n    base_url: https://relay.example.com/v1\n')
  const rctx = rw.ctx()
  assert.deepEqual(groupOf('hermes', 'hermes.cli').proxyEntry.files(rctx), [path.join(rw.home, '.hermes', '.env'), path.join(rw.home, '.hermes', 'profiles', 'work', '.env')], 'the proxy entry never points at config.yaml')
  assert.ok(MAC.hermes.inject(rctx).entries.some((e) => e.format === 'line' && e.path === path.join(rw.home, '.hermes', 'profiles', 'work', 'config.yaml')), 'the chat_completions route itself gets its ssl_ca_cert trust line')
})

test('no darwin group is an app-setting or a policy entry, and the TWO launchers are Claude Desktop\'s and the dsh desktop\'s measured doors: every form that would carry another (the Kimi extension, the Codex app) is not measured on macOS, so it has no group and nothing of it is ever located or written (the Z-Code desktop is measured now — 2026-10-13, the app-server Helper — and shares the CLI\'s group, whose config door is its trust door; so is the OpenCode desktop — its bundled core, the same env door and plugin the CLI has)', () => {
  assert.deepEqual(groupsOf().map((g) => g.proxyEntry.kind).sort(), ['file', 'file', 'file', 'file', 'file', 'launcher', 'launcher', 'shim', 'shim'], 'the darwin entry kinds: five files, two shims, two launchers — Claude Desktop\'s door (measured 2026-10-12, 4.9 §6.4) and the dsh desktop\'s (the dmg app, measured 2026-10-12: .env is not its door)')
  assert.deepEqual(groupsOf().filter((g) => g.proxyEntry.kind === 'launcher').map((g) => g.g), ['claude-code.desktop', 'deepseek-dsh.desktop'], 'the launcher groups are exactly the two desktops')
  for (const id of ['codex.app', 'hermes.desktop', 'kimi-code.vscode']) {
    const f = formsOf().find((x) => x.id === id)
    assert.equal(f.supported.reason, 'not-measured', id)
    assert.equal(f.g, null, `${id}: no group, so there is no entry of it to locate`)
  }
})

