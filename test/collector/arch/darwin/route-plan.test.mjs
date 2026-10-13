// test/collector/arch/darwin/route-plan.test.mjs — RFC 4.9 §1 · §2.1 · §2.2: which groups get an entry, and what each one's upstream and bypass table are (the plan half of 4.8's W5 / W71 / W72; MA6's plan half).
// This is the darwin port of the Task 8(a) sections of test/collector/arch/win32/route-plan.test.mjs (its header names the split: Task 6b owns the rules of upstream.mjs — on darwin those
// tests live with the darwin upstream.mjs port; this file owns what sits on top of them). The groups here are the REAL darwin data of the seven harnesses (`loadHarnesses`, `desc.darwin`),
// laid out in a sandbox home the way ~ is; the system proxy answers are the scutil dictionary's shape (wininet's `enable`/`server`/`override`/`autoConfigUrl` keys became
// `HTTPSEnable`/`HTTPSProxy`+`HTTPSPort`/`ExceptionsList`/`ProxyAutoConfigEnable`), and the login-environment dimension of the win32 tests is gone (4.9 §1: darwin has no registry to read).
// Nothing here runs macOS: the ctx is an object, the clock is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { groupsOf, hostSetOf, planRoutes, priorOf, resolveLogin } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { parseProxyText, proxyAuthOf } from '../../../../src/collector/arch/darwin/upstream.mjs'
import { bypassRuleOf, upstreamOf } from '../../../../src/collector/core/upstream-shape.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { applyJsonKey, applyTextEntry, newManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { proxyEntries } from '../../../../src/collector/arch/darwin/forms.mjs'
import { hostOf } from '../../../../src/collector/core/config-read.mjs'
import kimiBase from '../../../../src/collector/harness/kimi-code.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const local = { kind: 'local' }
const suf = (value) => ({ kind: 'domain-suffix', value })

// ======================================================================================================================================
// The route plan — which groups get an entry, what each one's upstream and bypass table are (4.9 §2.1 · §2.2, of 4.8 §2.2 · §2.3 · §3.5; W5, W72)
// The groups here are the REAL data of the seven darwin harnesses (`loadHarnesses`), laid out in a sandbox home directory the way ~ is.
// ======================================================================================================================================

const ALL = await loadHarnesses()
const GROUPS = groupsOf(ALL)

/** A sandbox home: files go in under it, and `ctx` is what the install gives a harness's `files(ctx)` (the one the trust tests use). */
function box(...sub) {
  const home = path.join(tmpDir('asight-rp-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const ctx = (env = {}, over = {}) => ({
    os: 'darwin', home, env: new Map([['HOME', home], ...Object.entries(env)]), running: [], collectorDir: path.join(home, '.asight', 'collector'), caPem: path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'),
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : { code: e.code, message: e.message } } } },
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
    ...over,
  })
  return { home, put, ctx, dir: path.join(home, '.asight', 'collector') }
}
const gdata = (g) => GROUPS.find((x) => x.g === g)
/** `priorOf` is asked for one harness's group: the manifest's records say which harness wrote them. */
const of = (g) => ({ harness: gdata(g).harness, group: gdata(g).group })
const USER_PROXY = 'http://alice:s3cret@corp.example:3128'

test('groupsOf: the darwin groups of the harness descriptors, each with its harness, its forms and the harness\'s proxy behaviour; a form with no group (not measured) is in none', () => {
  assert.deepEqual(GROUPS.map((x) => [x.harness, x.g, x.forms.map((f) => f.id)]), [
    ['claude-code', 'claude-code.settings', ['claude-code.native', 'claude-code.cli', 'claude-code.vscode']],
    ['claude-code', 'claude-code.desktop', ['claude-code.desktop']],
    ['codex', 'codex.env', ['codex.cli', 'codex.vscode']],
    ['deepseek-dsh', 'deepseek-dsh.env', ['deepseek-dsh.cli']],
    ['deepseek-dsh', 'deepseek-dsh.desktop', ['deepseek-dsh.desktop']],
    ['hermes', 'hermes.cli', ['hermes.cli']],
    ['kimi-code', 'kimi-code.cli', ['kimi-code.cli']],
    ['opencode', 'opencode.cli', ['opencode.cli']],
    ['z-code', 'z-code.cli', ['z-code.cli']],
  ])
  assert.ok(GROUPS.every((x) => x.group.g === x.g && x.proxy && Array.isArray(x.proxy.env) && Array.isArray(x.proxy.branches)), 'the group data and the harness\'s `proxy` (the variables it reads, its branches) are what upstreamFor is given')
  for (const id of ['hermes.desktop', 'codex.app', 'opencode.desktop', 'z-code.desktop', 'kimi-code.vscode']) {
    assert.equal(GROUPS.flatMap((x) => x.forms).some((f) => f.id === id), false, `${id} has no group: on darwin it is listed but not measured, so nothing can be routed for it`)
  }
  assert.deepEqual(groupsOf([{ name: 'windows-only' }, null]), [], 'a harness with no darwin data has no group on darwin')
})

// ---------- priorOf: the user's own proxy for a group, from the manifest when asight has written the entry, else from the file the agent reads (4.8 §2.2 ①) ----------

test('priorOf reads what an agent has in its entry file before asight: the JSON key, or the dotenv variables (and the NO_PROXY the group names), in whatever way the file writes them', () => {
  const b = box()
  b.put('.claude/settings.json', `{\n  // the corporate proxy\n  "env": { "HTTPS_PROXY": "${USER_PROXY}", "ANTHROPIC_BASE_URL": "https://relay.example.com" },\n}\n`)
  assert.deepEqual(priorOf({ ...of('claude-code.settings'), ctx: b.ctx() }), { value: USER_PROXY, noProxy: null, source: 'file' }, 'JSON with a comment and a trailing comma is what Claude Code reads')
  b.put('.codex/.env', `# mine\nOPENAI_API_KEY=sk-1\nexport HTTPS_PROXY="${USER_PROXY}"\nNO_PROXY='localhost, .corp.com'\n`)
  assert.deepEqual(priorOf({ ...of('codex.env'), ctx: b.ctx() }), { value: USER_PROXY, noProxy: 'localhost, .corp.com', source: 'file' })
  assert.deepEqual(priorOf({ ...of('claude-code.settings'), ctx: box().ctx() }), { value: null, noProxy: null, source: null }, 'no file: the agent has no proxy of its own')
  b.put('.claude/settings.json', '{"env": {"ANTHROPIC_BASE_URL": "https://relay.example.com"}}')
  assert.deepEqual(priorOf({ ...of('claude-code.settings'), ctx: b.ctx() }), { value: null, noProxy: null, source: null }, 'a file without the key')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": 3128}}')
  assert.equal(priorOf({ ...of('claude-code.settings'), ctx: b.ctx() }).value, null, 'a value that is no text is no proxy')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "  "}}')
  assert.equal(priorOf({ ...of('claude-code.settings'), ctx: b.ctx() }).value, null, 'an empty value is none')
})

