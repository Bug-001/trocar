// test/collector/arch/win32/upstream.test.mjs — RFC 4.8 §2.2: the readers of the user's proxy settings the P7 chain takes, and which targets the agent reached directly before asight (W5 readers, W71 watcher, W72 translation half).
// The readers of upstream.mjs only: what an upstream IS is the P7 chain's (test/collector/core/proxymode/chain.test.mjs); the old per-group trunk went with the old win32 collector (D57). Nothing here runs Windows: the helper is an object with a `call`, the clock is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bypassHit, chainSystemProxy, parseProxyText, proxyAddress, proxyAuthOf, readSystemProxy, sameSystemProxy, translateBypass, watchSystemProxy } from '../../../../src/collector/arch/win32/upstream.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { bypassRuleOf } from '../../../../src/collector/core/upstream-shape.mjs'

const W = (text) => translateBypass(text, 'wininet')
const N = (text) => translateBypass(text, 'no-proxy')
const local = { kind: 'local' }
const dom = (value) => ({ kind: 'domain', value })
const suf = (value) => ({ kind: 'domain-suffix', value })
const cidr = (value) => ({ kind: 'ip-cidr', value })

// ---------- W72 (translation half): ProxyOverride and NO_PROXY into the group's bypass table (4.8 §2.2) ----------

test('W72 ProxyOverride: <local>, *.suffix, 10.* ranges and an exact host each become one row, written out literally', () => {
  assert.deepEqual(W('<local>'), { bypass: [local], untranslated: 0 })
  assert.deepEqual(W('*.corp.com'), { bypass: [suf('corp.com')], untranslated: 0 })
  assert.deepEqual(W('10.*'), { bypass: [cidr('10.0.0.0/8')], untranslated: 0 })
  assert.deepEqual(W('192.168.*'), { bypass: [cidr('192.168.0.0/16')], untranslated: 0 })
  assert.deepEqual(W('172.16.*'), { bypass: [cidr('172.16.0.0/16')], untranslated: 0 })
  assert.deepEqual(W('10.1.2.*'), { bypass: [cidr('10.1.2.0/24')], untranslated: 0 })
  assert.deepEqual(W('10.*.*.*'), { bypass: [cidr('10.0.0.0/8')], untranslated: 0 })
  assert.deepEqual(W('10.1.*.*'), { bypass: [cidr('10.1.0.0/16')], untranslated: 0 })
  assert.deepEqual(W('intranet.corp.com'), { bypass: [dom('intranet.corp.com')], untranslated: 0 })
  assert.deepEqual(W('Intranet.Corp.COM'), { bypass: [dom('intranet.corp.com')], untranslated: 0 }, 'a host name is not case-sensitive')
  assert.deepEqual(W('10.1.2.3'), { bypass: [cidr('10.1.2.3/32')], untranslated: 0 }, 'an exact address is a range of one: the kernel sees an address, and a domain rule never matches one')
  assert.deepEqual(W('intranet.'), { bypass: [dom('intranet')], untranslated: 0 }, 'the root dot of a full name')
})

test('W72 a typical Verge ProxyOverride is one table, in the order written, with the loopback name also as its address range', () => {
  const verge = 'localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>'
  const r = W(verge)
  assert.equal(r.untranslated, 0)
  assert.deepEqual(r.bypass.slice(0, 5), [dom('localhost'), cidr('127.0.0.0/8'), cidr('192.168.0.0/16'), cidr('10.0.0.0/8'), cidr('172.16.0.0/16')], '`localhost` is a name AND, on the kernel (whose own hosts table has already made it 127.0.0.1 when the rules run, 4.8 §3.1), the loopback range; `127.*` is that same row, not a second one')
  assert.deepEqual(r.bypass[r.bypass.length - 1], local)
  assert.equal(r.bypass.length, 1 + 1 + 1 + 1 + 16 + 1, 'localhost, 127/8, 192.168/16, 10/8, sixteen 172.x/16, <local>')
})

