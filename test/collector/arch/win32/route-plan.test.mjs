// test/collector/arch/win32/route-plan.test.mjs — RFC 4.8 §2.2: what a group's upstream is and which targets its agent reached directly before asight (W5 upstream half, W71 rule half, W72 translation half).
// Task 6b owns the rules of upstream.mjs; Task 8(a) appends the route plan (planRoutes, priorOf, hostSetOf) that applies them to the groups. Nothing here runs Windows: the helper is an object with a `call`, the clock is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bypassHit, parseProxyText, proxyAddress, proxyAuthOf, readHkcuEnv, readSystemProxy, sameSystemProxy, translateBypass, upstreamFor, watchSystemProxy } from '../../../../src/collector/arch/win32/upstream.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { bypassRuleOf, upstreamOf } from '../../../../src/collector/core/upstream-shape.mjs'
import { groupsOf, hostSetOf, planRoutes, priorOf, resolveLogin } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { applyJsonKey, applyTextEntry, newManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { proxyEntries } from '../../../../src/collector/arch/win32/forms.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
// the groups, as the harness files declare them (arch/ never imports harness/; a test may, to pin the rule to the real data)
import claudeCode from '../../../../src/collector/harness/win32/claude-code.mjs'
import codex from '../../../../src/collector/harness/win32/codex.mjs'
import hermes from '../../../../src/collector/harness/win32/hermes.mjs'
import zCode from '../../../../src/collector/harness/win32/z-code.mjs'

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

// ---------- the groups as the harness files declare them ----------


const groupOf = (h, g) => h.groups.find((x) => x.g === g)
const CODEX = { group: groupOf(codex, 'codex.env'), envNames: codex.proxy.env, branches: codex.proxy.branches } // follows the system proxy for HTTP, not for its WebSocket
const HERMES = { group: groupOf(hermes, 'hermes.cli'), envNames: hermes.proxy.env, branches: hermes.proxy.branches } // follows the system proxy, has no WebSocket branch
const CLAUDE = { group: groupOf(claudeCode, 'claude-code.settings'), envNames: claudeCode.proxy.env, branches: claudeCode.proxy.branches } // does not follow it
const DESKTOP = { group: groupOf(claudeCode, 'claude-code.desktop'), envNames: claudeCode.proxy.env, branches: claudeCode.proxy.branches } // follows it, its entry takes no credentials
const ZCODE = { group: groupOf(zCode, 'z-code.cli'), envNames: zCode.proxy.env, branches: zCode.proxy.branches } // reads a variable of its own, not one of the login environment's
const OWN = [17990, 17991, 17992]
const sys = (o = {}) => ({ ok: true, enable: true, server: '127.0.0.1:7897', override: '<local>', autoConfigUrl: null, ...o })
const direct = { kind: 'direct', source: 'direct', bypass: [], untranslated: 0, envUnreadable: true }
const via = (host, port, extra = {}) => ({ kind: 'http', host, port, source: 'system-proxy', bypass: [local], untranslated: 0, envUnreadable: true, ...extra })
const up = (who, o = {}) => upstreamFor({ ...who, ownPorts: OWN, ...o })

// ---------- W5 (upstream half): the table of 4.8 §2.2, every cell as a literal ----------

test('W5 §2.2 table: Verge, system proxy on, TUN off: a follower takes the system proxy, one that does not goes direct, one with its own proxy keeps it', () => {
  assert.deepEqual(up(CODEX, { systemProxy: sys() }), via('127.0.0.1', 7897, { egressDiffers: true }))
  assert.deepEqual(up(HERMES, { systemProxy: sys() }), via('127.0.0.1', 7897))
  assert.deepEqual(up(CLAUDE, { systemProxy: sys() }), direct)
  assert.deepEqual(up(CLAUDE, { systemProxy: sys(), prior: 'http://proxy.corp:3128' }), { kind: 'http', host: 'proxy.corp', port: 3128, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.deepEqual(up(CODEX, { systemProxy: sys(), prior: 'http://proxy.corp:3128', noProxy: 'localhost,.corp.com' }), { kind: 'http', host: 'proxy.corp', port: 3128, source: 'agent', bypass: [suf('localhost'), cidr('127.0.0.0/8'), suf('corp.com')], untranslated: 0, envUnreadable: false }, 'its own proxy beats the system proxy, with its own NO_PROXY as the bypass table, not the system proxy\'s ProxyOverride')
})

test('W5 §2.2 table: Verge with TUN on, v2rayN, another TUN VPN, no VPN: only the system proxy setting decides, never which product it is', () => {
  // TUN on, the system proxy still on: the same as TUN off; the system proxy off: direct, into the TUN
  assert.deepEqual(up(HERMES, { systemProxy: sys() }), via('127.0.0.1', 7897))
  assert.deepEqual(up(HERMES, { systemProxy: sys({ enable: false }) }), direct)
  assert.deepEqual(up(CLAUDE, { systemProxy: sys({ enable: false }) }), direct)
  // v2rayN writes the protocols apart: https= is the one an HTTPS request takes
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808' }) }), via('127.0.0.1', 10809))
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'socks=127.0.0.1:10808;https=127.0.0.1:10809;http=127.0.0.1:10810' }) }), via('127.0.0.1', 10809), 'https= first, wherever it stands')
  // another TUN VPN or none: the system proxy is off or absent
  assert.deepEqual(up(CODEX, { systemProxy: { ok: true, enable: null, server: null, override: null, autoConfigUrl: null } }), direct, 'no value is off')
  assert.deepEqual(up(CODEX, { systemProxy: sys({ enable: false, server: '127.0.0.1:7897' }) }), direct, 'a server left in the registry while the switch is off is not followed')
  assert.deepEqual(up(CODEX, { systemProxy: sys({ server: '' }) }), direct, 'switched on with no server is no proxy')
})