test('priorOf: once asight has written the entry, the user\'s proxy is the manifest\'s prior_value (the file now holds asight\'s own address); an entry whose prior is null means the user had none, and the file is not read for it', () => {
  const b = box()
  const ingress = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
  const cases = [
    ['claude-code', 'claude-code.settings', '.claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"}}\n`, null],
    ['codex', 'codex.env', '.codex/.env', `HTTPS_PROXY=${USER_PROXY}\nNO_PROXY=intranet.example,10.0.0.0/8\n`, 'intranet.example,10.0.0.0/8'],
  ]
  for (const [harness, g, rel, user, noProxy] of cases) {
    const group = gdata(g).group
    const file = b.put(rel, user)
    const m = newManifest()
    for (const e of proxyEntries(group, b.ctx(), ingress)) {
      if (e.kind === 'text') applyTextEntry({ dir: b.dir, home: b.home, manifest: m, harness, file: e.path, edit: e })
      else applyJsonKey({ dir: b.dir, home: b.home, manifest: m, harness, file: e.path, keys: e.keys, value: e.value })
    }
    assert.ok(fs.readFileSync(file, 'utf8').includes('127.0.0.1:17991'), `${g}: the file holds asight's address now`)
    assert.deepEqual(priorOf({ harness, group, ctx: b.ctx(), manifest: m }), { value: USER_PROXY, noProxy, source: 'manifest' }, `${g}: the user's proxy, not asight's address`)
    assert.deepEqual(priorOf({ harness, group, ctx: b.ctx() }).source, 'file', `${g}: without the manifest the file is all there is to read`)
    assert.equal(priorOf({ harness, group, ctx: b.ctx() }).value.includes('127.0.0.1:17991'), true, `${g}: and it holds asight's own address (the upstream rule calls that a route loop)`)
  }
  // an agent that had no proxy: the manifest says so, and asight's own address in the file is not mistaken for the user's
  const group = gdata('claude-code.settings').group
  const file = b.put('.claude/settings.json', '{"env": {"ANTHROPIC_BASE_URL": "https://relay.example.com"}}\n')
  const m = newManifest()
  const e = proxyEntries(group, b.ctx(), ingress)[0]
  applyJsonKey({ dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  assert.deepEqual(priorOf({ harness: 'claude-code', group, ctx: b.ctx(), manifest: m }), { value: null, noProxy: null, source: 'manifest' })
  assert.ok(fs.readFileSync(file, 'utf8').includes('127.0.0.1:17991'))
  // the entries of other groups, and the trust entry of the same file, are not this group's
  assert.deepEqual(priorOf({ ...of('z-code.cli'), ctx: b.ctx(), manifest: m }), { value: null, noProxy: null, source: null }, 'another group\'s entry is no record for this one')
  const trust = { ...m.entries[0], keys: ['env', 'NODE_EXTRA_CA_CERTS'], prior_value: '/corp/ca.pem' }
  const viaTrust = priorOf({ harness: 'claude-code', group, ctx: b.ctx(), manifest: { entries: [trust] } })
  assert.equal(viaTrust.source, 'file', 'the trust key of the same file is not the proxy key: its record says nothing about the proxy entry, so the file is read (and holds asight\'s own address here)')
  assert.notEqual(viaTrust.value, '/corp/ca.pem')
  // the same for a dotenv file: the block the trust entry wrote (SSL_CERT_FILE) is no record of the proxy lines
  const envFile = b.put('.codex/.env', `HTTPS_PROXY=${USER_PROXY}\n`)
  const codexGroup = gdata('codex.env').group
  const trustBlock = { harness: 'codex', kind: 'text', format: 'dotenv-block', path: envFile, vars: { SSL_CERT_FILE: '/x/combined-codex.pem' }, prior_value: { SSL_CERT_FILE: '/corp/ca.pem' } }
  assert.deepEqual(priorOf({ harness: 'codex', group: codexGroup, ctx: b.ctx(), manifest: { entries: [trustBlock] } }), { value: USER_PROXY, noProxy: null, source: 'file' }, 'the trust block of the same file does not stand in for the proxy entry')
  // darwin paths: the record names the file in capitals, and is still the record of this file (APFS is case-insensitive by default)
  const proxyBlock = { harness: 'codex', kind: 'text', format: 'dotenv-block', path: envFile.toUpperCase(), vars: { HTTPS_PROXY: 'http://codex.env:x@127.0.0.1:1', NO_PROXY: 'localhost' }, prior_value: { HTTPS_PROXY: 'http://other:1' } }
  assert.equal(priorOf({ harness: 'codex', group: codexGroup, ctx: b.ctx(), manifest: { entries: [proxyBlock] } }).source, 'manifest', '/Users/u and /users/u are one file')
})

test('priorOf: a group with several entry files takes the first that holds a proxy, in the order the files are listed; a file asight wrote answers from the manifest, the others from themselves', () => {
  const b = box()
  const group = gdata('hermes.cli').group
  const root = '.hermes' // the darwin root (the Linux one; only Windows moved Hermes to %LOCALAPPDATA%)
  b.put(`${root}/.env`, 'OPENROUTER_API_KEY=k\n')
  b.put(`${root}/profiles/work/config.yaml`, 'model: x\n')
  const second = b.put(`${root}/profiles/work/.env`, `HTTPS_PROXY=http://work-proxy:8080\n`)
  const ctx = b.ctx()
  assert.deepEqual(group.proxyEntry.files(ctx).map((f) => path.relative(b.home, f)), [path.join(root, '.env'), path.join(root, 'profiles', 'work', '.env')])
  assert.deepEqual(priorOf({ harness: 'hermes', group, ctx }), { value: 'http://work-proxy:8080', noProxy: null, source: 'file' }, 'the root has none: the profile\'s is the group\'s')
  b.put(`${root}/.env`, 'HTTPS_PROXY=http://root-proxy:8080\n')
  assert.equal(priorOf({ harness: 'hermes', group, ctx }).value, 'http://root-proxy:8080', 'the first file that has one')
  // the root's entry written by asight with no proxy before it: nothing there; the profile is read from itself
  const m = { entries: [{ harness: 'hermes', kind: 'text', format: 'dotenv-block', path: group.proxyEntry.files(ctx)[0], vars: { HTTPS_PROXY: 'http://hermes.cli:x@127.0.0.1:17995', NO_PROXY: 'localhost' }, prior_value: null }] }
  assert.deepEqual(priorOf({ harness: 'hermes', group, ctx, manifest: m }), { value: 'http://work-proxy:8080', noProxy: null, source: 'file' })
  assert.ok(second)
})

test('priorOf: the manifest answers for every file asight wrote an entry in, whichever files the caller\'s ctx lists — the daemon\'s env is not the install shell\'s (CODEX_HOME, CLAUDE_CONFIG_DIR), and `files(ctx)` follows the env', () => {
  const b = box()
  const ingress = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
  const m = newManifest()
  // `on` ran in a shell with CODEX_HOME and CLAUDE_CONFIG_DIR set: asight wrote the entries there too, and the user's corporate proxy is in the second Codex home and in the second Claude home
  b.put('.codex/.env', 'OPENAI_API_KEY=a\n')
  b.put('work-codex/.env', `HTTPS_PROXY=${USER_PROXY}\nNO_PROXY=intranet.example\n`)
  b.put('work-claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"}}\n`)
  const install = b.ctx({ CODEX_HOME: path.join(b.home, 'work-codex'), CLAUDE_CONFIG_DIR: path.join(b.home, 'work-claude') })
  const codex = of('codex.env')
  const claude = of('claude-code.settings')
  for (const e of proxyEntries(codex.group, install, ingress)) applyTextEntry({ dir: b.dir, home: b.home, manifest: m, harness: 'codex', file: e.path, edit: e })
  for (const e of proxyEntries(claude.group, install, ingress)) applyJsonKey({ dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  assert.equal(codex.group.proxyEntry.files(install).length, 2, 'the install ctx lists both Codex homes')
  assert.deepEqual(claude.group.proxyEntry.files(install), [path.join(b.home, 'work-claude', 'settings.json')])
  const want = { codex: { value: USER_PROXY, noProxy: 'intranet.example', source: 'manifest' }, claude: { value: USER_PROXY, noProxy: null, source: 'manifest' } }
  assert.deepEqual(priorOf({ ...codex, ctx: install, manifest: m }), want.codex)
  assert.deepEqual(priorOf({ ...claude, ctx: install, manifest: m }), want.claude)
  // the daemon asks later, from its own env: it has neither variable (and no codex is running), so `files(ctx)` names other files — or none; the records are still the answer
  const daemon = b.ctx()
  assert.deepEqual(codex.group.proxyEntry.files(daemon), [path.join(b.home, '.codex', '.env')], 'the daemon\'s ctx lists only the default home')
  assert.deepEqual(priorOf({ ...codex, ctx: daemon, manifest: m }), want.codex, 'the entry in the second Codex home is still the user\'s proxy, not "none"')
  assert.deepEqual(priorOf({ ...claude, ctx: daemon, manifest: m }), want.claude, 'the settings file of CLAUDE_CONFIG_DIR is not in the daemon\'s `files(ctx)`: its record answers')
  assert.deepEqual(priorOf({ ...codex, ctx: box().ctx(), manifest: m }), want.codex, 'a ctx that lists no file at all')
  // a file the daemon\'s ctx lists that asight has no record in (a third home) is read as it is, after the records
  b.put('third-codex/.env', 'HTTPS_PROXY=http://live.example:1\n')
  const third = b.ctx({ CODEX_HOME: path.join(b.home, 'third-codex') })
  assert.equal(codex.group.proxyEntry.files(third).length, 2)
  assert.deepEqual(priorOf({ ...codex, ctx: third, manifest: m }), want.codex, 'the records answer first: they are the entries asight wrote, which its port serves')
  // and the plan: the group\'s upstream stays the user\'s proxy on every re-plan, whatever the env of the process that plans
  for (const ctx of [install, daemon]) {
    const p = plan(b, { ctx, manifest: m })
    assert.deepEqual([p['codex.env'].upstream.source, p['codex.env'].upstream.host, p['codex.env'].upstream.port], ['agent', 'corp.example', 3128], 'Codex follows the system proxy only when it has none of its own')
    assert.deepEqual([p['claude-code.settings'].upstream.source, p['claude-code.settings'].upstream.host], ['agent', 'corp.example'])
    assert.deepEqual(p['codex.env'].bypass, [suf('intranet.example')], 'and its NO_PROXY is the bypass table')
  }
})

test('priorOf: a record counts for this group only when its harness wrote it and it is the proxy entry (the key, or the dotenv variable) — a record outside `files(ctx)` is no exception; of two records of one file the oldest answers', () => {
  const b = box()
  const codex = of('codex.env')
  const claude = of('claude-code.settings')
  const elsewhere = path.join(b.home, 'elsewhere')
  const rec = (o) => ({ kind: 'text', format: 'dotenv-block', harness: 'codex', path: path.join(elsewhere, '.env'), vars: { HTTPS_PROXY: 'http://codex.env:x@127.0.0.1:17991', NO_PROXY: 'localhost' }, prior_value: { HTTPS_PROXY: 'http://other-proxy:8080' }, ...o })
  const jrec = (o) => ({ harness: 'claude-code', path: path.join(elsewhere, 'settings.json'), keys: ['env', 'HTTPS_PROXY'], value: 'http://claude-code.settings:x@127.0.0.1:17991', prior_value: 'http://other-proxy:8080', ...o })
  const ask = (g, entries) => priorOf({ ...g, ctx: b.ctx(), manifest: { entries } })
  assert.equal(ask(codex, [rec()]).value, 'http://other-proxy:8080', 'a file asight wrote in, outside the ctx\'s own list, answers')
  assert.deepEqual(ask(codex, [rec({ harness: 'deepseek-dsh' })]), { value: null, noProxy: null, source: null }, 'another harness\'s dotenv entry of the same shape is not Codex\'s')
  assert.deepEqual(ask(codex, [rec({ vars: { SSL_CERT_FILE: '/x/combined-codex.pem' } })]), { value: null, noProxy: null, source: null }, 'the trust block of a home outside the list is not the proxy entry either')
  assert.equal(ask(claude, [jrec()]).value, 'http://other-proxy:8080')
  assert.deepEqual(ask(claude, [jrec({ harness: 'z-code' })]), { value: null, noProxy: null, source: null })
  assert.deepEqual(ask(claude, [jrec({ keys: ['env', 'NODE_EXTRA_CA_CERTS'], prior_value: '/corp/ca.pem' })]), { value: null, noProxy: null, source: null }, 'the trust key is not the proxy key')
  assert.equal(ask(claude, [jrec(), jrec({ prior_value: 'http://claude-code.settings:x@127.0.0.1:17990', installed_at: 'later' })]).value, 'http://other-proxy:8080', 'two records of one file: the oldest holds what the user had; the later one holds asight\'s own earlier address')
  assert.equal(ask(claude, [jrec({ prior_value: null }), jrec({ prior_value: 'http://claude-code.settings:x@127.0.0.1:17990' })]).value, null, 'and "the user had none" is the oldest record\'s answer too')
  assert.equal(ask(claude, [null, 7, { path: 3 }, { harness: 'claude-code' }, jrec()]).value, 'http://other-proxy:8080', 'a manifest with rows that are not entries is read past them')
})

test('priorOf: a file it cannot read or understand is 「不知道」 with a reason from the closed set — never a guess at "no proxy" — and the other files are still read', () => {
  const b = box()
  const group = gdata('claude-code.settings').group
  const denied = b.ctx({}, { readTextOrError: () => ({ text: null, error: { code: 'EACCES', message: 'permission denied, open /Users/alice/.claude/settings.json' } }) })
  const r = priorOf({ harness: 'claude-code', group, ctx: denied })
  assert.deepEqual([r.value, r.noProxy, r.source], [null, null, null])
  assert.deepEqual(r.unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EACCES' }], 'the errno, and no path (a user name may be in it)')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": ')
  assert.deepEqual(priorOf({ harness: 'claude-code', group, ctx: b.ctx() }).unknown, [{ what: 'agent-proxy', reason: 'unparseable' }], 'JSON that does not parse says so, and does not quote the file')
  b.put('.claude/settings.json', '[1, 2]')
  assert.equal(priorOf({ harness: 'claude-code', group, ctx: b.ctx() }).unknown, undefined, 'JSON that is no object has no such key: that is a read, and there is none')
  const hermes = gdata('hermes.cli').group
  const b2 = box()
  b2.put('.hermes/.env', 'X=1\n')
  b2.put('.hermes/profiles/p/config.yaml', 'x: 1\n')
  b2.put('.hermes/profiles/p/.env', 'HTTPS_PROXY=http://p:1\n')
  const flaky = b2.ctx({}, { readTextOrError: (f) => (f.endsWith(path.join('hermes', '.env')) ? { text: null, error: { code: 'EPERM', message: 'x' } } : { text: fs.readFileSync(f, 'utf8'), error: null }) })
  const r2 = priorOf({ harness: 'hermes', group: hermes, ctx: flaky })
  assert.equal(r2.value, 'http://p:1', 'one file that cannot be read does not hide another that can')
  assert.deepEqual(r2.unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EPERM' }])
})

test('priorOf: a group whose entry is not a file asight writes (a policy value, a shim, a launcher, an app setting — Claude Desktop\'s unmeasured door on darwin) has no prior here — the opt-in step that writes it records it (Task 14)', () => {
  for (const g of ['claude-code.desktop', 'kimi-code.cli', 'opencode.cli']) {
    assert.deepEqual(priorOf({ ...of(g), ctx: box().ctx() }), { value: null, noProxy: null, source: null }, g)
  }
})

test('priorOf wants a group and a ctx; the secret in a user\'s proxy is in its answer and in no error', () => {
  assert.throws(() => priorOf({}), TypeError)
  assert.throws(() => priorOf({ ...of('codex.env') }), TypeError, 'a read needs the ctx that says where the home is')
  assert.throws(() => priorOf({ group: gdata('codex.env').group, ctx: box().ctx() }), { name: 'TypeError', message: /harness/ }, 'the manifest\'s records are told apart by the harness that wrote them: a call without it would read another harness\'s entry')
  const b = box()
  b.put('.claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"`)
  const r = priorOf({ ...of('claude-code.settings'), ctx: b.ctx() })
  assert.equal(JSON.stringify(r).includes('s3cret'), false, 'a file that does not parse is not quoted')
})

// ---------- resolveLogin: the login an upstream answer's `auth_ref` names (4.8 §2.2; on darwin the reference is always `prior:<group>`, 4.9 §1) ----------

test('resolveLogin: `prior:<group>` is the login in the user\'s proxy of that group — the manifest\'s prior_value once asight wrote the entry, the file before', () => {
  const b = box()
  const ingress = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
  const group = gdata('claude-code.settings').group
  const file = b.put('.claude/settings.json', `{"env": {"HTTPS_PROXY": "http://al%40ice:s3%3Acret@corp.example:3128"}}\n`)
  const ctx = b.ctx()
  assert.deepEqual(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx }), { username: 'al@ice', password: 's3:cret' }, 'the file before asight: the login is decoded')
  const m = newManifest()
  const e = proxyEntries(group, ctx, ingress)[0]
  applyJsonKey({ dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  assert.ok(fs.readFileSync(file, 'utf8').includes('127.0.0.1:17991'), 'the file holds asight\'s address now, and has no login')
  assert.deepEqual(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx, manifest: m }), { username: 'al@ice', password: 's3:cret' }, 'after asight wrote the entry the manifest is what answers: the same login, not the one of asight\'s own address')
})

test('resolveLogin: every way of not finding it is null — a reference of another shape (`hkcu-env:<NAME>`\'s: darwin has no registry to name a variable of), a group that is not there, a file that is not there or holds no login — and never a throw or a guess', () => {
  const b = box()
  const ctx = b.ctx()
  for (const ref of [undefined, null, '', 7, 'prior', 'prior:', 'hkcu-env:', 'hkcu-env:HTTPS_PROXY', 'system:x', 'env:HTTPS_PROXY', 'prior-claude-code.settings']) assert.equal(resolveLogin(ref, { groups: GROUPS, ctx }), null, `${String(ref)}`)
  assert.equal(resolveLogin('prior:no-such-group', { groups: GROUPS, ctx }), null, 'a group the plan does not know')
  assert.equal(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx }), null, 'no file: the user had no proxy')
  assert.equal(resolveLogin('prior:claude-code.settings', { groups: GROUPS }), null, 'no ctx to read with is not a throw')
  assert.equal(resolveLogin('prior:claude-code.settings'), null, 'no groups')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "http://u:p@h:1"')
  assert.equal(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx }), null, 'a file that does not parse is not read for a login')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "http://plain.example:3128"}}')
  assert.equal(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx }), null, 'a text with no login has none')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "ftp://u:p@h:21"}}')
  assert.equal(resolveLogin('prior:claude-code.settings', { groups: GROUPS, ctx }), null, 'a scheme asight cannot dial has no login to hand out')
})