test('W72 what asight cannot read is not in the table and is counted: a wildcard in the middle, a port, a scheme, an address family it has no rule for, <-loopback>', () => {
  const r = W('*.corp.com;a*b.com;10.*;<local>;*corp.com;corp*;*;http://x.com;host:8080;[::1];::1;<-loopback>;10.1;300.1.2.3;10.*.1.*;例え.jp;-x.com')
  assert.deepEqual(r.bypass, [suf('corp.com'), cidr('10.0.0.0/8'), local])
  assert.equal(r.untranslated, 14, 'every one of the others')
  assert.deepEqual(W(' ; <local> ;; '), { bypass: [local], untranslated: 0 }, 'empty entries are nothing, not unread')
  assert.deepEqual(W(''), { bypass: [], untranslated: 0 })
  assert.deepEqual(W(null), { bypass: [], untranslated: 0 })
  assert.deepEqual(W(undefined), { bypass: [], untranslated: 0 })
  assert.deepEqual(W('10.*;10.*;*.corp.com;*.CORP.com'), { bypass: [cidr('10.0.0.0/8'), suf('corp.com')], untranslated: 0 }, 'one row for what is said twice')
  assert.throws(() => translateBypass(7, 'wininet'), TypeError)
  assert.throws(() => translateBypass('x', 'curl'), TypeError, 'two spellings are read, and the caller says which')
})

test('W72 NO_PROXY: a bare name and a leading dot cover the domain and its subdomains (what curl, Go, Python and undici do), a CIDR is a range, entries split on commas and white space', () => {
  assert.deepEqual(N('localhost,127.0.0.1,::1'), { bypass: [suf('localhost'), cidr('127.0.0.0/8'), cidr('127.0.0.1/32')], untranslated: 1 }, '::1 is not read: there is no IPv6 rule')
  assert.deepEqual(N('.corp.com'), { bypass: [suf('corp.com')], untranslated: 0 })
  assert.deepEqual(N('corp.com'), { bypass: [suf('corp.com')], untranslated: 0 })
  assert.deepEqual(N('*.corp.com'), { bypass: [suf('corp.com')], untranslated: 0 })
  assert.deepEqual(N('10.0.0.0/8, 192.168.0.0/16\t172.16.0.0/12'), { bypass: [cidr('10.0.0.0/8'), cidr('192.168.0.0/16'), cidr('172.16.0.0/12')], untranslated: 0 })
  assert.deepEqual(N('10.1.2.3'), { bypass: [cidr('10.1.2.3/32')], untranslated: 0 })
  assert.deepEqual(N('10.*'), { bypass: [cidr('10.0.0.0/8')], untranslated: 0 })
  assert.deepEqual(N('*'), { bypass: [], untranslated: 1 }, 'everything direct is not a row, and it is said')
  assert.deepEqual(N('host:8080,<local>,10.0.0.0/33,10.0.0.0/x,fe80::/10,10.0.0.256/8'), { bypass: [], untranslated: 6 })
  assert.deepEqual(N('a.com,,b.com'), { bypass: [suf('a.com'), suf('b.com')], untranslated: 0 })
  assert.deepEqual(N(''), { bypass: [], untranslated: 0 })
})

