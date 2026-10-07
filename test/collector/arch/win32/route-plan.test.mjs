// test/collector/arch/win32/route-plan.test.mjs — RFC 4.8 §2.2: what a group's upstream is and which targets its agent reached directly before asight (W5 upstream half, W71 rule half, W72 translation half).
// Task 6b owns the rules of upstream.mjs; Task 8(a) appends the route plan (planRoutes) that applies them to the groups. Nothing here runs Windows: the helper is an object with a `call`, the clock is injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bypassHit, translateBypass } from '../../../../src/collector/arch/win32/upstream.mjs'
import { bypassRuleOf } from '../../../../src/netenv/mihomo/rules.mjs'

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