// ---------- planRoutes: the entries and upstreams of all groups at once (W5, the plan half) ----------

const HARNESSES = ALL.filter((d) => d.darwin).map((d) => d.name)
/** A scutil answer as `readSystemProxy` gives it: the https proxy on, at 127.0.0.1:7897, `<local>` bypassed. */
const sys = (o = {}) => ({ ok: true, HTTPSEnable: true, HTTPSProxy: '127.0.0.1', HTTPSPort: 7897, HTTPEnable: null, HTTPProxy: null, HTTPPort: null, SOCKSEnable: null, SOCKSProxy: null, SOCKSPort: null, ProxyAutoConfigEnable: null, ExceptionsList: ['<local>'], ...o })
const NOTHING = { ok: true, HTTPSEnable: null, HTTPSProxy: null, HTTPSPort: null, HTTPEnable: null, HTTPProxy: null, HTTPPort: null, SOCKSEnable: null, SOCKSProxy: null, SOCKSPort: null, ProxyAutoConfigEnable: null, ExceptionsList: null }
const OWN = [17990, 17991, 17992]
const NETENV = (o = {}) => ({ systemProxy: sys(), ownPorts: OWN, ...o })
const ALL_ON = Object.fromEntries(HARNESSES.map((h) => [h, { desired: 'on', updated_at: null }])) // `state.json` v2's `harnesses`, as it is
/** planRoutes with every harness on and nobody named; the group's result by group id. */
const plan = (b, over = {}) => planRoutes({ netenv: NETENV(), groups: GROUPS, desired: ALL_ON, optIns: [], manifest: null, ctx: b.ctx(), procs: [], last: {}, ...over })
/** What a cell of the table says about a group, as the table writes it. */
const view = (p) => ({ entry: p.entry, on: p.on, reason: p.reason, upstream: p.upstream, ...(p.egressDiffers ? { egressDiffers: true } : {}), envUnreadable: p.envUnreadable })
const AUTO = ['claude-code.settings', 'codex.env', 'deepseek-dsh.env', 'hermes.cli', 'z-code.cli']
const NAMED = ['claude-code.desktop', 'kimi-code.cli', 'opencode.cli']
const PROXY = (host, port) => ({ kind: 'http', host, port, source: 'system-proxy' })
const DIRECT = { kind: 'direct', source: 'direct' }
const ON = { entry: 'auto', on: true, reason: null }
/** An opt-in group that follows the system proxy: no measured darwin opt-in group does (Kimi and OpenCode read the environment only, and Claude Desktop's proxy door is not measured, 4.9 §6.4), so the plan rules that need one are pinned with this declared group, the way the win32 test's own `two` group is. */
const FOLLOWER = { g: 'optfollow', harness: 'ofh', group: { g: 'optfollow', proxyEntry: { kind: 'file', format: 'json-key', files: () => [], key: ['k'] }, auth: true, followsSystemProxy: { http: true, ws: false }, optIn: [{ item: 'i', scope: 'user', impact: 'y' }] }, forms: [{ id: 'optfollow.a' }], proxy: { env: [], branches: ['all'] } }

