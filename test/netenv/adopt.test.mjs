// test/netenv/adopt.test.mjs — RFC 1.6 §9.5 「用户自己的代理」 (V46 接上 · V47 漂移,不悄悄覆盖 · V48 `off` 留下用户的设置). Linux driver mode end to end through the command line in a sandbox HOME
// (the dispatch fixture: fake systemd, fake daemon, injected `ss` / `ip` and process table), and proxy mode through an injected routing — `{ ownsProxyField, fieldOf, adopt }`, the shape the Windows branch
// supplies — whose own kernel and field entries are that branch's to test (4.8): here the assertions are on what `on` hands it, asks, writes and records.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { userUnit } from '../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { readProxySetting, detectDrift, recordDrift, driftCheck, newDriftState, sameAdoption, driftRoutingOf } from '../../src/netenv/adopt.mjs'
import { settingSha } from '../../src/netenv/redact.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { sandbox, installedViaCli, snapshot } from '../cli/fixtures/dispatch-ctx.mjs'
import { claudeProc } from '../cli/fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const descs = await loadHarnesses()
const D = Object.fromEntries(descs.map((d) => [d.name, d]))
const USER_PROXY = 'http://dave:hunter2@proxy.corp:8080'
const ENGINE = { status: { engine: { port: 47123 } } }
const FACTS = { netFactsDeps: async () => ({ harnesses: descs, archFacts: linuxNetFacts }) }
/** `on` told it runs on Linux (the dispatch fixture says `none`), so the manifest keeps each harness's process signature and `status` can tell which process is Claude's. */
const LINUX = { parts: { os: 'linux', osRootsFile: null, harnesses: descs, scan: async () => [], match: () => ({ agent: null }), arch: { unit: { userUnit } } } }
const settingsOf = (s) => path.join(s.home, '.claude', 'settings.json')
const netenvOf = (s) => path.join(s.home, '.asight', 'netenv.json')
const seedProxy = (s, value = USER_PROXY) => fs.writeFileSync(settingsOf(s), `${JSON.stringify({ model: 'x', env: { HTTPS_PROXY: value } }, null, 2)}\n`)
/** The user changes the one value and nothing else (a file that is not what asight left would make `on` stop at an entry the user changed). */
const setProxy = (s, value) => { const d = readJson(settingsOf(s)); d.env.HTTPS_PROXY = value; fs.writeFileSync(settingsOf(s), `${JSON.stringify(d, null, 2)}\n`) }
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

