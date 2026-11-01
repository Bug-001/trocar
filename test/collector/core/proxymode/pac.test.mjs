// test/collector/core/proxymode/pac.test.mjs — CM19 (4.11 P10): the PAC text, generated over bypass rows (each kind; verdict = bypassHit's: door then direct) × own leg (set / none / credentialed) × scheme (plain http: the app's own way) ×
// on vs after off, evaluated in a sandbox with the PAC builtins it uses; loopback = the door's own predicate (chain.mjs isLoopbackHost); and CM33: peerAllowed over same / other uid and SID.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { pacText, pacHandler, peerAllowed } from '../../../../src/collector/core/proxymode/pac.mjs'
import { PAC_PATH } from '../../../../src/collector/core/proxymode/entries.mjs'
import { isLoopbackHost } from '../../../../src/collector/core/proxymode/chain.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { bypassHit } from '../../../../src/collector/core/upstream-shape.mjs'

// the PAC builtins the text uses, as the PAC spec defines them (isInNet on an address literal: no lookup)
const ip4 = (a) => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
const PAC_ENV = { dnsDomainIs: (h, d) => h.length >= d.length && h.slice(-d.length) === d, isInNet: (h, net, mask) => ((ip4(h) & ip4(mask)) >>> 0) === ((ip4(net) & ip4(mask)) >>> 0) }
const run = (text, host, scheme = 'https') => { const ctx = vm.createContext({ ...PAC_ENV }); vm.runInContext(text, ctx); return ctx.FindProxyForURL(`${scheme}://${host}/`, host) }

// the bypass axis: rows of each kind the chain carries (translateBypass's output), alone and mixed, incl. macOS's default 169.254/16
const ROWS = { local: { kind: 'local' }, domain: { kind: 'domain', value: 'build.internal' }, suffix: { kind: 'domain-suffix', value: 'corp.example' }, cidr: { kind: 'ip-cidr', value: '169.254.0.0/16' }, cidr8: { kind: 'ip-cidr', value: '10.0.0.0/8' }, all: { kind: 'ip-cidr', value: '0.0.0.0/0' } }
const BYPASS = [[], [ROWS.local], [ROWS.domain], [ROWS.suffix], [ROWS.cidr], [ROWS.suffix, ROWS.cidr8, ROWS.local], [ROWS.all], [{ kind: 'domain-suffix', value: 'localhost' }, { kind: 'ip-cidr', value: '127.0.0.0/8' }], Object.values(ROWS)]
// sample hosts that probe each kind's edges: the domain itself, a subdomain, a lookalike, plain names, addresses in and out of each range, case, a trailing dot, IPv6
const HOSTS = ['api.anthropic.com', 'intranet', 'INTRANET', 'build.internal', 'x.build.internal', 'corp.example', 'a.corp.example', 'A.Corp.Example.', 'notcorp.example', 'corp.example.evil', '169.254.1.2', '169.255.0.1', '10.9.9.9', '11.0.0.1', '[2001:db8::1]', 'fe80::1']
// loopback as the door judges it: localhost and every *.localhost name (RFC 6761; Clash Verge's default bypass row `domain-suffix localhost` put them on the
// bypass list, so they reached the door), 127.0.0.0/8, ::1; NEAR are the lookalikes that are not, and they take the ordinary rule below
const LOOP = ['localhost', 'LOCALHOST', 'a.localhost', 'x.y.Localhost.', '127.0.0.1', '127.1.2.3', '127.255.255.254', '::1', '[::1]']
const NEAR = ['localhost.example', 'notlocalhost', 'xlocalhost', '128.0.0.1', '126.255.255.255', '1.127.0.0', '[::2]']
const LEGS = [['none', null, 'DIRECT'], ['set', 'http://proxy.corp:3128', 'PROXY proxy.corp:3128'], ['credentialed', 'http://alice:s3cret@proxy.corp:3128', 'PROXY proxy.corp:3128'], ['socks', 'socks5://127.0.0.2:1080', 'SOCKS5 127.0.0.2:1080']]
const DOORS = [['on', '127.0.0.1:47001'], ['after-off', null]]

