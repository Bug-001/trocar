// test/collector/harness/win32-forms.test.mjs — the Windows forms of the harnesses (RFC 4.8 §2.3 · §2.4 · §3; acceptance W23). A form is the unit of an entry group,
// an opt-in item and a matrix row; which process is a harness is the name list's (D51), tested on the presets in test/collector/core/. Here the REAL data is.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { entryGate } from '../../../src/collector/core/entry-forms.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import eighth from './fixtures/eighth.mjs'

const raw = String.raw
const U = raw`C:\Users\u`
const ALL = await loadHarnesses()
const WIN = Object.fromEntries(ALL.filter((d) => d.win32).map((d) => [d.name, d.win32]))
const formsOf = () => Object.values(WIN).flatMap((w) => w.forms)
const groupsOf = () => Object.values(WIN).flatMap((w) => w.groups)

// ── what 4.8 §2.3 says each harness has: its groups (form lists) and its forms — whether the user must name one, and which are listed unmeasured. Which PROCESS is a
// harness is the name list's (D51, the base descriptors' `processes`; test/collector/core/identity-presets.test.mjs), never a form's ──
const EXPECT = {
  'claude-code': {
    groups: { 'claude-code.settings': ['claude-code.cli', 'claude-code.vscode'], 'claude-code.desktop': ['claude-code.desktop'] },
    forms: { 'claude-code.cli': {}, 'claude-code.vscode': {}, 'claude-code.desktop': { optIn: true } },
  },
  'codex': {
    groups: { 'codex.env': ['codex.cli', 'codex.vscode', 'codex.app'] },
    forms: { 'codex.cli': {}, 'codex.vscode': {}, 'codex.app': {} },
  },
  'opencode': {
    groups: { 'opencode.cli': ['opencode.cli'], 'opencode.desktop': ['opencode.desktop'] },
    forms: { 'opencode.cli': { optIn: true }, 'opencode.desktop': { optIn: true } },
  },
  'deepseek-dsh': {
    groups: { 'deepseek-dsh.env': ['deepseek-dsh.cli', 'deepseek-dsh.desktop'] },
    forms: { 'deepseek-dsh.cli': {}, 'deepseek-dsh.desktop': {} },
  },
  'hermes': {
    groups: { 'hermes.cli': ['hermes.cli'] },
    forms: { 'hermes.cli': {}, 'hermes.desktop': { unmeasured: true } },
  },
  'kimi-code': {
    groups: { 'kimi-code.cli': ['kimi-code.cli'], 'kimi-code.vscode': ['kimi-code.vscode'] },
    forms: { 'kimi-code.cli': { optIn: true }, 'kimi-code.vscode': { optIn: true } }, // the host program Code.exe: named by hosts.processes at the door (D51)
  },
  'z-code': {
    groups: { 'z-code.cli': ['z-code.cli'], 'z-code.desktop': ['z-code.desktop'] },
    forms: { 'z-code.cli': {}, 'z-code.desktop': { optIn: true } },
  },
}

test('all seven harnesses have Windows data, and the table above covers every one of them', () => {
  const seven = ['claude-code', 'codex', 'deepseek-dsh', 'hermes', 'kimi-code', 'opencode', 'z-code']
  assert.deepEqual(Object.keys(WIN).sort(), seven)
  assert.deepEqual(Object.keys(EXPECT).sort(), seven)
  assert.equal(formsOf().length, 16, 'the 16 forms of 4.8 §2.3 (hermes.desktop among them, unmeasured)')
})

