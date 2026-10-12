// test/cli/darwin-on.test.mjs — the install half of the OS roots on darwin (the flip checklist ② of 4.9 §4 末): the arch reads its roots (darwinRoots: the keychain-administered
// anchors ∪ Node's bundled ∪ Apple's SystemRootCertificates, 4.9 §6.2) instead of naming one file, and the daemon's daily rebuild already consumes that arm (daemon.mjs) — but
// `on`'s install path passed only `osRootsFile` (null on darwin), so the FIRST install's combined bundles were composed with an empty `osText`: no keychain anchor in them, and a
// replace-semantics entry (Codex's SSL_CERT_FILE) would silently cut the agent off its relay until the next daily rebuild. This file pins the seam the flip connects: runOnCli asks
// `parts.arch.osRoots` and hands the answer to the install as its roots. Nothing here reads a real keychain — the arch hook is a fake over a generated certificate; HOME is a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { fakeDaemon, fakeIo } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const descs = await loadHarnesses()
const codex = descs.find((d) => d.name === 'codex')

/** One darwin `on` world: the codex .env a user has, the arch hooks of the flip's seam (`osRoots` a spy over a generated certificate), a daemon that answers.
 *  The fake arch carries NO kernel hooks (D47: darwin has none — no `prepare`, no `ensureKernel`; the plumbing's win32 twins are test/cli/win-plan.test.mjs's D44 cells).
 *  `harness` swaps the one harness in parts (the desktop-hint test runs claude-code); `optInHooks` gives the fake arch an optIn half (plan rows). */
