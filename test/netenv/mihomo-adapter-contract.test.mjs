// W57 (second half, the one about the user's VPN): the controller client and the Verge adapter on a REAL mihomo, not on fixtures/fake-core.mjs. D43: asight only reads the user's core, so what is held to the real
// binary is the two reads (GET /version, GET /configs), the refusals of a client that cannot write (4.7 N9: /rules, the node list and every write method are refused before a byte is sent), and the fixed
// messages a real core says for a refused request, which are the only words of the core the client ever hands on (fixtures/real-rules.mjs, the tables the fake core and the client's own test answer from).
// The own kernel's client (own: true, which may write its own config) is the same code; it is checked here against a real core too because that core is the stand-in for the kernel.
//
// Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary (fixtures/real-mihomo.mjs: loopback only, a scratch home, no tun, no dns, no geodata download, the process killed in t.after); otherwise it skips.
// The scratch home is a Verge data directory (verge.yaml, profiles.yaml, profiles/Script.js, the runtime clash-verge.yaml) and the core runs on that runtime as Verge's does (`-d <home> -f clash-verge.yaml`).
// The nodes are `http` outbounds at the discard port and every group is a select (no health check dials out).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpDir } from '../helpers/tmp.mjs'
import { gate, freePort, startMihomo } from './fixtures/real-mihomo.mjs'
import { loopbackRuntimeText } from './fixtures/rules/runtime.mjs'
import { VERGE_YAML, PROFILES_YAML, SCRIPT_JS, CONFIG_YAML } from './fixtures/verge-world.mjs'
import { RECORDED_REFUSALS, RECORDED_FIXED } from './fixtures/real-rules.mjs'
import { createController } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter, VERGE_DIR_NAME } from '../../src/netenv/adapters/clash-verge-rev.mjs'

/** A Verge data directory with a real core running on its runtime, the adapter on that core's controller (read-only), and a client of the same core that may write (`own: true`: the kernel's kind). */
async function realWorld(t) {
  const ports = { mixed: await freePort(), controller: await freePort() }
  const secret = randomBytes(16).toString('hex')
  const sandbox = tmpDir('asight-realworld-')
  const home = path.join(sandbox, 'AppData', 'Roaming', VERGE_DIR_NAME)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const yaml = loopbackRuntimeText({ mixed: ports.mixed, controller: ports.controller, secret })
  const put = (rel, text) => fs.writeFileSync(path.join(home, rel), text)
  put('verge.yaml', VERGE_YAML()); put('config.yaml', CONFIG_YAML); put('profiles.yaml', PROFILES_YAML); put(path.join('profiles', 'Script.js'), SCRIPT_JS); put('clash-verge.yaml', yaml)
  const m = await startMihomo(t, { configText: yaml, configName: 'clash-verge.yaml', home, secret, controller: ports.controller })
  const endpoint = `tcp:127.0.0.1:${ports.controller}`
  const ctl = createController({ endpoint, secret })
  const own = createController({ endpoint, secret, own: true })
  const adapter = createVergeAdapter({ home, controller: ctl, running: () => true })
  return { ports, secret, sandbox, home, m, ctl, own, adapter, file: (rel) => path.join(home, rel) }
}
/** A PUT whose body is the text as it is (the client and `m.ctl` both send JSON), with the controller's own secret: what the core says to a body that is not JSON. */
const putText = (w, target, text) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: w.ports.controller, method: 'PUT', path: target, agent: false, headers: { authorization: `Bearer ${w.secret}`, 'content-type': 'application/json' } }, (rs) => {
    let b = ''
    rs.on('data', (d) => { b += d })
    rs.on('end', () => resolve({ status: rs.statusCode, message: JSON.parse(b).message }))
  })
  r.on('error', reject)
  r.end(text)
})

test('W57 adapter, reads: GET /configs and GET /version of the real core are what the adapter reads (mode, mixed-port, tun, version), and it asks nothing else', gate, async (t) => {
  const w = await realWorld(t)
  assert.deepEqual(await w.adapter.readConfigs(), { ok: true, mode: 'rule', mixedPort: w.ports.mixed, tun: false })
  const f = await w.adapter.facts()
  assert.match(f.runtime.version, /^v?\d+\.\d+/)
  assert.deepEqual([f.runtime.mode, f.runtime.mixedPort, f.runtime.tun, f.controller.how], ['rule', w.ports.mixed, false, 'given'])
})

test('W57 a core that refuses a config (the own kernel\'s client): the client keeps the status and none of the core\'s words; the recorded refusals and fixed messages are what this core says', gate, async (t) => {
  const w = await realWorld(t)
  const base = () => ({ 'mixed-port': w.ports.mixed, 'external-controller': `127.0.0.1:${w.ports.controller}`, secret: w.secret, mode: 'rule', proxies: [{ name: 'node-a', type: 'http', server: '127.0.0.1', port: 9 }],
    'proxy-groups': [{ name: 'Manual', type: 'select', proxies: ['node-a'] }], rules: ['MATCH,DIRECT'] })
  const variants = [
    (c) => { c.rules = ['DOMAIN,x.example,My Private Group', 'MATCH,DIRECT'] },
    (c) => { c['proxy-groups'] = [{ name: 'Manual', type: 'select', proxies: ['Secret Node'] }] },
    (c) => { c['proxy-groups'] = [{ name: 'AUTO-ALL', type: 'select', proxies: ['node-a'] }, { name: 'AUTO-ALL', type: 'select', proxies: ['node-a'] }] },
    (c) => { c.rules = ['PROCESS-NAME,x.exe,Zzz Group Name', 'MATCH,DIRECT'] },
    (c) => { c.__text = JSON.stringify('this: is: not: [valid') },
    (c) => { c.__text = ':\n  - [' },
  ]
  assert.equal(variants.length, RECORDED_REFUSALS.length)
  for (const [i, { why, status, message }] of RECORDED_REFUSALS.entries()) {
    const c = base()
    variants[i](c)
    const payload = c.__text ?? JSON.stringify(c)
    const raw = await w.m.ctl('PUT', '/configs?force=true', { payload })
    assert.deepEqual([raw.status, raw.json().message], [status, message], `${why}: this core says what the table recorded`)
    const through = await w.own.put('/configs?force=true', { payload })
    assert.deepEqual([through.status, through.ok, through.text, through.json], [status, false, '', null], `${why}: the client hands on the status and nothing the core said`)
  }

  // the fixed messages: each is what this core says for the thing it names, so the client's allow-list is the core's own list
  const seen = new Map()
  const bearer = await createController({ endpoint: `tcp:127.0.0.1:${w.ports.controller}`, secret: 'a-wrong-secret-1234' }).get('/version')
  seen.set(bearer.text, bearer.status)
  const missing = await w.own.get('/proxies/asight-sw-nope')
  seen.set(missing.text, missing.status)
  const body = await putText(w, '/proxies/Manual', 'not json')
  seen.set(body.message, body.status)
  const sel = await w.m.ctl('PUT', '/proxies/Manual', { name: 'no-such-member' })
  seen.set(sel.json().message, sel.status)
  assert.deepEqual([...seen.keys()].sort(), [...RECORDED_FIXED].sort(), 'the four fixed messages of the allow-list, each seen from this core')
  assert.deepEqual([...seen.values()].sort(), [400, 400, 401, 404])
})