for (const bypass of BYPASS) for (const [legName, ownLeg, legWord] of LEGS) for (const [phase, door] of DOORS) {
  test(`CM19 PAC: bypass ${JSON.stringify(bypass.map((r) => r.value || r.kind))} · own leg ${legName} · ${phase}`, () => {
    const text = pacText({ door, ownLeg, bypass })
    assert.ok(!/alice|s3cret/.test(text), 'credentials never reach the PAC')
    for (const h of LOOP) { assert.ok(isLoopbackHost(h), h); assert.equal(run(text, h), 'DIRECT', `loopback ${h} is direct`) }
    for (const h of NEAR) assert.ok(!isLoopbackHost(h), `${h} is no loopback`)
    const want = door ? `PROXY ${door}; ${legWord}` : legWord
    // a bypass-list host still goes through the door, which dials it direct (bypassHit): a DIRECT there was a turn never seen (mac Claude Desktop, 2026-10-17)
    for (const h of [...HOSTS, ...NEAR]) assert.equal(run(text, h), bypassHit(bypass, h) ? (door ? `PROXY ${door}; DIRECT` : 'DIRECT') : want, `${h}: the PAC says what the door's own matcher (bypassHit) says`)
    // plain http takes the app's own way, on and after off (P10: the PAC does not hand plain http to the door)
    for (const h of [...HOSTS, ...NEAR]) assert.equal(run(text, h, 'http'), bypassHit(bypass, h) ? 'DIRECT' : legWord, `http://${h}: the app's own way`)
    for (const h of LOOP) assert.equal(run(text, h, 'HTTP'), 'DIRECT')
    if (!bypassHit(bypass, 'api.anthropic.com')) for (const scheme of ['wss', 'ws']) assert.equal(run(text, 'api.anthropic.com', scheme), want, `${scheme}: a WebSocket is CONNECTed, so it goes to the door`)
    if (door == null) assert.ok(!text.includes('47001'), 'after off the door is gone from the PAC')
  })
}

test('a bypass row the matcher cannot meet is refused, never guessed into a test (a raw string, an unknown kind, a bad range)', () => {
  for (const bad of ['*.lan', { kind: 'glob', value: '*.lan' }, { kind: 'ip-cidr', value: '169.254/16' }]) assert.throws(() => pacText({ door: null, bypass: [bad] }), TypeError)
})

test('an own leg keeps its scheme\'s default port; a scheme with no PAC word is refused, never guessed', () => {
  assert.equal(run(pacText({ door: null, ownLeg: 'https://p' }), 'x.example'), 'HTTPS p:443')
  assert.throws(() => pacText({ door: null, ownLeg: 'ftp://p:21' }), /no PAC word/)
})

test('pacHandler serves GET /trocar.pac from state() per request, and leaves every other request to the door', () => {
  let st = { door: '127.0.0.1:47001', ownLeg: null, bypass: [] }
  const h = pacHandler({ state: () => st })
  const res = () => { const r = { head: null, body: null, writeHead(s, hd) { r.head = [s, hd] }, end(b) { r.body = b } }; return r }
  const a = res()
  assert.equal(h({ method: 'GET', url: PAC_PATH }, a), true)
  assert.equal(a.head[0], 200); assert.match(a.head[1]['content-type'], /proxy-autoconfig/); assert.match(a.body, /PROXY 127\.0\.0\.1:47001; DIRECT/)
  st = { ...st, door: null }
  const b = res(); h({ method: 'GET', url: `${PAC_PATH}?x=1` }, b)
  assert.ok(!b.body.includes('47001'))
  assert.equal(h({ method: 'GET', url: '/other' }, res()), false)
  assert.equal(h({ method: 'POST', url: PAC_PATH }, res()), false)
})

const PEERS = [ // name, peer, self, allowed, refused because its owner could not be read (not shown to be another user's)
  ['mac same uid', { pid: 1, uid: 501 }, { uid: 501 }, true],
  ['mac other uid', { pid: 2, uid: 502 }, { uid: 501 }, false, false],
  ['mac uid unknown', { pid: 3 }, { uid: 501 }, false, true],
  ['win same SID', { pid: 4, sid: 's-1-5-21-1-1001' }, { sid: 'S-1-5-21-1-1001' }, true],
  ['win other SID', { pid: 5, sid: 'S-1-5-21-1-1002' }, { sid: 'S-1-5-21-1-1001' }, false, false],
  ['win helper sameUser', { pid: 6, sameUser: true }, { sid: null }, true],
  ['win helper other user', { pid: 7, sameUser: false }, { sid: null }, false, false],
  ['no facts', null, { uid: 501 }, false, true],
]
for (const [name, peer, self, ok, unread] of PEERS) {
  test(`CM33 peerAllowed: ${name} → ${ok ? 'allowed' : 'refused (the caller records it: one record per connection)'}`, () => {
    const r = peerAllowed(peer, self)
    assert.equal(r.ok, ok)
    if (!ok) { assert.equal(r.code, 'pac-peer-refused'); assert.equal(typeof r.detail, 'string'); assert.equal(r.unread, unread) }
  })
}