test('W72 whatever translateBypass says is a row, the kernel config generator accepts: no input of the user\'s can make `on` throw', () => {
  const nasty = ['a..b', 'a_b.com', '-x.com', 'x'.repeat(300), `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, '0.0.0.0/0', '255.255.255.255', '1.2.3.4/32', '1.2.3.4.5', '*.', '.', '..', '*.*.com', '*.10.*', 'a b', 'ünï.com', '\u0000', '<local>x', ' <LOCAL> ', 'LOCALHOST', '*.localhost']
  for (const style of ['wininet', 'no-proxy']) {
    for (const t of [...nasty, nasty.join(';'), nasty.join(',')]) {
      const { bypass } = translateBypass(t, style)
      for (const e of bypass) assert.doesNotThrow(() => bypassRuleOf(e), `${style}: ${JSON.stringify(t)} gave ${JSON.stringify(e)}`)
    }
  }
})

// ---------- W72 (matcher): the one test the redirector and the kernel's rules share ----------

test('W72 bypassHit: <local> is a name without a dot, a suffix is the name and its subdomains on a dot boundary, a range holds only IPv4 literals', () => {
  assert.equal(bypassHit([local], 'intranet'), true)
  assert.equal(bypassHit([local], 'Intranet.'), true)
  assert.equal(bypassHit([local], 'localhost'), true)
  assert.equal(bypassHit([local], 'a.b'), false)
  assert.equal(bypassHit([local], '10.1.2.3'), false)
  assert.equal(bypassHit([local], '[::1]'), false)
  assert.equal(bypassHit([local], '::1'), false)
  assert.equal(bypassHit([dom('corp.com')], 'CORP.com'), true)
  assert.equal(bypassHit([dom('corp.com')], 'a.corp.com'), false, 'an exact host is exact')
  for (const h of ['corp.com', 'a.corp.com', 'a.b.corp.com', 'A.Corp.COM']) assert.equal(bypassHit([suf('corp.com')], h), true, h)
  for (const h of ['xcorp.com', 'corp.com.evil.io', 'corp.co', 'orp.com']) assert.equal(bypassHit([suf('corp.com')], h), false, h)
  for (const h of ['10.0.0.0', '10.255.255.255', '10.1.2.3']) assert.equal(bypassHit([cidr('10.0.0.0/8')], h), true, h)
  for (const h of ['11.0.0.0', '9.255.255.255', 'ten.example', '10.1.2.3.4', '10.1.2', '[::ffff:10.1.2.3]']) assert.equal(bypassHit([cidr('10.0.0.0/8')], h), false, h)
  assert.equal(bypassHit([cidr('10.1.2.3/32')], '10.1.2.3'), true)
  assert.equal(bypassHit([cidr('10.1.2.3/32')], '10.1.2.4'), false)
  assert.equal(bypassHit([cidr('172.16.0.0/12')], '172.31.255.255'), true)
  assert.equal(bypassHit([cidr('172.16.0.0/12')], '172.32.0.0'), false)
  assert.equal(bypassHit([cidr('0.0.0.0/0')], '8.8.8.8'), true)
  assert.equal(bypassHit([cidr('10.1.2.3/8')], '10.9.9.9'), true, 'host bits in the range are masked, as the core does')
  assert.equal(bypassHit([cidr('10.0.0.0/8')], '999.1.1.1'), false)
  assert.equal(bypassHit([], 'a.com'), false)
  assert.equal(bypassHit(undefined, 'a.com'), false)
  assert.equal(bypassHit([local], ''), false)
  assert.equal(bypassHit([local], undefined), false)
  assert.equal(bypassHit([dom('a.com'), suf('b.com'), cidr('10.0.0.0/8')], 'x.b.com'), true, 'any row')
})

/** What the core does with one rule line, on a host the way its metadata carries it: a domain for a name, an address for a literal (and then a domain rule has nothing to match). */
function coreMatches(ruleText, host) {
  const [type, payload] = ruleText.split(',')
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (type === 'IP-CIDR') {
    if (!ip) return false
    const [net, bits] = payload.split('/')
    const n = (s) => s.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
    const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
    return ((n(host) & mask) >>> 0) === ((n(net) & mask) >>> 0)
  }
  if (ip || host.includes(':')) return false
  if (type === 'DOMAIN') return host === payload
  if (type === 'DOMAIN-SUFFIX') return host === payload || host.endsWith(`.${payload}`)
  if (type === 'DOMAIN-REGEX') return new RegExp(payload).test(host)
  throw new Error(`a rule the test does not know: ${ruleText}`)
}

test('W72 the matcher the redirector uses and the rule text the kernel gets say the same thing about the same targets (they are one table)', () => {
  const rows = [local, dom('corp.com'), suf('corp.com'), cidr('10.0.0.0/8'), cidr('10.1.2.3/32'), cidr('172.16.0.0/12'), cidr('127.0.0.0/8')]
  const hosts = ['intranet', 'localhost', 'a.b', 'corp.com', 'a.corp.com', 'xcorp.com', 'corp.com.evil.io', '10.1.2.3', '10.1.2.4', '11.0.0.1', '172.16.0.1', '172.32.0.1', '127.0.0.1', '8.8.8.8', 'api.anthropic.com', '999.1.1.1']
  for (const row of rows) {
    for (const h of hosts) assert.equal(bypassHit([row], h), coreMatches(bypassRuleOf(row), h), `${JSON.stringify(row)} on ${h}: the matcher and the rule ${bypassRuleOf(row)} disagree`)
  }
})

// ---------- the system proxy the chain takes, and the topology's hop (4.8 §2.2) ----------

const sys = (o = {}) => ({ ok: true, enable: true, server: '127.0.0.1:7897', override: '<local>', autoConfigUrl: null, ...o })

test('W5 one reading of the system proxy (4.8 §2.2): for `http=a;https=b` the topology hop (proxyAddress) and the chain\'s upstream (chainSystemProxy) are the same address', () => {
  for (const server of ['http=a:1;https=b:2', 'https=b:2;http=a:1', 'http=a:1;10.0.0.9:3128', 'http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808']) {
    const hop = proxyAddress(server), dialed = chainSystemProxy(sys({ server }))
    assert.ok(hop && dialed && dialed.url, server)
    assert.equal(dialed.url, `http://${hop.host}:${hop.port}`, `${server}: the hop shows the proxy asight dials`)
  }
  assert.deepEqual(proxyAddress('http=a:1;https=b:2'), { host: 'b', port: 2 })
  assert.equal(proxyAddress('socks=127.0.0.1:10808'), null, 'a SOCKS-only value is no hop, as it is no upstream')
})

