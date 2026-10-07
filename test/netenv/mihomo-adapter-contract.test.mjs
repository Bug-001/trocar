// W57 (second half): the controller client and the Verge adapter on a REAL mihomo, not on fixtures/fake-core.mjs. The plan says every behaviour the fake fakes is re-checked here, and a review found it was not:
// the fake echoed the config's spelling of a logic rule where the core renders `((ProcessName,a.exe) && (Domain,x))`, and a refused config's text, which the core fills with the user's own names, was tested
// only with a made-up quoted one. What follows runs createController and createVergeAdapter against the core and pins the tables of fixtures/real-rules.mjs, which the fake answers from.
//
// Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary (fixtures/real-mihomo.mjs: loopback only, a scratch home, no tun, no dns, no geodata download, the process killed in t.after); otherwise it skips.
// The scratch home is a Verge data directory (verge.yaml, profiles.yaml, profiles/Script.js, the runtime clash-verge.yaml) and the core runs on that runtime as Verge's does (`-d <home> -f clash-verge.yaml`),
// so the route files the adapter writes are where the core's file providers read them. The nodes are `http` outbounds at the discard port and every group is a select (no health check dials out).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpDir } from '../helpers/tmp.mjs'
import { gate, freePort, startMihomo } from './fixtures/real-mihomo.mjs'
import { loopbackRuntimeText } from './fixtures/rules/runtime.mjs'
import { block as blockInput, CC_CLI, CODEX_APP } from './fixtures/rules/inputs.mjs'
import { memoryLedger } from './fixtures/ledger.mjs'
import { VERGE_YAML, PROFILES_YAML, SCRIPT_JS, CONFIG_YAML } from './fixtures/verge-world.mjs'
import { RECORDED_RULES, RECORDED_REFUSALS, RECORDED_FIXED, RECORDED_FORMS, RECORDED_NAMING } from './fixtures/real-rules.mjs'
import { createController } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter, VERGE_DIR_NAME } from '../../src/netenv/adapters/clash-verge-rev.mjs'
import { buildBlock, buildScriptJs, names } from '../../src/netenv/mihomo/rules.mjs'

const CC = CC_CLI.g
const CODEX = CODEX_APP.g

/** A Verge data directory with a real core running on its runtime, the adapter on that core's controller, and the ledger in memory. */
async function realWorld(t, { rules = ['MATCH,DIRECT'], runtime = (y) => y } = {}) {
  const ports = { mixed: await freePort(), controller: await freePort(), engine: await freePort() }
  const secret = randomBytes(16).toString('hex')
  const sandbox = tmpDir('asight-realworld-')
  const home = path.join(sandbox, 'AppData', 'Roaming', VERGE_DIR_NAME)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const yaml = runtime(loopbackRuntimeText({ mixed: ports.mixed, controller: ports.controller, secret })
    .replace('find-process-mode: "off"', 'find-process-mode: strict')
    .replace('rules:\n- MATCH,DIRECT\n', `rules:\n${rules.map((r) => `- ${JSON.stringify(r)}`).join('\n')}\n`)) // a JSON string is a YAML string
  const put = (rel, text) => fs.writeFileSync(path.join(home, rel), text)
  put('verge.yaml', VERGE_YAML()); put('config.yaml', CONFIG_YAML); put('profiles.yaml', PROFILES_YAML); put(path.join('profiles', 'Script.js'), SCRIPT_JS); put('clash-verge.yaml', yaml)
  const m = await startMihomo(t, { configText: yaml, configName: 'clash-verge.yaml', home, secret, controller: ports.controller })
  const ctl = createController({ endpoint: `tcp:127.0.0.1:${ports.controller}`, secret })
  const ledger = memoryLedger({ home: sandbox })
  const adapter = createVergeAdapter({ home, controller: ctl, ledger, running: () => true, daemonAlive: () => false })
  const block = buildBlock(blockInput([CC_CLI, CODEX_APP], { enginePort: ports.engine, reenter: { host: '127.0.0.1', port: ports.mixed } }))
  const lines = (g) => block.files[names(g).routeFile].split('\n').filter(Boolean)
  return { ports, secret, sandbox, home, m, ctl, ledger, adapter, block, lines, file: (rel) => path.join(home, rel), script: () => fs.readFileSync(path.join(home, 'profiles', 'Script.js')) }
}
const groupsOn = (w, on) => [CC, CODEX].map((g) => ({ g, on: on.includes(g), lines: w.lines(g) }))
const nowOf = async (w, name) => (await w.m.ctl('GET', `/proxies/${name}`)).json().now
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