test('W5 §2.2 table, group by group: the system proxy on (a TUN under it or none: the same), the switch off or the dictionary empty, a PAC — what each automatic group gets, written out literally', () => {
  const b = box()
  const dsh = { entry: 'auto', on: true, reason: null, upstream: DIRECT, envUnreadable: true } // dsh follows nothing and has no proxy of its own
  // 1. the system proxy on, with a TUN under it (or none): the followers take the system proxy, the others go direct
  const verge = plan(b)
  assert.deepEqual(AUTO.map((g) => [g, view(verge[g])]), [
    ['claude-code.settings', { ...ON, upstream: DIRECT, envUnreadable: true }],
    ['codex.env', { ...ON, upstream: PROXY('127.0.0.1', 7897), egressDiffers: true, envUnreadable: true }],
    ['deepseek-dsh.env', dsh],
    ['hermes.cli', { ...ON, upstream: PROXY('127.0.0.1', 7897), envUnreadable: true }],
    ['z-code.cli', { ...ON, upstream: DIRECT, envUnreadable: true }],
  ])
  // 2. the switch off (or the whole dictionary empty), a TUN or no VPN: everyone direct, and the TUN (if any) carries it as before
  for (const sp of [sys({ HTTPSEnable: false }), NOTHING, sys({ HTTPSProxy: null, HTTPSPort: null })]) {
    const off = plan(b, { netenv: NETENV({ systemProxy: sp }) })
    assert.deepEqual(AUTO.map((g) => view(off[g])), AUTO.map(() => ({ ...ON, upstream: DIRECT, envUnreadable: true })), JSON.stringify(sp))
  }
  // 3. scutil keeps the protocols apart in its own keys: the HTTPS entry is the one an HTTPS request takes, not the http or SOCKS one
  const v2 = plan(b, { netenv: NETENV({ systemProxy: sys({ HTTPEnable: true, HTTPProxy: '127.0.0.1', HTTPPort: 10809, HTTPSPort: 10810, SOCKSEnable: true, SOCKSProxy: '127.0.0.1', SOCKSPort: 10808 }) }) })
  assert.deepEqual([v2['codex.env'].upstream, v2['hermes.cli'].upstream, v2['claude-code.settings'].upstream], [PROXY('127.0.0.1', 10810), PROXY('127.0.0.1', 10810), DIRECT])
  // 4. a PAC: the followers are not routed (asight does not run a script), the others are as before
  const pac = plan(b, { netenv: NETENV({ systemProxy: sys({ ProxyAutoConfigEnable: true }) }) })
  const notRouted = { entry: null, on: false, reason: 'not-routed', upstream: null, envUnreadable: true }
  assert.deepEqual(AUTO.map((g) => view(pac[g])), [{ ...ON, upstream: DIRECT, envUnreadable: true }, notRouted, dsh, notRouted, { ...ON, upstream: DIRECT, envUnreadable: true }])
  assert.deepEqual([pac['codex.env'].code, pac['codex.env'].why, pac['hermes.cli'].why], ['not-routed', 'system-proxy-pac', 'system-proxy-pac'])
  // 5. a system proxy nobody could read is 「不知道」: the followers are not routed with the reason, never a guess at direct
  const blind = plan(b, { netenv: NETENV({ systemProxy: { ok: false, reason: 'timeout', detail: 'ETIMEDOUT' } }) })
  assert.deepEqual([blind['codex.env'].reason, blind['codex.env'].why, blind['codex.env'].detail, blind['claude-code.settings'].entry], ['not-routed', 'system-proxy-unreadable', 'timeout', 'auto'])
})

