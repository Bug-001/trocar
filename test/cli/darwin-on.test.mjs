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

/** One darwin `on` world: the codex .env a user has, the arch hooks of the flip's seam (`osRoots` a spy over a generated certificate), a daemon that answers. */
function darwinWorld({ osRoots } = {}) {
  const home = tmpDir('asight-darwin-on-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const asked = []
  const arch = {
    // the read-only hooks runOnCli asks of an arch (on.mjs): only osRoots matters here — prepare / refuseElevated / nodePreflight / unit / routing are absent and skipped
    osRoots: async () => { asked.push(1); if (osRoots === undefined) return { pem: FAKE_OS.certPem }; return osRoots() },
  }
  const parts = { os: 'darwin', osRootsFile: null, harnesses: [codex], scan: async () => [], match: () => ({ agent: null }), arch }
  const run = async (argv, { platform = 'linux', deps: extraDeps = {} } = {}) => {
    const io = fakeIo()
    const exit = await runOnCli(argv, {
      io, home, platform, // 'linux' + parts.os 'darwin' was the pre-flip seam (the same split the win flip used); Part 2 sends 'darwin' straight through
      env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run') },
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

// the flip (4.9 §4 末 · Part 2, 1.6 §4 / §2): hasNewCollector('darwin') is true, so `on` on a Mac is the NEW collector's on — the darwin arch
// hooks draw the plan — and the legacy dispatch (src/capture/legacy-on.mjs) is not what runs. The win twin of this cell is test/cli/win-plan.test.mjs's flip test.
test('the flip (Part 2, 1.6 §4): `on` with platform darwin runs the new collector — the darwin arch hooks are asked and the plan is drawn, and the legacy-on dispatch never runs', async () => {
  const w = darwinWorld()
  const legacy = []
  const r = await w.run(['--dry-run'], { platform: 'darwin', deps: { legacyOn: async (argv) => { legacy.push(argv); return 0 } } })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(legacy, [], 'darwin does not run legacyOnCli (src/capture/legacy-on.mjs) any more')
  assert.match(r.text, /^asight 将打开采集/, 'the NEW collector\'s plan is what a Mac gets')
  assert.match(r.text, /\.codex\/\.env/, 'drawn from the darwin arch\'s own world (the codex trust entry)')
  assert.ok(!/驱动旧采集|本平台未实现/.test(r.text), 'and no word of the old capture remains in what `on` says first')
})