test('loadHarnesses attaches win32/<name>.mjs as desc.win32, skips the win32 directory and its helpers, and leaves a harness without Windows data as it was', async () => {
  const dir = tmpDir('asight-load-')
  fs.mkdirSync(path.join(dir, 'win32'))
  // a descriptor owes `asight status` / `doctor` its `proxy` export (1.6 §9.7): loadHarnesses checks the shape, so a stub has one
  const proxy = { env: ['HTTPS_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: {}, branches: ['all'], measured: { win32: 'inferred', linux: 'inferred', darwin: 'inferred' }, restart: { hint: 'restart it', processes: 'the stub' } }
  const desc = (n) => `export default { name: ${JSON.stringify(n)}, proxy: ${JSON.stringify(proxy)}, proxyMode: ${JSON.stringify(eighth.proxyMode)} }\n` // and its proxyMode (spec 4.11 §2.3): CM27's data-only fixture
  for (const n of ['one', 'two']) fs.writeFileSync(path.join(dir, `${n}.mjs`), desc(n))
  fs.writeFileSync(path.join(dir, 'win32', 'one.mjs'), 'export default { forms: [] }\n')
  fs.writeFileSync(path.join(dir, 'win32', '_paths.mjs'), 'export default { notAHarness: true }\n')
  fs.writeFileSync(path.join(dir, 'win32', 'three.mjs'), 'export default { orphan: true }\n') // Windows data of a harness that is not there
  const got = await loadHarnesses(new URL(`file://${dir}/`))
  assert.deepEqual(got.map((d) => d.name), ['one', 'two'])
  assert.deepEqual(got[0].win32, { forms: [] })
  assert.ok(!('win32' in got[1]), 'no data file, no property')
  const none = tmpDir('asight-load-')
  fs.writeFileSync(path.join(none, 'only.mjs'), desc('only'))
  assert.deepEqual((await loadHarnesses(new URL(`file://${none}/`))).map((d) => d.name), ['only'], 'no win32 directory at all')
})

test('every win32 data file has the shape the later tasks read: groups, forms, trust injection, the proxy export; ids and the group table are consistent', () => {
  assert.ok(Object.keys(WIN).length > 0)
  for (const [h, w] of Object.entries(WIN)) {
    assert.equal(typeof w.inject, 'function', `${h}: inject(ctx) gives the trust entries`)
    assert.ok(Array.isArray(w.groups) && w.groups.length && Array.isArray(w.forms) && w.forms.length, h)
    const gids = new Set()
    for (const g of w.groups) {
      assert.ok(!gids.has(g.g), `${h}: group ${g.g} once`)
      gids.add(g.g)
      assert.match(g.g, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${g.g}: a group id is a Basic user name and a probe path: no colon, no space`)
      assert.ok(g.g.startsWith(`${h}.`), `${g.g}: named after its harness`)
      assert.ok(g.proxyEntry && ['file', 'policy', 'shim', 'launcher', 'app-setting'].includes(g.proxyEntry.kind), `${g.g}: a known entry kind`)
      assert.equal(typeof g.auth, 'boolean', `${g.g}: auth`)
      assert.ok(g.followsSystemProxy && typeof g.followsSystemProxy.http === 'boolean' && typeof g.followsSystemProxy.ws === 'boolean', `${g.g}: followsSystemProxy`)
      const automatic = g.proxyEntry.kind === 'file'
      if (automatic) { // what proxyEntries() reads: the files the agent reads, and either one JSON key or the variables of a dotenv block
        assert.equal(typeof g.proxyEntry.files, 'function', `${g.g}: files(ctx)`)
        if (g.proxyEntry.format === 'json-key') assert.ok(Array.isArray(g.proxyEntry.key) && g.proxyEntry.key.every((k) => typeof k === 'string'), `${g.g}: key`)
        else assert.deepEqual([g.proxyEntry.format, typeof g.proxyEntry.block.urlVar, typeof g.proxyEntry.block.fixed], ['dotenv-block', 'string', 'object'], `${g.g}: block`)
      }
      assert.equal(!!(g.optIn && g.optIn.length), !automatic, `${g.g}: only a file entry is automatic; every other kind is named by the user (4.8 §2.4)`)
      for (const o of g.optIn || []) assert.ok(o.item && ['user', 'machine'].includes(o.scope) && typeof o.impact === 'string' && o.impact.length > 20, `${g.g}: an opt-in item says what it is, its scope and its impact`)
    }
    const ids = new Set()
    for (const f of w.forms) {
      assert.ok(!ids.has(f.id), `${f.id} once`)
      ids.add(f.id)
      assert.ok(f.id.startsWith(`${h}.`), f.id)
      assert.deepEqual(Object.keys(f).filter((k) => !['id', 'g', 'supported', 'hosts'].includes(k)), [], `${f.id}: a form keeps only id · g · supported · hosts (D51: no identity data)`)
      if (f.supported !== true) { // a form nobody could install: listed so status says "unknown · not measured", with no group (4.8 §2.3, §6.4)
        assert.deepEqual([f.supported, f.g], [{ reason: 'not-measured' }, null], f.id)
        continue
      }
      assert.ok(gids.has(f.g), `${f.id}: its group ${f.g} exists`)
      if (f.hosts) assert.ok(Array.isArray(f.hosts.processes) && f.hosts.processes.length > 0 && f.hosts.processes.every((n) => n === n.toLowerCase() && !/[\\/.]/.test(n)), `${f.id}: hosts.processes are normalized names (Code.exe → code)`)
    }
    const proxy = w.proxy
    assert.deepEqual(Object.keys(proxy).sort(), ['branches', 'env', 'files', 'measured', 'restart', 'schemes', 'systemProxy', 'unsupported'], `${h}: the proxy export has the 1.6 §9.7 fields`)
    assert.deepEqual(proxy.measured, { win32: 'lab' })
  }
})

test('the group table: the three shared groups hold their forms, every other form is its own group', () => {
  const shared = { 'claude-code.settings': ['claude-code.cli', 'claude-code.vscode'], 'codex.env': ['codex.cli', 'codex.vscode', 'codex.app'], 'deepseek-dsh.env': ['deepseek-dsh.cli', 'deepseek-dsh.desktop'] }
  for (const [h, w] of Object.entries(WIN)) {
    for (const g of w.groups) {
      const members = w.forms.filter((f) => f.g === g.g).map((f) => f.id)
      assert.deepEqual(members, shared[g.g] || [g.g], `${g.g}: its forms`)
      assert.ok(members.length >= 1)
    }
    assert.deepEqual(Object.fromEntries(w.groups.map((g) => [g.g, w.forms.filter((f) => f.g === g.g).map((f) => f.id)])), EXPECT[h].groups, `${h}: the table of 4.8 §2.3`)
  }
})

test('the forms of 4.8 §2.3: each harness lists exactly these, an unmeasured one says so, and a form needs naming exactly when its group has an opt-in item', () => {
  for (const [h, e] of Object.entries(EXPECT)) {
    assert.deepEqual(WIN[h].forms.map((f) => f.id).sort(), Object.keys(e.forms).sort(), `${h}: the forms of 4.8 §2.3`)
    for (const [id, row] of Object.entries(e.forms)) {
      const f = WIN[h].forms.find((x) => x.id === id)
      if (row.unmeasured) { assert.equal(f.supported.reason, 'not-measured', id); continue }
      assert.equal(!!(WIN[h].groups.find((g) => g.g === f.g).optIn || []).length, !!row.optIn, `${id}: whether the user must name it`)
    }
  }
})

test('only the Kimi extension has a host set, and its settings reader finds the base URLs in a config.toml', () => {
  const forms = formsOf()
  assert.deepEqual(forms.filter((f) => f.hosts).map((f) => f.id), ['kimi-code.vscode'], 'a host tree is only the editor Kimi lives in (4.8 §3); ZCode.exe is the agent\'s own process (OPEN 23)')
  const { hosts } = forms.find((f) => f.id === 'kimi-code.vscode')
  assert.deepEqual(hosts.defaults, ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn'])
  const ctx = (env = {}) => ({ home: U, env: new Map(Object.entries(env)) })
  assert.equal(hosts.settings.file(ctx()), path.join(U, '.kimi-code', 'config.toml'))
  assert.equal(hosts.settings.file(ctx({ KIMI_CODE_HOME: raw`D:\kimi` })), path.join(raw`D:\kimi`, 'config.toml'))
  const toml = '[providers.relay]\nbase_url = "https://relay.example.com/v1"\napi_key = "sk-secret"\n[services]\nweb = { base_url = \'http://10.0.0.5:8080\' }\nMOONSHOT_BASE_URL = "https://api.moonshot.cn"\n# base_url = "https://commented.example.com"\n'
  assert.deepEqual(hosts.settings.hostsOf(toml), ['relay.example.com', '10.0.0.5', 'api.moonshot.cn'])
  assert.deepEqual(hosts.settings.hostsOf(''), [])
})

test('W23: a form that needs naming has an opt-in item and no automatic entry; Claude Desktop takes no credentialed upstream', () => {
  const desktop = groupsOf().find((g) => g.g === 'claude-code.desktop')
  assert.deepEqual(entryGate(desktop), { ok: false, reason: 'opt-in-needed' })
  assert.deepEqual(entryGate(desktop, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(desktop, { optedIn: true, upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' }, 'its entry takes no credentials, so its port is open to every process of the machine')
  assert.equal(desktop.auth, false)
  for (const g of groupsOf().filter((x) => !(x.optIn && x.optIn.length))) assert.deepEqual(entryGate(g), { ok: true }, g.g)
})

// ── the data Tasks 6b, 8 and 10 read, pinned to 4.8 §2.3 (the 「跟随系统代理」 column, the entry column) and §2.4 (the opt-in items) and to the CLI plan's proxy table (T13, 1.6 §9.7) ──
// A shape check (above) cannot tell `followsSystemProxy.http: true` from `false`: this table can, so a flipped cell is red. Every cell is a row of one of those tables.
const GROUPS = {
  // [follows system proxy http, ws] · noProxyKey · auth · the entry (4.8 §2.3 entry column)
  'claude-code.settings': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['env', 'HTTPS_PROXY'] } },
  'claude-code.desktop': { follows: [true, false], auth: false, entry: { kind: 'policy', hive: 'HKCU', key: raw`SOFTWARE\Policies\Claude`, name: 'egressProxyUrl' } },
  'codex.env': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'opencode.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'opencode' } },
  'opencode.desktop': { follows: [false, false], auth: true, entry: { kind: 'launcher', shortcut: 'OpenCode.lnk', places: ['start-menu', 'desktop'] } },
  'kimi-code.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'kimi' } },
  'kimi-code.vscode': { follows: [true, false], auth: true, entry: { kind: 'app-setting', keys: ['http.proxy', 'http.systemCertificates'] } },
  'deepseek-dsh.env': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: {} } } },
  'hermes.cli': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'z-code.cli': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['network', 'httpProxy'] } },
  'z-code.desktop': { follows: [false, false], auth: true, entry: { kind: 'app-setting', keys: ['httpProxy', 'httpProxyCaCertPath'] } },
}
const OPT_IN = { // 4.8 §2.4: the item, its scope, and when a machine-level item applies; an automatic group has none
  'claude-code.desktop': [['cert-store-current-user', 'user']],
  'opencode.cli': [['user-path-shim', 'user'], ['machine-path-dispatcher', 'machine', 'real-binary-on-machine-path']],
  'opencode.desktop': [['start-menu-launcher', 'user'], ['all-users-launcher', 'machine', 'all-users-shortcuts']],
  'kimi-code.cli': [['user-path-shim', 'user'], ['machine-path-dispatcher', 'machine', 'real-binary-on-machine-path']],
  'kimi-code.vscode': [['vscode-settings-and-launcher', 'user']],
  'z-code.desktop': [['zcode-app-settings', 'user']],
}
// the `proxy` export per harness (CLI plan T13): system proxy, the schemes the agent takes, what it does with a SOCKS proxy, which branches follow the entry
const PROXY_EXPORT = {
  'claude-code': { env: ['HTTPS_PROXY', 'HTTP_PROXY'], files: [{ path: raw`%USERPROFILE%\.claude\settings.json`, key: 'env.HTTPS_PROXY', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'codex': { env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'], files: [{ path: raw`%CODEX_HOME%\.env`, key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['http', 'ws'] },
  'opencode': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'kimi-code': { env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'deepseek-dsh': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: raw`%USERPROFILE%\.dsh\.env`, key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['all'] },
  'hermes': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: raw`%LOCALAPPDATA%\hermes\.env`, key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'z-code': { env: ['ZCODE_HTTP_PROXY'], files: [{ path: raw`%USERPROFILE%\.zcode\cli\config.json`, key: 'network.httpProxy', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5h'], unsupported: {}, branches: ['all'] },
}

test('the groups, cell by cell: follows the system proxy (HTTP / WebSocket), the no-proxy key, credentials, the entry itself, and the opt-in items with their scope — as 4.8 §2.3 and §2.4 say', () => {
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

test('the proxy export of each harness is 4.8 §2.3 and the CLI plan\'s proxy table, value by value (system proxy, schemes, SOCKS behaviour, branches, where the setting is read from)', () => {
  assert.deepEqual(Object.keys(WIN).sort(), Object.keys(PROXY_EXPORT).sort())
  for (const [h, w] of Object.entries(WIN)) {
    const { env, files, systemProxy, schemes, unsupported, branches } = w.proxy
    assert.deepEqual({ env, files, systemProxy, schemes, unsupported, branches }, PROXY_EXPORT[h], h)
  }
  // the group's own cell and the harness's row agree where the harness has one form class (Claude Code's desktop shell is the one that follows, as its own group)
  for (const [h, w] of Object.entries(WIN)) for (const g of w.groups.filter((x) => !x.g.endsWith('.desktop') || h === 'hermes')) {
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
    os: 'win32', home, env: new Map(Object.entries(env)), running: [], collectorDir: path.join(home, '.asight', 'collector'), caPem: path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'),
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' ? null : { code: e.code, message: e.message } } } },
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
  })
  return { home, mk, ctx }
}
const groupOf = (h, g) => WIN[h].groups.find((x) => x.g === g)

test('a group\'s proxy entry goes into the files its trust entry does (Claude Code, Codex, Hermes, Z-Code), wherever the agent\'s home was moved to: CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME; dsh\'s trust entry is a patch file, so its .env is its own', () => {
  const w = world('John Smith')
  const cfg = path.join(w.home, 'D', 'claude-cfg')
  w.mk('.codex/x'); w.mk('D/codex-home/x'); w.mk('AppData/Local/hermes/profiles/work/config.yaml', 'x: 1\n'); w.mk('D/hermes/profiles/alt/config.yaml', 'x: 1\n'); w.mk('.zcode/cli/config.json', '{}')
  const trustFiles = (h, ctx) => (WIN[h].inject(ctx).entries || []).map((e) => e.path)
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
  same('hermes', 'hermes.cli', {}, [path.join(w.home, 'AppData', 'Local', 'hermes', '.env'), path.join(w.home, 'AppData', 'Local', 'hermes', 'profiles', 'work', '.env')])
  same('hermes', 'hermes.cli', { HERMES_HOME: path.join(w.home, 'D', 'hermes', 'profiles', 'alt') }, [path.join(w.home, 'D', 'hermes', '.env'), path.join(w.home, 'D', 'hermes', 'profiles', 'alt', '.env')])
  same('z-code', 'z-code.cli', {}, [path.join(w.home, '.zcode', 'cli', 'config.json')])
  assert.deepEqual(groupOf('z-code', 'z-code.cli').proxyEntry.files(world().ctx()), [], 'Z-Code has not run for this user: no file')
  const dsh = groupOf('deepseek-dsh', 'deepseek-dsh.env').proxyEntry
  assert.deepEqual(dsh.files(w.ctx()), [path.join(w.home, '.dsh', '.env')])
  assert.deepEqual(dsh.files(w.ctx({ DSH_HOME: path.join(w.home, 'D', 'dsh') })), [path.join(w.home, 'D', 'dsh', '.env')], 'DSH_HOME moves the .env with the patch file: one home')
})

test('where the app-setting entries live: the Z-Code Desktop v2 setting.json (ZCODE_DESKTOP_HOME_DIR moves it) and the VS Code user settings under %APPDATA%', () => {
  const w = world('John Smith')
  const z = groupOf('z-code', 'z-code.desktop').proxyEntry
  assert.equal(z.file(w.ctx()), path.join(w.home, '.zcode', 'v2', 'setting.json'))
  assert.equal(z.file(w.ctx({ ZCODE_DESKTOP_HOME_DIR: path.join(w.home, 'D', 'zd') })), path.join(w.home, 'D', 'zd', '.zcode', 'v2', 'setting.json'))
  const k = groupOf('kimi-code', 'kimi-code.vscode').proxyEntry
  assert.equal(k.file(w.ctx()), path.join(w.home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'), '%APPDATA% derived from the home when it is not set')
  assert.equal(k.file(w.ctx({ APPDATA: path.join(w.home, 'R') })), path.join(w.home, 'R', 'Code', 'User', 'settings.json'))
})

