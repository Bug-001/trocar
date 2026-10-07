// verge-apply.test.mjs — what asight does to Verge's groups and what it reads back (RFC 4.8 §4.1 · §4.3 · §4.4, 4.7 §3.4; acceptance W11 W55 W56): verify() from the provider list, the strategies, the switch of a
// single harness's groups, Verge not running or its controller unreadable. The controller is a fake core (fixtures/fake-core.mjs, W57 holds it to the real mihomo); Verge's data directory is a sandbox.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startWorld, snapshot, sha, GROUPS, VERGE_YAML } from './fixtures/verge-world.mjs'
import { names, buildScriptJs } from '../../src/netenv/mihomo/rules.mjs'
import { pickApply } from '../../src/netenv/adapters/clash-verge-rev.mjs'

const CC = 'claude-code.cli'
const CODEX = 'codex.app'
const lineCount = (w, g) => w.block().files[names(g).routeFile].split('\n').filter(Boolean).length

// ---- W11: verify -------------------------------------------------------------------------------------------------------------------------------------------------------

test('W11 verify: on = the select is on the fallback group AND the provider has rules; the count comes from the list while the single-provider read is 405', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  const on = await w.adapter.verify(CC)
  assert.deepEqual(on, { live: true, now: names(CC).fb, fbNow: names(CC).in, ruleCount: lineCount(w, CC), reason: null })
  const off = await w.adapter.verify(CODEX)
  assert.deepEqual(off, { live: false, now: 'PASS', fbNow: names(CODEX).in, ruleCount: 0, reason: 'off' })
  assert.ok(!w.core.requests.some((r) => /^\/providers\/rules\/./.test(r.path)), 'the 405 read is never made')
})

test('W11 verify: off is the select on PASS or an empty provider (one key is enough); a block that is not in the runtime is off; on needs both', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  fs.writeFileSync(w.file(names(CC).routeFile), '') // the provider's file is emptied and re-read, the select left on the fallback group
  w.core.reloadProvider(names(CC).provider)
  assert.deepEqual(await w.adapter.verify(CC), { live: false, now: names(CC).fb, fbNow: names(CC).in, ruleCount: 0, reason: 'empty-provider' })
  w.core.select(names(CODEX).sw, names(CODEX).fb) // selected, but its provider is empty (the file was written empty): not on
  assert.equal((await w.adapter.verify(CODEX)).live, false)
  const bare = await startWorld(t)
  assert.deepEqual(await bare.adapter.verify(CC), { live: false, now: null, fbNow: null, ruleCount: null, reason: 'block-not-in-runtime' })
})

test('W11 verify: the fallback group on asight-re while the daemon is alive is fallback-active (on, but the engine does not answer mihomo); with the daemon not alive, or not said, it is not claimed', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.engineAlive = false
  w.core.healthCheck()
  const re = names(CC).re
  assert.deepEqual(await w.adapter.verify(CC, { daemonAlive: true }), { live: true, now: names(CC).fb, fbNow: re, ruleCount: lineCount(w, CC), reason: 'fallback-active' })
  assert.equal((await w.adapter.verify(CC, { daemonAlive: false })).reason, null)
  w.state.daemon = true
  assert.equal((await w.adapter.verify(CC)).reason, 'fallback-active', 'the adapter\'s own daemonAlive() is the default')
  w.state.daemon = undefined
  assert.equal((await w.adapter.verify(CC)).reason, null, 'a daemon state that is not known is not claimed')
})

test('W11 verify: what cannot be read is 「不知道」: live null with the reason, never a guess', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.failOn('GET', /^\/providers\/rules$/, 500)
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: names(CC).fb, fbNow: names(CC).in, ruleCount: null, reason: 'unreadable' }, 'on needs the count')
  assert.equal((await w.adapter.verify(CODEX)).live, false, 'PASS is off whatever the provider list says')
  w.core.failures.length = 0
  w.core.failOn('GET', /^\/proxies\/asight-sw-/, 500)
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: null, fbNow: null, ruleCount: null, reason: 'unreadable' })
  await w.core.stop()
  assert.deepEqual(await w.adapter.verify(CC), { live: null, now: null, fbNow: null, ruleCount: null, reason: 'controller-unreadable' })
})

// ---- W11: which keys, and what lands ----------------------------------------------------------------------------------------------------------------------------------------------