test('W5 §2.2 ①: an agent with a proxy of its own keeps it as the upstream — read from its file before `on`, from the manifest after — and the plan names where the login is, never the login', () => {
  const b = box()
  b.put('.claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"}}`)
  b.put('.codex/.env', 'HTTPS_PROXY=http://corp.example:3128\nNO_PROXY=localhost,.corp.com\n')
  const p = plan(b)
  const claude = { kind: 'http', host: 'corp.example', port: 3128, credentialed: true, auth_ref: 'prior:claude-code.settings', source: 'agent' }
  assert.deepEqual(view(p['claude-code.settings']), { ...ON, upstream: claude, envUnreadable: false })
  assert.deepEqual(view(p['codex.env']), { ...ON, upstream: { kind: 'http', host: 'corp.example', port: 3128, source: 'agent' }, envUnreadable: false }, 'Codex follows the system proxy only when it has none of its own; its WebSocket then goes the same way as its HTTP, so there is nothing to tell')
  assert.deepEqual([p['codex.env'].bypass, p['codex.env'].untranslated], [[suf('localhost'), { kind: 'ip-cidr', value: '127.0.0.0/8' }, suf('corp.com')], 0], 'the NO_PROXY it set is its own bypass table, with the loopback range `localhost` stands for')
  const json = JSON.stringify(p)
  for (const secret of ['s3cret', 'alice']) assert.equal(json.includes(secret), false, `${secret} is in no part of the plan: the credentials stay where the user put them, and the kernel config and the dial read them from there`)
  // after `on` the file holds asight's address and the manifest holds the user's: the same plan
  const m = newManifest()
  const e = proxyEntries(gdata('claude-code.settings').group, b.ctx(), { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })[0]
  applyJsonKey({ dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  const after = plan(b, { manifest: m })
  assert.deepEqual(after['claude-code.settings'], p['claude-code.settings'])
  const blind = plan(b)
  assert.equal(blind['claude-code.settings'].reason, 'route-loop', 'without the manifest, the file says asight\'s own address: a loop, said so, nothing dialled')
})

test('W5 §2.2 protocols: http, socks5 and socks5h connect (the last two are one thing); https and socks4 are not routed and say which, with the doctor code; nothing is swapped for another way out', () => {
  const b = box()
  const up = (text) => { b.put('.claude/settings.json', JSON.stringify({ env: { HTTPS_PROXY: text } })); return plan(b)['claude-code.settings'] }
  const shown = (r) => [r.entry, r.reason, r.code, r.why ?? null, r.protocol ?? null, r.upstream && r.upstream.kind]
  assert.deepEqual(shown(up('http://p.example:3128')), ['auto', null, undefined, null, null, 'http'])
  assert.deepEqual(shown(up('p.example:3128')), ['auto', null, undefined, null, null, 'http'], 'a bare host:port is an HTTP proxy')
  assert.deepEqual(shown(up('socks5://p.example:1080')), ['auto', null, undefined, null, null, 'socks5'])
  assert.deepEqual(shown(up('socks5h://p.example:1080')), ['auto', null, undefined, null, null, 'socks5'])
  assert.deepEqual(shown(up('https://p.example:3128')), [null, 'not-routed', 'proxy-unsupported', 'upstream-protocol', 'https', null])
  assert.deepEqual(shown(up('socks4://p.example:1080')), [null, 'not-routed', 'proxy-unsupported', 'upstream-protocol', 'socks4', null])
  assert.deepEqual(shown(up('ftp://p.example:21')), [null, 'not-routed', 'proxy-unsupported', 'upstream-protocol', 'ftp', null])
  assert.deepEqual(shown(up('http://p.example:3128\nx')), [null, 'not-routed', 'not-routed', 'upstream-unparseable', null, null], 'a value with a line break in it is not read: that is the group\'s reason, not a throw')
})

test('W5 whatever upstream the plan hands out, the kernel\'s config generator accepts: no proxy text of the user\'s — in the agent\'s file or the system proxy, on darwin the two sources there are — can make `on` or a reload throw', () => {
  const b = box()
  const nasty = ['http://a,b:3128', 'socks5://a,b:1080', 'a,b:3128', 'http://a，b:3128', 'http://a%2Cb:3128', 'socks5://a%2Cb:1080', 'http://u:p@a,b:3128', 'http://[::1]:3128', 'http://例え.jp:3128', 'socks5://ünï:1080', 'http://x:0', 'http://x:99999',
    'http://:3128', 'http://', 'http://a b:1', 'http://a\u0000b:1', 'https://a,b:1', 'socks4://a,b:1', 'ftp://x:1', 'http://us%3Aer:p%40ss@host:3128', 'host', 'HOST:3128', '  http://padded:3128  ', 'http://127.0.0.1:7897', 'socks5h://corp.example']
  const commas = new Set(['http://a,b:3128', 'socks5://a,b:1080', 'a,b:3128', 'http://a，b:3128', 'http://a%2Cb:3128', 'http://u:p@a,b:3128']) // not socks5://a%2Cb:…: the non-special scheme keeps the percent in its opaque host, the generator takes it, and it connects
  const gets = (r, text) => ({ type: r.upstream.kind, host: r.upstream.host, port: r.upstream.port, ...(r.upstream.credentialed ? proxyAuthOf(text) : {}) })
  let connected = 0
  const viaGenerator = (r, text, how) => {
    if (!r.upstream || !r.upstream.kind) return
    const upstream = r.upstream.kind === 'direct' ? 'direct' : gets(r, text)
    assert.doesNotThrow(() => { if (upstream !== 'direct') upstreamOf(r.g, upstream); for (const b of r.bypass || []) bypassRuleOf(b) }, `${how}: ${JSON.stringify(text)} gave ${JSON.stringify(r.upstream)}`)
    if (r.upstream.kind !== 'direct') connected++
  }
  for (const text of nasty) {
    b.put('.claude/settings.json', JSON.stringify({ env: { HTTPS_PROXY: text } }))
    const agent = plan(b)['claude-code.settings']
    viaGenerator(agent, text, 'the agent\'s file')
    // the system proxy: the scutil dictionary holds the host and the port apart, so the whole text goes in as the host (no port key)
    const system = plan(b, { netenv: NETENV({ systemProxy: sys({ HTTPSProxy: text, HTTPSPort: null }) }) })
    for (const g of ['codex.env', 'hermes.cli']) viaGenerator(system[g], text, `the system proxy, ${g}`)
    if (commas.has(text)) {
      for (const r of [agent, system['codex.env'], system['hermes.cli']]) assert.deepEqual([r.entry, r.reason, r.why, r.upstream], [null, 'not-routed', 'upstream-unparseable', null], `${JSON.stringify(text)}: an address the kernel's config cannot hold is not an upstream, and is said so`)
    }
  }
  assert.ok(connected > 20, `the table has addresses that do connect (${connected}): the check is not empty`)
  assert.equal(parseProxyText('http://a,b:3128').ok, false)
  assert.equal(proxyAuthOf('http://u:p@a,b:3128'), null, 'an address that is not one has no login to hand to anybody')
})

test('W8 / W5: an upstream that is asight\'s own port is a route loop — the group is not routed, and the plan says which address', () => {
  const b = box()
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "http://127.0.0.1:17991"}}')
  const r = plan(b)['claude-code.settings']
  assert.deepEqual([r.entry, r.on, r.reason, r.code, r.detail, r.upstream], [null, false, 'route-loop', 'route-loop', '127.0.0.1:17991', null])
  assert.equal(plan(b, { netenv: NETENV({ ownPorts: [] }) })['claude-code.settings'].entry, 'auto', 'it is only a loop because that port is one of asight\'s')
})

test('W5 an entry is written only for a group the user named when it is an opt-in item (opt-in-needed otherwise), and only for a harness that is on (desired-off otherwise); the first reason that holds is the one said', () => {
  const b = box()
  const p = plan(b)
  for (const g of NAMED) assert.deepEqual([g, p[g].entry, p[g].on, p[g].reason, p[g].code], [g, null, false, 'opt-in-needed', 'opt-in-needed'], `${g} is not the automatic kind: it waits to be named, and nothing is written for it`)
  assert.deepEqual(NAMED.flatMap((g) => gdata(g).forms.map((f) => p[g].forms[f.id].reason)), NAMED.flatMap((g) => gdata(g).forms.map(() => 'opt-in-needed')), 'and every form of it says so')
  const named = plan(b, { optIns: ['kimi-code.cli', 'claude-code.desktop'] })
  assert.deepEqual(['kimi-code.cli', 'claude-code.desktop', 'opencode.cli'].map((g) => [g, named[g].entry, named[g].on, named[g].reason]), [['kimi-code.cli', 'opt-in', true, null], ['claude-code.desktop', 'opt-in', true, null], ['opencode.cli', null, false, 'opt-in-needed']], 'only what was named')
  // a form of the group may be the name: a group with two forms is named by either
  const two = { g: 'x', harness: 'xh', group: { g: 'x', proxyEntry: { kind: 'file', format: 'json-key', files: () => [], key: ['k'] }, auth: true, followsSystemProxy: { http: false, ws: false }, optIn: [{ item: 'i', scope: 'user', impact: 'y' }] }, forms: [{ id: 'x.a' }, { id: 'x.b' }], proxy: { env: [], branches: ['all'] } }
  assert.deepEqual([planRoutes({ netenv: NETENV(), groups: [two], desired: { xh: 'on' }, optIns: ['x.b'], ctx: b.ctx() }).x.entry, planRoutes({ netenv: NETENV(), groups: [two], desired: { xh: 'on' }, optIns: ['x.zzz'], ctx: b.ctx() }).x.reason], ['opt-in', 'opt-in-needed'])
  // off: no entry; the upstream is still computed (what the kernel forwards to for a process that outlives `off`)
  const off = plan(b, { desired: { codex: { desired: 'off' }, hermes: 'off', 'claude-code': 'on' } })
  assert.deepEqual(['codex.env', 'hermes.cli', 'claude-code.settings', 'z-code.cli'].map((g) => [g, off[g].entry, off[g].on, off[g].reason]), [['codex.env', null, false, 'desired-off'], ['hermes.cli', null, false, 'desired-off'], ['claude-code.settings', 'auto', true, null], ['z-code.cli', null, false, 'desired-off']], 'a harness with no word in `desired` is off')
  assert.deepEqual(off['codex.env'].upstream, PROXY('127.0.0.1', 7897), 'forward-only needs the upstream')
  assert.equal(off['codex.env'].egressDiffers, undefined, 'nothing is connected to tell it about')
  assert.deepEqual(plan(b, { desired: null })['codex.env'].reason, 'desired-off')
  // the order: off first, then not named, then the upstream, then the entry that takes no login (pinned with FOLLOWER: no measured darwin opt-in group follows the system proxy)
  const pacFollower = { netenv: NETENV({ systemProxy: sys({ ProxyAutoConfigEnable: true }) }), groups: [FOLLOWER], ctx: b.ctx() }
  assert.equal(planRoutes({ ...pacFollower, desired: {} }).optfollow.reason, 'desired-off', 'off first, whatever else holds')
  assert.equal(planRoutes({ ...pacFollower, desired: { ofh: 'on' } }).optfollow.reason, 'opt-in-needed', 'it follows the system proxy, which is a PAC; it is the naming that is missing first')
  const namedPac = planRoutes({ ...pacFollower, desired: { ofh: 'on' }, optIns: ['optfollow'] }).optfollow
  assert.deepEqual([namedPac.reason, namedPac.why], ['not-routed', 'system-proxy-pac'])
})

test('W5 / W23: an entry that takes no login (a group whose `auth` is false) is not routed to an upstream that needs one — form-unsupported; one with an upstream that needs none is', () => {
  const b = box()
  b.put('.x/c.json', `{"p": "${USER_PROXY}"}`)
  const entryless = { g: 'nologin', harness: 'xh', group: { g: 'nologin', proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => [path.join(ctx.home, '.x', 'c.json')], key: ['p'] }, auth: false, followsSystemProxy: { http: false, ws: false } }, forms: [{ id: 'nologin.a' }], proxy: { env: [], branches: ['all'] } }
  const r = planRoutes({ netenv: NETENV(), groups: [entryless], desired: { xh: 'on' }, ctx: b.ctx() }).nologin
  assert.deepEqual([r.entry, r.on, r.reason, r.upstream.credentialed, r.forms['nologin.a'].reason], [null, false, 'form-unsupported', true, 'form-unsupported'])
  b.put('.x/c.json', '{"p": "http://corp.example:3128"}')
  assert.equal(planRoutes({ netenv: NETENV(), groups: [entryless], desired: { xh: 'on' }, ctx: b.ctx() }).nologin.entry, 'auto')
  // the real auth:false group on darwin is Claude Desktop, whose proxy door is not measured (4.9 §6.4): it follows no proxy asight can see, so once named it
  // connects direct; the credentials-in-system-proxy refusal (a system asight cannot dial as the client that ran before it) is pinned on a follower
  assert.equal(plan(b, { optIns: ['claude-code.desktop'] })['claude-code.desktop'].entry, 'opt-in')
  const credentialed = plan(b, { netenv: NETENV({ systemProxy: sys({ HTTPSProxy: 'alice:s3cret@corp.example', HTTPSPort: 3128 }) }) })['codex.env']
  assert.deepEqual([credentialed.reason, credentialed.why, credentialed.detail], ['not-routed', 'upstream-unparseable', 'credentials-in-system-proxy'])
})

