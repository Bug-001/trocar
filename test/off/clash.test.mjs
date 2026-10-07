// test/off/clash.test.mjs — src/off/clash.mjs is the ONE undo of asight's Clash route (RFC 1.6 §4: `asight off` and `asight desktop off` run the same code). What src/capture/desktop-steer.mjs
// exports under the old names is that code, not a copy of it; the pure transforms take asight's route out and leave every other byte (D28, D29).
import test from 'node:test'
import assert from 'node:assert/strict'
import * as clash from '../../src/off/clash.mjs'
import { makeClash } from '../../src/off/clash.mjs'
import * as steer from '../../src/capture/desktop-steer.mjs'

test('1.6 §4: desktop-steer re-exports the strip transforms of src/off/clash.mjs — the same functions and names, not a second copy', () => {
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

test('1.6 §4: the socket discovery, the payload reload and the probes are src/off/clash.mjs\'s too, and desktop-steer says so', () => {
  for (const name of ['knownMihomoSocks', 'mihomoSockCandidates', 'discoverMihomoSock', 'mihomoPayloadReload', 'REACTIVATE_HINT']) assert.equal(steer[name], clash[name], `${name} is src/off/clash.mjs's`)
  for (const name of ['probeVersion', 'probeProxy']) assert.equal(typeof clash[name], 'function', `${name} is exported from src/off/clash.mjs (module-private in desktop-steer before)`)
})

test('makeClash finds the core through the injected runner of `ps` (never a real one), pins ASIGHT_MIHOMO_SOCK without asking ps, and answers null — unknown, never "not live" — when no core answers', async () => {
  const calls = []
  const exec = (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '/x/verge-mihomo -d /x -ext-ctl-unix /nonexistent/mihomo.sock\n', stderr: '' } }
  const files = { '/rt.yaml': 'proxies:\n- {name: VPN}\nrules:\n- MATCH,VPN\n' }
  const fsys = { existsSync: (p) => p in files, readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] } }
  const c = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', exec, env: {}, knownSocks: [] })
  assert.equal(await c.probeLive(), null, 'no socket answers: unknown')
  assert.deepEqual(c.located().tried, ['/nonexistent/mihomo.sock'], 'the one ps named was tried')
  assert.deepEqual(calls, ['/bin/ps -axww -o command='])
  const pinned = makeClash({ fs: fsys, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', exec, env: { ASIGHT_MIHOMO_SOCK: '/pinned.sock' } })
  assert.equal(await pinned.probeLive(), null)
  assert.deepEqual(pinned.located().tried, ['/pinned.sock'])
  assert.equal(calls.length, 1, 'a pinned socket needs no ps')
})
