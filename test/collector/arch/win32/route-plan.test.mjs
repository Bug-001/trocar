// test/collector/arch/win32/route-plan.test.mjs — RFC 4.8 §2.2: what a group's upstream is and which targets its agent reached directly before asight (W5 upstream half, W71 rule half, W72 translation half).
// Task 6b owns the rules of upstream.mjs; Task 8(a) appends the route plan (planRoutes, priorOf, hostSetOf) that applies them to the groups. Nothing here runs Windows: the helper is an object with a `call`, the clock is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bypassHit, parseProxyText, proxyAuthOf, readHkcuEnv, readSystemProxy, sameSystemProxy, translateBypass, upstreamFor, watchSystemProxy } from '../../../../src/collector/arch/win32/upstream.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { bypassRuleOf } from '../../../../src/netenv/mihomo/rules.mjs'
import { groupsOf, planRoutes, priorOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
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
function reaches(src, allowed = ['../../../netenv/mihomo/rules.mjs']) {
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
const USER_PROXY = 'http://alice:s3cret@corp.example:3128'

test('groupsOf: the Windows groups of the harness descriptors, each with its harness, its forms and the harness\'s proxy behaviour; a form with no group (not measured) is in none', () => {
  assert.deepEqual(GROUPS.map((x) => [x.harness, x.g, x.forms.map((f) => f.id)]), [
    ['claude-code', 'claude-code.settings', ['claude-code.cli', 'claude-code.vscode']],
    ['claude-code', 'claude-code.desktop', ['claude-code.desktop']],
    ['codex', 'codex.env', ['codex.cli', 'codex.vscode', 'codex.app']],
    ['deepseek-dsh', 'deepseek-dsh.env', ['deepseek-dsh.cli', 'deepseek-dsh.desktop']],
    ['hermes', 'hermes.cli', ['hermes.cli']],
    ['kimi-code', 'kimi-code.cli', ['kimi-code.cli']],
    ['kimi-code', 'kimi-code.vscode', ['kimi-code.vscode']],
    ['opencode', 'opencode.cli', ['opencode.cli']],
    ['opencode', 'opencode.desktop', ['opencode.desktop']],
    ['z-code', 'z-code.cli', ['z-code.cli']],
    ['z-code', 'z-code.desktop', ['z-code.desktop']],
  ])
  assert.ok(GROUPS.every((x) => x.group.g === x.g && x.proxy && Array.isArray(x.proxy.env) && Array.isArray(x.proxy.branches)), 'the group data and the harness\'s `proxy` (the variables it reads, its branches) are what upstreamFor is given')
  assert.equal(GROUPS.flatMap((x) => x.forms).some((f) => f.id === 'hermes.desktop'), false, 'hermes.desktop has no group: nothing can be routed for it')
  assert.deepEqual(groupsOf([{ name: 'linux-only' }, null]), [], 'a harness with no Windows data has no group on Windows')
})

// ---------- priorOf: the user's own proxy for a group, from the manifest when asight has written the entry, else from the file the agent reads (4.8 §2.2 ①) ----------

test('priorOf reads what an agent has in its entry file before asight: the JSON key, or the dotenv variables (and the NO_PROXY the group names), in whatever way the file writes them', () => {
  const b = box()
  b.put('.claude/settings.json', `{\n  // the corporate proxy\n  "env": { "HTTPS_PROXY": "${USER_PROXY}", "ANTHROPIC_BASE_URL": "https://relay.example.com" },\n}\n`)
  assert.deepEqual(priorOf({ group: gdata('claude-code.settings').group, ctx: b.ctx() }), { value: USER_PROXY, noProxy: null, source: 'file' }, 'JSON with a comment and a trailing comma is what Claude Code reads')
  b.put('.codex/.env', `# mine\nOPENAI_API_KEY=sk-1\nexport HTTPS_PROXY="${USER_PROXY}"\nNO_PROXY='localhost, .corp.com'\n`)
  assert.deepEqual(priorOf({ group: gdata('codex.env').group, ctx: b.ctx() }), { value: USER_PROXY, noProxy: 'localhost, .corp.com', source: 'file' })
  assert.deepEqual(priorOf({ group: gdata('claude-code.settings').group, ctx: box().ctx() }), { value: null, noProxy: null, source: null }, 'no file: the agent has no proxy of its own')
  b.put('.claude/settings.json', '{"env": {"ANTHROPIC_BASE_URL": "https://relay.example.com"}}')
  assert.deepEqual(priorOf({ group: gdata('claude-code.settings').group, ctx: b.ctx() }), { value: null, noProxy: null, source: null }, 'a file without the key')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": 3128}}')
  assert.equal(priorOf({ group: gdata('claude-code.settings').group, ctx: b.ctx() }).value, null, 'a value that is no text is no proxy')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": "  "}}')
  assert.equal(priorOf({ group: gdata('claude-code.settings').group, ctx: b.ctx() }).value, null, 'an empty value is none')
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
      if (e.kind === 'text') applyTextEntry({ dir: b.dir, manifest: m, harness, file: e.path, edit: e })
      else applyJsonKey({ dir: b.dir, manifest: m, harness, file: e.path, keys: e.keys, value: e.value })
    }
    assert.ok(fs.readFileSync(file, 'utf8').includes('127.0.0.1:17991'), `${g}: the file holds asight's address now`)
    assert.deepEqual(priorOf({ group, ctx: b.ctx(), manifest: m }), { value: USER_PROXY, noProxy, source: 'manifest' }, `${g}: the user's proxy, not asight's address`)
    assert.deepEqual(priorOf({ group, ctx: b.ctx() }).source, 'file', `${g}: without the manifest the file is all there is to read`)
    assert.equal(priorOf({ group, ctx: b.ctx() }).value.includes('127.0.0.1:17991'), true, `${g}: and it holds asight's own address (the upstream rule calls that a route loop)`)
  }
  // an agent that had no proxy: the manifest says so, and asight's own address in the file is not mistaken for the user's
  const group = gdata('claude-code.settings').group
  const file = b.put('.claude/settings.json', '{"env": {"ANTHROPIC_BASE_URL": "https://relay.example.com"}}\n')
  const m = newManifest()
  const e = proxyEntries(group, b.ctx(), ingress)[0]
  applyJsonKey({ dir: b.dir, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
  assert.deepEqual(priorOf({ group, ctx: b.ctx(), manifest: m }), { value: null, noProxy: null, source: 'manifest' })
  assert.ok(fs.readFileSync(file, 'utf8').includes('127.0.0.1:17991'))
  // the entries of other groups, and the trust entry of the same file, are not this group's
  assert.deepEqual(priorOf({ group: gdata('z-code.cli').group, ctx: b.ctx(), manifest: m }), { value: null, noProxy: null, source: null }, 'another group\'s entry is no record for this one')
  const trust = { ...m.entries[0], keys: ['env', 'NODE_EXTRA_CA_CERTS'], prior_value: 'C:/corp/ca.pem' }
  const viaTrust = priorOf({ group, ctx: b.ctx(), manifest: { entries: [trust] } })
  assert.equal(viaTrust.source, 'file', 'the trust key of the same file is not the proxy key: its record says nothing about the proxy entry, so the file is read (and holds asight\'s own address here)')
  assert.notEqual(viaTrust.value, 'C:/corp/ca.pem')
  // the same for a dotenv file: the block the trust entry wrote (SSL_CERT_FILE) is no record of the proxy lines
  const envFile = b.put('.codex/.env', `HTTPS_PROXY=${USER_PROXY}\n`)
  const codexGroup = gdata('codex.env').group
  const trustBlock = { kind: 'text', format: 'dotenv-block', path: envFile, vars: { SSL_CERT_FILE: 'C:/x/combined-codex.pem' }, prior_value: { SSL_CERT_FILE: 'C:/corp/ca.pem' } }
  assert.deepEqual(priorOf({ group: codexGroup, ctx: b.ctx(), manifest: { entries: [trustBlock] } }), { value: USER_PROXY, noProxy: null, source: 'file' }, 'the trust block of the same file does not stand in for the proxy entry')
  // Windows paths: the record names the file in the other slash and in capitals, and is still the record of this file
  const proxyBlock = { kind: 'text', format: 'dotenv-block', path: envFile.toUpperCase().replace(/\//g, '\\'), vars: { HTTPS_PROXY: 'http://codex.env:x@127.0.0.1:1', NO_PROXY: 'localhost' }, prior_value: { HTTPS_PROXY: 'http://other:1' } }
  assert.equal(priorOf({ group: codexGroup, ctx: b.ctx(), manifest: { entries: [proxyBlock] } }).source, 'manifest', 'C:\\Users\\u and c:/users/u are one file')
})

test('priorOf: a group with several entry files takes the first that holds a proxy, in the order the files are listed; a file asight wrote answers from the manifest, the others from themselves', () => {
  const b = box()
  const group = gdata('hermes.cli').group
  const root = 'AppData/Local/hermes'
  b.put(`${root}/.env`, 'OPENROUTER_API_KEY=k\n')
  b.put(`${root}/profiles/work/config.yaml`, 'model: x\n')
  const second = b.put(`${root}/profiles/work/.env`, `HTTPS_PROXY=http://work-proxy:8080\n`)
  const ctx = b.ctx()
  assert.deepEqual(group.proxyEntry.files(ctx).map((f) => path.relative(b.home, f)), [path.join(root, '.env'), path.join(root, 'profiles', 'work', '.env')])
  assert.deepEqual(priorOf({ group, ctx }), { value: 'http://work-proxy:8080', noProxy: null, source: 'file' }, 'the root has none: the profile\'s is the group\'s')
  b.put(`${root}/.env`, 'HTTPS_PROXY=http://root-proxy:8080\n')
  assert.equal(priorOf({ group, ctx }).value, 'http://root-proxy:8080', 'the first file that has one')
  // the root's entry written by asight with no proxy before it: nothing there; the profile is read from itself
  const m = { entries: [{ kind: 'text', format: 'dotenv-block', path: group.proxyEntry.files(ctx)[0], vars: { HTTPS_PROXY: 'http://hermes.cli:x@127.0.0.1:17995', NO_PROXY: 'localhost' }, prior_value: null }] }
  assert.deepEqual(priorOf({ group, ctx, manifest: m }), { value: 'http://work-proxy:8080', noProxy: null, source: 'file' })
  assert.ok(second)
})

test('priorOf: a file it cannot read or understand is 「不知道」 with a reason from the closed set — never a guess at "no proxy" — and the other files are still read', () => {
  const b = box()
  const group = gdata('claude-code.settings').group
  const denied = b.ctx({}, { readTextOrError: () => ({ text: null, error: { code: 'EACCES', message: 'permission denied, open C:\\Users\\alice\\.claude\\settings.json' } }) })
  const r = priorOf({ group, ctx: denied })
  assert.deepEqual([r.value, r.noProxy, r.source], [null, null, null])
  assert.deepEqual(r.unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EACCES' }], 'the errno, and no path (a user name may be in it)')
  b.put('.claude/settings.json', '{"env": {"HTTPS_PROXY": ')
  assert.deepEqual(priorOf({ group, ctx: b.ctx() }).unknown, [{ what: 'agent-proxy', reason: 'unparseable' }], 'JSON that does not parse says so, and does not quote the file')
  b.put('.claude/settings.json', '[1, 2]')
  assert.equal(priorOf({ group, ctx: b.ctx() }).unknown, undefined, 'JSON that is no object has no such key: that is a read, and there is none')
  const hermes = gdata('hermes.cli').group
  const b2 = box()
  b2.put('AppData/Local/hermes/.env', 'X=1\n')
  b2.put('AppData/Local/hermes/profiles/p/config.yaml', 'x: 1\n')
  b2.put('AppData/Local/hermes/profiles/p/.env', 'HTTPS_PROXY=http://p:1\n')
  const flaky = b2.ctx({}, { readTextOrError: (f) => (f.endsWith(path.join('hermes', '.env')) ? { text: null, error: { code: 'EPERM', message: 'x' } } : { text: fs.readFileSync(f, 'utf8'), error: null }) })
  const r2 = priorOf({ group: hermes, ctx: flaky })
  assert.equal(r2.value, 'http://p:1', 'one file that cannot be read does not hide another that can')
  assert.deepEqual(r2.unknown, [{ what: 'agent-proxy', reason: 'denied', detail: 'EPERM' }])
})

test('priorOf: a group whose entry is not a file asight writes (a policy value, a shim, a launcher, an app setting) has no prior here — the opt-in step that writes it records it (Task 14)', () => {
  for (const g of ['claude-code.desktop', 'kimi-code.cli', 'kimi-code.vscode', 'opencode.cli', 'opencode.desktop', 'z-code.desktop']) {
    assert.deepEqual(priorOf({ group: gdata(g).group, ctx: box().ctx() }), { value: null, noProxy: null, source: null }, g)
  }
})

test('priorOf wants a group and a ctx; the secret in a user\'s proxy is in its answer and in no error', () => {
  assert.throws(() => priorOf({}), TypeError)
  assert.throws(() => priorOf({ group: gdata('codex.env').group }), TypeError, 'a read needs the ctx that says where the home is')
  const b = box()
  b.put('.claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"`)
  const r = priorOf({ group: gdata('claude-code.settings').group, ctx: b.ctx() })
  assert.equal(JSON.stringify(r).includes('s3cret'), false, 'a file that does not parse is not quoted')
})

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

test('W5 §2.2 table, group by group: Verge with the system proxy on (TUN on or off: the same), v2rayN, another TUN VPN or none, a PAC — what each automatic group gets, written out literally', () => {
  const b = box()
  const dsh = { entry: 'auto', on: true, reason: null, upstream: DIRECT, envUnreadable: true } // dsh follows nothing and has no proxy of its own
  // 1. Verge, system proxy on, TUN off — and with the TUN on (the system proxy still on): the followers take the system proxy, the others go direct
  const verge = plan(b)
  assert.deepEqual(AUTO.map((g) => [g, view(verge[g])]), [
    ['claude-code.settings', { ...ON, upstream: DIRECT, envUnreadable: true }],
    ['codex.env', { ...ON, upstream: PROXY('127.0.0.1', 7897), egressDiffers: true, envUnreadable: true }],
    ['deepseek-dsh.env', dsh],
    ['hermes.cli', { ...ON, upstream: PROXY('127.0.0.1', 7897), envUnreadable: true }],
    ['z-code.cli', { ...ON, upstream: DIRECT, envUnreadable: true }],
  ])
  // 2. Verge with the TUN on and the system proxy off, another TUN VPN, no VPN: the switch is off (or the value absent): everyone direct, and the TUN (if any) carries it as before
  for (const sp of [sys({ enable: false }), { ok: true, enable: null, server: null, override: null, autoConfigUrl: null }, sys({ enable: true, server: '' })]) {
    const off = plan(b, { netenv: NETENV({ systemProxy: sp }) })
    assert.deepEqual(AUTO.map((g) => view(off[g])), AUTO.map(() => ({ ...ON, upstream: DIRECT, envUnreadable: true })), JSON.stringify(sp))
  }
  // 3. v2rayN writes the protocols apart: the https= entry is the one an HTTPS request takes
  const v2 = plan(b, { netenv: NETENV({ systemProxy: sys({ server: 'http=127.0.0.1:10809;https=127.0.0.1:10810;socks=127.0.0.1:10808' }) }) })
  assert.deepEqual([v2['codex.env'].upstream, v2['hermes.cli'].upstream, v2['claude-code.settings'].upstream], [PROXY('127.0.0.1', 10810), PROXY('127.0.0.1', 10810), DIRECT])
  // 4. a PAC: the followers are not routed (asight does not run a script), the others are as before
  const pac = plan(b, { netenv: NETENV({ systemProxy: sys({ autoConfigUrl: 'http://wpad.corp/proxy.pac' }) }) })
  const notRouted = { entry: null, on: false, reason: 'not-routed', upstream: null, envUnreadable: true }
  assert.deepEqual(AUTO.map((g) => view(pac[g])), [{ ...ON, upstream: DIRECT, envUnreadable: true }, notRouted, dsh, notRouted, { ...ON, upstream: DIRECT, envUnreadable: true }])
  assert.deepEqual([pac['codex.env'].code, pac['codex.env'].why, pac['hermes.cli'].why], ['not-routed', 'system-proxy-pac', 'system-proxy-pac'])
  // 5. a system proxy nobody could read is 「不知道」: the followers are not routed with the reason, never a guess at direct
  const blind = plan(b, { netenv: NETENV({ systemProxy: { ok: false, reason: 'timeout', detail: 'helper-timeout' } }) })
  assert.deepEqual([blind['codex.env'].reason, blind['codex.env'].why, blind['codex.env'].detail, blind['claude-code.settings'].entry], ['not-routed', 'system-proxy-unreadable', 'timeout', 'auto'])
})

test('W5 §2.2 ①: an agent with a proxy of its own keeps it as the upstream — read from its file before `on`, from the manifest after — and the plan names where the login is, never the login', () => {
  const b = box()
  b.put('.claude/settings.json', `{"env": {"HTTPS_PROXY": "${USER_PROXY}"}}`)
  b.put('.codex/.env', 'HTTPS_PROXY=http://corp.example:3128\nNO_PROXY=localhost,.corp.com\n')
  const p = plan(b)
  const claude = { kind: 'http', host: 'corp.example', port: 3128, credentialed: true, auth_ref: 'prior:claude-code.settings', source: 'agent' }
  assert.deepEqual(view(p['claude-code.settings']), { ...ON, upstream: claude, envUnreadable: false })
  assert.deepEqual(view(p['codex.env']), { ...ON, upstream: ownProxy({ kind: 'http', host: 'corp.example', port: 3128 }), envUnreadable: false }, 'Codex follows the system proxy only when it has none of its own; its WebSocket then goes the same way as its HTTP, so there is nothing to tell')
  assert.deepEqual([p['codex.env'].bypass, p['codex.env'].untranslated], [[suf('localhost'), cidr('127.0.0.0/8'), suf('corp.com')], 0], 'the NO_PROXY it set is its own bypass table, with the loopback range `localhost` stands for')
  const json = JSON.stringify(p)
  for (const secret of ['s3cret', 'alice']) assert.equal(json.includes(secret), false, `${secret} is in no part of the plan: the credentials stay where the user put them, and the kernel config and the dial read them from there`)
  // after `on` the file holds asight's address and the manifest holds the user's: the same plan
  const m = newManifest()
  const e = proxyEntries(gdata('claude-code.settings').group, b.ctx(), { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })[0]
  applyJsonKey({ dir: b.dir, manifest: m, harness: 'claude-code', file: e.path, keys: e.keys, value: e.value })
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

test('W5 the form results: an elevated process of a form and a process whose path nobody measured are said on the forms; they do not change what the group gets, and a group\'s own reason says the same for all its forms', () => {
  const b = box()
  const procs = [
    { pid: 7712, match: { kind: 'form', id: 'claude-code.cli' }, elevated: true },
    { pid: 7713, match: { kind: 'form', id: 'claude-code.cli' }, elevated: true },
    { pid: 7714, match: { kind: 'form', id: 'claude-code.vscode' }, elevated: false },
    { pid: 5530, match: { kind: 'form', id: 'codex.app' }, elevated: null },
    { pid: 9001, match: { kind: 'path-unknown', forms: ['claude-code.cli', 'claude-code.vscode', 'claude-code.desktop'], shape: 'D:\\tools\\claude.exe' }, elevated: false },
    { pid: 9002, match: { kind: 'path-unknown', forms: ['codex.cli', 'codex.vscode', 'codex.app'], shape: 'C:\\Users\\<user>\\x\\codex.exe' } },
    { pid: 4000, match: { kind: 'pending', forms: ['deepseek-dsh.cli'] } },
    { pid: 4001, match: { kind: 'none' }, elevated: true },
    { pid: 4002, match: { kind: 'form', id: 'no.such.form' }, elevated: true },
  ]
  const p = plan(b, { procs })
  const f = p['claude-code.settings'].forms
  assert.deepEqual(f['claude-code.cli'], { reason: 'elevated-agent', elevatedPids: [7712, 7713], unknownPaths: ['D:\\tools\\claude.exe'] }, 'the elevated pids are a fact about a known form, and the first thing said about it')
  assert.deepEqual(f['claude-code.vscode'], { reason: 'form-path-unknown', unknownPaths: ['D:\\tools\\claude.exe'] }, 'a path that tells which form it is does not exist: every form of that image carries it')
  assert.deepEqual(p['codex.env'].forms['codex.app'], { reason: 'form-path-unknown', unknownPaths: ['C:\\Users\\<user>\\x\\codex.exe'] }, 'an elevation nobody could read (null) is not an elevation')
  assert.deepEqual(p['deepseek-dsh.env'].forms, { 'deepseek-dsh.cli': { reason: null }, 'deepseek-dsh.desktop': { reason: null } }, 'a form whose command line is not known yet, and one that is no agent, are nothing yet')
  assert.deepEqual(['entry', 'on', 'reason'].map((k) => p['claude-code.settings'][k]), ['auto', true, null], 'the group is connected: the elevated process is the one that is not captured')
  assert.deepEqual(p['claude-code.desktop'].forms['claude-code.desktop'], { reason: 'opt-in-needed', unknownPaths: ['D:\\tools\\claude.exe'] }, 'the group\'s reason is first')
  assert.deepEqual(plan(b)['claude-code.settings'].forms, { 'claude-code.cli': { reason: null }, 'claude-code.vscode': { reason: null } }, 'nothing seen, nothing said')
})

test('W71 (plan half): fed its own answers as `last`, a system proxy that turned PAC or could not be read leaves the followers on the upstream and the bypass table they had, with a hint; a group that was not routed before stays not routed', () => {
  const b = box()
  const before = plan(b, { netenv: NETENV({ systemProxy: sys({ override: '<local>;*.corp.com' }) }) })
  const last = Object.fromEntries(Object.values(before).map((r) => [r.g, r.answer]))
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

// ---------- what route-plan.mjs may touch ----------

const PLAN_SRC = fs.readFileSync(fileURLToPath(new URL('../../../../src/collector/arch/win32/route-plan.mjs', import.meta.url)), 'utf8')

test('route-plan.mjs imports only the config readers, forms.mjs and upstream.mjs, touches no disk, process, network or OS by itself (the files it reads come through the ctx it is given), and names no harness: its groups are data (W39)', () => {
  assert.deepEqual(reaches(PLAN_SRC, ['../../core/config-read.mjs', './forms.mjs', './upstream.mjs']), [])
  assert.ok(reaches("import fs from 'node:fs'\n", ['./forms.mjs']).length > 0, 'the scan can fail')
  assert.ok(reaches("/** the process. */\nconst x = process.platform\n", []).length > 0 && reaches('/** the process. */\nconst x = 1\n', []).length === 0, 'a call is found, prose in a comment is not')
  const code = PLAN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.deepEqual(code.match(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/gi), null, 'the code names no harness (the harness files are the only place that does)')
})