test('W5 egress-differs: a group connected through the system proxy whose WebSocket did not follow it is told so, once it is connected; a group that was not connected, or whose harness has no such branch, is not', () => {
  const b = box()
  const p = plan(b)
  assert.deepEqual(['codex.env', 'hermes.cli', 'claude-code.settings'].map((g) => p[g].egressDiffers === true), [true, false, false], 'Codex has an HTTP and a WebSocket branch, Hermes follows the system proxy but has only one')
  assert.equal(plan(b, { desired: { codex: 'off' } })['codex.env'].egressDiffers, undefined)
})

test('W5 the bypass table: a follower\'s is the system proxy\'s ExceptionsList, an agent\'s own proxy takes its NO_PROXY, a group going direct has none to leave direct, and what asight cannot read is counted — each group its own', () => {
  const b = box()
  b.put('.codex/.env', 'OPENAI_API_KEY=k\n')
  const list = ['<local>', '*.corp.com', '10.*', 'intranet.corp.com', 'a*b.com'] // the darwin dialect: an array, and a bare name read the NO_PROXY way (the domain AND its subdomains), not WinINET's exact host
  const p = plan(b, { netenv: NETENV({ systemProxy: sys({ ExceptionsList: list }) }) })
  assert.deepEqual([p['codex.env'].bypass, p['codex.env'].untranslated], [[local, suf('corp.com'), { kind: 'ip-cidr', value: '10.0.0.0/8' }, suf('intranet.corp.com')], 1])
  assert.deepEqual([p['hermes.cli'].bypass, p['hermes.cli'].untranslated], [p['codex.env'].bypass, 1], 'both follow the same ExceptionsList')
  assert.notEqual(p['hermes.cli'].bypass, p['codex.env'].bypass, 'but not one table between two groups')
  assert.deepEqual([p['claude-code.settings'].bypass, p['claude-code.settings'].untranslated], [[], 0], 'direct has nothing to leave direct')
  const own = plan(b, { netenv: NETENV({ systemProxy: sys({ ExceptionsList: list }) }), manifest: { entries: [] } }) // no change: the manifest has no record
  assert.deepEqual(own['codex.env'].bypass, p['codex.env'].bypass)
  b.put('.codex/.env', 'HTTPS_PROXY=http://corp.example:3128\nNO_PROXY=.corp.com,10.0.0.0/8,[::1]\n')
  const withOwn = plan(b, { netenv: NETENV({ systemProxy: sys({ ExceptionsList: list }) }) })
  assert.deepEqual([withOwn['codex.env'].bypass, withOwn['codex.env'].untranslated], [[suf('corp.com'), { kind: 'ip-cidr', value: '10.0.0.0/8' }], 1], 'the NO_PROXY of the proxy it uses, not the system\'s list for another proxy')
  assert.deepEqual(withOwn['hermes.cli'].bypass, p['hermes.cli'].bypass, 'and another group\'s table is its own')
})

test('W5 darwin has no login environment to read (4.9 §1): a proxy set only in the user\'s terminal is invisible — envUnreadable says so on every group whose upstream is not its own entry — and an entry file that cannot be read is 「不知道」 beside the answer, never a guess', () => {
  const b = box()
  const p = plan(b)
  for (const g of [...AUTO, ...NAMED]) assert.equal(p[g].envUnreadable, true, `${g}: the cannot-read-your-terminal hint 4.8 §2.2 has, and on darwin there is not even a registry to try`)
  assert.deepEqual(p['z-code.cli'].upstream, DIRECT, 'Z-Code\'s door is its config file\'s key: a variable of the terminal is not read, on darwin by anybody')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "http://login.example:8080"}}')
  const mine = plan(b)['claude-code.settings']
  assert.deepEqual([mine.upstream, mine.envUnreadable], [{ kind: 'http', host: 'login.example', port: 8080, source: 'agent' }, false], 'its own entry is the one place asight can see')
  const denied = plan(b, { ctx: b.ctx({}, { readTextOrError: () => ({ text: null, error: { code: 'EACCES', message: 'x' } }) }) })
  assert.deepEqual(denied['claude-code.settings'].unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EACCES' }], 'an entry file that cannot be read is said too')
  assert.equal(denied['claude-code.settings'].entry, 'auto', 'the rules go on: it is direct, and the plan says what it could not read')
})

test('W5 the form results: an elevated process of a form and a process whose path nobody measured are said on the forms; they do not change what the group gets, and a group\'s own reason says the same for all its forms', () => {
  const b = box()
  const procs = [
    { pid: 7712, match: { kind: 'form', id: 'claude-code.cli' }, elevated: true },
    { pid: 7713, match: { kind: 'form', id: 'claude-code.cli' }, elevated: true },
    { pid: 7714, match: { kind: 'form', id: 'claude-code.vscode' }, elevated: false },
    { pid: 5530, match: { kind: 'form', id: 'codex.cli' }, elevated: null },
    { pid: 9001, match: { kind: 'path-unknown', forms: ['claude-code.cli', 'claude-code.vscode', 'claude-code.desktop'], shape: '/tools/claude' }, elevated: false },
    { pid: 9002, match: { kind: 'path-unknown', forms: ['codex.cli'], shape: '/Users/<user>/x/codex' } },
    { pid: 4000, match: { kind: 'pending', forms: ['deepseek-dsh.cli'] } }, // not a shape darwin's matchForm gives (ps hands the command line in the same shot); kept: a match that is neither form nor path-unknown is nothing
    { pid: 4001, match: { kind: 'none' }, elevated: true },
    { pid: 4002, match: { kind: 'form', id: 'no.such.form' }, elevated: true },
  ]
  const p = plan(b, { procs })
  const f = p['claude-code.settings'].forms
  assert.deepEqual(f['claude-code.cli'], { reason: 'elevated-agent', elevatedPids: [7712, 7713], unknownPaths: ['/tools/claude'] }, 'the elevated pids are a fact about a known form, and the first thing said about it')
  assert.deepEqual(f['claude-code.vscode'], { reason: 'form-path-unknown', unknownPaths: ['/tools/claude'] }, 'a path that tells which form it is does not exist: every form of that image carries it')
  assert.deepEqual(p['codex.env'].forms['codex.cli'], { reason: 'form-path-unknown', unknownPaths: ['/Users/<user>/x/codex'] }, 'an elevation nobody could read (null) is not an elevation')
  assert.deepEqual(p['deepseek-dsh.env'].forms, { 'deepseek-dsh.cli': { reason: null } }, 'a match that is neither a form nor a path-unknown, and one that is no agent, are nothing yet')
  assert.deepEqual(['entry', 'on', 'reason'].map((k) => p['claude-code.settings'][k]), ['auto', true, null], 'the group is connected: the elevated process is the one that is not captured')
  assert.deepEqual(p['claude-code.desktop'].forms['claude-code.desktop'], { reason: 'opt-in-needed', unknownPaths: ['/tools/claude'] }, 'the group\'s reason is first')
  assert.deepEqual(plan(b)['claude-code.settings'].forms, { 'claude-code.native': { reason: null }, 'claude-code.cli': { reason: null }, 'claude-code.vscode': { reason: null } }, 'nothing seen, nothing said')
})

test('W71 (plan half): fed its own result as `last`, a system proxy that turned PAC or could not be read leaves the followers on the upstream and the bypass table they had, with a hint; a group that was not routed before stays not routed', () => {
  const b = box()
  const before = plan(b, { netenv: NETENV({ systemProxy: sys({ ExceptionsList: ['<local>', '*.corp.com'] }) }) })
  const last = before // the plan's own return value is the next call's `last`
  for (const [why, sp] of [['system-proxy-pac', sys({ ProxyAutoConfigEnable: true })], ['system-proxy-unreadable', { ok: false, reason: 'timeout' }]]) {
    const after = plan(b, { netenv: NETENV({ systemProxy: sp }), last })
    assert.deepEqual([after['codex.env'].entry, after['codex.env'].on, after['codex.env'].reason, after['codex.env'].hint], ['auto', true, null, why])
    assert.deepEqual([after['codex.env'].upstream, after['codex.env'].bypass, after['codex.env'].egressDiffers], [before['codex.env'].upstream, before['codex.env'].bypass, true], 'where it was, with the table it had')
    assert.deepEqual(after['claude-code.settings'], before['claude-code.settings'], 'a group that does not follow the system proxy is not touched')
    assert.equal(plan(b, { netenv: NETENV({ systemProxy: sp }) })['codex.env'].reason, 'not-routed', 'with no last answer there is nothing to stay on')
  }
  const same = plan(b, { netenv: NETENV({ systemProxy: sys({ ExceptionsList: ['<local>', '*.corp.com'] }) }), last })
  assert.deepEqual(Object.values(same).map((r) => r.answer), Object.values(before).map((r) => r.answer), 'an unchanged system proxy gives the answers it gave: the daemon compares these and reloads nothing')
  assert.ok(Object.values(before).every((r) => !('hint' in r.answer) && JSON.stringify(r.answer).length > 0))
})