test('V46 (a) Linux: `on` writes no proxy key anywhere — the changed files and keys hold none — the user\'s own is where it was, the receipt draws the chain with the credentials masked, and netenv.json has the hash and not the value', async () => {
  const s = sandbox(ENGINE); seedProxy(s)
  const r = await s.run(['on', '--yes', '--json'], { deps: FACTS })
  assert.equal(r.exit, 0, r.io.text())
  const doc = r.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.ok(doc.changed.length > 0 && doc.changed.every((c) => !/proxy/i.test(c.change)), `no changed key is a proxy key: ${JSON.stringify(doc.changed.map((c) => c.change))}`)
  assert.deepEqual(readJson(settingsOf(s)).env.HTTPS_PROXY, USER_PROXY, 'the user\'s setting is exactly what it was')
  assert.equal(readJson(settingsOf(s)).env.NODE_EXTRA_CA_CERTS.endsWith('extra-cc.pem'), true, 'and asight\'s own entry is the only thing it added')
  const a = doc.adopted['claude-code']
  assert.equal(a.chain, 'claude-code → [eBPF] asight 引擎 → [CONNECT 原样转] proxy.corp:8080 → 出口')
  assert.equal(a.proxy, 'http://***@proxy.corp:8080')
  const text = (await (async () => { const t = sandbox(ENGINE); seedProxy(t); return (await t.run(['on', '--yes'], { deps: FACTS })).io.text() })())
  assert.match(text, /^接上后 claude-code 的路: .*\[CONNECT 原样转\] proxy\.corp:8080.*http:\/\/\*\*\*@proxy\.corp:8080/m, 'the plan and the receipt print the chain')
  assert.equal(text.match(/^接上后 claude-code 的路:/gm).length, 2, 'once in the plan, once in the receipt')
  assert.ok(!/dave|hunter2/.test(text + JSON.stringify(doc)), 'no credential in the text or the JSON')
  const file = fs.readFileSync(netenvOf(s), 'utf8')
  assert.ok(!/dave|hunter2|proxy\.corp:8080"/.test(file.replace('http://***@proxy.corp:8080', '')), 'netenv.json: no original value')
  assert.equal(readJson(netenvOf(s)).adopted['claude-code'].sha256, settingSha(USER_PROXY))
  assert.ok(doc.created.includes(netenvOf(s)), 'the file `on` wrote is in the receipt (V3)')
  assert.equal(fs.statSync(netenvOf(s)).mode & 0o777, 0o600)
})

test('V46 (a) R9: a second `on` finds the same setting and writes nothing — netenv.json is byte for byte what it was, and the receipt does not list it; a changed setting is recorded', async () => {
  const s = sandbox(ENGINE); seedProxy(s)
  await s.run(['on', '--yes', '--json'], { deps: FACTS })
  const first = fs.readFileSync(netenvOf(s), 'utf8'), at = readJson(netenvOf(s)).adopted['claude-code'].at
  const again = (await s.run(['on', '--yes', '--json'], { deps: FACTS })).io.json()
  assert.ok(!again.created.includes(netenvOf(s)) && !again.changed.some((c) => c.path === netenvOf(s)))
  assert.equal(fs.readFileSync(netenvOf(s), 'utf8'), first)
  assert.equal(again.adopted['claude-code'].at, at, 'the record is the one that was')
  setProxy(s, 'http://proxy.new:3128')
  const third = (await s.run(['on', '--yes', '--json'], { deps: FACTS })).io.json()
  assert.ok(third.created.includes(netenvOf(s)), 'a setting that is different now is a new record')
  assert.equal(readJson(netenvOf(s)).adopted['claude-code'].proxy, 'http://proxy.new:3128')
})

test('V46 (a) `on --dry-run` draws the chain and writes nothing; a platform with no network facts adopts nothing (no netenv.json written by `on`)', async () => {
  const s = sandbox(ENGINE); seedProxy(s)
  const before = snapshot(s.home)
  const r = await s.run(['on', '--dry-run', '--json'], { deps: FACTS })
  assert.equal(r.exit, 0)
  assert.match(r.io.json().adopted['claude-code'].chain, /\[CONNECT 原样转\] proxy\.corp:8080/)
  assert.deepEqual(snapshot(s.home), before)
  const plain = sandbox(ENGINE); seedProxy(plain)
  const q = await plain.run(['on', '--yes', '--json'])
  assert.equal(q.io.json().adopted, undefined)
  assert.equal(fs.existsSync(netenvOf(plain)), false)
})

test('V47 (a) Linux: the setting is changed after `on` — the next connections go to the new proxy and asight is still on the path, the process that started before is listed under 「仍按启动时的设置」 with the old proxy (and asight on its way), and the drift is `proxy-changed`, captured', async () => {
  const s = sandbox({ status: { engine: { port: 47123 }, agents: [{ pid: 4121, agent: 'claude-code', trusted: true, decrypt: true }] } }); seedProxy(s)
  await s.run(['on', '--yes'], { deps: { ...FACTS, ...LINUX } })
  const started = Date.now() + 5000, changedAt = new Date(Date.now() + 10_000) // a process that started after `on`, and a change of the file after it
  setProxy(s, 'http://proxy.new:3128'); fs.utimesSync(settingsOf(s), changedAt, changedAt)
  const r = await s.run(['status', 'claude-code'], { deps: { ...FACTS, procs: async () => [claudeProc(4121, started)] } })
  const text = r.io.stdoutText()
  assert.match(text, /^ {2}claude-code .*\[CONNECT 原样转\] proxy\.new:3128 → 出口\s+在路径上 · 是$/m, 'the new connections go to the new proxy, through asight')
  assert.match(text, /^pid 4121 仍按启动时的设置:claude 4121 → \[eBPF\] asight 引擎 :47123 → \[CONNECT 原样转\] proxy\.corp:8080 → 出口;重启后按上面的路$/m)
  assert.ok(!/dave|hunter2/.test(text))
  const adopted = readJson(netenvOf(s)).adopted
  const setting = readProxySetting(D['claude-code'], { home: s.home, env: {} })
  assert.deepEqual(detectDrift({ adopted, h: 'claude-code', setting, routing: 'driver' }), [{ code: 'proxy-changed', from: 'http://***@proxy.corp:8080', to: 'http://proxy.new:3128', captured: true }])
  assert.deepEqual(detectDrift({ adopted, h: 'claude-code', setting: readProxySetting(D['claude-code'], { home: tmpDir('asight-x-'), env: {} }), routing: 'driver' }).map((d) => [d.code, d.to]), [['proxy-changed', null]], 'a setting taken away is a change too')
  assert.deepEqual(detectDrift({ adopted, h: 'claude-code', setting: { unknown: { reason: 'denied', detail: 'x' } }, routing: 'driver' }), [], 'one that cannot be read is not a change: status says it is unknown')
  assert.deepEqual(detectDrift({ adopted: {}, h: 'claude-code', setting, routing: 'driver' }), [], 'with nothing adopted there is nothing to have drifted from')
})

test('V47 (a) a process whose environment holds only a key its harness does not read (ALL_PROXY for claude-code) was started with no proxy: `status claude-code` does not list it under 「仍按启动时的设置」, and says nothing false about where it goes', async () => {
  const s = sandbox({ status: { engine: { port: 47123 }, agents: [{ pid: 4121, agent: 'claude-code', trusted: true, decrypt: true }] } })
  await s.run(['on', '--yes'], { deps: { ...FACTS, ...LINUX } })
  const started = Date.now() + 5000
  const only = new Map([['ALL_PROXY', 'socks5://127.0.0.1:1080']])
  const r = await s.run(['status', 'claude-code', '--json'], { deps: { ...FACTS, procs: async () => [claudeProc(4121, started, only)] } })
  const text = r.io.text(), t = r.io.json().topology['claude-code']
  assert.doesNotMatch(text, /仍按启动时的设置|1080/)
  assert.deepEqual(t.running, [], 'no process is on another path')
  const own = await s.run(['status', 'claude-code'], { deps: { ...FACTS, procs: async () => [claudeProc(4121, started, new Map([['HTTPS_PROXY', 'http://127.0.0.1:7890']]))] } })
  assert.match(own.io.stdoutText(), /^pid 4121 仍按启动时的设置:/m, 'a key it does read is still reported')
})

test('V47 the daemon\'s 5 s check: a change of the file is one `netenv-change` (and no `failure`: the harness is still captured), however many checks run; a file nobody touched says nothing; it only reads', async () => {
  const s = sandbox(ENGINE); seedProxy(s)
  await s.run(['on', '--yes'], { deps: FACTS })
  const events = [], state = newDriftState(), before = snapshot(s.home)
  const check = () => driftCheck({ home: s.home, env: {}, harnesses: descs, desired: () => 'on', appendEvent: (e) => events.push(e), state })
  assert.deepEqual(check(), [], 'nothing changed since `on`')
  assert.deepEqual(snapshot(s.home), before, 'and checking writes nothing')
  setProxy(s, 'http://proxy.new:3128'); fs.writeFileSync(settingsOf(s), `${fs.readFileSync(settingsOf(s), 'utf8')}\n`) // another size and mtime
  const settingsBytes = fs.readFileSync(settingsOf(s), 'utf8')
  for (let i = 0; i < 3; i++) check()
  assert.deepEqual(events.map((e) => [e.event, e.where, e.code, e.captured]), [['netenv-change', 'netenv', 'proxy-changed', true]])
  assert.deepEqual([events[0].from, events[0].to], ['http://***@proxy.corp:8080', 'http://proxy.new:3128'])
  for (const e of events) assert.deepEqual(checkRecord(e), [], 'every record is in the closed sets (V53)')
  assert.equal(fs.readFileSync(settingsOf(s), 'utf8'), settingsBytes, 'the agent\'s file is byte for byte what the user left')
  setProxy(s, 'http://proxy.third:1'); check()
  assert.equal(events.length, 2, 'a further change is one more')
})

test('V47 (b) proxy mode: a field that holds anything but what asight put there bypasses asight — captured false: one `netenv-change` and one `failure` (where netenv), however many checks run, and the file is not touched', async () => {
  const s = await installedViaCli(ENGINE)
  const { routing, field } = proxyRouting(s)
  await s.run(['on', '--yes', 'codex'], { deps: { ...FACTS, routing } })
  const written = readJson(netenvOf(s)).adopted.codex
  assert.equal(written.routing, 'driver', 'the facts here are Linux\'s; the routing hooks are what is injected')
  fs.writeFileSync(field.path, fs.readFileSync(field.path, 'utf8').replace(KERNEL, 'http://proxy.new:3128'))
  const bytes = fs.readFileSync(field.path), events = [], state = newDriftState()
  const check = () => driftCheck({ home: s.home, env: {}, harnesses: descs, desired: () => 'on', appendEvent: (e) => events.push(e), state })
  for (let i = 0; i < 3; i++) check()
  assert.deepEqual(events.map((e) => [e.event, e.where, e.code, e.captured]), [['netenv-change', 'netenv', 'proxy-changed', false], ['failure', 'netenv', 'proxy-changed', undefined]])
  for (const e of events) assert.deepEqual(checkRecord(e), [], 'in the closed sets')
  assert.deepEqual(fs.readFileSync(field.path), bytes, 'status, doctor and the daemon only read: the field is the user\'s')
  const off = []; driftCheck({ home: s.home, env: {}, harnesses: descs, desired: () => 'off', appendEvent: (e) => off.push(e), state: newDriftState() })
  assert.deepEqual(off.map((e) => e.event), ['netenv-change'], 'a harness that is off has nothing to lose: no failure')
})

test('driftCheck takes the semantics of the record `on` made, not a routing handed in: a proxy-mode record (routing proxy, or one that holds `written_sha256`) with the field holding what asight wrote is no drift, and the first edit of it is a drift that bypasses asight; a driver-mode record is measured against what `on` found', () => {
  const s = sandbox(ENGINE); seedProxy(s, 'http://asight.entry:17991')
  const base = { at: 'T', chain: 'c', source: [], vpn: null, sha256: settingSha('http://proxy.old:3128'), file_sha256: settingSha('http://proxy.old:3128'), proxy: 'http://proxy.old:3128' }
  const write = (rec) => { fs.mkdirSync(path.dirname(netenvOf(s)), { recursive: true }); fs.writeFileSync(netenvOf(s), `${JSON.stringify({ at: 'T', adopted: { 'claude-code': rec } })}\n`) }
  const run = (state = newDriftState()) => { const ev = []; driftCheck({ home: s.home, env: {}, harnesses: descs, desired: () => 'on', appendEvent: (e) => ev.push(e), state }); return ev }
  const WRITTEN = settingSha('http://asight.entry:17991')
  assert.deepEqual([driftRoutingOf({ routing: 'proxy' }), driftRoutingOf({ routing: 'driver', written_sha256: WRITTEN }), driftRoutingOf({ routing: 'driver' }), driftRoutingOf(undefined)], ['proxy', 'proxy', 'driver', 'driver'])
  write({ ...base, routing: 'proxy', written_sha256: WRITTEN })
  assert.deepEqual(run(), [], 'the field holds what asight wrote: nothing to say, which a driver-mode reading would call a change on the first check after every `on`')
  setProxy(s, 'http://proxy.new:3128')
  assert.deepEqual(run().map((e) => [e.event, e.code, e.captured]), [['netenv-change', 'proxy-changed', false], ['failure', 'proxy-changed', undefined]], 'the user\'s edit leaves it uncaptured')
  write({ ...base, routing: 'driver' })
  setProxy(s, 'http://proxy.old:3128')
  assert.deepEqual(run(), [], 'a driver-mode record against the value `on` found')
  setProxy(s, 'http://proxy.new:3128')
  assert.deepEqual(run().map((e) => [e.event, e.captured]), [['netenv-change', true]], 'and an edit of it leaves the harness steered: one event, no failure')
})

const KERNEL = 'http://127.0.0.1:17992'
/** The routing an injected platform supplies: it owns the codex field (`.codex/.env HTTPS_PROXY`), writes it when asked to adopt (the platform\'s part, here a plain write), and says where it is. */
function proxyRouting(s, calls = []) {
  const field = { path: path.join(s.home, '.codex', '.env'), key: 'HTTPS_PROXY' }
  const routing = { ownsProxyField: () => true, fieldOf: () => field, adopt: async (h, setting) => {
    calls.push({ h, raw: setting && setting.raw, value: setting && setting.value })
    const cur = fs.readFileSync(field.path, 'utf8').split('\n').filter((l) => !/^HTTPS_PROXY=/.test(l)).join('\n')
    fs.writeFileSync(field.path, `${cur.replace(/\n*$/, '\n')}HTTPS_PROXY=${KERNEL}\n`)
  } }
  return { routing, field, calls }
}

test('V46 (b) proxy mode: `adopt` is handed the setting that was there (the value as written, for the platform\'s upstream; masked everywhere that is printed), a field it writes is recorded as what asight wrote, and a change of the system proxy is one `netenv-change`, no `failure`, and no file touched', async () => {
  const s = await installedViaCli(ENGINE)
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'HTTPS_PROXY=http://bob:secret@proxy.old:3128\n')
  const calls = [], { routing, field } = proxyRouting(s, calls)
  const r = await s.run(['on', '--yes', '--json', 'codex'], { deps: { ...FACTS, routing } })
  assert.equal(r.exit, 0, r.io.text())
  assert.deepEqual(calls, [{ h: 'codex', raw: 'http://bob:secret@proxy.old:3128', value: 'http://***@proxy.old:3128' }])
  const a = readJson(netenvOf(s)).adopted.codex
  assert.equal(a.sha256, settingSha('http://bob:secret@proxy.old:3128'), 'what the user had')
  assert.equal(a.written_sha256, settingSha(KERNEL), 'what asight wrote: an edit is told from it')
  assert.ok(!/bob|secret/.test(fs.readFileSync(netenvOf(s), 'utf8') + JSON.stringify(r.io.json())))
  const bytes = fs.readFileSync(field.path), events = []
  recordDrift({ drift: { code: 'netenv-changed', from: 'system proxy :7897', to: 'system proxy :7890', captured: true }, h: 'codex', desired: 'on', appendEvent: (e) => events.push(e) })
  assert.deepEqual(events.map((e) => [e.event, e.where, e.code, e.from, e.to]), [['netenv-change', 'netenv', 'netenv-changed', 'system proxy :7897', 'system proxy :7890']])
  for (const e of events) assert.deepEqual(checkRecord(e), [])
  assert.deepEqual(fs.readFileSync(field.path), bytes)
  // the daemon check of the field: what asight wrote is not drift
  const quiet = []; driftCheck({ home: s.home, env: {}, harnesses: descs, desired: () => 'on', appendEvent: (e) => quiet.push(e), state: newDriftState() })
  assert.deepEqual(quiet, [])
})