test('W11 pickApply: every combination of what the controller can do, written out', () => {
  const T = true, F = false, N = null
  const table = [
    // blockInRuntime, serviceMode, controllerWritable, payloadAccepted → on, off
    [T, F, T, N, ['select', 'provider'], ['select', 'provider']],
    [T, N, T, N, ['select', 'provider'], ['select', 'provider']], [T, F, T, T, ['select', 'provider'], ['select', 'provider']], [T, F, T, F, ['select', 'provider'], ['select', 'provider']], // the switch does not push
    [T, T, T, N, ['select'], ['select']], // service mode: the provider key is left out (the copy of the file, [L4b] S5)
    [F, F, T, N, ['payload'], ['none']], [F, F, T, T, ['payload'], ['none']], [F, T, T, N, ['payload'], ['none']],
    [F, F, T, F, ['none'], ['none']], // a push that was refused is not tried again
    [N, F, T, N, ['payload'], ['none']], // not known to be in the runtime: it is not
    [T, F, F, N, ['none'], ['none']], [T, F, N, N, ['none'], ['none']], [F, F, F, N, ['none'], ['none']], [T, T, F, N, ['none'], ['none']], // the controller cannot be written
    [undefined, undefined, undefined, undefined, ['none'], ['none']],
  ]
  for (const [blockInRuntime, serviceMode, controllerWritable, payloadAccepted, on, off] of table) {
    assert.deepEqual(pickApply({ blockInRuntime, serviceMode, controllerWritable, payloadAccepted }), { on, off }, JSON.stringify({ blockInRuntime, serviceMode, controllerWritable, payloadAccepted }))
  }
  assert.deepEqual(pickApply(), { on: ['none'], off: ['none'] })
  const a = pickApply({ blockInRuntime: true, controllerWritable: true })
  a.on.push('x')
  assert.deepEqual(pickApply({ blockInRuntime: true, controllerWritable: true }).on, ['select', 'provider'], 'a fresh object each time')
})

const lines = (w, g) => w.block().files[names(g).routeFile].split('\n').filter(Boolean)
const ccOn = (w) => [{ g: CC, on: true, lines: lines(w, CC) }]
const both = (w, on = true) => [{ g: CC, on, lines: lines(w, CC) }, { g: CODEX, on, lines: lines(w, CODEX) }]
const sw = (w, g) => w.core.groups.get(names(g).sw).now

test('W11 on with the block live: the route file is written, the provider refreshed, the switch put on the fallback group, and it is read back: verified', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS)
  const r = await w.adapter.applyGroups({ groups: both(w) })
  assert.deepEqual([r.ok, r.exit, r.lines], [true, 0, []])
  for (const row of r.rows) assert.deepEqual([row.strategy, row.state, row.live, row.reason, row.now], [['select', 'provider'], 'verified', true, null, names(row.g).fb], row.g)
  assert.deepEqual(r.rows[0].steps.map((x) => x.step), ['file', 'provider', 'select'])
  assert.deepEqual([r.rows[0].ruleCount, fs.readFileSync(w.file(names(CC).routeFile), 'utf8')], [2, lines(w, CC).join('\n') + '\n'])
  assert.deepEqual(w.core.writes().map((q) => `${q.method} ${q.path}`), [`PUT /providers/rules/${names(CC).provider}`, `PUT /proxies/${names(CC).sw}`, `PUT /providers/rules/${names(CODEX).provider}`, `PUT /proxies/${names(CODEX).sw}`])
  assert.equal(r.receipts.length, 4, 'two rule files and two selects are recorded')
})

