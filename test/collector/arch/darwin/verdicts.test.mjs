// test/collector/arch/darwin/verdicts.test.mjs — the verdict producer on macOS (RFC 4.9 §5.4 — which is 4.8 §5.4 「谁产生判定」 carried over, acceptance W76; plan Task 8(v)'s darwin run).
// The redirector's verdict table is filled by `watch(pid, { decrypt, agent })`, and the one that pushes is the tracker. The Windows twin's two blockers are gone the same way here: the daemon hands
// `matchForm` to the registry (`createRegistry(descriptors, { osMatch: { darwin } })`: one rule for which form, no copy of the patterns — the darwin harness files carry no `signatures`), and `procinfo`
// facts carry `envRead: false` so `env: null` is the OS's rule (no privileged read of another process's environment on macOS either, 4.9 §5.4) and not a failure to read, so the tracker judges by the
// entry files. The layers the tracker judges by are the descriptor's own (`d.layers`, the Linux ones — the darwin files carry no `layers` of their own, for only Windows moved a root, 4.9 §2.3), the
// plugin marker is compared with the same fixed tolerance (`MARKER_TOLERANCE_MS`), and the tracker listens to `facts-update` as well (a form told by its command line is judged again when it arrives —
// no not-yet state exists on darwin today, so nothing fires it; the shape is the contract and this file drives the event by hand). Still fail-safe: a pid nobody pushed a verdict for is untrusted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { createDarwinRedirector } from '../../../../src/collector/arch/darwin/redirector.mjs'
import { matchForm } from '../../../../src/collector/arch/darwin/forms.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'
import { createTracker } from '../../../../src/collector/core/tracker.mjs'
import { createTrustChecker, MARKER_TOLERANCE_MS } from '../../../../src/collector/core/trust/confirm.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest, installedAt } from '../../../../src/collector/core/trust/journal.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const HOME = '/Users/u'
const IMG = {
  ccNative: '/Users/u/.local/share/claude/versions/2.1.292/claude',
  ccVscode: '/Users/u/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude',
  ccDesktop: '/Applications/Claude.app/Contents/MacOS/Claude',
  codexNpm: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  hermesPy: '/Users/u/.hermes/tools/python-3.12.6/bin/python3',
  kimi: '/Users/u/.kimi-code/bin/kimi',
  node: '/usr/local/bin/node',
  opencode: '/Users/u/.opencode/bin/opencode',
  zcode: '/Applications/ZCode.app/Contents/MacOS/ZCode',
  syslogd: '/usr/libexec/syslogd',
}
const DSH_CMD = '/usr/local/bin/node /Users/u/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js'
const HERMES_CMD = `${IMG.hermesPy} -I -c "import hermes_bootstrap; import hermes_cli.main"`
const ZCODE_CMD = '/Applications/ZCode.app/Contents/MacOS/ZCode /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server --stdio'

/** What the darwin procinfo gives, with `envRead: false` — "this OS never reads another process's environment", so `env: null` is the rule here and not a failure to read (the tracker judges by the entry files instead). */
const facts = (pid, exe, extra = {}) => ({ os: 'darwin', pid, ppid: 1, name: exe.split('/').pop(), exe, argv: [], cmdline: exe, env: null, envRead: false, cwd: null, startedAt: 1700000000000 + pid, startTicks: String(1700000000000 + pid), cmdlineState: 'ok', elevated: false, elevationInferred: false, source: 'exec', ...extra })

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)
const GROUPS = groupsOf(ALL)
const FORMS = GROUPS.flatMap((g) => g.forms)
const HARNESS_OF_FORM = new Map(GROUPS.flatMap((g) => g.forms.map((f) => [f.id, g.harness])))

/** The registry as the daemon wires it (8(c)): `matchForm` over the same form data the redirector routes by, handed to the registry — the tracker and the redirector share one rule for which form a process is. */
function darwinRegistry(descriptors = ALL) {
  const darwin = (f) => { const m = matchForm(FORMS, f, { home: HOME }); return m.kind === 'form' ? HARNESS_OF_FORM.get(m.id) : null }
  return createRegistry(descriptors, { osMatch: { darwin } })
}