test('V47 (b) `on` over a field the user edited since the last `on`: not in a terminal and no --yes, it prints the plan with 「你改过的代理设置」 and exits 2 having written nothing; with --yes `adopt` gets the new proxy; a field `on` itself wrote is not an edit', async () => {
  const s = await installedViaCli(ENGINE)
  const calls = [], { routing, field } = proxyRouting(s, calls)
  await s.run(['on', '--yes', 'codex'], { deps: { ...FACTS, routing } })
  const again = await s.run(['on', 'codex'], { deps: { ...FACTS, routing } })
  assert.equal(again.exit, 0, 'asight\'s own value in the field is not an edit: nothing to ask')
  fs.writeFileSync(field.path, fs.readFileSync(field.path, 'utf8').replace(KERNEL, 'http://proxy.new:3128'))
  const before = snapshot(s.home), n = calls.length
  const plan = await s.run(['on', 'codex'], { deps: { ...FACTS, routing } })
  assert.equal(plan.exit, 2)
  assert.match(plan.io.text(), /你改过的代理设置: codex 的 .*\.env HTTPS_PROXY 现在是 http:\/\/proxy\.new:3128/)
  assert.deepEqual(snapshot(s.home), before, 'nothing written')
  assert.equal(calls.length, n, 'and the routing was not asked to adopt')
  const yes = await s.run(['on', '--yes', 'codex'], { deps: { ...FACTS, routing } })
  assert.equal(yes.exit, 0, yes.io.text())
  assert.deepEqual([calls.length, calls[n].raw], [n + 1, 'http://proxy.new:3128'])
  assert.equal(readJson(netenvOf(s)).adopted.codex.proxy, 'http://proxy.new:3128')
})

