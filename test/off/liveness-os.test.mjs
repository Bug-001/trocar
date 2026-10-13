// test/off/liveness-os.test.mjs — off judges who may hold a combined bundle on macOS and Windows too (RFC 4.6 §安装清单与卸载「判活快照」and
// 「撤销顺序」第 2 步, D39, 1.6 R3). `on` writes the liveness snapshot for the OS it runs on — there, the form table folded into a signature (the arch's
// livenessSignature) — and `off` reads that OS's process table (`ps` + `lsof` on macOS, one Get-CimInstance question on Windows) and nothing else. A Codex
// that started after `on` re-reads combined-codex.pem at its next connection: removing the bundle under it leaves it with no network, so off keeps it
// without the asight CA and names the pid. A snapshot with no signature (an older asight's `on` on these OSes wrote null) is "not known", never "nobody".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installCollector, turnOn } from '../../src/collector/install.mjs'
import { loadArch } from '../../src/collector/arch/index.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { listProcs } from '../../src/off/proc.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { darwinTools } from './fixtures/darwin-tools.mjs'
import { fakeSystem } from '../cli/fixtures/on-ctx.mjs'

const ROOT = createCa({ commonName: 'liveness-os root' })
const roots = { node: [ROOT.certPem], osText: '' }
const HARNESSES = await loadHarnesses()

// Each OS: where its codex lives (an install shape its form table carries — the npm vendor binary the node launcher spawns, test/collector/harness/
// {darwin,win32}-forms.test.mjs), and that OS's table reader over the injected runner, with that codex in it (pid 4242, a child of its node launcher).
const OS = {
  darwin: {
    codex: '/Users/u/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    table: (codex, at) => darwinTools([
      { pid: 4241, at, exe: '/Users/u/.nvm/versions/node/v22.20.0/bin/node', cmdline: 'node /Users/u/.nvm/versions/node/v22.20.0/bin/codex --model x' },
      ...(codex ? [{ pid: 4242, ppid: 4241, at, exe: codex, cmdline: `${codex} --model x` }] : []),
    ]).run,
  },
  win32: {
    codex: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
    table: (codex, at) => () => ({ status: 0, stdout: JSON.stringify([{ p: 4241, pp: 1, n: 'node.exe', x: 'C:\\Program Files\\nodejs\\node.exe', s: at.getTime(), c: '"C:\\Program Files\\nodejs\\node.exe" codex.js' }, ...(codex ? [{ p: 4242, pp: 4241, n: 'codex.exe', x: codex, s: at.getTime(), c: `"${codex}" --model x` }] : [])]), stderr: '' }),
  },
}

