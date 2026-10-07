// forwarder.test.mjs — the own kernel: where it comes from, how it is checked, how it runs (RFC 4.8 §3 · §4 · §8; acceptance W27 W28 W55 W74).
// Everything runs against a temp directory standing in for the platform package, a fake exe whose sha256 is in a test copy of the pin, and (below) a fake kernel process. No Windows, no network: a recorder
// refuses and lists every connection, name lookup and fetch the paths try (W27 ⑦).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { recordNetwork, nonLoopback } from './fixtures/no-network.mjs'
import { locateKernel, ensureBinary, verifyCopy, hashFile, loadPin, mainPackage, reinstallCommands, sacState, sacBlocks, KERNEL_EXE, KERNEL_LICENSE, KERNEL_SOURCE } from '../../../../src/collector/arch/win32/forwarder.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORWARDER_SRC = path.join(HERE, '..', '..', '..', '..', 'src', 'collector', 'arch', 'win32', 'forwarder.mjs')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const MAIN = { name: 'asight', version: '0.0.0' }
const EXE = Buffer.from('MZ fake asight-forwarder.exe, sixty kilobytes of nothing '.repeat(8))
const LICENSE = Buffer.from('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n')
const SOURCE = Buffer.from('https://github.com/MetaCubeX/mihomo/tree/v1.19.32\n')