test('V47 `adopt` that fails is an `on` that did not finish: exit 1, the harness is named, and no record says it was adopted', async () => {
  const s = await installedViaCli(ENGINE)
  const routing = { ownsProxyField: () => true, fieldOf: () => ({ path: '/x', key: 'HTTPS_PROXY' }), adopt: async () => { throw new Error('the kernel did not start') } }
  const r = await s.run(['on', '--yes', '--json', 'codex'], { deps: { ...FACTS, routing } })
  assert.equal(r.exit, 1)
  const doc = r.io.json()
  assert.equal(doc.ok, false)
  assert.match(doc.notes.join('\n'), /codex: the kernel did not start/)
  assert.equal(doc.adopted.codex, undefined)
})

test('V48 Linux: `off` touches no proxy key — the user\'s HTTPS_PROXY is where it was, and what `on` added is gone, so the file reads as before', async () => {
  const s = sandbox(ENGINE); seedProxy(s)
  const original = fs.readFileSync(settingsOf(s), 'utf8')
  await s.run(['on', '--yes'], { deps: FACTS })
  const off = await s.run(['off', '--yes'], { deps: FACTS })
  assert.equal(off.exit, 0, off.io.text())
  assert.equal(readJson(settingsOf(s)).env.HTTPS_PROXY, USER_PROXY)
  assert.deepEqual(Object.keys(readJson(settingsOf(s)).env), ['HTTPS_PROXY'])
  assert.equal(fs.readFileSync(settingsOf(s), 'utf8'), original, 'byte for byte, as R2 promises')
})

