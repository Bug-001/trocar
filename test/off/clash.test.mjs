// test/off/clash.test.mjs — src/off/clash.mjs is the ONE undo of trocar's Clash route (`trocar desktop off` runs it). What src/capture/desktop-steer.mjs
// exports under the old names is that code, not a copy of it; the pure transforms take trocar's route out and leave every other byte .
import test from 'node:test'
import assert from 'node:assert/strict'
import * as clash from '../../src/off/clash.mjs'
import { makeClash } from '../../src/off/clash.mjs'
import * as steer from '../../src/capture/desktop-steer.mjs'

test('desktop-steer re-exports the strip transforms of src/off/clash.mjs — the same functions and names, not a second copy', () => {
  for (const name of ['stripBlock', 'stripRuntime', 'stripMergeLegacy', 'PROXY_NAME', 'DESKTOP_RULE']) assert.equal(steer[name], clash[name], `${name} is src/off/clash.mjs's`)
  assert.equal(clash.PROXY_NAME, 'atrace-mitm', 'a legacy name (the proxy Clash lists), not to be renamed')
})

test('stripBlock takes the sentinel block out of Script.js (the // form) and of a runtime yaml (the # form) and nothing else', () => {
  const js = `function main(config) {\n  // ${clash.MARK_BEGIN}\n  config.rules.unshift('x');\n  // ${clash.MARK_END}\n  return config;\n}\n`
  assert.equal(clash.stripBlock(js), 'function main(config) {\n  return config;\n}\n')
  const yaml = `proxies:\n# ${clash.MARK_BEGIN}\n- {name: ${clash.PROXY_NAME}}\n# ${clash.MARK_END}\n- {name: VPN}\n`
  assert.equal(clash.stripBlock(yaml), 'proxies:\n- {name: VPN}\n')
  assert.equal(clash.stripBlock('function main(c) { return c; }\n'), 'function main(c) { return c; }\n', 'no block: the bytes are not touched')
})

test('the socket discovery, the payload reload and the probes are src/off/clash.mjs\'s too, and desktop-steer says so', () => {
  for (const name of ['knownMihomoSocks', 'mihomoSockCandidates', 'discoverMihomoSock', 'mihomoPayloadReload', 'REACTIVATE_HINT']) assert.equal(steer[name], clash[name], `${name} is src/off/clash.mjs's`)
  for (const name of ['probeVersion', 'probeProxy']) assert.equal(typeof clash[name], 'function', `${name} is exported from src/off/clash.mjs (module-private in desktop-steer before)`)
})

test('makeClash finds the core through the injected runner of `ps` (never a real one), pins TROCAR_MIHOMO_SOCK without asking ps, and answers null — unknown, never "not live" — when no core answers', async () => {
  const calls = []
  const exec = (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '/x/verge-mihomo -d /x -ext-ctl-unix /nonexistent/mihomo.sock\n', stderr: '' } }
  const files = { '/rt.yaml': 'proxies:\n- {name: VPN}\nrules:\n- MATCH,VPN\n' }
  const fsys = { existsSync: (p) => p in files, readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] } }
  const c = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', exec, env: {}, knownSocks: [] })
  assert.equal(await c.probeLive(), null, 'no socket answers: unknown')
  assert.deepEqual(c.located().tried, ['/nonexistent/mihomo.sock'], 'the one ps named was tried')
  assert.deepEqual(calls, ['/bin/ps -axww -o command='])
  const pinned = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', exec, env: { TROCAR_MIHOMO_SOCK: '/pinned.sock' } })
  assert.equal(await pinned.probeLive(), null)
  assert.deepEqual(pinned.located().tried, ['/pinned.sock'])
  assert.equal(calls.length, 1, 'a pinned socket needs no ps')
})

