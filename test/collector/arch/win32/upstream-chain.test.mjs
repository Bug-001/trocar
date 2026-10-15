// test/collector/arch/win32/upstream-chain.test.mjs — D57 scope: the Windows system-proxy reader the P7 chain takes. WPAD (AutoDetect, flag 0x8 of
// Connections\DefaultConnectionSettings) is a PAC like an AutoConfigURL: reported, never executed, never judged direct. The HKLM policy
// ProxySettingsPerUser=0 moves the settings to HKLM. Every key read is on the helper's allow-list. Nothing here runs Windows: the helper is an object.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chainSystemProxy, readSystemProxyChain } from '../../../../src/collector/arch/win32/upstream.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { upstreamFor } from '../../../../src/collector/core/proxymode/chain.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'

const IS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const POLICY = 'Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const sz = (value) => ({ kind: 'REG_SZ', value })
const dword = (value) => ({ kind: 'REG_DWORD', value })
/** DefaultConnectionSettings as WinINET writes it: version, counter, then the flags DWORD (1 direct, 2 proxy, 4 PAC url, 8 auto-detect). */
const conn = (flags) => { const b = Buffer.alloc(16); b.writeUInt32LE(0x46, 0); b.writeUInt32LE(3, 4); b.writeUInt32LE(flags, 8); return { kind: 'REG_BINARY', value: b.toString('base64') } }

/** The registry by `${hive}\\${key}`: each a map of value name → { kind, value }. Refuses what the helper would. */
function registry(keys) {
  const calls = []
  return {
    calls,
    async call(verb, args) {
      calls.push(args)
      assert.equal(verb, 'reg-read')
      if (regReadAllowed(args) === null) throw Object.assign(new Error('outside'), { code: 'helper-forbidden-key' })
      const k = keys[`${args.hive}\\${args.key}`]
      if (k === undefined) return { keyExists: false, values: {} }
      if (k instanceof Error) throw k
      return { keyExists: true, values: Object.fromEntries(args.names.filter((n) => n in k).map((n) => [n, k[n]])) }
    },
  }
}
const VERGE = { ProxyEnable: dword(1), ProxyServer: sz('127.0.0.1:7897'), ProxyOverride: sz('localhost;<local>') }

test('WPAD on (no ProxyServer, no AutoConfigURL) is a PAC: the follower\'s upstream is not direct but PAC-flagged', async () => {
  const helper = registry({ [`HKCU\\${IS}`]: {}, [`HKCU\\${IS}\\Connections`]: { DefaultConnectionSettings: conn(0x9) } })
  const sp = await readSystemProxyChain({ helper })
  assert.equal(sp.autoDetect, true)
  assert.deepEqual(chainSystemProxy(sp), { pac: true })
  const descs = await loadHarnesses()
  const follower = descs.find((d) => d.proxy.systemProxy.http === true)
  const r = await upstreamFor({ desc: follower, facts: { pid: 1, start: 1, env: {}, parentOf: async () => null }, systemProxy: chainSystemProxy(sp) })
  assert.notEqual(r.source, 'direct')
  assert.equal(r.pac, true)
  assert.equal(r.url, null)
  for (const a of helper.calls) assert.notEqual(regReadAllowed(a), null, JSON.stringify(a))
})

test('AutoDetect is flag 0x8 of DefaultConnectionSettings, whatever else is set; a short or absent blob is no WPAD', async () => {
  for (const [blob, want] of [[conn(0x9), true], [conn(0x8 | 0x2), true], [conn(0xd), true], [conn(0x1), false], [conn(0x3), false], [{ kind: 'REG_BINARY', value: 'RgAAAA==' }, false], [sz('x'), false], [undefined, false]]) {
    const helper = registry({ [`HKCU\\${IS}`]: VERGE, [`HKCU\\${IS}\\Connections`]: blob === undefined ? {} : { DefaultConnectionSettings: blob } })
    const sp = await readSystemProxyChain({ helper })
    assert.equal(sp.autoDetect, want, JSON.stringify(blob))
    if (want) assert.deepEqual(chainSystemProxy(sp), { pac: true }, 'WPAD wins over a manual proxy, as an AutoConfigURL does')
  }
})

test('ProxySettingsPerUser=0 reads HKLM Internet Settings (and its Connections); any other value or none reads HKCU', async () => {
  const keys = {
    [`HKLM\\${POLICY}`]: { ProxySettingsPerUser: dword(0) },
    [`HKLM\\${IS}`]: { ProxyEnable: dword(1), ProxyServer: sz('proxy.corp:3128'), ProxyOverride: sz('*.corp.com') },
    [`HKCU\\${IS}`]: VERGE,
  }
  const machine = await readSystemProxyChain({ helper: registry(keys) })
  assert.equal(machine.hive, 'HKLM')
  assert.deepEqual(chainSystemProxy(machine), { url: 'http://proxy.corp:3128', bypass: [{ kind: 'domain-suffix', value: 'corp.com' }] })
  for (const pol of [dword(1), sz('0'), undefined]) {
    const user = await readSystemProxyChain({ helper: registry({ ...keys, [`HKLM\\${POLICY}`]: pol === undefined ? {} : { ProxySettingsPerUser: pol } }) })
    assert.equal(user.hive, 'HKCU', JSON.stringify(pol))
    assert.equal(chainSystemProxy(user).url, 'http://127.0.0.1:7897')
  }
  const polGone = await readSystemProxyChain({ helper: registry({ ...keys, [`HKLM\\${POLICY}`]: Object.assign(new Error('t'), { code: 'helper-timeout' }) }) })
  assert.equal(polGone.hive, 'HKCU', 'a policy that cannot be read is the default: per user')
})

test('the chain shape: off is none; socks5 kept as socks5; a SOCKS-only, TLS or credentialed ProxyServer, or an unreadable key, is not usable (ok:false)', async () => {
  const read = async (k) => chainSystemProxy(await readSystemProxyChain({ helper: registry({ [`HKCU\\${IS}`]: k }) }))
  assert.equal(await read({ ...VERGE, ProxyEnable: dword(0) }), null)
  assert.equal(await read({}), null)
  assert.deepEqual(await read({ ProxyEnable: dword(1), ProxyServer: sz('socks5://127.0.0.1:1080') }), { url: 'socks5://127.0.0.1:1080', bypass: [] })
  assert.deepEqual(await read({ ProxyEnable: dword(1), ProxyServer: sz('http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808') }), { url: 'http://127.0.0.1:10809', bypass: [] })
  for (const server of ['socks=127.0.0.1:10808', 'https://proxy.corp:443', 'http://u:p@proxy.corp:3128']) assert.equal((await read({ ProxyEnable: dword(1), ProxyServer: sz(server) })).ok, false, server)
  assert.deepEqual(await read({ ...VERGE, AutoConfigURL: sz('http://wpad/proxy.pac') }), { pac: true })
  const gone = await readSystemProxyChain({ helper: registry({ [`HKCU\\${IS}`]: Object.assign(new Error('t'), { code: 'helper-timeout' }) }) })
  assert.deepEqual(chainSystemProxy(gone), { ok: false, why: 'system-proxy-unreadable' })
})