test('sameAdoption: the time does not make a record another one', () => {
  const a = { at: 'T1', routing: 'driver', chain: 'c', source: [], sha256: 'x', file_sha256: 'x', proxy: null, vpn: null }
  assert.equal(sameAdoption(a, { ...a, at: 'T2' }), true)
  assert.equal(sameAdoption(a, { ...a, sha256: 'y' }), false)
  assert.equal(sameAdoption(null, a), false)
})

test('netenv-changed: the VPN software differs from what `on` saw (turned TUN on, gone, upgraded, newly installed) — the product, its version, port and TUN — and a probe that was not run or could not be read is no change', () => {
  const vpn = { product: 'clash-verge', version: '2.5.7', port: 7897, tun: false }
  const adopted = { codex: { at: 'T', routing: 'driver', chain: 'c', source: [], sha256: null, file_sha256: null, proxy: null, vpn } }
  const setting = { value: null, scheme: null, host: null, port: null, source: [], sha256: null, changedAt: null }
  const drift = (v) => detectDrift({ adopted, h: 'codex', setting, routing: 'driver', vpn: v })
  assert.deepEqual(drift({ ...vpn }), [], 'the same')
  assert.deepEqual(drift({ ...vpn, mode: 'global', pid: 99 }), [], 'its mode and pid are not what asight\'s route depends on')
  assert.deepEqual(drift({ ...vpn, tun: true }), [{ code: 'netenv-changed', from: 'clash-verge 2.5.7 :7897', to: 'clash-verge 2.5.7 :7897 TUN', captured: true }])
  assert.deepEqual(drift({ ...vpn, version: '2.6.0' }).map((d) => d.code), ['netenv-changed'])
  assert.deepEqual(drift(null).map((d) => [d.code, d.to]), [['netenv-changed', 'none']], 'it quit')
  assert.deepEqual(drift(undefined), [], 'not probed: nothing to compare')
  assert.deepEqual(drift({ ...vpn, tun: null, unknown: { reason: 'controller-unreadable' } }), [], 'a product whose controller could not be read is not a change: status says it is unknown')
  const none = { codex: { ...adopted.codex, vpn: null } }
  assert.deepEqual(detectDrift({ adopted: none, h: 'codex', setting, routing: 'driver', vpn: { ...vpn } }).map((d) => [d.code, d.from]), [['netenv-changed', 'none']], 'newly installed')
})