// ---------- the protocols (4.8 §2.2, W5) ----------

test('W5 protocols: http, socks5 and socks5h connect (the last two are one thing); https and socks4 are not routed and say which; the proxy is never swapped for another way out', () => {
  assert.deepEqual(parseProxyText('HTTP://Proxy.Corp:3128/'), { ok: true, kind: 'http', host: 'proxy.corp', port: 3128, credentialed: false })
  assert.deepEqual(parseProxyText('socks5://127.0.0.1:1080'), { ok: true, kind: 'socks5', host: '127.0.0.1', port: 1080, credentialed: false })
  assert.deepEqual(parseProxyText('socks5h://127.0.0.1:1080'), { ok: true, kind: 'socks5', host: '127.0.0.1', port: 1080, credentialed: false })
  assert.deepEqual(parseProxyText('proxy.corp:3128'), { ok: true, kind: 'http', host: 'proxy.corp', port: 3128, credentialed: false }, 'a bare host:port is an HTTP proxy, as curl and the Python clients read it')
  assert.equal(parseProxyText('http://proxy.corp').port, 80)
  assert.equal(parseProxyText('socks5://proxy.corp').port, 1080)
  assert.equal(parseProxyText('http://[::1]:7890').host, '::1', 'an IPv6 address without its brackets, as a socket wants it')
  for (const [text, protocol] of [['https://proxy.corp:443', 'https'], ['socks4://p:1080', 'socks4'], ['socks4a://p:1080', 'socks4a'], ['socks://p:1080', 'socks'], ['ftp://p:21', 'ftp'], ['HTTPS://p:1', 'https']]) {
    assert.deepEqual(parseProxyText(text), { ok: false, why: 'upstream-protocol', protocol }, text)
  }
  for (const text of ['http://', '://x', 'host:abc', 'http://h:99999', 'http://h:0', 'h port', 'http://h\n:80', 'http://h:80\u0000', 'http://:80', '::::']) assert.equal(parseProxyText(text).why, 'upstream-unparseable', JSON.stringify(text))
})

test('W5 credentials: parseProxyText says only that there is a login; proxyAuthOf is the one place that reads it', () => {
  const r = parseProxyText('http://alice:p%40ss%3Aword@proxy.corp:3128/path?x=1')
  assert.deepEqual(r, { ok: true, kind: 'http', host: 'proxy.corp', port: 3128, credentialed: true })
  assert.doesNotMatch(JSON.stringify(r), /alice|p%40ss|p@ss|word/)
  assert.deepEqual(proxyAuthOf('http://alice:p%40ss%3Aword@proxy.corp:3128/path'), { username: 'alice', password: 'p@ss:word' }, 'the one place that reads them, for whoever resolves the reference')
  assert.deepEqual(proxyAuthOf('socks5://bob@proxy.corp'), { username: 'bob', password: '' })
  assert.equal(proxyAuthOf('http://proxy.corp:3128'), null)
  assert.equal(proxyAuthOf('https://alice:x@proxy.corp'), null, 'a proxy asight cannot use has no credentials to lend')
  assert.equal(proxyAuthOf('nonsense'), null)
  assert.equal(parseProxyText('http://alice:@proxy.corp:3128').credentialed, true, 'a name with an empty password is a login')
})