test('W11 on needs both keys: a refresh that fails leaves the provider empty, a select that fails leaves PASS; neither is "on"', async (t) => {
  for (const [what, fail] of [['the provider refresh', () => ['PUT', /^\/providers\/rules\//]], ['the select', () => ['PUT', /^\/proxies\//]]]) {
    const w = await startWorld(t)
    w.live(GROUPS)
    w.core.failOn(...fail(), 500)
    const r = await w.adapter.applyGroups({ groups: ccOn(w) })
    assert.deepEqual([r.ok, r.exit, r.rows[0].state, r.rows[0].live], [false, 1, 'not-live', false], what)
    assert.equal(r.rows[0].steps.find((s) => s.ok === false).status, 500, `${what} failed, and it says so`)
  }
})

test('W11 off with one key failing is still off; with both failing it is still on and says so (exit 1)', async (t) => {
  for (const [what, fail] of [['the select', () => ['PUT', /^\/proxies\//]], ['the provider refresh', () => ['PUT', /^\/providers\/rules\//]]]) {
    const w = await startWorld(t)
    w.live(GROUPS, { on: [CC] })
    w.core.failOn(...fail(), 500)
    const r = await w.adapter.applyGroups({ groups: [{ g: CC, on: false }] })
    assert.deepEqual([r.ok, r.exit, r.rows[0].state, r.rows[0].live], [true, 0, 'verified', false], `${what} failed: off still landed`)
  }
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.failOn('PUT', /^\/proxies\//, 500)
  w.core.failOn('PUT', /^\/providers\/rules\//, 500)
  const r = await w.adapter.applyGroups({ groups: [{ g: CC, on: false }] })
  assert.deepEqual([r.ok, r.exit, r.rows[0].state, r.rows[0].live], [false, 1, 'not-live', true], 'the file was emptied but the core never read it: still on')
})

test('W11 find-process-mode off: an `on` writes nothing at all (the block\'s process rules would do nothing) and says find-process-off; an `off` still goes through', async (t) => {
  const w = await startWorld(t, { core: { findProcessMode: 'off' } })
  w.live(GROUPS, { on: [CODEX] })
  const files = snapshot(w.sandbox)
  const r = await w.adapter.applyGroups({ groups: [{ g: CC, on: true, lines: lines(w, CC) }] })
  assert.deepEqual([r.ok, r.exit, r.rows[0].state, r.rows[0].reason], [false, 1, 'refused', 'find-process-off'])
  assert.deepEqual([w.core.writes(), snapshot(w.sandbox)], [[], files], 'zero writes to the core and to the disk')
  const off = await w.adapter.applyGroups({ groups: [{ g: CODEX, on: false }] })
  assert.deepEqual([off.ok, off.rows[0].state], [true, 'verified'])
})

test('W11 none: a payload the core refuses leaves only the files written, and the receipt says so; it is not tried again until the adapter looks again', async (t) => {
  const w = await startWorld(t)
  w.core.rejectPayload = 'cannot load'
  const r = await w.adapter.installBlock({ block: w.block(), blockText: buildScriptJs({ block: w.block() }), groups: both(w) })
  assert.deepEqual([r.ok, r.exit, r.script.ok], [false, 1, true])
  assert.ok(r.lines.includes('已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活'))
  for (const row of r.rows) assert.deepEqual([row.strategy, row.state, row.live, row.reason], [['payload', 'none'], 'not-live', false, 'block-not-in-runtime'])
  assert.equal(fs.readFileSync(w.file(names(CC).routeFile), 'utf8'), lines(w, CC).join('\n') + '\n', 'the files are written')
  assert.ok(fs.readFileSync(w.file('profiles/Script.js'), 'utf8').includes('asight collector'), 'so is the block: the next activation has it')
  const pushes = () => w.core.requests.filter((q) => q.path === '/configs?force=true').length
  assert.equal(pushes(), 1)
  const again = await w.adapter.applyGroups({ groups: both(w), block: w.block() })
  assert.deepEqual([again.rows[0].strategy, pushes()], [['none'], 1], 'a refused push is not repeated')
  w.adapter.reset()
  w.core.rejectPayload = null
  const third = await w.adapter.applyGroups({ groups: both(w), block: w.block() })
  assert.deepEqual([third.ok, third.rows[0].strategy, pushes()], [true, ['payload'], 2])
})

test('W11 none: no controller to talk to, or a core that is not Verge\'s, writes the files and says 未生效; a push with no block to push says block-needed', async (t) => {
  const w = await startWorld(t)
  await w.core.stop()
  const r = await w.adapter.applyGroups({ groups: both(w) })
  assert.deepEqual([r.ok, r.exit, r.lines], [false, 1, ['已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活']])
  assert.deepEqual(r.rows.map((x) => [x.strategy, x.state, x.reason]), [[['none'], 'not-live', 'controller-unreadable'], [['none'], 'not-live', 'controller-unreadable']])
  const v = await startWorld(t)
  const noBlock = await v.adapter.applyGroups({ groups: both(v) })
  assert.deepEqual([noBlock.rows[0].strategy, noBlock.rows[0].steps.find((s) => s.step === 'payload').reason], [['payload', 'none'], 'block-needed'])
  assert.deepEqual(v.core.writes(), [], 'nothing was pushed')
})

test('W11 service mode: the provider key is left out (no refresh is sent); the file is still written and the select decides', async (t) => {
  const w = await startWorld(t, { verge: VERGE_YAML().replace('enable_service_mode: false', 'enable_service_mode: true') })
  w.live(GROUPS)
  const r = await w.adapter.applyGroups({ groups: ccOn(w) })
  assert.deepEqual([r.rows[0].strategy, r.rows[0].steps.map((s) => s.step)], [['select'], ['file', 'select']])
  assert.ok(!w.core.writes().some((q) => q.path.startsWith('/providers')))
  const unknown = await startWorld(t, { verge: VERGE_YAML().replace('enable_service_mode: false\n', ''), adapter: { serviceRunning: () => true } })
  unknown.live(GROUPS)
  assert.deepEqual((await unknown.adapter.applyGroups({ groups: ccOn(unknown) })).rows[0].strategy, ['select'], 'verge.yaml does not say: the service process running does')
})

test('W11 an unreadable read-back is 「不知道」 and exit 1: the writes were sent, the result could not be read', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: [CC] })
  w.core.failOn('GET', /^\/providers\/rules$/, 500)
  const on = await w.adapter.applyGroups({ groups: ccOn(w) })
  assert.deepEqual([on.ok, on.exit, on.rows[0].state, on.rows[0].live, on.rows[0].reason], [false, 1, 'unknown', null, 'unreadable'])
  const off = await w.adapter.applyGroups({ groups: [{ g: CC, on: false }] })
  assert.deepEqual([off.ok, off.rows[0].live], [true, false], 'PASS is off whatever the provider list says')
})

// ---- W55: one harness's switch does not touch another's ------------------------------------------------------------------------------------------------------------------------

test('W55 two harnesses are on and `off codex`: only codex\'s switch goes to PASS and only its route file is emptied; Script.js is byte for byte the same; the other harness\'s switch, count and file are as they were', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  const first = await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: both(w) })
  assert.deepEqual([first.ok, first.rows.map((r) => r.strategy)], [true, [['payload'], ['payload']]])
  const script = sha(w.file('profiles/Script.js'))
  const ccFile = fs.readFileSync(w.file(names(CC).routeFile), 'utf8')
  const ccBefore = await w.adapter.verify(CC)
  const mark = w.core.requests.length
  const r = await w.adapter.applyGroups({ groups: [{ g: CODEX, on: false }] })
  assert.deepEqual([r.ok, r.rows.map((x) => x.g)], [true, [CODEX]])
  assert.deepEqual([sw(w, CODEX), sw(w, CC)], ['PASS', names(CC).fb])
  assert.equal(fs.readFileSync(w.file(names(CODEX).routeFile), 'utf8'), '', 'codex\'s file is emptied')
  assert.deepEqual([fs.readFileSync(w.file(names(CC).routeFile), 'utf8') === ccFile, sha(w.file('profiles/Script.js')) === script], [true, true])
  assert.deepEqual(await w.adapter.verify(CC), ccBefore, 'the other harness: now, fbNow and ruleCount unchanged')
  const touched = w.core.requests.slice(mark).filter((q) => q.method !== 'GET').map((q) => q.path)
  assert.deepEqual(touched, [`/proxies/${names(CODEX).sw}`, `/providers/rules/${names(CODEX).provider}`], 'and nothing sent for the other one, not even a refresh')
  const on = await w.adapter.applyGroups({ groups: [{ g: CODEX, on: true, lines: lines(w, CODEX) }] })
  assert.deepEqual([on.ok, sw(w, CODEX), sw(w, CC)], [true, names(CODEX).fb, names(CC).fb], '`on codex` brings it back the same way')
})

test('W55 a group that is not in the runtime is not switched (no 404 step); only its file is emptied; the ones that are there are switched', async (t) => {
  const w = await startWorld(t)
  w.live([GROUPS[0]], { on: [CC] })
  const r = await w.adapter.applyGroups({ groups: [{ g: CC, on: false }, { g: CODEX, on: false }] })
  assert.deepEqual(r.rows.map((x) => [x.g, x.strategy, x.state]), [[CC, ['select', 'provider'], 'verified'], [CODEX, ['none'], 'verified']])
  assert.deepEqual(w.core.writes().map((q) => q.path), [`/proxies/${names(CC).sw}`, `/providers/rules/${names(CC).provider}`])
})

// ---- W56: Verge is not running, or its controller cannot be read --------------------------------------------------------------------------------------------------------------

async function installed(t, over = {}) {
  const w = await startWorld(t, over)
  const b = w.block()
  const original = fs.readFileSync(w.file('profiles/Script.js'))
  const r = await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: both(w) })
  assert.equal(r.ok, true)
  return { w, original }
}
const undone = (w, original) => [fs.readFileSync(w.file('profiles/Script.js')).equals(original), fs.existsSync(w.adapter.paths.asightDir), w.ledger.entries().filter((e) => e.kind === 'vpn-script-block' || e.kind === 'vpn-rule-file').length, w.ledger.backups().length]