test('W71 (plan half): only a group that WAS connected is left on its last upstream — the answer a group worked out while it was off, or was not routed, is what it would have dialled, not what it did (OPEN 17)', () => {
  const b = box()
  const pac = NETENV({ systemProxy: sys({ ProxyAutoConfigEnable: true }) })
  const only = (...hs) => Object.fromEntries(hs.map((h) => [h, { desired: 'on', updated_at: null }]))
  // the harnesses were off: the plan still works out the upstream the kernel forwards to (the system proxy as it then was)
  const off = plan(b, { desired: {} })
  assert.deepEqual([off['codex.env'].on, off['codex.env'].reason, off['codex.env'].upstream], [false, 'desired-off', PROXY('127.0.0.1', 7897)])
  // the user moved to a PAC and then runs `asight on codex`: the plan before had the group off, so there is nothing to stay on
  const onNow = plan(b, { desired: only('codex'), netenv: pac, last: off })
  assert.deepEqual([onNow['codex.env'].entry, onNow['codex.env'].on, onNow['codex.env'].reason, onNow['codex.env'].why, onNow['codex.env'].hint, onNow['codex.env'].upstream], [null, false, 'not-routed', 'system-proxy-pac', undefined, null],
    'not connected through a hop the user no longer uses')
  assert.deepEqual(onNow['codex.env'], plan(b, { desired: only('codex'), netenv: pac })['codex.env'], 'the same as with no `last` at all')
  // connected, then the PAC: it stays (the other tests); connected, `off`, then the PAC and `on` again: the off plan was not connected, so it does not
  const live = plan(b, { desired: only('codex', 'hermes') })
  const stayed = plan(b, { desired: only('codex', 'hermes'), netenv: pac, last: live })
  assert.deepEqual([stayed['codex.env'].on, stayed['codex.env'].hint, stayed['codex.env'].upstream], [true, 'system-proxy-pac', PROXY('127.0.0.1', 7897)])
  const turnedOff = plan(b, { desired: {}, netenv: pac, last: stayed })
  assert.deepEqual([turnedOff['codex.env'].on, turnedOff['codex.env'].reason], [false, 'desired-off'], 'off: nothing connected')
  const again = plan(b, { desired: only('codex', 'hermes'), netenv: pac, last: turnedOff })
  assert.deepEqual([again['codex.env'].entry, again['codex.env'].reason, again['codex.env'].why], [null, 'not-routed', 'system-proxy-pac'], 'and `on` again after the PAC does not pick the old hop up from the off plan')
  // an opt-in group the user named is connected like any other, and stays; one nobody named was never connected, so it has nothing to stay on even though it has an answer of its own
  // (FOLLOWER again: no measured darwin opt-in group follows the system proxy)
  const named = planRoutes({ netenv: NETENV(), groups: [FOLLOWER], desired: { ofh: 'on' }, optIns: ['optfollow'], ctx: b.ctx() })
  assert.deepEqual([named.optfollow.entry, named.optfollow.on], ['opt-in', true])
  const namedPac = planRoutes({ netenv: pac, groups: [FOLLOWER], desired: { ofh: 'on' }, optIns: ['optfollow'], ctx: b.ctx(), last: named })
  assert.deepEqual([namedPac.optfollow.entry, namedPac.optfollow.hint, namedPac.optfollow.upstream], ['opt-in', 'system-proxy-pac', PROXY('127.0.0.1', 7897)])
  const unnamed = planRoutes({ netenv: NETENV(), groups: [FOLLOWER], desired: { ofh: 'on' }, ctx: b.ctx() })
  assert.deepEqual([unnamed.optfollow.entry, unnamed.optfollow.reason, unnamed.optfollow.upstream], [null, 'opt-in-needed', PROXY('127.0.0.1', 7897)])
  const unnamedPac = planRoutes({ netenv: pac, groups: [FOLLOWER], desired: { ofh: 'on' }, optIns: ['optfollow'], ctx: b.ctx(), last: unnamed })
  assert.deepEqual([unnamedPac.optfollow.entry, unnamedPac.optfollow.reason, unnamedPac.optfollow.why], [null, 'not-routed', 'system-proxy-pac'], 'named only now, after the PAC: nothing was connected before')
  // `last` is the previous RESULT: handing it the answers (the old shape) is a bug of the caller, said so rather than read as "nothing to stay on"
  assert.throws(() => plan(b, { last: { 'codex.env': live['codex.env'].answer } }), { name: 'TypeError', message: /previous result/ })
  assert.doesNotThrow(() => plan(b, { last: { 'no-such-group': { on: true, answer: null } } }), 'a group that is gone is nothing')
  assert.doesNotThrow(() => plan(b, { last: null }))
})

test('planRoutes wants its inputs: the groups, the network as it was read, asight\'s own ports (without them no loop could be seen), and the ctx that says where the files are', () => {
  const b = box()
  const ok = { netenv: NETENV(), groups: GROUPS, desired: ALL_ON, ctx: b.ctx() }
  assert.equal(typeof planRoutes(ok), 'object')
  assert.throws(() => planRoutes({ ...ok, groups: undefined }), { name: 'TypeError', message: /needs the groups/ })
  assert.throws(() => planRoutes({ ...ok, netenv: undefined }), { name: 'TypeError', message: /needs the network/ })
  assert.throws(() => planRoutes({ ...ok, netenv: { systemProxy: sys() } }), { name: 'TypeError', message: /own ports/ }, 'a plan that cannot see a loop is not a plan')
  assert.throws(() => planRoutes({ ...ok, ctx: undefined }), { name: 'TypeError', message: /needs the ctx/ })
  assert.throws(() => planRoutes({ ...ok, groups: [], ctx: undefined }), { name: 'TypeError', message: /needs the ctx/ }, 'whether or not there is a group to read a file for')
  assert.throws(() => planRoutes(), TypeError)
  assert.deepEqual(Object.keys(planRoutes({ ...ok, groups: [] })), [])
})

// ---------- hostSetOf: the hosts a host-tree form hands to the engine (4.8 §3.5, OPEN 22; W69 config half) ----------
// darwin has no measured host-tree form yet (kimi-code.vscode is listed but not measured on macOS, 4.9 §2.3, MA4), so the host-set form here is the
// win32 twin's shape over the base descriptor's own Kimi data (defaults, config.toml, the same base_url reader): the rule — hostSetOf — is what is pinned.

const TOML_URL = /(?:^|[{,])[ \t]*(base_url|[A-Z][A-Z0-9_]*_BASE_URL)[ \t]*=[ \t]*(["'])([^"'\n]+)\2/gm
const KIMI_HOSTS_FORM = {
  id: 'kimi-code.vscode',
  hosts: {
    defaults: [...kimiBase.hosts], // Kimi's known API hosts: one list, the base descriptor's (the win32 form's own source)
    settings: { file: (ctx) => path.join(ctx.env.get('KIMI_CODE_HOME') || path.join(ctx.home, '.kimi-code'), 'config.toml'), hostsOf: (text) => [...String(text).matchAll(TOML_URL)].map((m) => hostOf(m[3])).filter(Boolean) },
  },
}
const KIMI_DEFAULTS = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn']
/** `readSettings` the way the daemon gives it: the form's settings file, read through the ctx (`{ text, error }`). */
const settingsOf = (ctx) => () => ctx.readTextOrError(KIMI_HOSTS_FORM.hosts.settings.file(ctx))

test('W69 hostSetOf: the host set is the default hosts, then the base URLs of the extension\'s own settings, then the operator\'s extra_hosts — three sources, one injected each, in that order, each name once', () => {
  const b = box()
  const ctx = b.ctx()
  const only = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(ctx) })
  assert.deepEqual(only, { hosts: KIMI_DEFAULTS, settings: 'absent', dropped: [] }, 'no settings file: nothing configured, which is not a failure; the relay is not in the set')
  b.put('.kimi-code/config.toml', '[providers.relay]\nbase_url = "https://relay.example.com/v1"\napi_key = "sk-secret"\n')
  const withRelay = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(ctx) })
  assert.deepEqual(withRelay, { hosts: [...KIMI_DEFAULTS, 'relay.example.com'], settings: 'read', dropped: [] }, 'the relay in Kimi\'s settings is in the set: a connection through it is captured without anyone writing a list')
  assert.equal(JSON.stringify(withRelay).includes('sk-secret'), false)
  const extra = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(box().ctx()), extraHosts: ['gateway.corp.example'] })
  assert.deepEqual(extra.hosts, [...KIMI_DEFAULTS, 'gateway.corp.example'], 'extra_hosts is the third source')
  const all = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(ctx), extraHosts: ['gateway.corp.example', 'API.Moonshot.cn', 'relay.example.com'] })
  assert.deepEqual(all.hosts, [...KIMI_DEFAULTS, 'relay.example.com', 'gateway.corp.example'], 'in this order, and a name that is in the set already (in any case) is not there twice')
  b.put('.kimi-code/config.toml', '')
  assert.deepEqual(hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(ctx) }), { hosts: KIMI_DEFAULTS, settings: 'read', dropped: [] }, 'an empty file is read: it names no relay')
  assert.deepEqual(KIMI_HOSTS_FORM.hosts.defaults, KIMI_DEFAULTS, 'the form\'s data is not changed')
})