// ---------- the two registry reads (4.8 §1, §2.2, §9) and the watcher (W71, W72) ----------

/** A helper that answers reg-read from a registry that is a plain object, and remembers what it was asked. */
function fakeRegistry(initial) {
  const reg = { internet: { ...initial }, env: {} }
  const calls = []
  const helper = {
    calls,
    async call(verb, args, opts) {
      calls.push({ verb, args, opts })
      if (reg.fail) throw Object.assign(new Error(reg.fail.message ?? 'x'), { code: reg.fail.code })
      if (verb !== 'reg-read') throw new Error(`not asked for: ${verb}`)
      if (regReadAllowed(args) === null) throw Object.assign(new Error('reg-read outside the allow-list'), { code: 'helper-forbidden-key' })
      const src = /Environment$/i.test(args.key) ? reg.env : reg.internet
      if (src === null) return { keyExists: false, values: {} }
      const values = {}
      for (const n of args.names) if (n in src && src[n] !== undefined) values[n] = src[n]
      return reg.answer ?? { keyExists: true, values }
    },
  }
  return { reg, helper }
}
const sz = (value) => ({ kind: 'REG_SZ', value })
const dword = (value) => ({ kind: 'REG_DWORD', value })
const VERGE = { ProxyEnable: dword(1), ProxyServer: sz('127.0.0.1:7897'), ProxyOverride: sz('localhost;<local>') }

test('W71 readSystemProxy asks the four Internet Settings values the helper may read, and gives the answer in the form chainSystemProxy and the watcher take', async () => {
  const { helper } = fakeRegistry(VERGE)
  assert.deepEqual(await readSystemProxy({ helper }), { ok: true, enable: true, server: '127.0.0.1:7897', override: 'localhost;<local>', autoConfigUrl: null })
  assert.equal(helper.calls.length, 1)
  assert.deepEqual(helper.calls[0].args, { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', names: ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'] })
  assert.notEqual(regReadAllowed(helper.calls[0].args), null, 'on the helper\'s allow-list, so no write and no other key is asked')
  for (const [reg, want] of [
    [{ ProxyEnable: dword(0), ProxyServer: sz('127.0.0.1:7897') }, { ok: true, enable: false, server: '127.0.0.1:7897', override: null, autoConfigUrl: null }],
    [{}, { ok: true, enable: null, server: null, override: null, autoConfigUrl: null }],
    [{ ProxyEnable: dword(1), AutoConfigURL: sz('http://wpad/proxy.pac') }, { ok: true, enable: true, server: null, override: null, autoConfigUrl: 'http://wpad/proxy.pac' }],
    [{ ProxyEnable: sz('1'), ProxyServer: { kind: 'REG_EXPAND_SZ', value: '%X%:1' } }, { ok: true, enable: null, server: '%X%:1', override: null, autoConfigUrl: null }], // 4.8 §2.2: only a DWORD 1 is on; text that reads 1 is no DWORD
    [{ ProxyEnable: sz('0'), ProxyServer: sz('127.0.0.1:7897') }, { ok: true, enable: null, server: '127.0.0.1:7897', override: null, autoConfigUrl: null }],
    [{ ProxyEnable: { kind: 'REG_QWORD', value: 1 }, ProxyServer: sz('127.0.0.1:7897') }, { ok: true, enable: null, server: '127.0.0.1:7897', override: null, autoConfigUrl: null }],
    [{ ProxyEnable: { kind: 'REG_BINARY', value: 'AQAAAA==' }, ProxyServer: sz('127.0.0.1:7897') }, { ok: true, enable: null, server: '127.0.0.1:7897', override: null, autoConfigUrl: null }],
    [{ ProxyEnable: dword(1.5), ProxyServer: sz('127.0.0.1:7897') }, { ok: true, enable: null, server: '127.0.0.1:7897', override: null, autoConfigUrl: null }],
    [{ ProxyEnable: dword(7), ProxyServer: dword(5), ProxyOverride: sz('') }, { ok: true, enable: null, server: null, override: '', autoConfigUrl: null }],
  ]) assert.deepEqual(await readSystemProxy({ helper: fakeRegistry(reg).helper }), want)
  const none = fakeRegistry(null)
  none.reg.internet = null
  assert.deepEqual(await readSystemProxy({ helper: none.helper }), { ok: true, enable: null, server: null, override: null, autoConfigUrl: null }, 'a key that is not there is nothing set, and is read')
})