test('W5 §2.2 table: a PAC is not followed — a follower is not routed, the others go on as they would; `on` never runs a script', () => {
  const pac = sys({ autoConfigUrl: 'http://wpad.corp/proxy.pac' })
  assert.deepEqual(up(CODEX, { systemProxy: pac }), { source: 'system-proxy', reason: 'not-routed', why: 'system-proxy-pac', bypass: [], untranslated: 0, envUnreadable: true })
  // 4.8 §2.2 reads any non-empty AutoConfigURL as a PAC, whatever ProxyEnable says. That is the spec's ASSUMPTION, not a measurement: whether turning the setup script off leaves its old address in the value is unmeasured (4.8 OPEN 27, Task 11).
  // If it does, a user with the manual proxy on and a stale address would get this answer, which fails closed with a reason that is not the real one.
  assert.deepEqual(up(HERMES, { systemProxy: sys({ enable: false, autoConfigUrl: 'http://wpad/p.pac' }) }).why, 'system-proxy-pac', 'the rule as written (an assumption, OPEN 27): an address in AutoConfigURL is a PAC whether or not the manual proxy is also switched on')
  assert.equal(up(HERMES, { systemProxy: pac }).reason, 'not-routed')
  assert.deepEqual(up(CLAUDE, { systemProxy: pac }), direct, 'a group that does not follow the system proxy does not care')
  assert.equal(up(CLAUDE, { systemProxy: pac, prior: 'http://proxy.corp:3128' }).source, 'agent')
  assert.equal(up(CODEX, { systemProxy: pac, prior: 'http://proxy.corp:3128' }).kind, 'http', 'nor does one with a proxy of its own')
  assert.equal(up(CODEX, { systemProxy: sys({ autoConfigUrl: '   ' }) }).kind, 'http', 'an empty script address is none')
})

test('W5 a system proxy that cannot be read is 「不知道」 with a reason: a follower is not routed (never a guess at direct), the others are unaffected', () => {
  const r = up(CODEX, { systemProxy: { ok: false, reason: 'timeout' } })
  assert.deepEqual(r, { source: 'system-proxy', reason: 'not-routed', why: 'system-proxy-unreadable', detail: 'timeout', bypass: [], untranslated: 0, envUnreadable: true })
  assert.equal(up(CODEX, { systemProxy: null }).why, 'system-proxy-unreadable', 'not asked is not read either')
  assert.equal(up(CODEX, { systemProxy: { ok: false } }).detail, 'absent')
  assert.deepEqual(up(CLAUDE, { systemProxy: { ok: false, reason: 'denied' } }), direct)
})

test('W5 one reading of the system proxy (4.8 §2.2): for `http=a;https=b` the topology hop (proxyAddress) and the dialed upstream (upstreamFor) are the same address', () => {
  for (const server of ['http=a:1;https=b:2', 'https=b:2;http=a:1', 'http=a:1;10.0.0.9:3128', 'http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808']) {
    const hop = proxyAddress(server), dialed = up(HERMES, { systemProxy: sys({ server }) })
    assert.ok(hop && dialed.kind === 'http', server)
    assert.deepEqual({ host: hop.host, port: hop.port }, { host: dialed.host, port: dialed.port }, `${server}: the hop shows the proxy asight dials`)
  }
  assert.deepEqual(proxyAddress('http=a:1;https=b:2'), { host: 'b', port: 2 })
  assert.equal(proxyAddress('socks=127.0.0.1:10808'), null, 'a SOCKS-only value is no hop, as it is no upstream')
})

test('W5 the ProxyServer string: https= first, then the one entry for every protocol; nothing for HTTPS is direct; a SOCKS entry alone, a TLS proxy or a mess is not routed', () => {
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: ' http=a:1 ; 10.0.0.9:3128 ; https=b:2 ' }) }), via('b', 2))
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'http=a:1;10.0.0.9:3128' }) }), via('10.0.0.9', 3128), 'no https=: the entry that has no protocol')
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'http://proxy.corp:8080' }) }), via('proxy.corp', 8080), 'a scheme on the entry')
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'http=a:1;ftp=c:3' }) }), direct, 'WinINET does not proxy an HTTPS request when only http= and ftp= are named: neither does asight')
  assert.deepEqual(up(HERMES, { systemProxy: sys({ server: 'socks=127.0.0.1:10808' }) }), { source: 'system-proxy', reason: 'not-routed', why: 'upstream-protocol', protocol: 'socks', bypass: [], untranslated: 0, envUnreadable: true })
  assert.equal(up(HERMES, { systemProxy: sys({ server: 'https=https://proxy:443' }) }).protocol, 'https')
  assert.equal(up(HERMES, { systemProxy: sys({ server: 'https=host:notaport' }) }).why, 'upstream-unparseable')
  assert.equal(up(HERMES, { systemProxy: sys({ server: ';;;' }) }).kind, 'direct')
  const login = up(HERMES, { systemProxy: sys({ server: 'https=u:p@proxy:8080' }) })
  assert.deepEqual([login.reason, login.why, login.detail], ['not-routed', 'upstream-unparseable', 'credentials-in-system-proxy'], 'WinINET takes no credentials from this value, so a client that read them would not be the one that ran before asight')
})

