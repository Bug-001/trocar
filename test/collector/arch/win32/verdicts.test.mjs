// test/collector/arch/win32/verdicts.test.mjs — the verdict producer on Windows (RFC 4.8 §5.4 「谁产生判定」, acceptance W76; plan Task 8(v)).
// The redirector's verdict table is filled by `watch(pid, { decrypt, agent })`, and the one that pushes is the tracker. Until Task 8(v) nothing could produce a `decrypt:true`
// verdict on Windows: `registry.match` keyed on `descriptor.signatures[facts.os]` and no harness had `signatures.win32`, and the tracker vetoed every process with
// `facts.env === null` (`environ-unreadable`) while every Windows process has `env: null` (4.8 §10.1). Built (2026-10-08):
//   the daemon builds one registry from the name lists (`createRegistry(descriptors)`, D51: one rule for which harness on every OS),
//   `procinfo` facts carry `envRead: false` so `env: null` is the OS's rule and not a failure to read, the tracker judges by the harness's Windows entry files
//   (`desc.win32.layers` where the files move — Hermes's root is %LOCALAPPDATA%\hermes; the Linux layers otherwise, they read the same files), the plugin marker
//   is compared with a fixed tolerance (`MARKER_TOLERANCE_MS`: the marker is ms-rounded `performance.timeOrigin`, the helper gives ms), and the tracker listens to
//   `facts-update` as well (a form told by its command line is judged again when it arrives). Still fail-safe: a pid nobody pushed a verdict for is untrusted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'
import { splitCommandLine } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { createTracker } from '../../../../src/collector/core/tracker.mjs'
import { createTrustChecker, MARKER_TOLERANCE_MS } from '../../../../src/collector/core/trust/confirm.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest, installedAt } from '../../../../src/collector/core/trust/journal.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const HOME = String.raw`C:\Users\u`
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  ccDesktop: String.raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`,
  codexNpm: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  hermesPy: String.raw`C:\Users\u\AppData\Local\hermes\tools\python-3.12.6\python.exe`,
  kimi: String.raw`C:\Users\u\.kimi-code\bin\kimi.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  dshDesktop: String.raw`C:\Users\u\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`,
  opencode: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`,
  opencodeDesk: String.raw`C:\Users\u\AppData\Local\@opencode-aidesktop\OpenCode.exe`,
  zcode: String.raw`C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe`,
  svchost: String.raw`C:\Windows\System32\svchost.exe`,
}
const DSH_CMD = String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
// what `hermes.exe -z …` execs (measured win 2026-10-14): the private python runs the zip appended to the launcher
const HERMES_CMD = String.raw`"C:\Users\u\AppData\Local\hermes\tools\python-3.12.6\python.exe" -I "C:\Users\u\AppData\Local\hermes\bin\hermes.exe" -z "hi"`
const ZCODE_NET_CMD = String.raw`"C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe" --type=utility --utility-sub-type=network.mojom.NetworkService`
const ZCODE_CMD = String.raw`"C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe" C:\Users\u\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs app-server --stdio`

/** What the Windows procinfo gives, with the field Task 8(v) added: `envRead: false` says "this OS never reads another process's environment", so `env: null` is the rule here and not a failure to read. */
const facts = (pid, exe, extra = {}) => ({ os: 'win32', pid, ppid: 1, name: exe.split('\\').pop(), exe, argv: splitCommandLine(extra.cmdline === undefined ? `"${exe}"` : extra.cmdline), cmdline: `"${exe}"`, env: null, envRead: false, cwd: null, startedAt: 1700000000000 + pid, startTicks: String(1700000000000 + pid), cmdlineState: 'ok', elevated: false, source: 'exec', ...extra })

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)

/** The registry as the daemon wires it: the D51 name lists, the same on every OS (no osMatch: the registry needs no redirector). */
function winRegistry(descriptors = ALL) {
  return createRegistry(descriptors)
}

/** A sandbox %USERPROFILE% with one harness's trust entries really installed (`on`'s own writer), the manifest, the CA and its paths. */
async function sandbox(harnessName, rels = []) {
  const home = tmpDir('asight-verdicts-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const d = one(harnessName)
  await installCollector({ home, env: { HOME: home, USERPROFILE: home }, osName: 'win32', harnesses: [d], freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const m = readManifest(dir)
  const ca = { certPem: fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'), keyPem: fs.readFileSync(path.join(dir, 'ca', 'ca.key'), 'utf8') }
  return { home, dir, m, pem: ca.certPem, ca, d, t0: Math.max(...m.entries.map((e) => Date.parse(e.installed_at))) }
}

/** The tracker over a real win32 redirector, wired the way the daemon wires it (the osMatch rule, the win32 layers, the manifest's installed_at, the marker's tolerance).
 *  The door model has no watcher: the redirector itself tells 'exec' when a connection meets a pid (D47's twin), so the test emits that event the way
 *  a lookup would. `over` reaches the redirector. */
function rigged({ descriptors, box: b, marker = false, over = {} }) {
  const helper = { ready: Promise.resolve({ ready: true, proto: 1, pid: 55, native: true }), pid: 55, async call() { throw new Error('no verb in the rig') }, async close() {} }
  const registry = winRegistry(descriptors)
  const redirector = createWin32Redirector({ helper, groups: groupsOf(descriptors), identify: registry.match, isOn: () => true, ...over })
  const tracker = createTracker({
    redirector, registry, trust: createTrustChecker({ caCertPem: b.pem }), home: b.home, alive: () => false, collectorDir: b.dir,
    installedAt: (l) => installedAt(b.m, l),
    osLayers: { win32: (d) => (d.win32 && d.win32.layers) || d.layers },
    ...(marker ? { markerDir: path.join(b.dir, 'run', 'trust'), caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), markerToleranceMs: MARKER_TOLERANCE_MS } : {}),
  })
  tracker.start()
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  return { redirector, tracker, settle }
}

// ── W76 cell 1: one rule for which harness ─────────────────────────────────────────────────────────────────────────────────────────────────

test('W76 the registry the tracker judges by finds the harness of a process of each Windows form by its name; there is no second rule (no identity data under harness/win32)', async () => {
  const registry = winRegistry()
  const rows = [
    [IMG.ccCli, {}, 'claude-code'], [IMG.ccVscode, {}, 'claude-code'], [IMG.ccDesktop, {}, 'claude-code'],
    [IMG.codexNpm, {}, 'codex'], [IMG.codexApp, {}, 'codex'],
    [IMG.hermesPy, { cmdline: HERMES_CMD }, 'hermes'], [IMG.kimi, {}, 'kimi-code'],
    [IMG.node, { cmdline: DSH_CMD }, 'deepseek-dsh'], [IMG.dshDesktop, {}, 'deepseek-dsh'],
    [IMG.opencode, {}, 'opencode'], [IMG.opencodeDesk, {}, 'opencode'],
    [IMG.zcode, { cmdline: ZCODE_CMD }, 'z-code'], [IMG.zcode, { cmdline: ZCODE_NET_CMD }, 'z-code'],
  ]
  for (const [exe, extra, harness] of rows) {
    const f = facts(10, exe, extra)
    assert.deepEqual(registry.match(f), { agent: harness, descriptor: one(harness), reason: 'match' }, `${exe}: the registry finds ${harness}`)
  }
  assert.equal(registry.match(facts(11, IMG.svchost)).agent, null, 'a process on no list is no agent')
  assert.deepEqual([registry.match(facts(13, IMG.zcode)).agent, registry.match(facts(14, IMG.hermesPy)).agent], [null, null], 'the Z-Code GUI itself (no zcode.cjs, no network-service args) and a bare python are no agent: a name alone is not enough for them (4.6 按 harness 名单, 4.8 W3)')
  const pending = registry.match(facts(12, IMG.node, { cmdline: null, argv: [], cmdlineState: 'pending' }))
  assert.equal(pending.agent, null, 'a command line not known yet judges nothing: the facts-update re-judges it (below)')
  // no second pattern set under harness/win32: the name list is the one rule
  const dir = new URL('../../../../src/collector/harness/win32/', import.meta.url)
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs') || name.startsWith('_')) continue
    const src = fs.readFileSync(new URL(name, dir), 'utf8')
    assert.equal(src.includes('signatures'), false, `${name} carries no signatures: the name list is the one rule`)
  }
  for (const d of ALL) assert.ok(d.processes && !d.signatures, `${d.name}: one name list for every OS (D51), no per-OS signatures`)
})

// ── W76 cell 2: per harness, on its Windows files (planTrust's entries really installed; `installed_at` from the manifest) ─────────────

test('W76 a process started after its harness\'s Windows trust entry is judged trusted although its environment is not read; one started before it is config-after-start — the Linux entry files read the same ones on a Windows-shaped home (claude-code, codex, z-code)', async () => {
  for (const [harness, exe, rels, extra] of [
    ['claude-code', IMG.ccCli, [], {}],
    ['codex', IMG.codexApp, [['.codex/config.toml']], {}],
    ['z-code', IMG.zcode, [['.zcode/cli/config.json', '{}']], { cmdline: ZCODE_CMD }],
  ]) {
    const b = await sandbox(harness, rels)
    const { redirector, settle } = rigged({ descriptors: [b.d], box: b })
    redirector.emit('exec', facts(20, exe, { ...extra, startedAt: b.t0 + 5000 }))
    redirector.emit('exec', facts(21, exe, { ...extra, startedAt: b.t0 - 5000 }))
    await settle()
    const after = redirector.verdictOf(20), before = redirector.verdictOf(21)
    assert.deepEqual([after.decrypt, after.agent], [true, harness], `${harness}: started after the entry → watch(pid, {decrypt:true})`)
    assert.equal(before.decrypt, false, `${harness}: started before it → the entry was not in effect when it started`)
    assert.equal(redirector.verdictOf(21).agent, harness)
  }
})

test('W76 Hermes on Windows is recognised and never decrypted (D51④): its live client refuses the .env entry asight writes (win 2026-10-14T09-06-56-260Z), so even after its .env block it is win-doors-rejected', async () => {
  const b = await sandbox('hermes', [['AppData/Local/hermes/config.yaml']])
  const { redirector, tracker, settle } = rigged({ descriptors: [b.d], box: b })
  assert.equal(typeof b.d.win32.layers, 'function', 'the Windows data carries its own layers: the Linux ones read ~/.hermes, which is not where Windows Hermes keeps its .env')
  redirector.emit('exec', facts(20, IMG.hermesPy, { cmdline: HERMES_CMD, startedAt: b.t0 + 5000 }))
  redirector.emit('exec', facts(21, IMG.hermesPy, { cmdline: HERMES_CMD, startedAt: b.t0 - 5000 }))
  await settle()
  for (const pid of [20, 21]) {
    assert.deepEqual(redirector.verdictOf(pid), { decrypt: false, agent: 'hermes' }, `pid ${pid}: a row is pushed, recognised as Hermes (the launcher shape), not decrypted`)
    assert.equal(tracker.describe(pid).reason, 'win-doors-rejected', `pid ${pid}: the reason names the refused entry, not config-after-start or a silent "not an agent"`)
  }
})

test('W76 Kimi has no automatic Windows trust entry (its shim is an opt-in item, Task 14): the process is judged and stays untrusted — fail-safe, never a broken connection', async () => {
  const b = await sandbox('kimi-code')
  assert.deepEqual(b.m.entries.filter((e) => e.harness === 'kimi-code'), [], 'planTrust writes nothing for Kimi on Windows')
  const { redirector, tracker, settle } = rigged({ descriptors: [b.d], box: b })
  redirector.emit('exec', facts(20, IMG.kimi, { startedAt: b.t0 + 5000 }))
  await settle()
  assert.deepEqual(redirector.verdictOf(20), { decrypt: false, agent: 'kimi-code' }, 'a row is pushed and it says not trusted')
  assert.equal(tracker.describe(20).reason, 'shim-not-on-path', 'the reason names what is missing (the shim), not a silent "not an agent"')
})

// ── W76 cell 3: the plugin marker's tolerance (dsh, 4.8 §6.1) ──────────────────────────────────────────────────────────────────────────

test('W76 the dsh plugin marker is trusted within the fixed tolerance (it is ms-rounded performance.timeOrigin against the helper\'s ms) and a marker an earlier process with the same pid left stays stale', async () => {
  const b = await sandbox('deepseek-dsh')
  const { redirector, settle } = rigged({ descriptors: [b.d], box: b, marker: true })
  const markerDir = path.join(b.dir, 'run', 'trust')
  const marker = (pid, at) => fs.writeFileSync(path.join(markerDir, String(pid)), String(at))
  const t = 1700000005000
  const dshAt = (pid, markerAt) => { marker(pid, markerAt); redirector.emit('exec', facts(pid, IMG.node, { cmdline: DSH_CMD, startedAt: t, startTicks: String(t) })) }
  dshAt(30, t) // the exact value
  dshAt(31, t - (MARKER_TOLERANCE_MS - 1)) // rounded down, still the same start
  dshAt(32, t + (MARKER_TOLERANCE_MS - 1)) // rounded up
  dshAt(33, t - 60000) // an earlier process of a recycled pid
  redirector.emit('exec', facts(34, IMG.node, { cmdline: DSH_CMD, startedAt: t, startTicks: String(t) })) // no marker at all
  await settle()
  assert.deepEqual([30, 31, 32].map((p) => redirector.verdictOf(p).decrypt), [true, true, true], 'the exact value and both rounding directions trust')
  assert.deepEqual([33, 34].map((p) => redirector.verdictOf(p).decrypt), [false, false], 'a stale marker and none never do')
  assert.equal(MARKER_TOLERANCE_MS > 0, true)
  // OpenCode is the same mechanism with no layers of its own (the marker is its only trust source), on its own image
  const o = await sandbox('opencode')
  const rig = rigged({ descriptors: [o.d], box: o, marker: true })
  fs.writeFileSync(path.join(o.dir, 'run', 'trust', '35'), String(t))
  rig.redirector.emit('exec', facts(35, IMG.opencode, { startedAt: t + 500, startTicks: String(t + 500) }))
  fs.writeFileSync(path.join(o.dir, 'run', 'trust', '36'), String(t - 60000))
  rig.redirector.emit('exec', facts(36, IMG.opencodeDesk, { startedAt: t, startTicks: String(t) }))
  await rig.settle()
  assert.deepEqual([rig.redirector.verdictOf(35).decrypt, rig.redirector.verdictOf(36).agent, rig.redirector.verdictOf(36).decrypt], [true, 'opencode', false], 'within the tolerance trusts, a recycled pid\'s stale marker does not')
})

// ── W76 cell 4: facts-update re-judges the same pid (a form told by its command line) ────────────────────────────────────────────────

test('W76 a form told by its command line is not judged "not an agent" while the command line is unknown: the facts-update judges the same pid again and pushes watch again', async () => {
  const b = await sandbox('deepseek-dsh')
  const { redirector, tracker, settle } = rigged({ descriptors: [b.d], box: b, marker: true })
  const t = 1700000005000
  redirector.emit('exec', facts(40, IMG.node, { cmdline: null, argv: [], cmdlineState: 'pending', startedAt: t, startTicks: String(t) }))
  await settle()
  assert.equal(redirector.verdictOf(40), null, 'nothing was pushed: pending is not "not an agent" and not a form either')
  assert.equal(tracker.describe(40), null)
  fs.writeFileSync(path.join(b.dir, 'run', 'trust', '40'), String(t)) // the plugin reports while the command line is still on its way
  redirector.emit('exec', facts(40, IMG.node, { cmdline: DSH_CMD, cmdlineState: 'ok', source: 'accept', startedAt: t, startTicks: String(t) })) // the next connection's ask carries the arrived command line (the door re-asks per connection, never a cached row)
  await settle()
  assert.deepEqual(redirector.verdictOf(40), { decrypt: true, agent: 'deepseek-dsh' }, 'judged again on the update, and the marker it left trusts')
})

// ── W76 cell 5: the whole path — the real redirector, tracker, registry and a real ingress ─────────────────────────────────────────────

const REQ = 'GET /v1/models HTTP/1.1\r\nhost: upstream.test\r\n\r\n'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok'
const TOKEN = '0123456789abcdef0123456789abcdef'

test('W76 end to end: a Windows connection of a trusted process is decrypted and its envelope says capture:"proxy", an untrusted one is spliced with its row, and a pid whose watch was never pushed is a splice — a gate that cannot break an agent', async (t) => {
  const b = await sandbox('claude-code')
  const answers = [{ pid: 20, source: 'socket-table', ms: 4 }, { pid: 21, source: 'socket-table', ms: 4 }, { pid: 55, source: 'socket-table', ms: 4 }]
  const ownerOf = async () => answers.shift() || { pid: null, source: null, ms: 1 }
  const factsOf = async (pid) => ({ 20: facts(20, IMG.ccCli, { startedAt: b.t0 + 5000 }), 21: facts(21, IMG.ccCli, { startedAt: b.t0 - 5000 }), 55: facts(55, IMG.svchost, { startedAt: b.t0 + 5000 }) }[pid] ?? null) // the accept-time facts question, answered per connection
  const { redirector, tracker, settle } = rigged({
    descriptors: [b.d], box: b,
    over: { ownerOf, factsOf, routes: () => ({ 'claude-code.settings': { entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } }), ingress: () => ({ enginePort: 18790, groupPorts: { 'claude-code.settings': 18801 }, ingressToken: TOKEN, listenerToken: 'fedcba9876543210fedcba9876543210' }) },
  })
  redirector.emit('exec', facts(20, IMG.ccCli, { startedAt: b.t0 + 5000 }))
  redirector.emit('exec', facts(21, IMG.ccCli, { startedAt: b.t0 - 5000 }))
  redirector.emit('exec', facts(55, IMG.svchost, { startedAt: b.t0 + 5000 })) // in the table, but the tracker judges it no agent: its watch is never pushed
  await settle()

  const privCa = createCa({ commonName: 'private origin CA' })
  const originIssuer = createLeafIssuer(loadCa(privCa))
  const origin = tls.createServer({ SNICallback: (n, cb) => cb(null, originIssuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('data', () => s.write(RESP)); s.on('error', () => {}) })
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const flows = [], envelopes = []
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(b.ca)), upstreamCa: privCa.certPem, ingressToken: TOKEN,
    policy: (meta) => (meta.decrypt ? true : meta.skip ?? tracker.policy(meta, 'upstream.test')), // the daemon's policy: the meta's skip, else the tracker's row
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: () => {},
  })
  const { groupPorts } = await engine.listen({ groups: [{ id: 'claude-code.settings', port: 18801, auth: true, token: 'fedcba9876543210fedcba9876543210' }] })
  const ingressPort = groupPorts['claude-code.settings'] // the door: the daemon binds the wiring's slot to the engine's listen({groups})
  t.after(async () => { origin.close(); await closeWithin(engine) })
  const settled = async ({ envelope = false } = {}) => { for (let i = 0; i < 400 && (flows.length < 1 || (envelope && envelopes.length < 1)); i++) await new Promise((x) => setTimeout(x, 10)) }
  /** An agent's connection to the DOOR (CONNECT with the group's credentials), then TLS to the origin trusting `ca`. */
  async function agent(ca) {
    const sock = net.connect(ingressPort, '127.0.0.1'); sock.on('error', () => {})
    sock.write(`CONNECT 127.0.0.1:${origin.address().port} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`claude-code.settings:fedcba9876543210fedcba9876543210`).toString('base64')}\r\n\r\n`) // the door's credentials: the group id and the listener token, as the written entry holds
    await within(new Promise((res) => { let got = ''; const on = (d) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) { sock.removeListener('data', on); res() } }; sock.on('data', on) }), 4000, 'the 200', () => sock.destroy())
    return within(new Promise((resolve) => {
      let issuerOf = null, got = ''
      const c = tls.connect({ socket: sock, servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'] }, () => { issuerOf = c.getPeerX509Certificate().issuer; c.write(REQ) })
      c.on('data', (d) => { got += d.toString('latin1'); if (got.length >= RESP.length) c.end() })
      c.on('error', () => {}); c.on('close', () => resolve(issuerOf ? { issuer: issuerOf, got } : 'closed'))
    }), 6000, 'the TLS exchange', () => sock.destroy())
  }

  const trusted = await agent(b.pem)
  assert.equal(trusted.got, RESP)
  assert.match(trusted.issuer, /asight/i, 'decrypted: the leaf the agent sees is asight\'s')
  await settled({ envelope: true })
  assert.equal(envelopes[0].capture, 'proxy', 'the envelope names the mode (Task 2(b)\'s reader, now on the daemon path W76 ends on)')
  assert.deepEqual([envelopes[0].proc.agent, envelopes[0].proc.pid], ['claude-code', 20])
  flows.length = 0; envelopes.length = 0

  const before = await agent(privCa.certPem) // pid 21: started before the entry, untrusted
  assert.equal(before.got, RESP, 'the agent got its answer: nothing is broken')
  assert.match(before.issuer, /private origin CA/, 'spliced: the origin\'s own certificate')
  await settled()
  assert.deepEqual([flows[0].decision, flows[0].not_captured, flows[0].reason, flows[0].pid], ['splice', 'untrusted', 'config-after-start', 21])
  flows.length = 0

  const never = await agent(privCa.certPem) // pid 55: in the process table, no verdict ever pushed for it
  assert.equal(never.got, RESP)
  assert.match(never.issuer, /private origin CA/)
  await settled()
  assert.deepEqual([flows[0].decision, flows[0].not_captured, flows[0].reason ?? null], ['splice', 'untracked', 'not-an-agent'], 'a pid whose process is not this door\'s own form (svchost at the claude door): the splice says so — the missing gate is what it looks like, never a broken connection')
})
