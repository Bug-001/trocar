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
    ['opencode', 'opencode.cli', ['opencode.cli', 'opencode.desktop']],
    ['z-code', 'z-code.cli', ['z-code.cli', 'z-code.desktop']],
  ])
  assert.ok(GROUPS.every((x) => x.group.g === x.g && x.proxy && Array.isArray(x.proxy.env) && Array.isArray(x.proxy.branches)), 'the group data and the harness\'s `proxy` (the variables it reads, its branches) is what upstreamFor is given')
  for (const id of ['hermes.desktop', 'codex.app', 'kimi-code.vscode']) {
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
      if (e.kind === 'text') applyTextEntry({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness, file: e.path, edit: e })
      else applyJsonKey({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness, file: e.path, keys: e.keys, value: e.value })
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
  applyJsonKey({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
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
  for (const e of proxyEntries(codex.group, install, ingress)) applyTextEntry({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness: 'codex', file: e.path, edit: e })
  for (const e of proxyEntries(claude.group, install, ingress)) applyJsonKey({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
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
  applyJsonKey({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
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
  applyJsonKey({ phase: 'on', dir: b.dir, home: b.home, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  const after = plan(b, { manifest: m })
  assert.deepEqual(after['claude-code.settings'], p['claude-code.settings'])
  const blind = plan(b)
  assert.equal(blind['claude-code.settings'].reason, 'route-loop', 'without the manifest, the file says asight\'s own address: a loop, said so, nothing dialled')
})