function darwinWorld({ osRoots, harness = codex, optInHooks = null } = {}) {
  const home = tmpDir('asight-darwin-on-')
  // a darwin machine finds the daemon through control.json (4.9 §7); XDG_RUNTIME_DIR is a shape no real mac presents (the 2026-10-11 blind spot)
  fs.mkdirSync(path.join(home, '.asight', 'collector'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asight', 'collector', 'control.json'), JSON.stringify({ path: path.join(home, 'asight-0123456789abcdef.sock'), token: 'f'.repeat(64) }) + '\n')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const asked = []
  const arch = {
    // the read-only hooks runOnCli asks of an arch (on.mjs): only osRoots matters here — refuseElevated / nodePreflight / unit / routing are absent and skipped
    osRoots: async () => { asked.push(1); if (osRoots === undefined) return { pem: FAKE_OS.certPem }; return osRoots() },
    // no prepare / ensureKernel: the real darwin arch exports neither (D47 — the engine is the only proxy; wiring.test.mjs pins their absence)
    ...(optInHooks ? { optIn: optInHooks } : {}),
  }
  const parts = { os: 'darwin', osRootsFile: null, harnesses: [harness], scan: async () => [], match: () => ({ agent: null }), arch }
  const run = async (argv, { platform = 'linux', deps: extraDeps = {} } = {}) => {
    const io = fakeIo()
    const exit = await runOnCli(argv, {
      io, home, platform, // 'linux' + parts.os 'darwin' was the pre-flip seam (the same split the win flip used); Part 2 sends 'darwin' straight through
      env: { HOME: home },
      deps: {
        parts, request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true,
        netenv: async () => ({ at: '2026-10-11T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
        freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs,
        ...extraDeps,
      },
    })
    return { exit, io, text: io.text() }
  }
  return { home, asked, run }
}

const FAKE_OS = createCa({ commonName: 'fake keychain anchor' })

// the flip ② (4.9 §4 末): the FIRST install's combined bundle holds the arch's OS roots — the keychain anchor a replace-semantics entry needs on day one, not from the daily rebuild on
test('the flip ② (4.9 §4): `on` on the darwin arch asks parts.arch.osRoots and the first combined bundle carries its answer', async () => {
  const w = darwinWorld()
  const r = await w.run(['--yes', 'codex'])
  assert.equal(r.exit, 0, r.text)
  assert.equal(w.asked.length, 1, 'the arch hook was asked exactly once (the install seam, cli/on.mjs)')
  const m = path.join(w.home, '.codex', '.env')
  const named = /^SSL_CERT_FILE=(.+)$/m.exec(fs.readFileSync(m, 'utf8'))
  assert.ok(named, `the trust entry was written: ${fs.readFileSync(m, 'utf8')}`)
  const bundle = named[1].trim()
  assert.ok(bundle.startsWith(path.join(w.home, '.asight')), `the entry names asight's own bundle: ${bundle}`)
  const held = certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp)
  const fakeFp = certBlocks(FAKE_OS.certPem)[0].fp
  assert.ok(held.includes(fakeFp), `the bundle carries the arch's OS roots (the fake keychain anchor): ${held.slice(0, 3)}…`)
})

// the failure half (D38): roots that cannot be read stop `on` before one file of the agents' is touched — a bundle quietly missing the enterprise roots is the bug this wiring exists to close
test('the flip ② (4.9 §4): an arch whose roots cannot be read is said and stops the on — nothing is written', async () => {
  const w = darwinWorld({ osRoots: async () => { throw Object.assign(new Error('the macOS root certificates could not be read (security: I/O error)'), { name: 'RootsUnavailableError' }) } })
  const before = fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8')
  const r = await w.run(['--yes', 'codex'])
  assert.equal(r.exit, 1, r.text)
  assert.match(r.text, /root certificates could not be read/, 'the reason reaches the receipt')
  assert.equal(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'), before, 'the user\'s file is as it was')
  assert.ok(!fs.existsSync(path.join(w.home, '.asight', 'collector', 'ca')), 'no bundle was written on a guess')
})

// the arm is for the arches whose roots are read, not one file: Linux (osRootsFile) and a test's own `roots` are untouched by it
test('the flip ② (4.9 §4): an arch that names a file (Linux) is not asked for osRoots, and deps.roots still overrides everything', async () => {
  const home = tmpDir('asight-darwin-on-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const osFile = path.join(home, 'os-roots.pem')
  fs.writeFileSync(osFile, FAKE_OS.certPem)
  const asked = []
  const run = async (parts, deps = {}) => {
    const io = fakeIo()
    const exit = await runOnCli(['--yes', 'codex'], {
      io, home, platform: 'linux', env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run') },
      deps: {
        parts, request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true,
        netenv: async () => ({ at: '2026-10-11T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
        freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs, ...deps,
      },
    })
    return { exit, io, text: io.text() }
  }
  const arch = { osRoots: async () => { asked.push(1); return { pem: 'should not be asked' } } }
  let r = await run({ os: 'linux', osRootsFile: osFile, harnesses: [codex], scan: async () => [], match: () => ({ agent: null }), arch })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(asked, [], 'the file-naming arch reads the file, the hook is not asked')
  const named = /^SSL_CERT_FILE=(.+)$/m.exec(fs.readFileSync(path.join(home, '.codex', '.env'), 'utf8'))
  assert.ok(certBlocks(fs.readFileSync(named[1].trim(), 'utf8')).some((b) => b.fp === certBlocks(FAKE_OS.certPem)[0].fp), 'the file\'s roots are in the bundle, as before')
  // a second world: deps.roots given → the arch hook is not asked either (the seam a test or an embedder overrides with)
  const home2 = tmpDir('asight-darwin-on-')
  fs.mkdirSync(path.join(home2, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const io = fakeIo()
  const exit = await runOnCli(['--yes', 'codex'], {
    io, home: home2, platform: 'linux', env: { HOME: home2, XDG_RUNTIME_DIR: path.join(home2, 'run') },
    deps: {
      parts: { os: 'darwin', osRootsFile: null, harnesses: [codex], scan: async () => [], match: () => ({ agent: null }), arch },
      request: fakeDaemon().request, helperState: () => ({ ok: true }), linger: () => true,
      netenv: async () => ({ at: '2026-10-11T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
      freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs,
      roots: { node: [], osText: FAKE_OS.certPem },
    },
  })
  assert.equal(exit, 0, io.text())
  assert.deepEqual(asked, [], 'deps.roots given: the arch hook is not asked (the same override the win tests use)')
})

// the flip (4.9 §4 末 · Part 2, 1.6 §4 / §2) settled into the only path there is (D39⑥ executed 2026-10-11: the legacy-on dispatch went with the old capture):
// `on` with platform darwin runs the darwin arch's own plan. The win twin of this cell is test/cli/win-plan.test.mjs's flip test.
test('`on` with platform darwin runs the new collector — the darwin arch hooks are asked and the plan is drawn', async () => {
  const w = darwinWorld()
  const r = await w.run(['--dry-run'], { platform: 'darwin' })
  assert.equal(r.exit, 0, r.text)
  assert.match(r.text, /^asight 将打开采集/, 'the NEW collector\'s plan is what a Mac gets')
  assert.match(r.text, /\.codex\/\.env/, 'drawn from the darwin arch\'s own world (the codex trust entry)')
  assert.ok(!/驱动旧采集|本平台未实现/.test(r.text), 'and no word of the old capture remains in what `on` says first')
})

// the Claude Desktop steering hint (4.9 §6.4): the darwin plan says the launcher item exactly while claude-code is a
// target and the ledger has no done row for it — the win twin is formatWinPlan's codex line (test/cli/win-plan.test.mjs); nothing is ever installed
// by a hint, and the needs_restart honesty (only instances started through the launcher are steered) rides in the line itself.
const DESKTOP_HINT = 'macOS 上采 Claude Desktop 需要点名建启动器: asight on claude-code --opt-in claude-code.desktop(写 ~/.asight/collector/bin/claude-desktop-asight;只有经它启动的 Desktop 才被引流,已在跑的 Desktop 不受影响——先退出再用它启动)'
test('the desktop steering hint on darwin: the plan says it while claude-code is a target without a done row, and goes silent the moment the ledger has one', async () => {
  const claude = descs.find((d) => d.name === 'claude-code')
  const rows = (state) => [{ form: 'claude-code.desktop', item: 'desktop-launcher', scope: 'user', kinds: ['optin-desktop-launcher'], impact: 'a launcher that starts Claude Desktop steered at asight\'s listener', command: 'asight on claude-code --opt-in claude-code.desktop', chosen: false, applicable: true, state }]
  const hooks = (state) => ({ forms: async () => ['claude-code.desktop'], plan: async () => rows(state) })
  const w = darwinWorld({ harness: claude, optInHooks: hooks('needed') })
  const r = await w.run(['--yes', 'claude-code'], { platform: 'darwin' })
  assert.equal(r.exit, 0, r.text)
  assert.ok(r.text.includes(DESKTOP_HINT), `the hint is in the plan: ${r.text}`)
  const w2 = darwinWorld({ harness: claude, optInHooks: hooks('done') })
  const r2 = await w2.run(['--yes', 'claude-code'], { platform: 'darwin' })
  assert.equal(r2.exit, 0, r2.text)
  assert.ok(!r2.text.includes(DESKTOP_HINT), 'the done row: the hint has done its job and goes')
  const w3 = darwinWorld({ optInHooks: { forms: async () => [], plan: async () => [] } })
  const r3 = await w3.run(['--yes', 'codex'], { platform: 'darwin' })
  assert.equal(r3.exit, 0, r3.text)
  assert.ok(!r3.text.includes(DESKTOP_HINT), 'claude-code not a target: nothing to say')
})