test('stripMergeLegacy takes out trocar\'s own items of prepend-proxies / prepend-rules and NOTHING the user wrote: a Merge.yaml with none of them comes back byte for byte, a mixed list keeps the user\'s items and its header', () => {
  const strip = clash.stripMergeLegacy
  const user = 'profile:\n  store-selected: true\nprepend-rules:\n  - DOMAIN,corp.example.com,DIRECT\n  - DOMAIN-SUFFIX,intranet.example,DIRECT\nprepend-proxies:\n  - {name: my-jump, type: ss, server: 1.2.3.4, port: 1}\n  - name: other\n    type: http\n    plugin-opts: {name: atrace-mitm}\n'
  assert.equal(strip(user), user, 'the user\'s own lists are not trocar\'s: not one byte moves (a nested `name: atrace-mitm` of another proxy is not the proxy\'s name)')
  const mixed = 'prepend-rules:\n  - DOMAIN,corp.example.com,DIRECT\n  - AND,((PROCESS-PATH-REGEX,x),(DOMAIN,api.anthropic.com)),atrace-mitm\n  - "DOMAIN,quoted.example,atrace-mitm,no-resolve"\n  - DOMAIN-SUFFIX,intranet.example,DIRECT\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\n  - {name: my-jump, type: ss, server: 1.2.3.4, port: 1}\n'
  assert.equal(strip(mixed), 'prepend-rules:\n  - DOMAIN,corp.example.com,DIRECT\n  - DOMAIN-SUFFIX,intranet.example,DIRECT\nprepend-proxies:\n  - {name: my-jump, type: ss, server: 1.2.3.4, port: 1}\n')
  // the demo fragment as the repository ships it: a block item with a comment inside, a rule — both lists, headers included, go; the keys around them stay
  const demo = 'profile:\n  store-selected: true\n\nprepend-proxies:\n  - name: atrace-mitm\n    type: http\n    server: 127.0.0.1\n    port: 9899\n    # plaintext localhost hop to our own MITM\n\nprepend-rules:\n  - AND,((PROCESS-PATH-REGEX,(?i)Application Support/Claude/claude-code),(DOMAIN,api.anthropic.com)),atrace-mitm\n\nother: 1\n'
  assert.equal(strip(demo), 'profile:\n  store-selected: true\n\n\n\nother: 1\n', 'only trocar\'s lines go (the blank lines around them are the user\'s)')
  assert.equal(strip('prepend-rules: []\nprepend-proxies:\n'), 'prepend-rules: []\nprepend-proxies:\n', 'an empty or flow-style list has no item of trocar\'s')
  assert.equal(strip('prepend-rules:\r\n  - DOMAIN,a.example,DIRECT\r\n  - DOMAIN,x,atrace-mitm\r\n'), 'prepend-rules:\r\n  - DOMAIN,a.example,DIRECT\r\n', 'CRLF files')
  const wrapped = `profile: 1\n# ${clash.MARK_BEGIN}\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\nprepend-rules:\n  - DOMAIN,x,atrace-mitm\n# ${clash.MARK_END}\n`
  assert.equal(strip(wrapped), 'profile: 1\n', 'the sentinel-wrapped form the demo wrote goes whole')
})

test('makeClash.off: the core still lists the route and there is no runtime config to reload from — no reload is made, and the result is ok:false with a reason that says so (never ok with the route live)', async () => {
  const files = { '/s.js': 'function main(c) { return c; }\n' } // no clash-verge.yaml
  const fsys = { existsSync: (p) => p in files, readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] }, writeFileSync: (p, t) => { files[p] = t } }
  let reloads = 0
  const c = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', env: { TROCAR_MIHOMO_SOCK: '/x.sock' }, mihomoReload: async () => { reloads++; return { status: 204 } }, probeLive: async () => true })
  const r = await c.off()
  assert.equal(r.ok, false)
  assert.equal(reloads, 0, 'there is nothing to build a clean config from')
  assert.match(r.reason, /still in the core's live proxy list and no reload was made: there is no runtime config \(\/rt\.yaml\)/)
  const gone = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', env: { TROCAR_MIHOMO_SOCK: '/x.sock' }, probeLive: async () => false })
  assert.equal((await gone.off()).ok, true, 'a core that does not list it is fine without a runtime')
})