test('W56 Verge has exited (no runtime): the files are undone and `off` is done, exit 0', async (t) => {
  const { w, original } = await installed(t)
  await w.core.stop()
  w.state.running = false
  w.adapter.reset()
  const r = await w.adapter.removeBlock({ groups: [CC, CODEX] })
  assert.deepEqual([r.ok, r.exit, r.lines, r.residue], [true, 0, [], []])
  assert.deepEqual(r.rows.map((x) => [x.state, x.reason, x.live]), [['verified', 'verge-not-running', false], ['verified', 'verge-not-running', false]])
  assert.deepEqual(undone(w, original), [true, false, 0, 0], 'Script.js is as it was, the files are gone, the ledger and the backups are empty')
})

test('W56 Verge is running but its controller cannot be read: the files are undone too, but `off` says asight may still be on Clash\'s path and exits 1; a `running` that cannot be told is treated the same', async (t) => {
  for (const running of [true, null]) {
    const { w, original } = await installed(t)
    await w.core.stop()
    w.state.running = running
    w.adapter.reset()
    const r = await w.adapter.removeBlock({ groups: [CC, CODEX] })
    assert.deepEqual([r.ok, r.exit, r.lines], [false, 1, ['asight 可能仍在 Clash 的路径上,去 Clash Verge 重新激活']], String(running))
    assert.deepEqual(r.rows.map((x) => [x.state, x.reason, x.live]), [['unknown', 'controller-unreadable', null], ['unknown', 'controller-unreadable', null]])
    assert.deepEqual(undone(w, original), [true, false, 0, 0], 'the files are undone all the same')
  }
})