test('W5 egress-differs: a follower whose WebSocket did not follow (the harness declares a ws branch) is told its one upstream is now the way out of both; nobody else is', () => {
  assert.equal(up(CODEX, { systemProxy: sys() }).egressDiffers, true)
  assert.equal(up(HERMES, { systemProxy: sys() }).egressDiffers, undefined, 'Hermes follows the system proxy and has no WebSocket branch to differ')
  assert.equal(up(DESKTOP, { systemProxy: sys() }).egressDiffers, undefined)
  assert.equal(up(CODEX, { systemProxy: sys({ enable: false }) }).egressDiffers, undefined, 'direct for both before and after')
  assert.equal(up(CODEX, { systemProxy: sys(), prior: 'http://proxy.corp:3128' }).egressDiffers, undefined, 'its own proxy takes both')
  assert.equal(upstreamFor({ group: CODEX.group, systemProxy: sys(), ownPorts: OWN }).egressDiffers, undefined, 'without the harness\'s branches there is no WebSocket to differ')
})

test('W5 the agent\'s own proxy: the value its entry held, else the login environment\'s variable the harness names; the value of the entry wins', () => {
  const env = (values) => ({ ok: true, values })
  assert.deepEqual(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888' }) }), { kind: 'http', host: 'envproxy', port: 8888, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.equal(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888' }), prior: 'http://file:1' }).host, 'file', 'the entry first')
  assert.equal(up(CLAUDE, { hkcuEnv: env({ HTTP_PROXY: 'http://h:1', ALL_PROXY: 'http://a:2' }) }).host, 'h', 'the harness lists HTTPS_PROXY, then HTTP_PROXY: the first it names that is set')
  assert.equal(up(CODEX, { hkcuEnv: env({ HTTP_PROXY: 'http://h:1', ALL_PROXY: 'http://a:2' }) }).host, 'a', 'Codex names ALL_PROXY before HTTP_PROXY')
  assert.equal(up(ZCODE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888' }) }).kind, 'direct', 'a harness that reads a variable of its own (ZCODE_HTTP_PROXY) is not told by the login environment\'s')
  assert.equal(up(ZCODE, { hkcuEnv: env({ ZCODE_HTTP_PROXY: 'http://zz:1' }) }).kind, 'direct', 'and what asight reads of the login environment is those three proxy variables, whatever a caller hands in')
  assert.equal(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: '   ' }) }).kind, 'direct', 'a blank variable is none')
  assert.deepEqual(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888', NO_PROXY: '.corp.com' }) }).bypass, [suf('corp.com')], 'the login environment\'s NO_PROXY goes with its proxy')
  assert.deepEqual(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888', NO_PROXY: '.corp.com' }), noProxy: '.file.com' }).bypass, [suf('file.com')], 'and the entry\'s with the entry\'s')
  assert.equal(up(CLAUDE, { hkcuEnv: env({ HTTPS_PROXY: 'http://envproxy:8888' }), systemProxy: sys() }).source, 'agent')
  const unread = up(CLAUDE, { hkcuEnv: { ok: false, reason: 'timeout' } })
  assert.deepEqual(unread, { ...direct, unknown: [{ what: 'login-environment', reason: 'timeout' }] }, 'not read is said, and the rule goes on without it')
  assert.equal(up(CLAUDE, { hkcuEnv: { ok: false }, prior: 'http://file:1' }).unknown, undefined, 'a proxy the entry names makes the unread login environment not matter')
})

test('W5 envUnreadable: every group whose upstream is not the agent\'s own proxy says a proxy set only in the user\'s terminal is invisible', () => {
  for (const [who, o] of [[CLAUDE, {}], [CODEX, { systemProxy: sys() }], [CODEX, { systemProxy: sys({ enable: false }) }], [HERMES, { systemProxy: sys({ autoConfigUrl: 'http://p' }) }], [HERMES, { systemProxy: { ok: false } }]]) assert.equal(up(who, o).envUnreadable, true)
  assert.equal(up(CLAUDE, { prior: 'http://proxy.corp:3128' }).envUnreadable, false)
  assert.equal(up(CLAUDE, { hkcuEnv: { ok: true, values: { HTTPS_PROXY: 'http://e:1' } } }).envUnreadable, false)
  assert.equal(up(CLAUDE, { prior: 'https://proxy.corp:3128' }).envUnreadable, false, 'a proxy the agent has, even one asight cannot use')
})

// ---------- the protocols (4.8 §2.2, W5) ----------

