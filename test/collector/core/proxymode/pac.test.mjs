// test/collector/core/proxymode/pac.test.mjs — CM19 (4.11 P10): the PAC text, generated over bypass lists × own leg (set / none / credentialed) ×
// on vs after off, evaluated in a sandbox with the PAC builtins it uses; and CM33: peerAllowed over same / other uid and SID.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { pacText, pacHandler, peerAllowed } from '../../../../src/collector/core/proxymode/pac.mjs'
import { PAC_PATH, LOOPBACK } from '../../../../src/collector/core/proxymode/entries.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'

const glob = (s, p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(s)
const run = (text, host) => { const ctx = vm.createContext({ shExpMatch: glob, isPlainHostName: (h) => !h.includes('.') }); vm.runInContext(text, ctx); return ctx.FindProxyForURL(`https://${host}/`, host) }

const BYPASS = [[], ['<local>'], ['.corp.example', 'build.internal'], ['*.lan', '10.*', 'we"ird\\host'], ['  ', 'UPPER.Example']]
const LEGS = [['none', null, 'DIRECT'], ['set', 'http://proxy.corp:3128', 'PROXY proxy.corp:3128'], ['credentialed', 'http://alice:s3cret@proxy.corp:3128', 'PROXY proxy.corp:3128'], ['socks', 'socks5://127.0.0.2:1080', 'SOCKS5 127.0.0.2:1080']]
const DOORS = [['on', '127.0.0.1:47001'], ['after-off', null]]

for (const bypass of BYPASS) for (const [legName, ownLeg, legWord] of LEGS) for (const [phase, door] of DOORS) {
  test(`CM19 PAC: bypass ${JSON.stringify(bypass)} · own leg ${legName} · ${phase}`, () => {
    const text = pacText({ door, ownLeg, bypass })
    assert.ok(!/alice|s3cret/.test(text), 'credentials never reach the PAC')
    for (const h of LOOPBACK) assert.equal(run(text, h), 'DIRECT', `loopback ${h} is direct`)
    const want = door ? `PROXY ${door}; ${legWord}` : legWord
    assert.equal(run(text, 'api.anthropic.com'), want)
    for (const b of bypass.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      const sample = b === '<local>' ? 'intranet' : b.startsWith('.') ? `a${b}` : b.replace(/\*/g, 'x')
      assert.equal(run(text, sample), 'DIRECT', `${sample} is bypassed by ${b}`)
    }
    if (door == null) assert.ok(!text.includes('47001'), 'after off the door is gone from the PAC')
  })
}

test('an own leg keeps its scheme\'s default port; a scheme with no PAC word is refused, never guessed', () => {
  assert.equal(run(pacText({ door: null, ownLeg: 'https://p' }), 'x.example'), 'HTTPS p:443')
  assert.throws(() => pacText({ door: null, ownLeg: 'ftp://p:21' }), /no PAC word/)
})

test('pacHandler serves GET /asight.pac from state() per request, and leaves every other request to the door', () => {
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

const PEERS = [
  ['mac same uid', { pid: 1, uid: 501 }, { uid: 501 }, true],
  ['mac other uid', { pid: 2, uid: 502 }, { uid: 501 }, false],
  ['mac uid unknown', { pid: 3 }, { uid: 501 }, false],
  ['win same SID', { pid: 4, sid: 's-1-5-21-1-1001' }, { sid: 'S-1-5-21-1-1001' }, true],
  ['win other SID', { pid: 5, sid: 'S-1-5-21-1-1002' }, { sid: 'S-1-5-21-1-1001' }, false],
  ['win helper sameUser', { pid: 6, sameUser: true }, { sid: null }, true],
  ['win helper other user', { pid: 7, sameUser: false }, { sid: null }, false],
  ['no facts', null, { uid: 501 }, false],
]
for (const [name, peer, self, ok] of PEERS) {
  test(`CM33 peerAllowed: ${name} → ${ok ? 'allowed' : 'refused and recorded'}`, () => {
    const recs = []
    const r = peerAllowed(peer, self, { record: (e) => recs.push(e) })
    assert.equal(r.ok, ok)
    assert.equal(recs.length, ok ? 0 : 1)
    if (!ok) { assert.equal(r.code, 'pac-peer-refused'); assert.equal(recs[0].code, 'pac-peer-refused'); assert.equal(recs[0].event, 'failure'); assert.doesNotThrow(() => checkRecord({ ...recs[0], ts: new Date().toISOString() })) }
  })
}