test('the whole `off` with Verge up: every group off and read back, the block out of Script.js byte for byte, the files and their ledger entries gone; the runtime residue is listed, not a failure', async (t) => {
  const { w, original } = await installed(t)
  await w.adapter.applyGroups({ groups: [{ g: CC, on: true, lines: lines(w, CC) }] })
  const r = await w.adapter.removeBlock({ groups: [CC, CODEX] })
  assert.deepEqual([r.ok, r.exit, r.lines, r.script.identical], [true, 0, [], true])
  assert.deepEqual(r.rows.map((x) => [x.g, x.state, x.live]), [[CC, 'verified', false], [CODEX, 'verified', false]])
  assert.deepEqual([sw(w, CC), sw(w, CODEX)], ['PASS', 'PASS'])
  assert.deepEqual(undone(w, original), [true, false, 0, 0])
  assert.deepEqual(r.residue.map((x) => x.kind), ['runtime-block', 'cache-db-select'])
  assert.ok(w.core.groups.has(names(CC).sw), 'the inert block is still in the runtime: gone at Verge\'s next regeneration')
  assert.deepEqual(w.ledger.entries().map((e) => e.kind).sort(), ['vpn-runtime-block', 'vpn-runtime-select', 'vpn-runtime-select'], 'the runtime kinds stay: they are the residue the status shows')
  assert.equal(r.receipts.filter((x) => x.kind === 'vpn-script-block').length, 1)
})

test('the whole `off` with a damaged sentinel: Script.js is not touched and `off` exits 1, but the groups are off and the files are gone', async (t) => {
  const { w } = await installed(t)
  const file = w.file('profiles/Script.js')
  fs.writeFileSync(file, fs.readFileSync(file, 'latin1').replace('// <<< asight collector <<<', '// <<< asight collector <<< x'), 'latin1')
  const damaged = sha(file)
  const r = await w.adapter.removeBlock({ groups: [CC, CODEX] })
  assert.deepEqual([r.ok, r.exit, r.script.ok, r.script.reason, sha(file)], [false, 1, false, 'sentinel-damaged', damaged])
  assert.ok(r.lines.some((l) => l.includes('哨兵被改坏')))
  assert.deepEqual([r.rows.every((x) => x.state === 'verified'), fs.existsSync(w.adapter.paths.asightDir)], [true, false])
})

test('installBlock: a script that cannot take the block stops it before anything else is written', async (t) => {
  const w = await startWorld(t, { script: null })
  const b = w.block()
  const r = await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: both(w) })
  assert.deepEqual([r.ok, r.exit, r.script.reason, r.rows], [false, 1, 'script-missing', []])
  assert.deepEqual([w.core.writes(), fs.existsSync(w.adapter.paths.asightDir), w.ledger.entries()], [[], false, []])
})

test('the whole `off` takes out every route file the ledger knows of, also those of groups the caller did not name', async (t) => {
  const { w, original } = await installed(t)
  const r = await w.adapter.removeBlock({ groups: [CC] })
  assert.deepEqual([r.ok, r.rows.map((x) => x.g)], [true, [CC, CODEX]])
  assert.deepEqual(undone(w, original), [true, false, 0, 0])
  assert.equal(sw(w, CODEX), 'PASS')
})