test('W71 an unreadable system proxy is a reason from the closed set, never a throw and never an empty answer: the helper timed out, is gone, refuses, or answers something that is not a registry read', async () => {
  const cases = [[{ code: 'helper-timeout' }, 'timeout'], [{ code: 'helper-down' }, 'absent'], [{ code: 'helper-closed' }, 'absent'], [{ code: 'helper-start-failed' }, 'absent'], [{ code: 'helper-verb-error', message: 'Access to the registry key is denied' }, 'denied']]
  for (const [fail, reason] of cases) {
    const { reg, helper } = fakeRegistry(VERGE)
    reg.fail = fail
    assert.deepEqual(await readSystemProxy({ helper }), { ok: false, reason, detail: fail.code })
  }
  const bad = fakeRegistry(VERGE)
  bad.reg.answer = { nope: 1 }
  assert.deepEqual(await readSystemProxy({ helper: bad.helper }), { ok: false, reason: 'unparseable', detail: 'answer' })
  bad.reg.answer = 'garbage'
  assert.equal((await readSystemProxy({ helper: bad.helper })).reason, 'unparseable')
})

test('W71 sameSystemProxy compares the four values (a missing one is null); two unreadable answers are the same whatever the reason', () => {
  const a = { ok: true, enable: true, server: 'x:1', override: 'o', autoConfigUrl: null }
  assert.equal(sameSystemProxy(a, { ...a }), true)
  assert.equal(sameSystemProxy(a, { ok: true, enable: true, server: 'x:1', override: 'o' }), true, 'undefined is null')
  for (const k of ['enable', 'server', 'override', 'autoConfigUrl']) assert.equal(sameSystemProxy(a, { ...a, [k]: k === 'enable' ? false : 'changed' }), false, k)
  assert.equal(sameSystemProxy({ ok: false, reason: 'timeout' }, { ok: false, reason: 'denied' }), true)
  assert.equal(sameSystemProxy(a, { ok: false, reason: 'timeout' }), false)
  assert.equal(sameSystemProxy({ ok: false, reason: 'timeout' }, a), false)
})

/** A clock the test drives: setInterval / clearInterval that run when the test says so. */
function fakeTimers() {
  const live = new Map()
  const set = []
  let n = 0
  return {
    live,
    set,
    timers: { setInterval(fn, ms) { const id = ++n; live.set(id, fn); set.push(ms); return { id, unref() {} } }, clearInterval(t) { live.delete(t.id) } },
    async tick() { for (const fn of [...live.values()]) await fn() },
  }
}
const settle = () => new Promise((r) => setImmediate(r))

test('W71 watchSystemProxy: the first read is the baseline, no event; a change of the server, the switch, the override or the script address alone is one `change` with what differs', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  const clock = fakeTimers()
  const seen = []
  const w = watchSystemProxy({ helper, timers: clock.timers })
  w.on('change', (e) => seen.push(e))
  await w.ready
  assert.deepEqual(clock.set, [5000], 'every five seconds')
  assert.equal(helper.calls.length, 1)
  await clock.tick()
  assert.equal(seen.length, 0, 'nothing changed')
  reg.internet.ProxyServer = sz('127.0.0.1:7890')
  await clock.tick()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].changed, ['ProxyServer'])
  assert.equal(seen[0].before.server, '127.0.0.1:7897')
  assert.equal(seen[0].after.server, '127.0.0.1:7890')
  await clock.tick()
  assert.equal(seen.length, 1, 'the baseline moved with it')
  reg.internet.ProxyOverride = sz('localhost;10.*;<local>')
  await clock.tick()
  assert.deepEqual(seen[1].changed, ['ProxyOverride'], 'ProxyOverride alone is a change (W72)')
  reg.internet.ProxyEnable = dword(0)
  await clock.tick()
  assert.deepEqual(seen[2].changed, ['ProxyEnable'])
  reg.internet.AutoConfigURL = sz('http://wpad/proxy.pac')
  await clock.tick()
  assert.deepEqual(seen[3].changed, ['AutoConfigURL'])
  w.stop()
})