test('W5 protocols: http, socks5 and socks5h connect (the last two are one thing); https and socks4 are not routed and say which; the proxy is never swapped for another way out', () => {
  assert.deepEqual(up(CLAUDE, { prior: 'http://proxy.corp:3128' }).kind, 'http')
  assert.deepEqual(up(CLAUDE, { prior: 'HTTP://Proxy.Corp:3128/' }), { kind: 'http', host: 'proxy.corp', port: 3128, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.deepEqual(up(CLAUDE, { prior: 'socks5://127.0.0.1:1080' }), { kind: 'socks5', host: '127.0.0.1', port: 1080, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.deepEqual(up(CLAUDE, { prior: 'socks5h://127.0.0.1:1080' }), { kind: 'socks5', host: '127.0.0.1', port: 1080, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.deepEqual(up(CLAUDE, { prior: 'proxy.corp:3128' }), { kind: 'http', host: 'proxy.corp', port: 3128, source: 'agent', bypass: [], untranslated: 0, envUnreadable: false }, 'a bare host:port is an HTTP proxy, as curl and the Python clients read it')
  assert.equal(up(CLAUDE, { prior: 'http://proxy.corp' }).port, 80)
  assert.equal(up(CLAUDE, { prior: 'socks5://proxy.corp' }).port, 1080)
  assert.equal(up(CLAUDE, { prior: 'http://[::1]:7890' }).host, '::1', 'an IPv6 address without its brackets, as a socket wants it')
  for (const [text, protocol] of [['https://proxy.corp:443', 'https'], ['socks4://p:1080', 'socks4'], ['socks4a://p:1080', 'socks4a'], ['socks://p:1080', 'socks'], ['ftp://p:21', 'ftp'], ['HTTPS://p:1', 'https']]) {
    assert.deepEqual(up(CLAUDE, { prior: text }), { source: 'agent', reason: 'not-routed', why: 'upstream-protocol', protocol, bypass: [], untranslated: 0, envUnreadable: false }, text)
  }
  for (const text of ['http://', '://x', 'host:abc', 'http://h:99999', 'http://h:0', 'h port', 'http://h\n:80', 'http://h:80\u0000', 'http://:80', '::::']) assert.equal(up(CLAUDE, { prior: text }).why, 'upstream-unparseable', JSON.stringify(text))
})

test('W5 credentials are a reference: the upstream names where they live, and neither the name nor the secret is in what status, the plan or a record could print', () => {
  const r = up(CLAUDE, { prior: 'http://alice:p%40ss%3Aword@proxy.corp:3128/path?x=1' })
  assert.deepEqual(r, { kind: 'http', host: 'proxy.corp', port: 3128, credentialed: true, auth_ref: 'prior:claude-code.settings', source: 'agent', bypass: [], untranslated: 0, envUnreadable: false })
  assert.doesNotMatch(JSON.stringify(r), /alice|p%40ss|p@ss|word/)
  assert.deepEqual(proxyAuthOf('http://alice:p%40ss%3Aword@proxy.corp:3128/path'), { username: 'alice', password: 'p@ss:word' }, 'the one place that reads them, for whoever resolves the reference')
  assert.deepEqual(proxyAuthOf('socks5://bob@proxy.corp'), { username: 'bob', password: '' })
  assert.equal(proxyAuthOf('http://proxy.corp:3128'), null)
  assert.equal(proxyAuthOf('https://alice:x@proxy.corp'), null, 'a proxy asight cannot use has no credentials to lend')
  assert.equal(proxyAuthOf('nonsense'), null)
  const e = up(CLAUDE, { hkcuEnv: { ok: true, values: { HTTPS_PROXY: 'http://carol:secret@envproxy:8888' } } })
  assert.equal(e.auth_ref, 'hkcu-env:HTTPS_PROXY')
  assert.doesNotMatch(JSON.stringify(e), /carol|secret/)
  assert.equal(up(CLAUDE, { prior: 'http://proxy.corp:3128' }).credentialed, undefined)
  assert.equal(up(CLAUDE, { prior: 'http://alice:@proxy.corp:3128' }).credentialed, true, 'a name with an empty password is a login')
  assert.deepEqual(parseProxyText('http://alice:x@proxy.corp:3128'), { ok: true, kind: 'http', host: 'proxy.corp', port: 3128, credentialed: true })
})

// ---------- the loop: an upstream that is asight's own port (4.8 §2.2, W8) ----------

test('W8 an upstream that is one of asight\'s own ports is a route loop, whichever way the loopback is written, and not for another host or another port', () => {
  for (const text of ['http://127.0.0.1:17991', 'http://localhost:17990', 'socks5://[::1]:17992', 'http://127.0.0.2:17991', 'http://LOCALHOST:17991/', 'claude-code.settings:token@127.0.0.1:17991', 'http://claude-code.settings:abcdefabcdefabcd@127.0.0.1:17991']) {
    const r = up(CLAUDE, { prior: text })
    assert.deepEqual([r.reason, r.kind], ['route-loop', undefined], text)
  }
  assert.equal(up(CLAUDE, { prior: 'http://127.0.0.1:7897' }).kind, 'http', 'another port')
  assert.equal(up(CLAUDE, { prior: 'http://proxy.corp:17991' }).kind, 'http', 'another machine\'s port')
    assert.equal(upstreamFor({ group: CLAUDE.group, prior: 'http://127.0.0.1:17991', ownPorts: [] }).kind, 'http', 'no own ports given, none to loop on')
  const sp = up(HERMES, { systemProxy: sys({ server: '127.0.0.1:17992' }) })
  assert.deepEqual([sp.reason, sp.source, sp.kind], ['route-loop', 'system-proxy', undefined], 'a system proxy that points at asight\'s own port, which a stale entry left')
  assert.equal(up(CLAUDE, { hkcuEnv: { ok: true, values: { HTTPS_PROXY: 'http://127.0.0.1:17990' } } }).reason, 'route-loop')
})

// ---------- W71 (rule half): the system proxy changed, and only its followers follow ----------

test('W71 a changed system proxy gives a follower a new upstream and a new table; a group that does not follow gives the same answer as before', () => {
  const a = sys({ server: '127.0.0.1:7897', override: 'localhost;<local>' })
  const b = sys({ server: '127.0.0.1:7890', override: 'localhost;<local>' })
  const c = sys({ server: '127.0.0.1:7897', override: 'localhost;10.*;<local>' })
  assert.equal(up(CODEX, { systemProxy: a }).port, 7897)
  assert.equal(up(CODEX, { systemProxy: b }).port, 7890)
  assert.deepEqual(up(CODEX, { systemProxy: c }).bypass.map((x) => x.value ?? x.kind), ['localhost', '127.0.0.0/8', '10.0.0.0/8', 'local'], 'a ProxyOverride change alone is a change of the follower\'s table')
  assert.deepEqual(up(CLAUDE, { systemProxy: a }), up(CLAUDE, { systemProxy: b }), 'it does not follow')
  const own = { prior: 'http://proxy.corp:3128' }
  assert.deepEqual(up(CODEX, { ...own, systemProxy: a }), up(CODEX, { ...own, systemProxy: b }), 'one with a proxy of its own does not follow it either')
})

test('W71 after `on`, a system proxy turned PAC (or unreadable) leaves a follower on the last upstream and says so; before there is one it is not routed (OPEN 17)', () => {
  const last = up(CODEX, { systemProxy: sys() })
  const pac = up(CODEX, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }), last })
  assert.deepEqual(pac, { ...last, hint: 'system-proxy-pac' })
  assert.deepEqual(up(CODEX, { systemProxy: { ok: false, reason: 'timeout' }, last }), { ...last, hint: 'system-proxy-unreadable' })
  assert.equal(up(CODEX, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }), last: pac }).hint, 'system-proxy-pac', 'and again, from the result that already carries the hint')
  assert.equal(Object.hasOwn(up(CODEX, { systemProxy: sys({ server: '127.0.0.1:7890' }), last: pac }), 'hint'), false, 'a readable, followable system proxy clears it, and the new upstream is the new value')
  assert.equal(up(CODEX, { systemProxy: sys({ server: '127.0.0.1:7890' }), last: pac }).port, 7890)
  assert.deepEqual(up(CODEX, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }), last: direct }), { ...direct, hint: 'system-proxy-pac' }, 'the last upstream was direct: it stays direct')
  assert.equal(up(CODEX, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }), last: { source: 'system-proxy', reason: 'not-routed', why: 'system-proxy-pac' } }).reason, 'not-routed', 'nothing to keep when the last was no upstream')
  assert.equal(up(CODEX, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }) }).reason, 'not-routed', '`on` itself, with no last: not routed')
  assert.equal(up(CLAUDE, { systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }), last: direct }).hint, undefined, 'a group that does not follow has nothing to say about a PAC')
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

