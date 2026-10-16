// test/collector/arch/door-system-proxy.test.mjs — the door's system proxy on its default path (4.11 P7; D49, invariant 6): what doorPartsFor hands the
// collector (systemProxyWatch over the arch's real reader, the OS answer injected below the reader: a scutil runner, a registry helper) goes through the real
// P7 chain. A follower of the system proxy with an enabled HTTPS proxy dials it (source 'system-proxy'), never direct; PAC is said, unreadable is said, off is
// direct. The chain never sees a raw reader answer (the bug this guards: raw scutil / registry values read as "no proxy", every follower dialled direct).
import test from 'node:test'
import assert from 'node:assert/strict'
import { systemProxyWatch } from '../../../src/collector/arch/model-backends.mjs'
import * as darwin from '../../../src/collector/arch/darwin/upstream.mjs'
import * as win32 from '../../../src/collector/arch/win32/upstream.mjs'
import { upstreamFor } from '../../../src/collector/core/proxymode/chain.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'

const IS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const sz = (value) => ({ kind: 'REG_SZ', value })
const dword = (value) => ({ kind: 'REG_DWORD', value })

/** One OS proxy setting, as each OS stores it; `null` setting = the read fails. */
const OS = {
  darwin: (s) => {
    const exec = (file, args) => {
      if (s === null) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync scutil ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
      const lines = [`HTTPSEnable : ${s.on ? 1 : 0}`, ...(s.host ? [`HTTPSProxy : ${s.host}`, `HTTPSPort : ${s.port}`] : []), ...(s.socks ? ['SOCKSEnable : 1', 'SOCKSProxy : 127.0.0.1', 'SOCKSPort : 1080'] : []), ...(s.pac ? ['ProxyAutoConfigEnable : 1'] : []),
        ...(s.bypass ? ['ExceptionsList : <array> {', '0 : *.corp.com', '}'] : [])]
      assert.deepEqual([file, ...args], ['scutil', '--proxy'])
      return { status: 0, stdout: `<dictionary> {\n${lines.join('\n')}\n}\n`, stderr: '' }
    }
    return { up: darwin, read: darwin.readSystemProxy, io: { exec } }
  },
  win32: (s) => {
    const values = s === null ? null : { ProxyEnable: dword(s.on ? 1 : 0), ...(s.host ? { ProxyServer: sz(s.socks ? `socks=${s.host}:${s.port}` : `${s.host}:${s.port}`) } : s.socks ? { ProxyServer: sz('socks=127.0.0.1:1080') } : {}), ...(s.pac ? { AutoConfigURL: sz('http://wpad/proxy.pac') } : {}), ...(s.bypass ? { ProxyOverride: sz('*.corp.com') } : {}) }
    const helper = {
      async call(verb, args) {
        assert.equal(verb, 'reg-read')
        if (args.key !== IS) return { keyExists: false, values: {} }
        if (values === null) throw Object.assign(new Error('t'), { code: 'helper-timeout' })
        return { keyExists: true, values: Object.fromEntries(args.names.filter((n) => n in values).map((n) => [n, values[n]])) }
      },
    }
    return { up: win32, read: win32.readSystemProxyChain, io: { helper } }
  },
}

const hosts = [['127.0.0.1', 7897], ['10.1.2.3', 3128], ['proxy.corp', 8080]]
/** Every setting along the axes, with what the follower's upstream must be. */
function* settings() {
  for (const [host, port] of hosts) for (const bypass of [false, true]) {
    yield [{ on: true, host, port, bypass }, { source: 'system-proxy', url: `http://${host}:${port}`, bypassed: bypass }]
    yield [{ on: false, host, port, bypass }, { source: 'direct', url: null }]
    yield [{ on: true, host, port, bypass, pac: true }, { pac: true, url: null }]
  }
  yield [{ on: true, socks: true }, { notDirect: true, url: null }]
  yield [null, { unreadable: true, url: null }]
}

test('the door hands the P7 chain the system proxy in its shape: on darwin and win32 a follower dials the enabled HTTPS proxy, never direct', async () => {
  const follower = (await loadHarnesses()).find((d) => d.proxy.systemProxy && d.proxy.systemProxy.http === true)
  assert.ok(follower, 'a harness that follows the system proxy')
  for (const os of Object.keys(OS)) for (const [s, want] of settings()) {
    const at = JSON.stringify({ os, s })
    const { up, read, io } = OS[os](s)
    const w = await systemProxyWatch({ up, read, io })
    try {
      const r = await upstreamFor({ desc: follower, facts: { pid: 1, start: 1, env: {}, parentOf: async () => null }, systemProxy: w.now() })
      assert.equal(r.url, want.url, at)
      if (want.source) assert.equal(r.source, want.source, at)
      if (want.bypassed) assert.ok(r.bypass.length > 0, `${at}: the bypass table rides along`)
      if (want.pac) assert.equal(r.pac, true, at)
      if (want.unreadable) assert.equal(r.unreadable, true, at)
      if (want.notDirect) assert.notEqual(r.source, 'direct', at)
    } finally { w.stop() }
  }
})
