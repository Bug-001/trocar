// test/netenv/adopt-win32.test.mjs — the proxy-mode halves of V46/V47/V48 over the REAL Windows facts and entries (4.8 §10.3 W37, plan Task 10(c)): the drift
// machinery's platform-neutral core is adopt.test.mjs's (an injected routing); these are the Windows sides — the real gatherWin32Facts behind an injected helper
// (nothing on the machine is asked), the real win32Routing (adopt as the VERIFIER of the daemon's write), and the real entry writer the daemon's half of `on` is
// (createProxyEntries, the same journal `off` undoes by). The `on` runs with platform 'linux' and parts.os 'win32' (win32 is a new-collector platform since the flip (9(b)); parts carries the win32 arch
// either way). What is deliberately NOT here: V47(b)'s 「带 --yes re-adopts」 half — that re-adopt depends on the real daemon's write behavior
// (8(c)'s unlanded remainder), so its contract stays in adopt.test.mjs's injected platform; V48's json-key half ('left-user-value') is src/off's win32-undo tests.
import { PHASES } from '../../src/off/manifest.mjs' // the file holds install's certificate block too: the undo here runs over both phases, as uninstall does (off spares install's, D55①)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildTopology, renderDetail } from '../../src/netenv/topology.mjs'
import { driftCheck, newDriftState, readAdopted } from '../../src/netenv/adopt.mjs'
import { diagnose } from '../../src/netenv/findings.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { readManifest } from '../../src/collector/core/trust/journal.mjs'
import { win32Routing } from '../../src/collector/arch/win32/wiring.mjs'
import { winWorld, kernelUrl, seedSeven, helperOf, descs } from '../cli/fixtures/win-on-ctx.mjs'
import { readDotenv } from '../helpers/file-shapes.mjs'