test('W57 adapter, reads: GET /rules gives the recorded payload strings and processRulesNaming finds a process rule in each; GET /configs and a missing group are as the adapter reads them', gate, async (t) => {
  const w = await realWorld(t, { rules: RECORDED_RULES.map((r) => r.rule.replace(/,G$/, ',Manual')) })
  const rules = (await w.ctl.get('/rules')).json.rules
  assert.deepEqual(rules.map((r) => [r.type, r.payload]), RECORDED_RULES.map((r) => [r.type, r.payload]), 'the real core renders every rule as the table, which the fake core answers')
  const naming = await w.adapter.processRulesNaming(RECORDED_FORMS)
  assert.deepEqual([naming.ok, naming.reason], [true, null])
  assert.deepEqual(naming.rules.map((x) => [x.type, x.forms]), RECORDED_NAMING, 'a process rule is found in AND, OR, NOT, a NOT inside an AND, and a regex with groups')
  const text = JSON.stringify(naming)
  for (const leak of ['Manual', 'x.example', 'y.example', '443', 'DIRECT']) assert.ok(!text.includes(leak), `${leak} did not leave processRulesNaming`)

  assert.deepEqual(await w.adapter.readConfigs(), { ok: true, mode: 'rule', mixedPort: w.ports.mixed, tun: false, findProcessMode: 'strict' })
  assert.deepEqual(await w.adapter.readFindProcessMode(), { mode: 'strict', reason: null })

  // a group that is not in the runtime is a 404 on this core, and every read and write of the adapter takes it for what it is
  assert.deepEqual(await w.adapter.verify(CC), { live: false, now: null, fbNow: null, ruleCount: null, reason: 'block-not-in-runtime' })
  assert.deepEqual(await w.adapter.putSelect(CC, 'PASS'), { ok: false, status: 404, reason: 'refused', text: 'Resource not found' })
  assert.deepEqual(await w.adapter.refreshProvider(CC), { ok: false, status: 404, reason: 'refused' })
  assert.deepEqual(await w.adapter.refreshProbe(CC, { reenterPort: w.ports.mixed }), { ok: false, status: 404, reason: 'unreadable' })
  assert.deepEqual(w.ledger.entries(), [], 'nothing that failed is recorded')
})

test('W57 adapter, the whole turn on a real core: installBlock pushes the runtime, verify reads on and off from the provider list, a switch of one group leaves the other, removeBlock leaves PASS and a clean disk', gate, async (t) => {
  const w = await realWorld(t)
  const original = w.script()
  const { block } = w
  const reenter = w.ports.mixed

  // first `on`: the block is not in the runtime, so the runtime is pushed with it spliced in; the select starts on PASS and is put on the fallback group
  const first = await w.adapter.installBlock({ block, blockText: buildScriptJs({ block }), groups: groupsOn(w, [CC]) })
  assert.deepEqual([first.ok, first.exit, first.script.ok, first.lines], [true, 0, true, []], JSON.stringify(first.rows))
  assert.deepEqual(first.rows.map((r) => [r.g, r.strategy, r.state, r.live, r.now, r.reason]), [[CC, ['payload'], 'verified', true, names(CC).fb, null], [CODEX, ['none'], 'verified', false, 'PASS', 'off']])
  assert.equal(first.rows[0].ruleCount, w.lines(CC).length, 'the count is the real provider list\'s: the lines of the route file')
  assert.equal(first.rows[1].ruleCount, 0, 'an empty file is a provider with nothing in it')
  assert.deepEqual([await nowOf(w, names(CC).sw), await nowOf(w, names(CODEX).sw)], [names(CC).fb, 'PASS'])
  assert.equal((await w.adapter.verify(CC)).live, true)
  assert.deepEqual(w.ledger.entries().map((e) => e.kind).sort(), ['vpn-rule-file', 'vpn-rule-file', 'vpn-runtime-block', 'vpn-runtime-select', 'vpn-script-block'])
  assert.equal(first.receipts.length, w.ledger.entries().length, 'a receipt row for every ledger entry')

  // the daemon's refresh after the engine (re)starts: the group's own probe URL; nothing listens on the engine port, so the group settles on the re-entry point
  assert.deepEqual(await w.adapter.refreshProbe(CC, { reenterPort: reenter }), { ok: true, status: 200, reason: null })
  assert.equal((await w.adapter.verify(CC)).fbNow, names(CC).re, 'asight-re answers its own probe, asight-in does not (no engine)')
  assert.equal((await w.adapter.verify(CC, { daemonAlive: true })).reason, 'fallback-active', 'and with the daemon alive that is said')

  // the runtime is pushed again (Verge activating the subscription): the core remembers the select in its cache.db, as the fake core's `storeSelected` does, and CC stays on
  assert.equal((await w.adapter.pushPayload({ block })).ok, true)
  assert.deepEqual([await nowOf(w, names(CC).sw), await nowOf(w, names(CODEX).sw)], [names(CC).fb, 'PASS'])

  // off for one group: its select goes to PASS and its provider is emptied and re-read; the other group (off) is not touched, nor the script
  const script = w.script()
  const off = await w.adapter.applyGroups({ groups: [{ g: CC, on: false }] })
  assert.deepEqual([off.ok, off.rows[0].strategy, off.rows[0].state, off.rows[0].live, off.rows[0].reason, off.rows[0].ruleCount], [true, ['select', 'provider'], 'verified', false, 'off', 0])
  assert.ok(w.script().equals(script), 'Script.js is not touched by a switch')
  // on again: both keys, read back
  const on = await w.adapter.applyGroups({ groups: groupsOn(w, [CC]).slice(0, 1) })
  assert.deepEqual([on.ok, on.rows[0].strategy, on.rows[0].live, on.rows[0].ruleCount], [true, ['select', 'provider'], true, w.lines(CC).length])
  // one key is enough for off: the select alone, the provider left full, and the core says off
  assert.equal((await w.m.ctl('PUT', `/proxies/${names(CC).sw}`, { name: 'PASS' })).status, 204)
  const selectOnly = await w.adapter.verify(CC)
  assert.deepEqual([selectOnly.live, selectOnly.now, selectOnly.ruleCount, selectOnly.reason], [false, 'PASS', w.lines(CC).length, 'off'])
  await w.adapter.applyGroups({ groups: groupsOn(w, [CC]).slice(0, 1) })

  // the whole `off`
  const gone = await w.adapter.removeBlock({ groups: [CC, CODEX] })
  assert.deepEqual([gone.ok, gone.exit, gone.lines, gone.script.identical], [true, 0, [], true])
  assert.deepEqual(gone.residue.map((x) => x.kind), ['runtime-block', 'cache-db-select'])
  assert.deepEqual([await nowOf(w, names(CC).sw), await nowOf(w, names(CODEX).sw)], ['PASS', 'PASS'], 'both read PASS from the core')
  assert.ok(w.script().equals(original), 'Script.js is as it was, byte for byte')
  assert.deepEqual([fs.existsSync(path.join(w.home, 'asight')), w.ledger.backups().length], [false, 0])
  assert.deepEqual(w.ledger.entries().map((e) => e.kind).sort(), ['vpn-runtime-block', 'vpn-runtime-select', 'vpn-runtime-select'], 'the runtime kinds stay: they are the residue')
  for (const row of gone.rows) assert.deepEqual([row.state, row.live], ['verified', false])

  // the strip of the payload path: the runtime goes back without a trace of asight, and the core accepts it
  const stripped = await w.adapter.pushPayload({ strip: true })
  assert.deepEqual([stripped.ok, stripped.receipt.change], [true, 'removed'])
  assert.equal((await w.adapter.verify(CC)).reason, 'block-not-in-runtime')
  assert.deepEqual(Object.keys((await w.m.ctl('GET', '/providers/rules')).json().providers).filter((k) => k.startsWith('asight-')), [])
})

