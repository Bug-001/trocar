// test/collector/core/host-set.test.mjs — hostSetOf, the host set of a host-tree form (4.8 §3.5, OPEN 22; core/host-agent.mjs, moved there from the
// deleted core/route-plan.mjs), and the purity scan of core/entry-forms.mjs (entryGate). The other route-plan pieces went with the old win32
// collector.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, specsOf } from '../../helpers/imports.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { hostSetOf } from '../../../src/collector/core/host-agent.mjs'
import { bypassRuleOf } from '../../../src/collector/core/upstream-shape.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { hostOf } from '../../../src/collector/core/config-read.mjs'

const src = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../../src/collector/${rel}`, import.meta.url)), 'utf8')
const ALL = await loadHarnesses()

test('core/entry-forms.mjs touches no OS, names no harness and imports nothing', () => {
  for (const rel of ['core/entry-forms.mjs']) {
    const text = src(rel)
    const code = stripComments(text)
    assert.deepEqual(specsOf(text).filter((s) => !/^\.\/(config-read|upstream-shape|entry-forms)\.mjs$/.test(s)), [], `${rel} imports only its core neighbours`)
    assert.doesNotMatch(code, /\brequire\s*\(|\bfetch\s*\(|\bprocess\s*\.|\bchild_process\b|\bwriteFile|\breadFile|\bspawn\s*\(|(?<!\.)\bexec(File)?(Sync)?\s*\(/, `${rel} reaches the OS itself`)
    assert.doesNotMatch(code, /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code|win32|darwin)\b/i, `${rel} names a harness or an OS`)
  }
})

/** A sandbox profile: files go in under it; `ctx` is what a harness's `file(ctx)` reads paths from, its reads `{ text, error }` the daemon's way. */
function box() {
  const home = tmpDir('trocar-hosts-')
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const ctx = () => ({
    os: 'win32', home, env: new Map([['USERPROFILE', home]]),
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : { code: e.code, message: e.message } } } },
  })
  return { home, put, ctx }
}

// ---------- hostSetOf: the hosts a host-tree form hands to the engine (4.8 §3.5, OPEN 22; W69 config half) ----------

// The host set's data: the base descriptor's Kimi hosts and its hostTree form, with a test-local relay reader (config.toml's base URLs,
// as kimi-code.mjs reads them); the model's default for a hostTree form (over the descriptor's configHosts) is pinned in proxymode/collector.test.mjs.
const KIMI = ALL.find((d) => d.name === 'kimi-code')
const TOML_URL = /(?:^|[{,])[ \t]*(base_url|[A-Z][A-Z0-9_]*_BASE_URL)[ \t]*=[ \t]*(["'])([^"'\n]+)\2/gm
const KIMI_VSCODE = {
  ...KIMI.proxyMode.forms.find((f) => f.id === 'kimi-code.vscode'),
  hosts: { defaults: [...KIMI.hosts], settings: { file: (ctx) => path.join(ctx.home, '.kimi-code', 'config.toml'), hostsOf: (text) => [...String(text).matchAll(TOML_URL)].map((m) => hostOf(m[3])).filter(Boolean) } },
}
const KIMI_DEFAULTS = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn']
/** `readSettings` the way the daemon gives it: the form's settings file, read through the ctx (`{ text, error }`). */
const settingsOf = (ctx) => () => ctx.readTextOrError(KIMI_VSCODE.hosts.settings.file(ctx))

test('W69 hostSetOf: the host set is the default hosts, then the base URLs of the extension\'s own settings, then the operator\'s extra_hosts — three sources, one injected each, in that order, each name once', () => {
  const b = box()
  const ctx = b.ctx()
  const only = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(ctx) })
  assert.deepEqual(only, { hosts: KIMI_DEFAULTS, settings: 'absent', dropped: [] }, 'no settings file: nothing configured, which is not a failure; the relay is not in the set')
  b.put('.kimi-code/config.toml', '[providers.relay]\nbase_url = "https://relay.example.com/v1"\napi_key = "sk-secret"\n')
  const withRelay = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(ctx) })
  assert.deepEqual(withRelay, { hosts: [...KIMI_DEFAULTS, 'relay.example.com'], settings: 'read', dropped: [] }, 'the relay in Kimi\'s settings is in the set: a connection through it is captured without anyone writing a list')
  assert.equal(JSON.stringify(withRelay).includes('sk-secret'), false)
  const extra = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(box().ctx()), extraHosts: ['gateway.corp.example'] })
  assert.deepEqual(extra.hosts, [...KIMI_DEFAULTS, 'gateway.corp.example'], 'extra_hosts is the third source')
  const all = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(ctx), extraHosts: ['gateway.corp.example', 'API.Moonshot.cn', 'relay.example.com'] })
  assert.deepEqual(all.hosts, [...KIMI_DEFAULTS, 'relay.example.com', 'gateway.corp.example'], 'in this order, and a name that is in the set already (in any case) is not there twice')
  b.put('.kimi-code/config.toml', '')
  assert.deepEqual(hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(ctx) }), { hosts: KIMI_DEFAULTS, settings: 'read', dropped: [] }, 'an empty file is read: it names no relay')
  assert.deepEqual(KIMI_VSCODE.hosts.defaults, KIMI_DEFAULTS, 'the form\'s data is not changed')
})

test('W69 hostSetOf: a settings file that cannot be read or understood is 「不知道」 with a reason from the closed set — the set is then the defaults and extra_hosts, and the caller says so — and a file that is not there is not that', () => {
  const read = (r) => hostSetOf({ form: KIMI_VSCODE, readSettings: () => r, extraHosts: ['x.example'] })
  const denied = read({ text: null, error: { code: 'EACCES', message: 'permission denied, open C:\\Users\\alice\\.kimi-code\\config.toml' } })
  assert.deepEqual(denied, { hosts: [...KIMI_DEFAULTS, 'x.example'], settings: { unreadable: { reason: 'denied', detail: 'EACCES' } }, dropped: [] }, 'the errno, no path (a user name may be in it)')
  assert.deepEqual(read({ text: null, error: { message: 'x' } }).settings, { unreadable: { reason: 'denied' } })
  assert.deepEqual(hostSetOf({ form: KIMI_VSCODE, readSettings: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }) } }).settings, { unreadable: { reason: 'denied', detail: 'EIO' } }, 'a reader that throws is a read that failed, not a throw out of `on`')
  assert.equal(read({ text: null, error: null }).settings, 'absent')
  const odd = { ...KIMI_VSCODE, hosts: { ...KIMI_VSCODE.hosts, settings: { ...KIMI_VSCODE.hosts.settings, hostsOf: () => { throw new Error('this is not TOML') } } } }
  assert.deepEqual(hostSetOf({ form: odd, readSettings: () => ({ text: 'x = [', error: null }) }), { hosts: KIMI_DEFAULTS, settings: { unreadable: { reason: 'unparseable' } }, dropped: [] }, 'a file the reader cannot parse says so, and quotes nothing')
  const notAList = { ...odd, hosts: { ...odd.hosts, settings: { ...odd.hosts.settings, hostsOf: () => 'api.x.com' } } }
  assert.deepEqual(hostSetOf({ form: notAList, readSettings: () => ({ text: 'x', error: null }) }).settings, { unreadable: { reason: 'unparseable' } })
  const none = { ...KIMI_VSCODE, hosts: { defaults: ['a.example'] } }
  assert.deepEqual(hostSetOf({ form: none }), { hosts: ['a.example'], settings: 'absent', dropped: [] }, 'a form with no settings reader has no settings to read')
})

test('W69 hostSetOf: only a name the kernel\'s DOMAIN-SUFFIX rule can match is in the set — an address literal, a wildcard, a name the generator refuses are said (`dropped`), never written and never thrown; and what is in the set is what the generator accepts', () => {
  const b = box()
  b.put('.kimi-code/config.toml', 'base_url = "http://10.0.0.5:8080"\nOTHER_BASE_URL = "https://[::1]:9/v1"\n')
  const r = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(b.ctx()), extraHosts: ['*.corp.example', 'host:443', '', '  Spaced.Example  ', 'a,b', 'ünï.example'] })
  assert.deepEqual(r.hosts, [...KIMI_DEFAULTS, 'spaced.example'])
  assert.deepEqual(r.dropped, ['10.0.0.5', '::1', '*.corp.example', 'host:443', 'a,b', 'ünï.example'], 'a relay by address cannot be matched by a domain rule: it is said, not silently left out')
  // the rule that is applied is the generator\'s own: a table of candidates, judged by the generator and by hostSetOf
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
  const r = hostSetOf({ form: KIMI_VSCODE, readSettings: settingsOf(b.ctx()), extraHosts: ['LocalHost', 'localhost.', 'relay.localhost', 'localhost.example', 'mylocalhost'] })
  assert.deepEqual(r.hosts, [...KIMI_DEFAULTS, 'relay.localhost', 'localhost.example', 'mylocalhost'], 'only the exact name is the one the hosts table turns into an address: a name under it, or beside it, is a name')
  assert.deepEqual(r.dropped, ['localhost', 'localhost.'], 'the name from Kimi\'s settings, said once; the root-dot spelling of it too')
  for (const h of r.hosts) assert.doesNotThrow(() => bypassRuleOf({ kind: 'domain-suffix', value: h }))
  assert.deepEqual(hostSetOf({ form: { hosts: { defaults: ['localhost', 'a.example'] } } }), { hosts: ['a.example'], settings: 'absent', dropped: ['localhost'] }, 'a default host is judged the same way')
})

test('hostSetOf wants a form with a host set, and a reader when the form has settings to read', () => {
  assert.throws(() => hostSetOf({}), TypeError)
  assert.throws(() => hostSetOf({ form: { id: 'x' } }), TypeError, 'a form with no host set is not a host tree')
  assert.throws(() => hostSetOf({ form: { hosts: { defaults: 'a.example' } } }), TypeError)
  assert.throws(() => hostSetOf({ form: KIMI_VSCODE }), { name: 'TypeError', message: /readSettings/ }, 'a missing reader is not an absent file')
})