const SYSPROXY = { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: '127.0.0.1:7897' } }
const PROXY_OFF = { ProxyEnable: { kind: 'REG_DWORD', value: 0 } }
const onPrior = { internet: SYSPROXY, envSeed: (put) => seedSeven(put, { codexProxy: 'http://proxy.old:3128' }) }
const cell = async (w, over = {}) => (await w.facts({ ids: ['codex'], ...over })).harnesses.codex.forms.find((x) => x.id === 'codex.cli')
const snap = (home) => { const out = {}; const walk = (x) => { for (const n of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, n.name); if (n.isDirectory()) walk(p); else out[path.relative(home, p)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex') } }; walk(home); return out }

test('V46(b): a real `on` over the real facts — the kernel dials the agent\'s own prior (§2.2 rule 1, no env note), the entry the daemon writes holds the kernel\'s address with the original line kept commented, the prior is ledgered with a backup, and win32Routing verifies the write', async () => {
  const w = winWorld(onPrior)
  const r = await w.run(['--yes', 'codex', '--json'])
  assert.equal(r.exit, 0)
  const after = fs.readFileSync(w.envFile, 'utf8')
  assert.ok(after.includes(`HTTPS_PROXY=${kernelUrl('codex.env')}`), 'the field holds the kernel\'s address (the group\'s credentials on loopback)')
  assert.ok(after.includes('#asight-collector-off# HTTPS_PROXY=http://proxy.old:3128'), 'the user\'s own line is kept, commented by the sentinel marker, not deleted')
  assert.match(r.stderr(), /codex\.cli · codex\.vscode · codex\.app  %USERPROFILE%\\\.codex\\\.env  顶部 asight 哨兵块  上游: proxy\.old:3128\(你原来的代理\)/, 'the plan\'s row: the prior as the upstream')
  assert.ok(!/读不到你终端里的/.test(r.stderr().split('要你点名的')[0]), 'rule 1 needs no env note: the prior was read from the agent\'s own file')
  const m = readManifest(w.dir, fs)
  const prox = m.entries.find((e) => e.harness === 'codex' && e.prior_value && e.prior_value.HTTPS_PROXY)
  assert.ok(prox, 'the proxy entry is ledgered like any other (the same journal off undoes by)')
  assert.equal(prox.prior_value.HTTPS_PROXY, 'http://proxy.old:3128')
  assert.ok(prox.backup, 'the pre-change copy exists (D39③)')
  const a = readAdopted(w.home, { fs }).codex
  assert.equal(a.routing, 'proxy')
  assert.equal(a.proxy, 'http://proxy.old:3128', 'the prior is the record the drift is measured from')
  assert.ok(a.written_sha256, 'proxy mode records the hash of what on wrote into the field')
  assert.ok(!JSON.stringify(a).includes('s3-listener-token'), 'the kernel\'s listener credential reaches netenv.json nowhere')
  await win32Routing({ harnesses: descs, home: w.home, env: {} }).adopt('codex') // the verifier: the ledger\'s group holds the kernel\'s address
})

test('V46(b): the §2.2 cells the upstream comes from — the agent\'s own prior (readable, no note), the system proxy and the direct fallback (both 「读不到你终端里的 HTTPS_PROXY」), and a system proxy whose port moved is the new dial with the entry byte-identical and nothing for the 5 s check', async () => {
  const prior = await cell(winWorld(onPrior))
  assert.deepEqual(prior.upstream, { kind: 'http', host: 'proxy.old', port: 3128, source: 'agent' })
  assert.equal(prior.envUnreadable, undefined)
  const via = await cell(winWorld({ internet: SYSPROXY }))
  assert.deepEqual(via.upstream, { kind: 'http', host: '127.0.0.1', port: 7897, source: 'system-proxy' })
  assert.equal(via.envUnreadable, true)
  assert.equal(via.egressDiffers, true, 'Codex\'s WebSocket goes direct while the HTTP side follows the system proxy')
  const direct = await cell(winWorld({ internet: PROXY_OFF }))
  assert.deepEqual(direct.upstream, { kind: 'direct', source: 'direct' })
  assert.equal(direct.envUnreadable, true)
  // the port moved after the on: the facts say the new dial, the entry and its file are untouched, the 5 s check (which stats files) records nothing
  const w = winWorld({ internet: SYSPROXY })
  assert.equal((await w.run(['--yes', 'codex', '--json'])).exit, 0)
  const bytes = fs.readFileSync(w.envFile, 'utf8')
  const moved = await cell(w, { helper: helperOf({ internet: { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: '127.0.0.1:7890' } } }) })
  assert.equal(moved.upstream.port, 7890, 'the kernel\'s dial follows the system proxy as it is now')
  assert.equal(fs.readFileSync(w.envFile, 'utf8'), bytes, 'the entry file is byte-identical: a read changed nothing')
  const events = [], state = newDriftState()
  for (let i = 0; i < 2; i++) driftCheck({ home: w.home, env: { HOME: w.home, USERPROFILE: w.home }, harnesses: descs, desired: () => 'on', appendEvent: (e) => events.push(e), state })
  assert.deepEqual(events, [], 'the entry is what the check stats: a moved system proxy is the kernel\'s dial, not a drift of the field')
})

test('V47(b) + W37: the user changes the entry\'s key — the real facts give proxy-changed, `status` draws the new path and prints 「接上： asight on codex」, the 5 s check records it once (netenv-change + failure) with the file untouched, a non-terminal `on` names the real field (exit 2, nothing written), win32Routing rejects, and doctor\'s finding says `asight on codex` first', async () => {
  const w = winWorld(onPrior)
  assert.equal((await w.run(['--yes', 'codex', '--json'])).exit, 0)
  fs.writeFileSync(w.envFile, fs.readFileSync(w.envFile, 'utf8').replace(kernelUrl('codex.env'), 'http://proxy.new:3128'))
  const f = await w.facts({ ids: ['codex'] })
  const t = buildTopology(f).codex
  assert.deepEqual([t.on_path, t.captured, t.reason], [false, false, 'proxy-changed'], 'a field that holds anything else bypasses asight (failure class)')
  assert.ok(t.notes.includes('接上: asight on codex'), 'W37: the note that re-adopts')
  assert.match(renderDetail(t).join('\n'), /proxy\.new:3128/, 'the new path is drawn')
  const events = [], state = newDriftState()
  const bytes = fs.readFileSync(w.envFile, 'utf8')
  for (let i = 0; i < 3; i++) driftCheck({ home: w.home, env: { HOME: w.home, USERPROFILE: w.home }, harnesses: descs, desired: () => 'on', appendEvent: (e) => events.push(e), state })
  assert.deepEqual(events.map((e) => [e.event, e.harness, e.code]), [['netenv-change', 'codex', 'proxy-changed'], ['failure', 'codex', 'proxy-changed']], 'recorded once, as a state change and a failure')
  assert.equal(events[0].captured, false, 'the state change says the harness is bypassed')
  assert.equal(fs.readFileSync(w.envFile, 'utf8'), bytes, 'the check only reads: only the operator\'s on writes (D30)')
  const before = snap(w.home)
  const plan = await w.run(['codex']) // not a terminal, no --yes: the plan and why nothing was done (R6)
  assert.equal(plan.exit, 2)
  assert.match(plan.stdout(), /你改过的代理设置: codex 的 .*\.env HTTPS_PROXY 现在是 http:\/\/proxy\.new:3128\(asight 上次接上时是 http:\/\/proxy\.old:3128\)/, 'the plan names the real field and both values')
  assert.deepEqual(snap(w.home), before, 'nothing was written')
  await assert.rejects(() => win32Routing({ harnesses: descs, home: w.home, env: {} }).adopt('codex'), /the proxy entry of codex\.env is in the ledger but the field does not hold the engine door's address/, 'the verifier\'s failure half: the on that wrote it did not finish (V47)')
  const found = diagnose({ facts: f, topology: { codex: t }, harnesses: null, user: 'alice' })
  const pc = found.find((x) => x.code === 'proxy-changed')
  assert.ok(pc, 'doctor\'s finding for the drift')
  assert.equal(pc.commands[0].run, 'asight on codex', 'the command that re-adopts comes first')
})

test('V48(b): `off` restores — the field still asight\'s own value → the file byte-identical to before `on` (the commented original back, the block gone); the user\'s value in the field → asight\'s part goes, the user\'s line stays untouched and in effect, the original stays out of effect and is reported (D48②; never a wholesale rollback)', async () => {
  const w1 = winWorld(onPrior)
  const before = fs.readFileSync(w1.envFile, 'utf8')
  await w1.run(['--yes', 'codex', '--json'])
  const undone = await undoHarnesses({ dir: w1.dir, home: w1.home, phases: PHASES, manifest: readManifest(w1.dir, fs), ids: ['codex'], procs: async () => [], env: {}, fs })
  assert.ok(undone.results.every((x) => x.result === 'restored'), 'each entry of the harness: restored')
  assert.equal(fs.readFileSync(w1.envFile, 'utf8'), before, 'byte-identical to before on')
  // the user changed the field while on: off takes asight\'s own value out and leaves the user\'s line exactly where it is
  const w2 = winWorld(onPrior)
  await w2.run(['--yes', 'codex', '--json'])
  fs.writeFileSync(w2.envFile, fs.readFileSync(w2.envFile, 'utf8').replace(kernelUrl('codex.env'), 'http://proxy.new:3128'))
  const kept = await undoHarnesses({ dir: w2.dir, home: w2.home, phases: PHASES, manifest: readManifest(w2.dir, fs), ids: ['codex'], procs: async () => [], env: {}, fs })
  assert.ok(kept.results.every((x) => x.result === 'reverted-not-identical'), 'the file was not as it was left: asight\'s part only, never the whole file back')
  const after = fs.readFileSync(w2.envFile, 'utf8')
  assert.ok(!after.includes(kernelUrl('codex.env')), 'asight\'s value is gone')
  assert.ok(!/asight collector/.test(after), 'and the whole sentinel block with it')
  assert.ok(after.includes('HTTPS_PROXY=http://proxy.new:3128'), 'the user\'s line is untouched (「用户改过就不动」)')
  // D48② (4.6「撤一个文件的规则」): the user's new value wins — the original line asight put out of effect stays so (unmarking it would make it the last
  // assignment, which dotenvy and python-dotenv read), and the result says which line it is
  assert.ok(after.includes('#asight-collector-off# HTTPS_PROXY=http://proxy.old:3128'), 'the original line stays out of effect')
  assert.equal(readDotenv(Buffer.from(after)).HTTPS_PROXY, 'http://proxy.new:3128', 'the user\'s new value is the one in effect')
  assert.ok(kept.results.some((x) => (x.prior_left || []).some((p) => p.key === 'HTTPS_PROXY' && after.split('\n')[p.line - 1].startsWith('#asight-collector-off# HTTPS_PROXY='))), 'and its line is reported')
})