test('W57 adapter, a core that refuses a config: the adapter keeps the status and a reason class and none of the core\'s words; the recorded refusals and fixed messages are what this core says', gate, async (t) => {
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
    const through = await w.ctl.put('/configs?force=true', { payload })
    assert.deepEqual([through.status, through.ok, through.text, through.json], [status, false, '', null], `${why}: the client hands on the status and nothing the core said`)
  }

  // the adapter: a runtime that names a group that is not there is refused by the core; the result is the status and the class
  fs.writeFileSync(w.file('clash-verge.yaml'), fs.readFileSync(w.file('clash-verge.yaml'), 'utf8').replace('- "MATCH,DIRECT"', '- "DOMAIN,x.example,My Private Group"\n- "MATCH,DIRECT"'))
  const refused = await w.adapter.pushPayload({ block: w.block })
  assert.deepEqual(refused, { ok: false, status: 400, reason: 'refused' })
  const first = await w.adapter.installBlock({ block: w.block, blockText: buildScriptJs({ block: w.block }), groups: groupsOn(w, [CC]) })
  const text = JSON.stringify([first, w.ledger.entries(), w.ledger.kept()])
  for (const leak of ['Private', 'x.example', 'not found']) assert.ok(!text.includes(leak), `"${leak}" of the core's words is not in a result, an entry or a receipt`)
  assert.deepEqual(first.rows.map((r) => [r.strategy, r.state, r.reason]), [[['payload', 'none'], 'not-live', 'block-not-in-runtime'], [['none'], 'verified', 'block-not-in-runtime']], 'the files are written and the receipt says 未生效')
  assert.ok(first.lines.includes('已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活'))

  // the fixed messages: each is what this core says for the thing it names, so the client's allow-list is the core's own list
  const seen = new Map()
  const bearer = await createController({ endpoint: `tcp:127.0.0.1:${w.ports.controller}`, secret: 'a-wrong-secret-1234' }).get('/version')
  seen.set(bearer.text, bearer.status)
  const missing = await w.ctl.get('/proxies/asight-sw-nope')
  seen.set(missing.text, missing.status)
  const body = await putText(w, '/proxies/Manual', 'not json')
  seen.set(body.message, body.status)
  const sel = await w.m.ctl('PUT', '/proxies/Manual', { name: 'no-such-member' })
  seen.set(sel.json().message, sel.status)
  assert.deepEqual([...seen.keys()].sort(), [...RECORDED_FIXED].sort(), 'the four fixed messages of the allow-list, each seen from this core')
  assert.deepEqual([...seen.values()].sort(), [400, 400, 401, 404])
})