test('W71 readSystemProxy asks the four Internet Settings values the helper may read, and gives the answer in the form upstreamFor takes', async () => {
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

test('W5 readHkcuEnv reads the four proxy variables of the login environment (read-only, on the helper\'s list), keeps the ones that are set as text, and says why when it cannot', async () => {
  const { reg, helper } = fakeRegistry({})
  reg.env = { HTTPS_PROXY: sz('http://a:1'), NO_PROXY: sz('.corp.com'), ALL_PROXY: sz(''), HTTP_PROXY: dword(3), Path: sz('C:\\x') }
  assert.deepEqual(await readHkcuEnv({ helper }), { ok: true, values: { HTTPS_PROXY: 'http://a:1', NO_PROXY: '.corp.com' } }, 'a blank value and a number are not a proxy; Path is not asked')
  assert.deepEqual(helper.calls[0].args, { hive: 'HKCU', key: 'Environment', names: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] })
  assert.notEqual(regReadAllowed(helper.calls[0].args), null)
  reg.env = null
  assert.deepEqual(await readHkcuEnv({ helper }), { ok: true, values: {} })
  reg.fail = { code: 'helper-timeout' }
  assert.deepEqual(await readHkcuEnv({ helper }), { ok: false, reason: 'timeout', detail: 'helper-timeout' })
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

test('W71 end to end: the registry moves its port, the watcher says so, and only the follower\'s upstream is new', async () => {
  const { reg, helper } = fakeRegistry(VERGE)
  const clock = fakeTimers()
  const w = watchSystemProxy({ helper, initial: await readSystemProxy({ helper }), timers: clock.timers })
  const changes = []
  w.on('change', (e) => changes.push(e))
  const first = await readSystemProxy({ helper })
  const before = { codex: up(CODEX, { systemProxy: first }), claude: up(CLAUDE, { systemProxy: first }) }
  reg.internet.ProxyServer = sz('127.0.0.1:7890')
  await clock.tick()
  assert.equal(changes.length, 1)
  const after = { codex: up(CODEX, { systemProxy: changes[0].after, last: before.codex }), claude: up(CLAUDE, { systemProxy: changes[0].after, last: before.claude }) }
  assert.equal(before.codex.port, 7897)
  assert.equal(after.codex.port, 7890)
  assert.deepEqual(after.claude, before.claude, 'a group that does not follow has the same answer')
  reg.internet.AutoConfigURL = sz('http://wpad/proxy.pac')
  await clock.tick()
  const pac = up(CODEX, { systemProxy: changes[1].after, last: after.codex })
  assert.deepEqual([pac.port, pac.hint], [7890, 'system-proxy-pac'], 'PAC after `on`: the last upstream stays and it is said')
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

test('upstreamFor wants a group: a call without one is a bug of the caller, not a direct upstream', () => {
  assert.throws(() => upstreamFor({}), TypeError)
  assert.throws(() => upstreamFor(), TypeError)
  assert.throws(() => upstreamFor({ group: { followsSystemProxy: { http: true } } }), TypeError, 'a group has an id: it names the reference to its stored login')
})

// ======================================================================================================================================
// Task 8(a): the route plan — which groups get an entry, what each one's upstream and bypass table are (4.8 §2.2, §2.3, §3.5; W5, W72)
// The groups here are the REAL data of all seven harnesses (`loadHarnesses`), laid out in a sandbox profile directory the way %USERPROFILE% is.
// ======================================================================================================================================

const ALL = await loadHarnesses()
const GROUPS = groupsOf(ALL)

/** A sandbox profile: files go in under it, and `ctx` is what the install gives a harness's `files(ctx)` (the one the trust tests use). */
function box(...sub) {
  const home = path.join(tmpDir('asight-rp-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const ctx = (env = {}, over = {}) => ({
    os: 'win32', home, env: new Map([['USERPROFILE', home], ...Object.entries(env)]), running: [], collectorDir: path.join(home, '.asight', 'collector'), caPem: path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'),
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

// ---------- planRoutes: the entries and upstreams of all groups at once (W5, the plan half) ----------

const HARNESSES = ALL.filter((d) => d.win32).map((d) => d.name)
const NETENV = (o = {}) => ({ systemProxy: sys(), hkcuEnv: { ok: true, values: {} }, ownPorts: OWN, ...o })
const ALL_ON = Object.fromEntries(HARNESSES.map((h) => [h, { desired: 'on', updated_at: null }])) // `state.json` v2's `harnesses`, as it is
/** planRoutes with every harness on and nobody named; the group's result by group id. */
const plan = (b, over = {}) => planRoutes({ netenv: NETENV(), groups: GROUPS, desired: ALL_ON, optIns: [], manifest: null, ctx: b.ctx(), procs: [], last: {}, ...over })
/** What a cell of the table says about a group, as the table writes it. */
const view = (p) => ({ entry: p.entry, on: p.on, reason: p.reason, upstream: p.upstream, ...(p.egressDiffers ? { egressDiffers: true } : {}), envUnreadable: p.envUnreadable })
const AUTO = ['claude-code.settings', 'codex.env', 'deepseek-dsh.env', 'hermes.cli', 'z-code.cli']
const NAMED = ['claude-code.desktop', 'kimi-code.cli', 'kimi-code.vscode', 'opencode.cli', 'opencode.desktop', 'z-code.desktop']
const PROXY = (host, port) => ({ kind: 'http', host, port, source: 'system-proxy' })
const DIRECT = { kind: 'direct', source: 'direct' }
const ON = { entry: 'auto', on: true, reason: null }
const ownProxy = (u) => ({ ...u, source: 'agent' })

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
  const named = plan(b, { optIns: ['kimi-code.cli', 'claude-code.desktop', 'z-code.desktop'] })
  assert.deepEqual(['kimi-code.cli', 'claude-code.desktop', 'z-code.desktop', 'kimi-code.vscode'].map((g) => [g, named[g].entry, named[g].on, named[g].reason]), [['kimi-code.cli', 'opt-in', true, null], ['claude-code.desktop', 'opt-in', true, null], ['z-code.desktop', 'opt-in', true, null], ['kimi-code.vscode', null, false, 'opt-in-needed']], 'only what was named')
  // a form of the group may be the name: a group with two forms is named by either
  const two = { g: 'x', harness: 'xh', group: { g: 'x', proxyEntry: { kind: 'file', format: 'json-key', files: () => [], key: ['k'] }, auth: true, followsSystemProxy: { http: false, ws: false }, optIn: [{ item: 'i', scope: 'user', impact: 'y' }] }, forms: [{ id: 'x.a' }, { id: 'x.b' }], proxy: { env: [], branches: ['all'] } }
  assert.deepEqual([planRoutes({ netenv: NETENV(), groups: [two], desired: { xh: 'on' }, optIns: ['x.b'], ctx: b.ctx() }).x.entry, planRoutes({ netenv: NETENV(), groups: [two], desired: { xh: 'on' }, optIns: ['x.zzz'], ctx: b.ctx() }).x.reason], ['opt-in', 'opt-in-needed'])
  // off: no entry; the upstream is still computed (what the kernel forwards to for a process that outlives `off`)
  const off = plan(b, { desired: { codex: { desired: 'off' }, hermes: 'off', 'claude-code': 'on' } })
  assert.deepEqual(['codex.env', 'hermes.cli', 'claude-code.settings', 'z-code.cli'].map((g) => [g, off[g].entry, off[g].on, off[g].reason]), [['codex.env', null, false, 'desired-off'], ['hermes.cli', null, false, 'desired-off'], ['claude-code.settings', 'auto', true, null], ['z-code.cli', null, false, 'desired-off']], 'a harness with no word in `desired` is off')
  assert.deepEqual(off['codex.env'].upstream, PROXY('127.0.0.1', 7897), 'forward-only needs the upstream')
  assert.equal(off['codex.env'].egressDiffers, undefined, 'nothing is connected to tell it about')
  assert.deepEqual(plan(b, { desired: null })['codex.env'].reason, 'desired-off')
  // the order: off first, then not named, then the upstream, then the entry that takes no login
  const worst = plan(b, { desired: {}, netenv: NETENV({ systemProxy: sys({ autoConfigUrl: 'http://x/p.pac' }) }) })
  assert.equal(worst['kimi-code.vscode'].reason, 'desired-off')
  const unnamedPac = plan(b, { netenv: NETENV({ systemProxy: sys({ autoConfigUrl: 'http://x/p.pac' }) }) })
  assert.equal(unnamedPac['kimi-code.vscode'].reason, 'opt-in-needed', 'it follows the system proxy, which is a PAC; it is the naming that is missing first')
  const namedPac = plan(b, { optIns: ['kimi-code.vscode'], netenv: NETENV({ systemProxy: sys({ autoConfigUrl: 'http://x/p.pac' }) }) })
  assert.deepEqual([namedPac['kimi-code.vscode'].reason, namedPac['kimi-code.vscode'].why], ['not-routed', 'system-proxy-pac'])
})

test('W5 / W23: an entry that takes no login (Claude Desktop\'s policy value) is not routed to an upstream that needs one — form-unsupported; one with an upstream that needs none is', () => {
  const b = box()
  b.put('.x/c.json', `{"p": "${USER_PROXY}"}`)
  const entryless = { g: 'nologin', harness: 'xh', group: { g: 'nologin', proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => [path.join(ctx.home, '.x', 'c.json')], key: ['p'] }, auth: false, followsSystemProxy: { http: false, ws: false } }, forms: [{ id: 'nologin.a' }], proxy: { env: [], branches: ['all'] } }
  const r = planRoutes({ netenv: NETENV(), groups: [entryless], desired: { xh: 'on' }, ctx: b.ctx() }).nologin
  assert.deepEqual([r.entry, r.on, r.reason, r.upstream.credentialed, r.forms['nologin.a'].reason], [null, false, 'form-unsupported', true, 'form-unsupported'])
  b.put('.x/c.json', '{"p": "http://corp.example:3128"}')
  assert.equal(planRoutes({ netenv: NETENV(), groups: [entryless], desired: { xh: 'on' }, ctx: b.ctx() }).nologin.entry, 'auto')
  // the real one: Claude Desktop follows the system proxy, and a system proxy with a login in it is not read at all (WinINET takes none from it)
  const desktop = plan(b, { optIns: ['claude-code.desktop'], netenv: NETENV({ systemProxy: sys({ server: 'alice:s3cret@corp.example:3128' }) }) })['claude-code.desktop']
  assert.deepEqual([desktop.reason, desktop.why, desktop.detail], ['not-routed', 'upstream-unparseable', 'credentials-in-system-proxy'])
  assert.equal(plan(b, { optIns: ['claude-code.desktop'] })['claude-code.desktop'].entry, 'opt-in')
})

test('W5 egress-differs: a group connected through the system proxy whose WebSocket did not follow it is told so, once it is connected; a group that was not connected, or whose harness has no such branch, is not', () => {
  const b = box()
  const p = plan(b)
  assert.deepEqual(['codex.env', 'hermes.cli', 'claude-code.settings'].map((g) => p[g].egressDiffers === true), [true, false, false], 'Codex has an HTTP and a WebSocket branch, Hermes follows the system proxy but has only one')
  assert.equal(plan(b, { desired: { codex: 'off' } })['codex.env'].egressDiffers, undefined)
})

test('W5 the bypass table: a follower\'s is the system proxy\'s ProxyOverride, an agent\'s own proxy takes its NO_PROXY, a group going direct has none to leave direct, and what asight cannot read is counted — each group its own', () => {
  const b = box()
  b.put('.codex/.env', 'OPENAI_API_KEY=k\n')
  const override = '<local>;*.corp.com;10.*;intranet.corp.com;a*b.com'
  const p = plan(b, { netenv: NETENV({ systemProxy: sys({ override }) }) })
  assert.deepEqual([p['codex.env'].bypass, p['codex.env'].untranslated], [[local, suf('corp.com'), cidr('10.0.0.0/8'), dom('intranet.corp.com')], 1])
  assert.deepEqual([p['hermes.cli'].bypass, p['hermes.cli'].untranslated], [p['codex.env'].bypass, 1], 'both follow the same ProxyOverride')
  assert.notEqual(p['hermes.cli'].bypass, p['codex.env'].bypass, 'but not one table between two groups')
  assert.deepEqual([p['claude-code.settings'].bypass, p['claude-code.settings'].untranslated], [[], 0], 'direct has nothing to leave direct')
  const own = plan(b, { netenv: NETENV({ systemProxy: sys({ override }) }), manifest: { entries: [] } }) // no change: the manifest has no record
  assert.deepEqual(own['codex.env'].bypass, p['codex.env'].bypass)
  b.put('.codex/.env', 'HTTPS_PROXY=http://corp.example:3128\nNO_PROXY=.corp.com,10.0.0.0/8,[::1]\n')
  const withOwn = plan(b, { netenv: NETENV({ systemProxy: sys({ override }) }) })
  assert.deepEqual([withOwn['codex.env'].bypass, withOwn['codex.env'].untranslated], [[suf('corp.com'), cidr('10.0.0.0/8')], 1], 'the NO_PROXY of the proxy it uses, not the system\'s list for another proxy')
  assert.deepEqual(withOwn['hermes.cli'].bypass, p['hermes.cli'].bypass, 'and another group\'s table is its own')
})

test('W5 the login environment: a harness that reads a proxy variable of the login environment has it as its upstream when its entry holds none; one that cannot be read is 「不知道」 beside the answer, not a guess', () => {
  const b = box()
  const env = { ok: true, values: { HTTPS_PROXY: 'http://login.example:8080', NO_PROXY: 'localhost' } }
  const p = plan(b, { netenv: NETENV({ hkcuEnv: env }) })
  assert.deepEqual([p['claude-code.settings'].upstream, p['claude-code.settings'].envUnreadable], [{ kind: 'http', host: 'login.example', port: 8080, source: 'agent' }, false])
  assert.deepEqual(p['z-code.cli'].upstream, DIRECT, 'Z-Code reads a variable of its own, not the login environment\'s')
  const blind = plan(b, { netenv: NETENV({ hkcuEnv: { ok: false, reason: 'timeout' } }) })
  assert.deepEqual(blind['claude-code.settings'].unknown, [{ what: 'login-environment', reason: 'timeout' }])
  assert.equal(blind['claude-code.settings'].entry, 'auto', 'the rules go on: it is direct, and the plan says what it could not read')
  assert.deepEqual(blind['z-code.cli'].unknown, [{ what: 'login-environment', reason: 'timeout' }])
  const denied = plan(b, { ctx: b.ctx({}, { readTextOrError: () => ({ text: null, error: { code: 'EACCES', message: 'x' } }) }) })
  assert.deepEqual(denied['claude-code.settings'].unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EACCES' }], 'an entry file that cannot be read is said too')
})

test('W5 the form results: an elevated agent is said on the forms of the door group it came through when that group is its own harness\'s (D51: the name list says who, the door says where); it does not change what the group gets, and a group\'s own reason comes first', () => {
  const b = box()
  const procs = [
    { pid: 7712, agent: 'claude-code', names: ['claude'], door: 'claude-code.settings', elevated: true },
    { pid: 7713, agent: 'claude-code', names: ['claude'], door: 'claude-code.settings', elevated: true },
    { pid: 7714, agent: 'claude-code', names: ['claude'], door: 'claude-code.settings', elevated: false },
    { pid: 5530, agent: 'codex', names: ['codex'], door: 'codex.env', elevated: null },
    { pid: 5531, agent: 'codex', names: ['codex'], door: 'claude-code.settings', elevated: true }, // codex at the claude door (W79): a fact about codex, not about claude's forms
    { pid: 4002, agent: 'claude-code', names: ['claude'], door: 'no.such.group', elevated: true },
    { pid: 4003, agent: 'claude-code', names: ['claude'], door: 'claude-code.desktop', elevated: true },
  ]
  const p = plan(b, { procs })
  const f = p['claude-code.settings'].forms
  for (const id of Object.keys(f)) assert.deepEqual(f[id], { reason: 'elevated-agent', elevatedPids: [7712, 7713] }, `${id}: the elevated pids are a fact about every form of the door group they came through`)
  assert.deepEqual(p['codex.env'].forms['codex.app'], { reason: null }, 'an elevation nobody could read (null) is not an elevation')
  assert.deepEqual(['entry', 'on', 'reason'].map((k) => p['claude-code.settings'][k]), ['auto', true, null], 'the group is connected: the elevated process is the one that is not captured')
  assert.equal(p['claude-code.desktop'].forms['claude-code.desktop'].reason, 'opt-in-needed', 'the group\'s reason is first')
  assert.deepEqual(plan(b)['claude-code.settings'].forms, { 'claude-code.cli': { reason: null }, 'claude-code.vscode': { reason: null } }, 'nothing seen, nothing said')
  for (const g of Object.values(p)) for (const x of Object.values(g.forms)) assert.equal(x.unknownPaths, undefined, 'no path shape is reported any more: the name list decides who a process is')
})

test('W71 (plan half): fed its own result as `last`, a system proxy that turned PAC or could not be read leaves the followers on the upstream and the bypass table they had, with a hint; a group that was not routed before stays not routed', () => {
  const b = box()
  const before = plan(b, { netenv: NETENV({ systemProxy: sys({ override: '<local>;*.corp.com' }) }) })
  const last = before // the plan\'s own return value is the next call\'s `last`
  for (const [why, sp] of [['system-proxy-pac', sys({ autoConfigUrl: 'http://wpad/p.pac' })], ['system-proxy-unreadable', { ok: false, reason: 'timeout' }]]) {
    const after = plan(b, { netenv: NETENV({ systemProxy: sp }), last })
    assert.deepEqual([after['codex.env'].entry, after['codex.env'].on, after['codex.env'].reason, after['codex.env'].hint], ['auto', true, null, why])
    assert.deepEqual([after['codex.env'].upstream, after['codex.env'].bypass, after['codex.env'].egressDiffers], [before['codex.env'].upstream, before['codex.env'].bypass, true], 'where it was, with the table it had')
    assert.deepEqual(after['claude-code.settings'], before['claude-code.settings'], 'a group that does not follow the system proxy is not touched')
    assert.equal(plan(b, { netenv: NETENV({ systemProxy: sp }) })['codex.env'].reason, 'not-routed', 'with no last answer there is nothing to stay on')
  }
  const same = plan(b, { netenv: NETENV({ systemProxy: sys({ override: '<local>;*.corp.com' }) }), last })
  assert.deepEqual(Object.values(same).map((r) => r.answer), Object.values(before).map((r) => r.answer), 'an unchanged system proxy gives the answers it gave: the daemon compares these and reloads nothing')
  assert.ok(Object.values(before).every((r) => !('hint' in r.answer) && JSON.stringify(r.answer).length > 0))
})

test('W71 (plan half): only a group that WAS connected is left on its last upstream — the answer a group worked out while it was off, or was not routed, is what it would have dialled, not what it did (OPEN 17)', () => {
  const b = box()
  const pac = NETENV({ systemProxy: sys({ autoConfigUrl: 'http://wpad/p.pac' }) })
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
  const desktop = plan(b, { desired: only('claude-code'), optIns: ['claude-code.desktop'] })
  assert.deepEqual([desktop['claude-code.desktop'].entry, desktop['claude-code.desktop'].on], ['opt-in', true])
  const desktopPac = plan(b, { desired: only('claude-code'), optIns: ['claude-code.desktop'], netenv: pac, last: desktop })
  assert.deepEqual([desktopPac['claude-code.desktop'].entry, desktopPac['claude-code.desktop'].hint, desktopPac['claude-code.desktop'].upstream], ['opt-in', 'system-proxy-pac', PROXY('127.0.0.1', 7897)])
  const unnamed = plan(b, { desired: only('claude-code') })
  assert.deepEqual([unnamed['claude-code.desktop'].entry, unnamed['claude-code.desktop'].reason, unnamed['claude-code.desktop'].upstream], [null, 'opt-in-needed', PROXY('127.0.0.1', 7897)])
  const unnamedPac = plan(b, { desired: only('claude-code'), optIns: ['claude-code.desktop'], netenv: pac, last: unnamed })
  assert.deepEqual([unnamedPac['claude-code.desktop'].entry, unnamedPac['claude-code.desktop'].reason, unnamedPac['claude-code.desktop'].why], [null, 'not-routed', 'system-proxy-pac'], 'named only now, after the PAC: nothing was connected before')
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
  assert.throws(() => planRoutes({ ...ok, netenv: { systemProxy: sys(), hkcuEnv: { ok: true, values: {} } } }), { name: 'TypeError', message: /own ports/ }, 'a plan that cannot see a loop is not a plan')
  assert.throws(() => planRoutes({ ...ok, ctx: undefined }), { name: 'TypeError', message: /needs the ctx/ })
  assert.throws(() => planRoutes({ ...ok, groups: [], ctx: undefined }), { name: 'TypeError', message: /needs the ctx/ }, 'whether or not there is a group to read a file for')
  assert.throws(() => planRoutes(), TypeError)
  assert.deepEqual(Object.keys(planRoutes({ ...ok, groups: [] })), [])
})