test('W69 hostSetOf: a settings file that cannot be read or understood is 「不知道」 with a reason from the closed set — the set is then the defaults and extra_hosts, and the caller says so — and a file that is not there is not that', () => {
  const read = (r) => hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: () => r, extraHosts: ['x.example'] })
  const denied = read({ text: null, error: { code: 'EACCES', message: 'permission denied, open /Users/alice/.kimi-code/config.toml' } })
  assert.deepEqual(denied, { hosts: [...KIMI_DEFAULTS, 'x.example'], settings: { unreadable: { reason: 'denied', detail: 'EACCES' } }, dropped: [] }, 'the errno, no path (a user name may be in it)')
  assert.deepEqual(read({ text: null, error: { message: 'x' } }).settings, { unreadable: { reason: 'denied' } })
  assert.deepEqual(hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }) } }).settings, { unreadable: { reason: 'denied', detail: 'EIO' } }, 'a reader that throws is a read that failed, not a throw out of `on`')
  assert.equal(read({ text: null, error: null }).settings, 'absent')
  const odd = { ...KIMI_HOSTS_FORM, hosts: { ...KIMI_HOSTS_FORM.hosts, settings: { ...KIMI_HOSTS_FORM.hosts.settings, hostsOf: () => { throw new Error('this is not TOML') } } } }
  assert.deepEqual(hostSetOf({ form: odd, readSettings: () => ({ text: 'x = [', error: null }) }), { hosts: KIMI_DEFAULTS, settings: { unreadable: { reason: 'unparseable' } }, dropped: [] }, 'a file the reader cannot parse says so, and quotes nothing')
  const notAList = { ...odd, hosts: { ...odd.hosts, settings: { ...odd.hosts.settings, hostsOf: () => 'api.x.com' } } }
  assert.deepEqual(hostSetOf({ form: notAList, readSettings: () => ({ text: 'x', error: null }) }).settings, { unreadable: { reason: 'unparseable' } })
  const none = { ...KIMI_HOSTS_FORM, hosts: { defaults: ['a.example'] } }
  assert.deepEqual(hostSetOf({ form: none }), { hosts: ['a.example'], settings: 'absent', dropped: [] }, 'a form with no settings reader has no settings to read')
})

test('W69 hostSetOf: only a name the kernel\'s DOMAIN-SUFFIX rule can match is in the set — an address literal, a wildcard, a name the generator refuses are said (`dropped`), never written and never thrown; and what is in the set is what the generator accepts', () => {
  const b = box()
  b.put('.kimi-code/config.toml', 'base_url = "http://10.0.0.5:8080"\nOTHER_BASE_URL = "https://[::1]:9/v1"\n')
  const r = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(b.ctx()), extraHosts: ['*.corp.example', 'host:443', '', '  Spaced.Example  ', 'a,b', 'ünï.example'] })
  assert.deepEqual(r.hosts, [...KIMI_DEFAULTS, 'spaced.example'])
  assert.deepEqual(r.dropped, ['10.0.0.5', '::1', '*.corp.example', 'host:443', 'a,b', 'ünï.example'], 'a relay by address cannot be matched by a domain rule: it is said, not silently left out')
  // the rule that is applied is the generator's own: a table of candidates, judged by the generator and by hostSetOf
  const candidates = ['api.kimi.com', 'a-b.c_d.example', '1.example.com', 'x'.repeat(253), 'x'.repeat(254), 'a,b', 'a b', '*.corp.com', '-x.com', '.x.com', 'a..b', 'ünï.com', '10.0.0.5', '1.2.3.4', '999.1.1.1', 'localhost', 'Mixed.Case.Example', 'a\nb', 'a\u0000b', 'a*b.com', 'a:80', 'a/b', 'a+b.com', 'a\\b', 'a=b', 'a;b', 'a@b.com', 'a_b-c.d']
  for (const c of candidates) {
    const accepted = (() => { try { bypassRuleOf({ kind: 'domain-suffix', value: c.toLowerCase() }); return true } catch { return false } })()
    const inSet = hostSetOf({ form: { hosts: { defaults: [] } }, extraHosts: [c] }).hosts.length === 1
    assert.equal(inSet, accepted && !/^\d+(\.\d+){3}$/.test(c) && c !== 'localhost', `${JSON.stringify(c)}: in the set ${inSet}, generator accepts ${accepted}; an address literal and the name \`localhost\` are the two the generator takes and the rule never meets`)
  }
  for (const h of r.hosts) assert.doesNotThrow(() => bypassRuleOf({ kind: 'domain-suffix', value: h }), `whatever the user wrote, \`on\` gets a set the matcher accepts: ${h}`)
})

test('W69 / OPEN 28 hostSetOf: the name `localhost` is said, not counted as captured — the kernel\'s own hosts table has made it 127.0.0.1 before the rules run, so DOMAIN-SUFFIX,localhost never meets it (a relay on this machine by name)', () => {
  const b = box()
  b.put('.kimi-code/config.toml', 'base_url = "http://localhost:8080/v1"\n')
  const r = hostSetOf({ form: KIMI_HOSTS_FORM, readSettings: settingsOf(b.ctx()), extraHosts: ['LocalHost', 'localhost.', 'relay.localhost', 'localhost.example', 'mylocalhost'] })
  assert.deepEqual(r.hosts, [...KIMI_DEFAULTS, 'relay.localhost', 'localhost.example', 'mylocalhost'], 'only the exact name is the one the hosts table turns into an address: a name under it, or beside it, is a name')
  assert.deepEqual(r.dropped, ['localhost', 'localhost.'], 'the name from Kimi\'s settings, said once; the root-dot spelling of it too')
  for (const h of r.hosts) assert.doesNotThrow(() => bypassRuleOf({ kind: 'domain-suffix', value: h }))
  assert.deepEqual(hostSetOf({ form: { hosts: { defaults: ['localhost', 'a.example'] } } }), { hosts: ['a.example'], settings: 'absent', dropped: ['localhost'] }, 'a default host is judged the same way')
})

test('hostSetOf wants a form with a host set, and a reader when the form has settings to read', () => {
  assert.throws(() => hostSetOf({}), TypeError)
  assert.throws(() => hostSetOf({ form: { id: 'x' } }), TypeError, 'a form with no host set is not a host tree')
  assert.throws(() => hostSetOf({ form: { hosts: { defaults: 'a.example' } } }), TypeError)
  assert.throws(() => hostSetOf({ form: KIMI_HOSTS_FORM }), { name: 'TypeError', message: /readSettings/ }, 'a missing reader is not an absent file')
})

// ---------- what route-plan.mjs may touch ----------

const PLAN_SRC = fs.readFileSync(fileURLToPath(new URL('../../../../src/collector/arch/darwin/route-plan.mjs', import.meta.url)), 'utf8')

/** What the file may not do (it computes and reads the files through the ctx it is given): reach the network, the disk, a process or the OS by itself. */
function reaches(src, allowed = ['../../core/upstream-shape.mjs']) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n') // prose in a comment is not a call
  const out = []
  for (const m of code.matchAll(/\bimport\b[^;]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\bimport\s*\(\s*(['"])([^'"]+)\5/g)) {
    const spec = m[2] || m[4] || m[6]
    if (!allowed.includes(spec)) out.push(`imports ${spec}`)
  }
  if (/\brequire\s*\(|\bfetch\s*\(|\bprocess\s*\.|\bchild_process\b|\bwriteFile|\bappendFile|\bunlink|\bspawn\s*\(|\bexecFile(Sync)?\s*\(|\bexecSync\s*\(/.test(code)) out.push('touches the OS, the disk or the network itself')
  return out
}

test('route-plan.mjs imports only the config readers, forms.mjs, upstream.mjs and the rule text generator (the judge of a host name), touches no disk, process, network or OS by itself (the files it reads come through the ctx it is given), and names no harness: its groups are data (W39, MA9)', () => {
  assert.deepEqual(reaches(PLAN_SRC, ['../../core/config-read.mjs', '../../core/upstream-shape.mjs', './forms.mjs', './upstream.mjs']), [])
  assert.ok(reaches("import fs from 'node:fs'\n", ['./forms.mjs']).length > 0, 'the scan can fail')
  assert.ok(reaches("/** the process. */\nconst x = process.platform\n", []).length > 0 && reaches('/** the process. */\nconst x = 1\n', []).length === 0, 'a call is found, prose in a comment is not')
  const code = PLAN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.deepEqual(code.match(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/gi), null, 'the code names no harness (the harness files are the only place that does)')
})