/** A sandbox $HOME with one harness's trust entries really installed (`on`'s own writer), the manifest, the CA and its paths. */
async function sandbox(harnessName, rels = []) {
  const home = tmpDir('asight-verdicts-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const d = one(harnessName)
  await installCollector({ home, env: { HOME: home }, osName: 'darwin', harnesses: [d], freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const m = readManifest(dir)
  const ca = { certPem: fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'), keyPem: fs.readFileSync(path.join(dir, 'ca', 'ca.key'), 'utf8') }
  return { home, dir, m, pem: ca.certPem, ca, d, t0: Math.max(...m.entries.map((e) => Date.parse(e.installed_at))) }
}

/** The tracker over a real darwin redirector, wired the way the daemon wires it (the osMatch rule, the layers, the manifest's installed_at, the marker's tolerance). `over` reaches the redirector. A pid met at a door is told as the redirector's own 'exec' (D47: the scan is gone; the door announces) — the tests drive the same event by hand. */
function rigged({ descriptors, box: b, marker = false, over = {} }) {
  const redirector = createDarwinRedirector({ groups: groupsOf(descriptors), home: HOME, ...over })
  const procWatcher = redirector
  const tracker = createTracker({
    redirector, registry: darwinRegistry(descriptors), trust: createTrustChecker({ caCertPem: b.pem }), home: b.home, alive: () => false, collectorDir: b.dir,
    installedAt: (l) => installedAt(b.m, l),
    osLayers: { darwin: (d) => (d.darwin && d.darwin.layers) || d.layers },
    ...(marker ? { markerDir: path.join(b.dir, 'run', 'trust'), caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), markerToleranceMs: MARKER_TOLERANCE_MS } : {}),
  })
  tracker.start()
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  return { procWatcher, redirector, tracker, settle }
} // `procWatcher` is the redirector itself now: emitting 'exec' on it is what a door does when it meets a pid

// ── W76 cell 1: one rule for which form ─────────────────────────────────────────────────────────────────────────────────────────────────

test('W76 the registry the tracker judges by finds the same harness as matchForm for a process of each darwin form; there is no second rule (no signatures.darwin anywhere)', async () => {
  const registry = darwinRegistry()
  const rows = [
    [IMG.ccNative, {}, 'claude-code'], [IMG.ccVscode, {}, 'claude-code'], [IMG.ccDesktop, {}, 'claude-code'],
    [IMG.codexNpm, {}, 'codex'],
    [IMG.hermesPy, { cmdline: HERMES_CMD }, 'hermes'], [IMG.kimi, {}, 'kimi-code'],
    [IMG.node, { cmdline: DSH_CMD }, 'deepseek-dsh'],
    [IMG.opencode, {}, 'opencode'],
    [IMG.zcode, { cmdline: ZCODE_CMD }, 'z-code'],
  ]
  for (const [exe, extra, harness] of rows) {
    const f = facts(10, exe, extra)
    const form = matchForm(FORMS, f, { home: HOME })
    assert.equal(form.kind, 'form', `${exe} is a form`)
    assert.equal(HARNESS_OF_FORM.get(form.id), harness)
    assert.deepEqual(registry.match(f), { agent: harness, descriptor: one(harness), reason: 'match' }, `${exe}: the registry finds ${harness}, as the redirector's form ${form.id} says`)
  }
  assert.equal(registry.match(facts(11, IMG.syslogd)).agent, null, 'a process of no form is no agent')
  const empty = registry.match(facts(12, IMG.node, { cmdline: null, argv: [], cmdlineState: 'empty' }))
  assert.equal(empty.agent, null, 'a row ps gave no command line for judges nothing here (final on darwin — the facts-update below is what would re-judge it, and nothing fires it today)')
  // no copy of the patterns as `signatures.darwin`: the form data is the one rule, and the darwin files carry no signatures
  const dir = new URL('../../../../src/collector/harness/darwin/', import.meta.url)
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs') || name.startsWith('_')) continue
    const src = fs.readFileSync(new URL(name, dir), 'utf8')
    assert.equal(src.includes('signatures'), false, `${name} carries no signatures: the registry is told matchForm, not a second pattern set`)
  }
  for (const d of ALL) assert.ok(d.signatures && d.signatures.linux && !d.signatures.darwin, `${d.name}: the descriptor keeps its Linux signatures and gains no darwin ones`)
})

// ── W76 cell 2: per harness, on its macOS files (planTrust's entries really installed; `installed_at` from the manifest) ───────────────

test('W76 a process started after its harness\'s trust entry is judged trusted although its environment is not read; one started before it is config-after-start — the Linux entry files read the same ones on a macOS home (claude-code, codex, z-code)', async () => {
  for (const [harness, exe, rels, extra] of [
    ['claude-code', IMG.ccNative, [], {}],
    ['codex', IMG.codexNpm, [['.codex/config.toml']], {}],
    ['z-code', IMG.zcode, [['.zcode/cli/config.json', '{}']], { cmdline: ZCODE_CMD }],
  ]) {
    const b = await sandbox(harness, rels)
    const { procWatcher, redirector, settle } = rigged({ descriptors: [b.d], box: b })
    procWatcher.emit('exec', facts(20, exe, { ...extra, startedAt: b.t0 + 5000 }))
    procWatcher.emit('exec', facts(21, exe, { ...extra, startedAt: b.t0 - 5000 }))
    await settle()
    const after = redirector.verdictOf(20), before = redirector.verdictOf(21)
    assert.deepEqual([after.decrypt, after.agent], [true, harness], `${harness}: started after the entry → watch(pid, {decrypt:true})`)
    assert.equal(before.decrypt, false, `${harness}: started before it → the entry was not in effect when it started`)
    assert.equal(redirector.verdictOf(21).agent, harness)
  }
})

test('W76 Hermes is judged on its macOS files (~/.hermes, the descriptor\'s own Linux layers — 4.9 §2.3: only Windows moved the root, so the darwin data carries no layers of its own): trusted after its .env block, config-after-start before it', async () => {
  const b = await sandbox('hermes', [['.hermes/config.yaml']])
  const { procWatcher, redirector, settle } = rigged({ descriptors: [b.d], box: b })
  assert.equal(b.d.darwin.layers, undefined, 'the darwin data carries no layers of its own: the Linux ones read ~/.hermes, which is where macOS Hermes keeps it (4.9 §2.3)')
  procWatcher.emit('exec', facts(20, IMG.hermesPy, { cmdline: HERMES_CMD, startedAt: b.t0 + 5000 }))
  procWatcher.emit('exec', facts(21, IMG.hermesPy, { cmdline: HERMES_CMD, startedAt: b.t0 - 5000 }))
  await settle()
  assert.deepEqual([redirector.verdictOf(20).decrypt, redirector.verdictOf(20).agent], [true, 'hermes'])
  assert.equal(redirector.verdictOf(21).decrypt, false)
})

test('W76 Kimi has no automatic darwin trust entry (its shim and rc PATH line are one opt-in item, 4.9 §2.3): the process is judged and stays untrusted — fail-safe, never a broken connection', async () => {
  const b = await sandbox('kimi-code')
  assert.deepEqual(b.m.entries.filter((e) => e.harness === 'kimi-code'), [], 'planTrust writes nothing for Kimi on darwin')
  const { procWatcher, redirector, tracker, settle } = rigged({ descriptors: [b.d], box: b })
  procWatcher.emit('exec', facts(20, IMG.kimi, { startedAt: b.t0 + 5000 }))
  await settle()
  assert.deepEqual(redirector.verdictOf(20), { decrypt: false, agent: 'kimi-code' }, 'a row is pushed and it says not trusted')
  assert.equal(tracker.describe(20).reason, 'shim-not-on-path', 'the reason names what is missing (the shim), not a silent "not an agent"')
})

// ── W76 cell 3: the plugin marker's tolerance (dsh, 4.8 §6.1) ──────────────────────────────────────────────────────────────────────────

test('W76 the dsh plugin marker is trusted within the fixed tolerance (it is ms-rounded performance.timeOrigin against ps\'s second-granularity lstart) and a marker an earlier process with the same pid left stays stale', async () => {
  const b = await sandbox('deepseek-dsh')
  const { procWatcher, redirector, settle } = rigged({ descriptors: [b.d], box: b, marker: true })
  const markerDir = path.join(b.dir, 'run', 'trust')
  const marker = (pid, at) => fs.writeFileSync(path.join(markerDir, String(pid)), String(at))
  const t = 1700000005000
  const dshAt = (pid, markerAt) => { marker(pid, markerAt); procWatcher.emit('exec', facts(pid, IMG.node, { cmdline: DSH_CMD, startedAt: t, startTicks: String(t) })) }
  dshAt(30, t) // the exact value
  dshAt(31, t - (MARKER_TOLERANCE_MS - 1)) // rounded down, still the same start
  dshAt(32, t + (MARKER_TOLERANCE_MS - 1)) // rounded up
  dshAt(33, t - 60000) // an earlier process of a recycled pid
  procWatcher.emit('exec', facts(34, IMG.node, { cmdline: DSH_CMD, startedAt: t, startTicks: String(t) })) // no marker at all
  await settle()
  assert.deepEqual([30, 31, 32].map((p) => redirector.verdictOf(p).decrypt), [true, true, true], 'the exact value and both rounding directions trust')
  assert.deepEqual([33, 34].map((p) => redirector.verdictOf(p).decrypt), [false, false], 'a stale marker and none never do')
  assert.equal(MARKER_TOLERANCE_MS > 0, true)
  // OpenCode is the same mechanism with no layers of its own (the marker is its only trust source), on its own image — the Windows twin drove it with a second
  // form (the desktop app), a form the darwin data does not list; the tolerance is the same either way
  const o = await sandbox('opencode')
  const rig = rigged({ descriptors: [o.d], box: o, marker: true })
  fs.writeFileSync(path.join(o.dir, 'run', 'trust', '35'), String(t))
  rig.procWatcher.emit('exec', facts(35, IMG.opencode, { startedAt: t + 500, startTicks: String(t + 500) }))
  fs.writeFileSync(path.join(o.dir, 'run', 'trust', '36'), String(t - 60000))
  rig.procWatcher.emit('exec', facts(36, IMG.opencode, { startedAt: t, startTicks: String(t) }))
  await rig.settle()
  assert.deepEqual([rig.redirector.verdictOf(35).decrypt, rig.redirector.verdictOf(36).agent, rig.redirector.verdictOf(36).decrypt], [true, 'opencode', false], 'within the tolerance trusts, a recycled pid\'s stale marker does not')
})

// ── W76 cell 4: facts-update re-judges the same pid (a form told by its command line) ────────────────────────────────────────────────

test('W76 a form told by its command line is not judged "not an agent" while the command line is missing: the facts-update judges the same pid again and pushes watch again (nothing fires it on darwin today — the shape is the contract, and this drives it by hand)', async () => {
  const b = await sandbox('deepseek-dsh')
  const { procWatcher, redirector, tracker, settle } = rigged({ descriptors: [b.d], box: b, marker: true })
  const t = 1700000005000
  procWatcher.emit('exec', facts(40, IMG.node, { cmdline: null, argv: [], cmdlineState: 'empty', startedAt: t, startTicks: String(t) }))
  await settle()
  assert.equal(redirector.verdictOf(40), null, 'nothing was pushed: a row with no command line is not a form, and it is not "not an agent" either — nothing was judged')
  assert.equal(tracker.describe(40), null)
  fs.writeFileSync(path.join(b.dir, 'run', 'trust', '40'), String(t)) // the plugin reports while the command line is still on its way
  procWatcher.emit('facts-update', facts(40, IMG.node, { cmdline: DSH_CMD, cmdlineState: 'ok', source: 'update', startedAt: t, startTicks: String(t) }))
  await settle()
  assert.deepEqual(redirector.verdictOf(40), { decrypt: true, agent: 'deepseek-dsh' }, 'judged again on the update, and the marker it left trusts')
})

// ── D47 finding, 2026-10-12: the z-code CLI's rewritten command line is still the form at the door ─────────────────────────────────────

test('D47 a z-code CLI that rewrote its whole command line to its title (`process.title = "zcode-cli"`) is the form at the door: the pid is announced at accept time and the verdict arrives through watch() — found live on macOS (the form knew only `zcode\.cjs`, the door answered path-unknown and spliced every connection untracked, no llm_call, while cc/codex/dsh — none of which rewrites its command line — decrypted fine)', async () => {
  // the two command lines a z-code CLI process lives in (the base descriptor's CLI_CMDLINE): the bundle path as invoked, and the title a `-p` / `tui`
  // CLI rewrites its whole command line to within moments of start — `ps` gave exactly `zcode-cli` for the process that owned the sockets (measured)
  for (const cmdline of [ZCODE_CMD, 'zcode-cli']) {
    const announced = []
    // the tracker's half of the seam, faked: judge → watch. The door's half is the real one (matchForm over the real form data, ownerOf, factsOf)
    const redirector = createDarwinRedirector({
      groups: GROUPS, home: HOME,
      ownerOf: async () => ({ pid: 50, source: 'socket-table', ms: 4 }),
      factsOf: () => facts(50, IMG.zcode, { cmdline, argv: cmdline.split(/\s+/), startedAt: 1700000005000, startTicks: '1700000005000', source: 'accept' }),
      routes: () => ({ 'z-code.cli': { entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } }),
      ingress: () => ({ enginePort: 18790, groupPorts: { 'z-code.cli': 18801 }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    })
    redirector.on('exec', (f) => { announced.push(f.pid); redirector.watch(f.pid, { decrypt: true, agent: 'z-code' }) })
    const meta = await redirector.lookupIngress({ peer: { address: '127.0.0.1', port: 51000 }, user: 'z-code.cli', target: { address: 'relay.asight.test', port: 443 } })
    assert.deepEqual(announced, [50], cmdline === 'zcode-cli' ? 'the rewritten-title CLI was announced at accept time' : 'the as-invoked CLI was announced at accept time')
    assert.equal(meta.form, 'z-code.cli', `${cmdline}: the door named the form`)
    assert.equal(meta.decrypt, true, `${cmdline}: the verdict arrived through watch(), not the 5 s tombstone`)
    assert.equal(meta.skip, undefined, `${cmdline}: nothing says untracked`)
    assert.equal(meta.agent, 'z-code')
  }
  // the desktop GUI's process (a command line of neither shape: the bare exe, no bundle path, no title) is still no form on macOS — the new title
  // pattern widens the CLI, it must not swallow the unmeasured desktop (4.6 OPEN ②'s darwin half)
  assert.equal(matchForm(FORMS, facts(51, IMG.zcode, { cmdline: IMG.zcode }), { home: HOME }).kind, 'path-unknown')
})

// ── the z-code DESKTOP seam, 2026-10-13 : the app-server Helper ───────────────────────

test('D47b the z-code DESKTOP\'s app-server is the form at the door: an Electron `ZCode Helper` binary carrying the CLI\'s own `zcode-cli` title (lsof txt record + ps command line, both measured live) — before the form existed every connection of the desktop\'s turn was spliced untracked (5 flows, decrypted 0, no llm_call); with it the pid is announced, the verdict arrives through watch(), and the OTHER Helper processes of the same binary (GPU / network / NodeService, Chromium switch command lines) are not the form', async () => {
  const HELPER = '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper'
  for (const cmdline of ['zcode-cli', `${HELPER} /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server --stdio`]) {
    const announced = []
    const redirector = createDarwinRedirector({
      groups: GROUPS, home: HOME,
      ownerOf: async () => ({ pid: 60, source: 'socket-table', ms: 4 }),
      factsOf: () => facts(60, HELPER, { cmdline, argv: cmdline.split(/\s+/), startedAt: 1700000006000, startTicks: '1700000006000', source: 'accept' }),
      routes: () => ({ 'z-code.cli': { entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } }),
      ingress: () => ({ enginePort: 18790, groupPorts: { 'z-code.cli': 18801 }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    })
    redirector.on('exec', (f) => { announced.push(f.pid); redirector.watch(f.pid, { decrypt: true, agent: 'z-code' }) })
    const meta = await redirector.lookupIngress({ peer: { address: '127.0.0.1', port: 51000 }, user: 'z-code.cli', target: { address: 'relay.asight.test', port: 443 } })
    assert.deepEqual(announced, [60], `${cmdline.slice(0, 40)}: the desktop's app-server was announced at accept time`)
    assert.equal(meta.form, 'z-code.desktop', `${cmdline.slice(0, 40)}: the door named the DESKTOP form (the Helper binary is not the CLI form's image)`)
    assert.equal(meta.decrypt, true, `${cmdline.slice(0, 40)}: the verdict arrived through watch()`)
    assert.equal(meta.skip, undefined, `${cmdline.slice(0, 40)}: nothing says untracked`)
    assert.equal(meta.agent, 'z-code')
  }
  // the OTHER processes of the same Helper binary — the Chromium family switches, no z-code title — are not the form: their connections at this
  // door stay not-a-process-of-form (measured: the desktop's own GPU / network / NodeService Helpers carry --type=… command lines)
  const notForm = `${HELPER} --type=utility --utility-sub-type=network.mojom.NetworkService --user-data-dir=/Users/u/Library/Application Support/ZCode`
  assert.deepEqual(matchForm(FORMS, facts(61, HELPER, { cmdline: notForm }), { home: HOME }), { kind: 'path-unknown', forms: ['z-code.desktop'], shape: '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper' }, 'a ZCode Helper without the agent command line is the desktop form\'s path-unknown, not the form')
})

// ── W76 cell 5: the whole path — the real redirector, tracker, registry and a real ingress ─────────────────────────────────────────────

const REQ = 'GET /v1/models HTTP/1.1\r\nhost: upstream.test\r\n\r\n'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok'
const TOKEN = '0123456789abcdef0123456789abcdef'

test('W76 end to end: a darwin connection of a trusted process is decrypted and its envelope says capture:"proxy", an untrusted one is spliced with its row, and a pid whose watch was never pushed is a splice — a gate that cannot break an agent', async (t) => {
  const b = await sandbox('claude-code')
  const answers = [{ pid: 20, source: 'socket-table', ms: 4 }, { pid: 21, source: 'socket-table', ms: 4 }, { pid: 55, source: 'socket-table', ms: 4 }]
  const ownerOf = async () => answers.shift() || { pid: null, source: null, ms: 1 }
  // the targeted facts of the three pids the socket will name (D47: the door asks, the store answers)
  const known = new Map([
    [20, facts(20, IMG.ccNative, { startedAt: b.t0 + 5000 })],
    [21, facts(21, IMG.ccNative, { startedAt: b.t0 - 5000 })],
    [55, facts(55, IMG.syslogd, { startedAt: b.t0 + 5000 })], // met, but the tracker judges it no agent: its watch is never pushed
  ])
  const { redirector, tracker } = rigged({
    descriptors: [b.d], box: b,
    over: { ownerOf, factsOf: (pid) => known.get(pid) ?? null, routes: () => ({ 'claude-code.settings': { entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } }), ingress: () => ({ enginePort: 18790, groupPorts: { 'claude-code.settings': 18801 }, ingressToken: TOKEN, listenerToken: 'fedcba9876543210fedcba9876543210' }) },
  })

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
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(async () => { origin.close(); await closeWithin(engine) })
  const settled = async ({ envelope = false } = {}) => { for (let i = 0; i < 400 && (flows.length < 1 || (envelope && envelopes.length < 1)); i++) await new Promise((x) => setTimeout(x, 10)) }
  /** An agent's connection as the door answers it (CONNECT, the door's group as the user — D47), then TLS to the origin trusting `ca`. */
  async function agent(ca) {
    const sock = net.connect(ingressPort, '127.0.0.1'); sock.on('error', () => {})
    sock.write(`CONNECT 127.0.0.1:${origin.address().port} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`claude-code.settings:${TOKEN}`).toString('base64')}\r\n\r\n`)
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
  assert.equal(envelopes[0].capture, 'proxy', 'the envelope names the mode (W76: the same data format on every platform, 4.9 §5.6)')
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
  assert.deepEqual([flows[0].decision, flows[0].not_captured, flows[0].reason ?? null], ['splice', 'untracked', 'not-a-process-of-form'], 'the tracker has no row to say why, and the door says what the process was not: the splice is what a missing gate looks like, never a broken connection')
})