async function codexHome(osName) {
  const home = tmpDir('asight-liveness-os-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const dir = path.join(home, '.asight', 'collector')
  const arch = await loadArch(osName)
  const off = (codex) => undoHarnesses({ dir, home, manifest: readManifest(dir), ids: ['codex'], roots, procs: () => listProcs({ uid: 501, platform: osName, exec: OS[osName].table(codex, new Date(Date.now() + 60_000)) }) })
  return { home, dir, arch, off, bundle: path.join(dir, 'ca', 'combined-codex.pem'), caFp: () => certBlocks(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp }
}

for (const osName of Object.keys(OS)) {
  test(`${osName}: off keeps combined-codex.pem for a codex that started after on — without the asight CA, its pid named — and removes it once that codex is gone`, async () => {
    const s = await codexHome(osName)
    await installCollector({ home: s.home, env: { HOME: s.home }, ids: ['codex'], osName, arch: s.arch, harnesses: HARNESSES, freePort: async () => 47011, scan: async () => [], roots })
    assert.ok(readManifest(s.dir).liveness.codex.signature, 'on wrote a signature for this OS: the form table, folded')
    const caFp = s.caFp()
    const r = await s.off(OS[osName].codex)
    assert.ok(fs.existsSync(s.bundle), `the bundle a running codex re-reads at its next connection is still there (removed: ${r.removed.map((p) => path.basename(p)).join(', ')})`)
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), [['combined-codex.pem', [4242], false]], 'kept, and the codex that may hold it is named — its node launcher is not codex')
    const left = certBlocks(fs.readFileSync(s.bundle, 'utf8'))
    assert.ok(left.length > 0 && !left.some((c) => c.fp === caFp), 'the same bundle without the asight CA')
    assert.deepEqual([r.left, r.still_trusting.map((p) => [p.pid, p.harness, p.until])], [[], [[4242, 'codex', 'next-connection']]], 'nothing left undone; the receipt says until when it trusts asight')
    const again = await s.off(null)
    assert.deepEqual([fs.existsSync(s.bundle), again.kept_bundles, again.left], [false, [], []], 'the codex is gone: the next off removes the bundle')
  })

  test(`${osName}: a snapshot with no signature (an older asight's on) is not known — the bundle kept without the CA, an item left, step 5 says it cannot tell — and the next on fills the signature in`, async () => {
    const s = await codexHome(osName)
    const sys = fakeSystem()
    const on = () => turnOn({ home: s.home, env: { HOME: s.home }, ids: ['codex'], osName, arch: s.arch, harnesses: HARNESSES, freePort: async () => 47011, roots, confirm: async () => true, unit: null, autostart: false, request: sys.daemon.request, socketPath: path.join(s.home, 'collector.sock'), sleep: async () => {} })
    assert.equal((await on()).exit, 0)
    const m = readManifest(s.dir)
    const folded = m.liveness.codex.signature
    m.liveness.codex.signature = null // what an `on` on this OS wrote before the form tables were folded into it
    saveManifest(s.dir, m)
    const r = await s.off(OS[osName].codex)
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.unjudged, /no process signature for codex/.test(k.error)]), [['combined-codex.pem', true, true]], 'not known is not "nobody": kept')
    assert.ok(!certBlocks(fs.readFileSync(s.bundle, 'utf8')).some((c) => c.fp === s.caFp()), 'without the asight CA')
    assert.deepEqual([r.left.map((l) => path.basename(l.path)), r.trust_unknown, r.still_trusting], [['combined-codex.pem'], ['codex'], []], 'an item left (exit 1); who still trusts asight is said to be unknown, not none')
    assert.equal((await on()).exit, 0)
    assert.deepEqual(readManifest(s.dir).liveness.codex.signature, folded, 'the next on records the signature it can now fold')
    const judged = await s.off(OS[osName].codex)
    assert.deepEqual([judged.kept_bundles.map((k) => k.pids), judged.left, judged.trust_unknown], [[[4242]], [], []], 'and off judges by it again')
  })
}

test('darwin: an extra trust file is held by a Claude Code process started after on, whose environment macOS never shows — kept without the CA, its pid named, not "not known" (4.6 「判活快照」)', async () => {
  const home = tmpDir('asight-liveness-os-')
  const corp = createCa({ commonName: 'liveness-os relay CA' })
  fs.writeFileSync(path.join(home, 'relay-ca.pem'), corp.certPem)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "model": "x"\n}\n')
  const env = { HOME: home, NODE_EXTRA_CA_CERTS: path.join(home, 'relay-ca.pem') } // the user's own CA: Claude Code gets an extra-cc.pem
  await installCollector({ home, env, ids: ['claude-code'], osName: 'darwin', arch: await loadArch('darwin'), harnesses: HARNESSES, freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector'), extra = path.join(dir, 'ca', 'extra-cc.pem')
  const at = new Date(Date.now() + 60_000), claude = `${home}/.local/share/claude/versions/2.1.296`
  const table = darwinTools([{ pid: 5151, at, exe: claude, cmdline: 'claude' }, { pid: 5152, ppid: 5151, at, exe: '/bin/zsh', cmdline: '/bin/zsh -c npm test' }, { pid: 5160, at, exe: '/bin/zsh', cmdline: '-zsh' }]).run
  const r = await undoHarnesses({ dir, home, manifest: readManifest(dir), ids: ['claude-code'], roots, procs: () => listProcs({ uid: 501, platform: 'darwin', exec: table }) })
  assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), [['extra-cc.pem', [5151, 5152], false]], 'Claude Code and the shell it started may hold it; a shell it did not start does not')
  assert.deepEqual([fs.existsSync(extra), r.left], [true, []], 'kept, nothing left undone (exit 0)')
})