/** A test copy of the pin whose exe digest is that of EXE, and a platform package directory holding it (with the licence and source files). */
function world(t, { exe = EXE, pinned = true } = {}) {
  const root = tmpDir('asight-kernel-')
  const pkg = path.join(root, 'node_modules', 'asight-kernel-win32-x64')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, KERNEL_EXE), exe)
  fs.writeFileSync(path.join(pkg, KERNEL_LICENSE), LICENSE)
  fs.writeFileSync(path.join(pkg, KERNEL_SOURCE), SOURCE)
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"asight-kernel-win32-x64"}\n')
  const pin = JSON.parse(JSON.stringify(loadPin()))
  pin.assets.x64.exe = pinned ? { name: KERNEL_EXE, size: EXE.length, sha256: sha(EXE) } : { name: KERNEL_EXE, size: null, sha256: null }
  const dir = path.join(root, '.asight', 'collector', 'kernel')
  const resolvePackage = (name) => (name === 'asight-kernel-win32-x64' ? pkg : null)
  return { root, pkg, pin, dir, resolvePackage, arch: 'x64', main: MAIN }
}
const tree = (dir) => { // every file under dir with its bytes' digest, for "byte-identical afterwards"
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(fs.readFileSync(p)) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const flip = (buf) => { const b = Buffer.from(buf); b[10] ^= 0xff; return b }
const COMMANDS_X64 = { npm: 'npm install --global asight@0.0.0 --include=optional', release: 'npm install --global asight-0.0.0.tgz asight-kernel-win32-x64-0.0.0.tgz' }

// ---- W27: the kernel's source, no network ----------------------------------------------------------------------------------------------------------

test('W27 ① the package is found and verified: the copy lands in kernel\\ with the licence and the source address beside it, its digest is the pin\'s; a second run does not rewrite it (mtime unchanged)', async (t) => {
  const w = world(t)
  const r = await ensureBinary(w)
  assert.deepEqual([r.path, r.sha256, r.copied], [path.join(w.dir, KERNEL_EXE), sha(EXE), true])
  assert.equal(sha(fs.readFileSync(r.path)), w.pin.assets.x64.exe.sha256, 'the copy has the pin\'s digest')
  assert.deepEqual(fs.readdirSync(w.dir).sort(), [KERNEL_EXE, KERNEL_LICENSE, KERNEL_SOURCE].sort(), 'the exe, the licence and the source address, and no temp file')
  assert.deepEqual([fs.readFileSync(path.join(w.dir, KERNEL_LICENSE)), fs.readFileSync(path.join(w.dir, KERNEL_SOURCE))], [LICENSE, SOURCE])
  const old = new Date('2020-01-01T00:00:00Z')
  fs.utimesSync(r.path, old, old)
  const again = await ensureBinary(w)
  assert.deepEqual([again.copied, again.sha256], [false, sha(EXE)])
  assert.equal(fs.statSync(r.path).mtimeMs, old.getTime(), 'a target that is there with the right digest is not rewritten')
  const located = await locateKernel(w)
  assert.deepEqual([located.found.packageDir, located.found.exe, located.found.sha256, located.found.size], [w.pkg, path.join(w.pkg, KERNEL_EXE), sha(EXE), EXE.length])
})

test('W27 ① a copy that was changed is replaced by the one in the package (that is `on` repairing it); the package is not touched', async (t) => {
  const w = world(t)
  await ensureBinary(w)
  fs.writeFileSync(path.join(w.dir, KERNEL_EXE), flip(EXE))
  const before = tree(w.pkg)
  const r = await ensureBinary(w)
  assert.equal(r.copied, true)
  assert.equal(sha(fs.readFileSync(r.path)), sha(EXE))
  assert.deepEqual(tree(w.pkg), before)
})

test('W27 ② no package, a package with no exe, an architecture the pin does not have, a pin with no exe digest: forwarder-binary-missing with the reason, and the reinstall commands (except for an architecture nobody builds)', async (t) => {
  const w = world(t)
  const gone = await locateKernel({ ...w, resolvePackage: () => null })
  assert.deepEqual(gone, { missing: { reason: 'package-not-installed', commands: COMMANDS_X64 } })
  fs.rmSync(path.join(w.pkg, KERNEL_EXE))
  assert.deepEqual(await locateKernel(w), { missing: { reason: 'package-not-installed', commands: COMMANDS_X64 } }, 'a package that lost its exe is not installed')
  assert.deepEqual(await locateKernel({ ...w, arch: 'ia32' }), { missing: { reason: 'unsupported-arch', commands: null } })
  const unpinned = world(t, { pinned: false })
  assert.deepEqual(await locateKernel(unpinned), { missing: { reason: 'not-pinned', commands: COMMANDS_X64 } })
  for (const bad of [gone, await ensureBinary({ ...w, resolvePackage: () => null }), await ensureBinary(unpinned)]) assert.ok(bad.missing && !fs.existsSync(unpinned.dir), 'nothing was copied')
})

test('W27 ③ one byte changed in the package\'s exe: forwarder-digest-mismatch of the package; kernel\\ has no file, the package directory is byte-identical afterwards', async (t) => {
  const w = world(t, { exe: EXE })
  fs.writeFileSync(path.join(w.pkg, KERNEL_EXE), flip(EXE))
  const before = tree(w.pkg)
  assert.deepEqual(await locateKernel(w), { mismatch: { of: 'package', commands: COMMANDS_X64 } })
  assert.deepEqual(await ensureBinary(w), { mismatch: { of: 'package', commands: COMMANDS_X64 } })
  assert.ok(!fs.existsSync(w.dir) || fs.readdirSync(w.dir).length === 0, 'nothing in kernel\\')
  assert.deepEqual(tree(w.pkg), before, 'the package directory is npm\'s: not touched')
  const sizeOff = world(t)
  sizeOff.pin.assets.x64.exe.size += 1
  assert.ok((await locateKernel(sizeOff)).mismatch, 'the size is compared too, when the pin has one')
})

test('W27 ④ before a start the copy is checked against the pin: right, one byte changed (of copy, not re-copied from the package), deleted (file-missing); a pin with no digest cannot be checked', async (t) => {
  const w = world(t)
  await ensureBinary(w)
  const v = () => verifyCopy({ dir: w.dir, pin: w.pin, arch: 'x64' })
  assert.deepEqual(await v(), { ok: true, sha256: sha(EXE) })
  fs.writeFileSync(path.join(w.dir, KERNEL_EXE), flip(EXE))
  assert.deepEqual(await v(), { mismatch: { of: 'copy' } })
  assert.equal(sha(fs.readFileSync(path.join(w.dir, KERNEL_EXE))), sha(flip(EXE)), 'a changed copy is reported, not repaired')
  fs.rmSync(path.join(w.dir, KERNEL_EXE))
  assert.deepEqual(await v(), { missing: { reason: 'file-missing' } })
  assert.ok(!fs.existsSync(path.join(w.dir, KERNEL_EXE)), 'and not re-copied from the package')
  assert.deepEqual(await verifyCopy({ dir: w.dir, pin: world(t, { pinned: false }).pin, arch: 'x64' }), { missing: { reason: 'not-pinned' } })
  assert.deepEqual(await verifyCopy({ dir: w.dir, pin: w.pin, arch: 'ia32' }), { missing: { reason: 'unsupported-arch' } })
})

test('W27 ⑤ the reinstall commands are the two literals of 4.8 §8 and §10.4, filled with the main package and the platform package, and have no URL in them', () => {
  assert.deepEqual(reinstallCommands({ main: MAIN, platformPackage: 'asight-kernel-win32-x64' }), COMMANDS_X64)
  assert.deepEqual(reinstallCommands({ main: { name: 'asight', version: '1.2.3' }, platformPackage: 'asight-kernel-win32-arm64' }), { npm: 'npm install --global asight@1.2.3 --include=optional', release: 'npm install --global asight-1.2.3.tgz asight-kernel-win32-arm64-1.2.3.tgz' })
  for (const c of Object.values(COMMANDS_X64)) assert.ok(!/https?:|github|\.zip/i.test(c), c)
  assert.deepEqual(mainPackage(), { name: 'asight', version: JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'package.json'), 'utf8')).version }, 'the main package is this one')
})