test('W71 a read that fails is a change to 「unreadable」 once, and the way back is a change once; two failures in a row are not a change; a read still running is not doubled', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  const clock = fakeTimers()
  const seen = []
  const w = watchSystemProxy({ helper, timers: clock.timers })
  w.on('change', (e) => seen.push(e))
  await w.ready
  reg.fail = { code: 'helper-timeout' }
  await clock.tick()
  await clock.tick()
  reg.fail = { code: 'helper-down' }
  await clock.tick()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].after.ok, false)
  assert.deepEqual(seen[0].changed, ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'], 'unreadable: nothing can be said to be the same')
  reg.fail = null
  await clock.tick()
  assert.equal(seen.length, 2)
  assert.equal(seen[1].after.ok, true)
  // a read that has not come back when the next tick fires is waited for, not repeated
  let release
  const slow = { calls: 0, async call() { slow.calls++; await new Promise((r) => { release = r }); return { keyExists: true, values: {} } } }
  const w2 = watchSystemProxy({ helper: slow, initial: { ok: true, enable: null, server: null, override: null, autoConfigUrl: null }, timers: clock.timers })
  const first = w2.poll()
  const second = w2.poll()
  await settle()
  assert.equal(slow.calls, 1)
  release()
  await Promise.all([first, second])
  assert.equal(slow.calls, 1)
  w.stop()
  w2.stop()
})

test('W71 watchSystemProxy sends no read while a reg-read that timed out is still out at the helper (4.8 §1: the helper is serial, a new one only queues behind it); the first tick after the late answer reads again', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  let out = 0 // what helper.abandoned('reg-read') says: calls that timed out and whose late answer has not come
  const call = helper.call.bind(helper)
  helper.call = async (...a) => { try { return await call(...a) } catch (e) { if (e.code === 'helper-timeout') out++; throw e } } // as the real client counts a timed-out call
  helper.abandoned = (verb) => (verb === 'reg-read' ? out : 0)
  const clock = fakeTimers()
  const seen = []
  const w = watchSystemProxy({ helper, timers: clock.timers })
  w.on('change', (e) => seen.push(e))
  await w.ready
  assert.equal(helper.calls.length, 1, 'the baseline')
  reg.fail = { code: 'helper-timeout' } // a slow CIM `ps` holds the helper: the read queued behind it times out
  await clock.tick()
  assert.equal(helper.calls.length, 2)
  assert.deepEqual([seen.length, seen[0].after.ok], [1, false], 'this one read did time out: one change to unreadable (the spec\'s own reading of a timeout)')
  for (let i = 0; i < 4; i++) await clock.tick()
  assert.equal(helper.calls.length, 2, 'four more ticks while it is out: not one more read queued behind it')
  assert.equal(await w.poll(), false, 'a poll by hand is skipped too')
  assert.equal(seen.length, 1, 'and nothing said')
  reg.internet.ProxyServer = sz('127.0.0.1:7890') // the registry moves meanwhile: nobody can see it yet
  reg.fail = null
  out = 0 // the helper answered the late one
  await clock.tick()
  assert.equal(helper.calls.length, 3, 'the first free tick reads')
  assert.equal(seen.length, 2)
  assert.deepEqual([seen[1].before.ok, seen[1].after.ok, seen[1].after.server], [false, true, '127.0.0.1:7890'], 'the way back, with what it found')
  // before there is a baseline: nothing is read until the helper is free, and then the baseline is taken (no event)
  out = 1
  const w2 = watchSystemProxy({ helper, timers: clock.timers })
  const early = []
  w2.on('change', (e) => early.push(e))
  assert.equal(await w2.ready, false)
  assert.equal(helper.calls.length, 3, 'no baseline read while one is out')
  out = 0
  await clock.tick()
  assert.equal(w2.last().server, '127.0.0.1:7890', 'the baseline, once the helper is free')
  assert.equal(early.length, 0, 'a baseline is no event')
  // a helper with no `abandoned` (the daemon\'s own fakes, an old client) is read as before
  const plain = fakeRegistry(VERGE)
  const w3 = watchSystemProxy({ helper: plain.helper, timers: clock.timers })
  await w3.ready
  await clock.tick()
  assert.ok(plain.helper.calls.length >= 2)
  w.stop(); w2.stop(); w3.stop()
})