test('W27 ⑦ no network: every path above (found, copied, missing, mismatch, verified) makes no connection, no name lookup and no fetch; the recorder itself can see one', async (t) => {
  const w = world(t)
  const bad = world(t)
  fs.writeFileSync(path.join(bad.pkg, KERNEL_EXE), flip(EXE))
  const attempts = await recordNetwork(async () => {
    await ensureBinary(w); await ensureBinary(w)
    await locateKernel({ ...w, resolvePackage: () => null }); await locateKernel({ ...w, arch: 'arm64' })
    await locateKernel(bad); await ensureBinary(bad)
    await verifyCopy({ dir: w.dir, pin: w.pin, arch: 'x64' })
    await sacState({ helper: { call: async () => ({ keyExists: true, values: { VerifiedAndReputablePolicyState: { kind: 'REG_DWORD', value: 1 } } }) } })
  })
  assert.deepEqual(nonLoopback(attempts), [])
  assert.deepEqual(attempts, [], 'not even a loopback one: this file does not talk to anything')
  const planted = await recordNetwork(async () => { await fetch('https://example.invalid/kernel.zip').catch(() => {}) })
  assert.deepEqual(nonLoopback(planted).map((a) => a.what), ['fetch'], 'a path that went online would turn this red')
})

/** Scan a module's source (comments and strings kept out of the way is not needed: an import or a call shows as code) for the network modules W27 ⑦ forbids. */
const NETWORK = /(?:from\s+|import\s*\(?\s*|require\(\s*)['"](?:node:)?(?:http|https|http2|dns|dns\/promises|net|tls|dgram)['"]|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/
const withoutComments = (src) => src.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^\n]*$/gm, '$1')
test('W27 ⑦ static: forwarder.mjs imports no network module and calls no fetch; a planted import turns the scan red', () => {
  const src = withoutComments(fs.readFileSync(FORWARDER_SRC, 'utf8'))
  assert.deepEqual(src.match(new RegExp(NETWORK.source, 'g')) || [], [], 'no http, https, http2, dns, net, tls, dgram, fetch in forwarder.mjs')
  for (const planted of ["import https from 'node:https'", "import('node:http')", "const dns = require('dns')", "await fetch('https://x')", "import net from 'node:net'"]) assert.ok(NETWORK.test(planted), planted)
  assert.ok(!NETWORK.test("import { createHash } from 'node:crypto'\nimport nodeFs from 'node:fs'"), 'the scan does not cry wolf at the modules this file does use')
})

test('W27 the pin as shipped: version, the package names, the zip digests the spec pins, the licence digest; the exe digest is still null (needs the operator\'s download, 4.8 §8 [T0]) and then the kernel is not-pinned', async (t) => {
  const pin = loadPin()
  assert.equal(pin.version, 'v1.19.32')
  assert.deepEqual(Object.keys(pin.assets), ['x64', 'arm64'])
  assert.deepEqual([pin.assets.x64.package, pin.assets.arm64.package], ['asight-kernel-win32-x64', 'asight-kernel-win32-arm64'])
  assert.deepEqual([pin.assets.x64.variant, pin.assets.arm64.variant], ['windows-amd64-compatible', 'windows-arm64'])
  assert.deepEqual([pin.assets.x64.sha256, pin.assets.x64.size], ['974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0', 22525067])
  assert.deepEqual([pin.assets.arm64.sha256, pin.assets.arm64.size], ['7a4f6e58af9a120920935f2150cf642d945085fdb3e753314505b334234e1d1e', 20194736])
  assert.equal(pin.assets.x64.exe.name, KERNEL_EXE)
  assert.equal(pin.license, 'GPL-3.0-only')
  assert.equal(pin.licenseFile.sha256, (await hashFile(path.join(HERE, '..', '..', '..', '..', KERNEL_LICENSE))).sha256, 'licenseFile.sha256 is the digest of the committed LICENSE-mihomo.txt')
  assert.match(fs.readFileSync(path.join(HERE, '..', '..', '..', '..', KERNEL_LICENSE), 'utf8'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  for (const arch of ['x64', 'arm64']) {
    const e = pin.assets[arch].exe
    assert.ok(e.sha256 === null || /^[0-9a-f]{64}$/.test(e.sha256), `${arch}: the exe digest is 64 hex digits, or null until the operator runs the pin step`)
    assert.ok(e.sha256 !== null || (await locateKernel({ pin, arch, resolvePackage: () => null })).missing.reason === 'not-pinned', `${arch}: no digest, no start`)
  }
  t.todo('the exe digests are filled by `node scripts/kernel-payload.mjs --pin` (two independent downloads of about 22 MB and 20 MB from github.com), which needs the operator\'s approval')
})

// ---- W74: Smart App Control (4.8 §8) ----------------------------------------------------------------------------------------------------------------

const helperOf = (answer) => ({ call: async (verb, args) => { assert.equal(verb, 'reg-read'); assert.deepEqual(args, { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', names: ['VerifiedAndReputablePolicyState'] }); if (answer instanceof Error) throw answer; return answer } })
const dword = (value) => ({ keyExists: true, values: { VerifiedAndReputablePolicyState: { kind: 'REG_DWORD', value } } })

test('W74 sacState: 0 is off, 1 is on, 2 is evaluation; no key or no value is off (the system has none); anything else, or an unreadable key, says it does not know and why', async () => {
  assert.equal(await sacState({ helper: helperOf(dword(0)) }), 'off')
  assert.equal(await sacState({ helper: helperOf(dword(1)) }), 'on')
  assert.equal(await sacState({ helper: helperOf(dword(2)) }), 'evaluation')
  assert.equal(await sacState({ helper: helperOf({ keyExists: false, values: {} }) }), 'off')
  assert.equal(await sacState({ helper: helperOf({ keyExists: true, values: {} }) }), 'off')
  assert.deepEqual(await sacState({ helper: helperOf(dword(7)) }), { unknown: { reason: 'unparseable', detail: '7' } })
  assert.deepEqual(await sacState({ helper: helperOf(Object.assign(new Error('late'), { code: 'helper-timeout' })) }), { unknown: { reason: 'timeout', detail: 'helper-timeout' } })
  assert.deepEqual(await sacState({ helper: helperOf(Object.assign(new Error('down'), { code: 'helper-down' })) }), { unknown: { reason: 'denied', detail: 'helper-down' } })
})

test('W74 only a state that says so blames Smart App Control: on and evaluation do, off and an unknown one do not', () => {
  assert.deepEqual(['off', 'on', 'evaluation', { unknown: { reason: 'denied' } }].map(sacBlocks), [false, true, true, false])
})