test('W71 watchSystemProxy: a baseline the caller already read is used (a change between its read and the first tick is not lost), stop() ends the reads and the events, a listener that throws costs the others nothing', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  const clock = fakeTimers()
  const initial = await readSystemProxy({ helper })
  reg.internet.ProxyServer = sz('127.0.0.1:7890') // moved after the caller's read
  const errors = []
  const seen = []
  const w = watchSystemProxy({ helper, initial, timers: clock.timers, onError: (e) => errors.push(e) })
  w.on('change', () => { throw new Error('a listener bug') })
  w.on('change', (e) => seen.push(e))
  assert.equal(helper.calls.length, 1, 'no baseline read of its own')
  await clock.tick()
  assert.equal(seen.length, 1, 'the second listener still heard it')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /a listener bug/)
  w.stop()
  assert.equal(clock.live.size, 0, 'the timer is cleared')
  reg.internet.ProxyServer = sz('127.0.0.1:1')
  const before = helper.calls.length
  await w.poll()
  assert.equal(helper.calls.length, before, 'a stopped watcher reads nothing')
  assert.equal(seen.length, 1)
  // a read that is still out when stop() comes is dropped: no event after the stop
  let release
  const slow = { async call() { await new Promise((r) => { release = r }); return { keyExists: true, values: { ProxyEnable: dword(1), ProxyServer: sz('x:1') } } } }
  const late = []
  const w2 = watchSystemProxy({ helper: slow, initial: { ok: true, enable: null, server: null, override: null, autoConfigUrl: null }, timers: clock.timers })
  w2.on('change', (e) => late.push(e))
  const inflight = w2.poll()
  w2.stop()
  release()
  assert.equal(await inflight, false)
  assert.equal(late.length, 0)
})

test('W71 end to end: the registry moves its port, the watcher says so, and the chain\'s system proxy is the new one', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  const clock = fakeTimers()
  const w = watchSystemProxy({ helper, initial: await readSystemProxy({ helper }), timers: clock.timers })
  const changes = []
  w.on('change', (e) => changes.push(e))
  assert.equal(chainSystemProxy(await readSystemProxy({ helper })).url, 'http://127.0.0.1:7897')
  reg.internet.ProxyServer = sz('127.0.0.1:7890')
  await clock.tick()
  assert.equal(changes.length, 1)
  assert.equal(chainSystemProxy(changes[0].after).url, 'http://127.0.0.1:7890')
  reg.internet.AutoConfigURL = sz('http://wpad/proxy.pac')
  await clock.tick()
  assert.deepEqual(chainSystemProxy(changes[1].after), { pac: true }, 'a PAC is said, never run')
  w.stop()
})

// ---------- what upstream.mjs may touch ----------

const UPSTREAM_SRC = fs.readFileSync(fileURLToPath(new URL('../../../../src/collector/arch/win32/upstream.mjs', import.meta.url)), 'utf8')
/** What the file may not do (it computes and reads the registry through the helper it is given): reach the network, the disk, a process or the OS by itself. */
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

test('upstream.mjs imports only the rule text generator and names no network, disk, process or OS call: its inputs are data and a helper it is handed (W39: loadArch(\'win32\') is importable anywhere)', () => {
  assert.deepEqual(reaches(UPSTREAM_SRC), [])
  assert.ok(reaches("import https from 'node:https'\n").length > 0, 'the scan can fail: an import')
  assert.ok(reaches("import('node:fs')\n").length > 0, 'a dynamic import')
  assert.ok(reaches('const x = process.platform\n').length > 0, 'the OS')
  assert.ok(reaches('await fetch(u)\n').length > 0, 'the network')
  assert.ok(reaches("import fs from 'node:fs'\nfs.writeFileSync(a, b)\n").length > 0, 'the disk')
})
