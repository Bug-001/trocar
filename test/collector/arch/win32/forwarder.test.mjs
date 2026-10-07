// forwarder.test.mjs — the own kernel: where it comes from, how it is checked, how it runs (RFC 4.8 §3 · §4 · §8; acceptance W27 W28 W55 W74).
// Everything runs against a temp directory standing in for the platform package, a fake exe whose sha256 is in a test copy of the pin, and (below) a fake kernel process. No Windows, no network: a recorder
// refuses and lists every connection, name lookup and fetch the paths try (W27 ⑦).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { recordNetwork, nonLoopback } from './fixtures/no-network.mjs'
import { locateKernel, ensureBinary, verifyCopy, hashFile, loadPin, mainPackage, reinstallCommands, sacState, sacBlocks, createForwarder, BACKOFF_MS, KERNEL_EXE, KERNEL_LICENSE, KERNEL_SOURCE } from '../../../../src/collector/arch/win32/forwarder.mjs'
import { buildForwarderConfig } from '../../../../src/netenv/mihomo/rules.mjs'
import { createController } from '../../../../src/netenv/mihomo/controller.mjs'
import { CC_GROUP, CODEX_GROUP, forwarder as ruleInputs } from '../../../netenv/fixtures/rules/inputs.mjs'

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

// ---- the kernel's life (W28 W55 W74): a fake kernel (a node script with mihomo's command line) as a REAL child process, and the product's own controller client --------------------------------------------------

const FAKE = path.join(HERE, 'fixtures', 'fake-mihomo.mjs')
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const isFree = (port) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))) })
const holdPort = (t, port) => new Promise((res) => { const s = net.createServer(); s.listen(port, '127.0.0.1', () => { t.after(() => s.close()); res() }) })
const FORMS = [{ f: 'claude-code.cli', on: true }, { f: 'claude-code.vscode', on: true }, { f: 'codex.app', on: true }]
const logOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** The collector directory, the copy of the kernel in it, free ports, a spawn that starts the fake as a real child (and kills every one at the end), and the recorder. `fake` is fake-mihomo's knobs. */
async function kernelWorld(t, { fake = {}, groups = [CC_GROUP, CODEX_GROUP], ...over } = {}) {
  const root = tmpDir('asight-fwd-')
  const dir = path.join(root, 'collector')
  const bin = path.join(dir, 'kernel', KERNEL_EXE)
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, EXE)
  const ports = { engine: await freePort(), controller: await freePort(), [CC_GROUP.g]: await freePort(), [CODEX_GROUP.g]: await freePort() }
  const log = path.join(root, 'fake.log')
  const spawned = []
  const spawn = (b, args, opts) => {
    spawned.push({ bin: b, args, opts })
    const c = nodeSpawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...process.env, ASIGHT_FAKE_MIHOMO: '1', FAKE_MIHOMO: JSON.stringify({ log, ...fake }) } })
    t.after(() => { try { process.kill(c.pid) } catch { /* gone */ } })
    return c
  }
  const events = { failures: [], states: [], failure: (r) => events.failures.push(r), state: (r) => events.states.push(r) }
  const hashed = []
  const verify = () => verifyCopy({ dir: path.dirname(bin), pin: world(t).pin, arch: 'x64', hash: async (f) => { hashed.push(f); return hashFile(f) } })
  const secret = '0123456789abcdef0123456789abcdef'
  const build = (controller, set = groups) => buildForwarderConfig(ruleInputs({ groups: set.map((g) => ({ ...g, port: ports[g.g] })), enginePort: ports.engine, controller }))
  const fwd = createForwarder({ dir, bin, controller: { port: ports.controller, secret }, spawn, events, isFree, verifyCopy: verify, pollMs: 10, startTimeoutMs: 1500, ...over })
  t.after(() => fwd.stopNow())
  return { fwd, dir, bin, ports, log, spawned, events, hashed, build, secret, root, P: { config: path.join(dir, 'forwarder', 'config.json'), lock: path.join(dir, 'forwarder.lock') } }
}

test('W28 start: the kernel is spawned detached on the copy in kernel\\ with its home and config, the config is 0600 and is the generator\'s text, forwarder.lock names pid, start time, endpoint and config, and the read-back says on for every form', async () => {
  const k = await kernelWorld(test, {})
  const r = await k.fwd.start({ build: k.build, forms: FORMS })
  assert.equal(r.ok, true)
  assert.deepEqual(Object.values(r.readBack.forms).map((x) => x.state), ['on', 'on', 'on'])
  assert.equal(k.spawned.length, 1)
  assert.deepEqual([k.spawned[0].bin, k.spawned[0].args], [k.bin, ['-d', path.join(k.dir, 'forwarder', 'home'), '-f', k.P.config]])
  assert.deepEqual([k.spawned[0].opts.detached, k.spawned[0].opts.stdio, k.spawned[0].opts.windowsHide], [true, 'ignore', true])
  assert.equal(fs.readFileSync(k.P.config, 'utf8'), k.build({ port: k.ports.controller, secret: k.secret }))
  assert.equal(fs.statSync(k.P.config).mode & 0o777, 0o600, 'it holds the controller secret and the tokens')
  assert.deepEqual(JSON.parse(fs.readFileSync(k.P.lock, 'utf8')), { pid: r.pid, startedAt: null, endpoint: `tcp:127.0.0.1:${k.ports.controller}`, config: k.P.config })
  assert.deepEqual(k.events.states.map((e) => [e.event, e.pid, e.adopted]), [['forwarder-start', r.pid, false]])
  assert.deepEqual(k.events.failures, [])
  const asked = logOf(k.log).map((q) => q.path)
  for (const f of ['claude-code.cli', 'claude-code.vscode', 'codex.app']) assert.ok(asked.some((q) => q.startsWith(`/group/asight-fb-${f}/delay?url=`)), `the ${f} probe is asked for now, not left to the interval (the first connection would race it)`)
})

test('W27 ④ the copy is checked before the spawn: one hash of kernel\\ per start; a changed copy is not spawned (of copy), nor a deleted one (file-missing); the failure is recorded, the status says why', async () => {
  const k = await kernelWorld(test, {})
  assert.equal((await k.fwd.start({ build: k.build, forms: FORMS })).ok, true)
  assert.deepEqual(k.hashed, [k.bin], 'one hash of the one copy')
  await k.fwd.stopNow()
  fs.writeFileSync(k.bin, flip(EXE))
  const bad = await k.fwd.start({ build: k.build, forms: FORMS })
  assert.deepEqual([bad.ok, bad.code, bad.of], [false, 'forwarder-digest-mismatch', 'copy'])
  assert.equal(k.spawned.length, 1, 'not started again, and not repaired from the package')
  fs.rmSync(k.bin)
  const gone = await k.fwd.start({ build: k.build, forms: FORMS })
  assert.deepEqual([gone.ok, gone.code, gone.reason], [false, 'forwarder-binary-missing', 'file-missing'])
  assert.equal(k.spawned.length, 1)
  assert.deepEqual(k.events.failures.map((f) => [f.where, f.code]), [['forwarder', 'forwarder-digest-mismatch'], ['forwarder', 'forwarder-binary-missing']])
  assert.equal(k.fwd.state().phase, 'stopped')
})

test('W74 a kernel that does not come up says why: Smart App Control when it is on (or evaluating), else what happened (exit code, no answer, no such file); a taken port is the port\'s, never Smart App Control\'s', async (t) => {
  const crash = await kernelWorld(t, { fake: { crash: true, exitCode: 3 }, sacOn: async () => true })
  const a = await crash.fwd.start({ build: crash.build, forms: FORMS })
  assert.deepEqual([a.ok, a.code, a.reason, a.exit], [false, 'forwarder-start-failed', 'smart-app-control', 3])
  assert.match(a.because, /exited \(code 3\)/, 'what happened is kept beside the reason')
  assert.deepEqual(crash.events.failures.map((f) => [f.where, f.code, f.reason]), [['forwarder', 'forwarder-start-failed', 'smart-app-control']])
  const plain = await kernelWorld(t, { fake: { crash: true, exitCode: 3 } })
  const b = await plain.fwd.start({ build: plain.build, forms: FORMS })
  assert.deepEqual([b.code, b.exit], ['forwarder-start-failed', 3])
  assert.match(b.reason, /exited \(code 3\) before it answered/)
  const mute = await kernelWorld(t, { fake: { noController: true }, startTimeoutMs: 300 })
  assert.match((await mute.fwd.start({ build: mute.build, forms: FORMS })).reason, /did not answer within 300 ms/)
  const nobody = await kernelWorld(t, { spawn: () => { throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }) } })
  assert.deepEqual([(await nobody.fwd.start({ build: nobody.build, forms: FORMS })).reason], ['UNKNOWN'])
  const taken = await kernelWorld(t, { sacOn: async () => true })
  await holdPort(t, taken.ports[CODEX_GROUP.g])
  const c = await taken.fwd.start({ build: taken.build, forms: FORMS })
  assert.deepEqual([c.ok, c.code, c.reason, c.port], [false, 'forwarder-start-failed', 'port-taken', taken.ports[CODEX_GROUP.g]])
  assert.equal(taken.spawned.length, 0, 'nothing was spawned onto a port somebody holds')
  assert.equal(taken.fwd.state().phase, 'stopped')
})

test('W12 W55 reload: the new text goes to the kernel by PUT /configs?force=true and to the config file; the read-back follows the group (off has no fallback group); a port the new text opens that is taken, or a kernel that refuses, leaves the old config running', async (t) => {
  const k = await kernelWorld(t, {})
  await k.fwd.start({ build: k.build, forms: FORMS })
  const codexOff = FORMS.map((f) => (f.f === 'codex.app' ? { ...f, on: false } : f))
  const r = await k.fwd.reload({ build: (c) => k.build(c, [CC_GROUP, { ...CODEX_GROUP, on: false }]), forms: codexOff })
  assert.equal(r.ok, true)
  assert.deepEqual(r.readBack.forms, { 'claude-code.cli': { state: 'on', now: 'asight-in-claude-code.cli' }, 'claude-code.vscode': { state: 'on', now: 'asight-in-claude-code.vscode' }, 'codex.app': { state: 'off' } })
  const puts = logOf(k.log).filter((q) => q.method === 'PUT')
  assert.deepEqual(puts.map((q) => q.path), ['/configs?force=true'])
  assert.equal(JSON.parse(fs.readFileSync(k.P.config, 'utf8')).listeners.length, 2, 'both listeners stay (a form that is off only forwards)')
  assert.deepEqual(r.readBack.forms['claude-code.cli'], (await k.fwd.check()).forms['claude-code.cli'], 'check() reads the same')
  // the read-back disagreeing with what was asked is not ok: the caller writes no entry then
  const wrong = await k.fwd.reload({ build: (c) => k.build(c, [CC_GROUP, { ...CODEX_GROUP, on: false }]), forms: FORMS })
  assert.deepEqual([wrong.ok, wrong.readBack.forms['codex.app'].state], [false, 'missing'], 'asked for on, and the kernel has no such group')
  const before = fs.readFileSync(k.P.config, 'utf8')
  const extra = await freePort()
  await holdPort(t, extra)
  const blocked = await k.fwd.reload({ build: (c) => buildForwarderConfig(ruleInputs({ groups: [CC_GROUP, { ...CODEX_GROUP, port: extra }], enginePort: k.ports.engine, controller: c })), forms: FORMS })
  assert.deepEqual([blocked.ok, blocked.reason, blocked.port], [false, 'port-taken', extra])
  assert.equal(fs.readFileSync(k.P.config, 'utf8'), before, 'a refused reload changes nothing on disk')
  const refusing = await kernelWorld(t, { fake: { refuseReload: true } })
  await refusing.fwd.start({ build: refusing.build, forms: FORMS })
  assert.deepEqual((await refusing.fwd.reload({ build: refusing.build, forms: FORMS })).error, { status: 400, text: '' }, 'the status, not the core\'s words (they may quote the user\'s config)')
})

test('W28 the read-back is what the kernel says: the engine down is fallback (not on, not an error), a group it does not know is missing, an answer it does not give plainly is unknown', async (t) => {
  const down = await kernelWorld(t, { fake: { engineDown: true } })
  const r = await down.fwd.start({ build: down.build, forms: FORMS })
  assert.equal(r.ok, false, 'asked for on, and the engine is not answering')
  assert.deepEqual(r.readBack.forms['claude-code.cli'], { state: 'fallback', now: 'asight-re-claude-code.settings' })
  const k = await kernelWorld(t, {})
  await k.fwd.start({ build: k.build, forms: FORMS })
  const ask = await k.fwd.check()
  assert.equal(ask.ok, true)
  const unknownForm = await k.fwd.reload({ build: k.build, forms: [{ f: 'nobody.cli', on: true }] })
  assert.deepEqual(unknownForm.readBack.forms['nobody.cli'], { state: 'missing' })
  const odd = await kernelWorld(t, { makeController: ({ port, secret }) => { const real = createController({ endpoint: `tcp:127.0.0.1:${port}`, secret, own: true }); return { ...real, get: async (q) => (q === '/proxies/asight-fb-codex.app' ? { status: 500, ok: false, json: null, text: '' } : q === '/proxies/asight-fb-claude-code.cli' ? { status: 200, ok: true, json: { now: 'somebody-else' }, text: '' } : real.get(q)) } } })
  await odd.fwd.start({ build: odd.build, forms: [] })
  assert.deepEqual((await odd.fwd.reload({ build: odd.build, forms: FORMS })).readBack.forms, { 'claude-code.cli': { state: 'unknown', reason: 'unexpected-now' }, 'claude-code.vscode': { state: 'on', now: 'asight-in-claude-code.vscode' }, 'codex.app': { state: 'unknown', reason: 'status-500' } })
  assert.deepEqual(await createForwarder({ dir: k.dir, bin: k.bin, controller: { port: 1, secret: 'x' }, isFree }).check(), { ok: false, forms: {}, reason: 'not-running' })
})

// ---- W28 supervision: a fake clock, fake children and a fake controller, so the backoff is read off the clock and not waited for --------------------------------------------------------------------------------------

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)) }
/** A clock that only moves when the test says: timers fire in order, and the promises they start are let to finish before the next one. */
function fakeClock() {
  let at = 0
  let seq = 0
  const timers = []
  return {
    now: () => at,
    setTimer: (fn, ms) => { const h = { fn, at: at + ms, id: ++seq, unref() {} }; timers.push(h); return h },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    pending: () => timers.map((h) => h.at - at),
    async advance(ms) {
      const end = at + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        if (!timers.length || timers[0].at > end) break
        const h = timers.shift(); at = h.at; h.fn(); await settle()
      }
      at = end; await settle()
    },
  }
}
async function fakeKernel(t, over = {}) {
  const clock = fakeClock()
  const root = tmpDir('asight-fwd-')
  const dir = path.join(root, 'collector')
  const children = []
  const alive = new Set()
  const spawn = () => { const c = new EventEmitter(); c.pid = 1000 + children.length; c.unref = () => {}; c.kill = () => { alive.delete(c.pid) }; children.push(c); alive.add(c.pid); return c }
  const die = (c, code = 1) => { alive.delete(c.pid); c.emit('exit', code, null) } // the kernel exits by itself
  const events = { failures: [], states: [], failure: (r) => events.failures.push(r), state: (r) => events.states.push(r) }
  const verified = []
  const verifyCopy = async () => { verified.push(clock.now()); return (over.verify && over.verify()) || { ok: true } }
  const makeController = () => ({ get: async (q) => (q === '/version' ? { ok: true, status: 200, json: { version: 'fake' } } : { ok: true, status: 200, json: { now: 'asight-in-claude-code.cli' } }), put: async () => ({ ok: true, status: 204 }) })
  const secret = '0123456789abcdef0123456789abcdef'
  const build = () => buildForwarderConfig(ruleInputs({ groups: [{ ...CC_GROUP, port: 18801 }], enginePort: 18790, controller: { port: 18899, secret } }))
  const fwd = createForwarder({ dir, bin: path.join(dir, 'kernel', KERNEL_EXE), controller: { port: 18899, secret }, spawn, makeController, events, isFree: async () => true, verifyCopy, isAlive: (pid) => alive.has(pid), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, pollMs: 1, ...over.fwd })
  const forms = [{ f: 'claude-code.cli', on: true }]
  return { fwd, clock, children, alive, die, events, verified, build, forms, dir, start: () => fwd.start({ build, forms }) }
}
const restarts = (k) => k.events.failures.filter((f) => f.code === 'forwarder-restart').map((f) => f.delay_ms)

test('W28 a kernel that exits again and again: respawned after 1, 2, 4, 8, 16, then 30 s (the cap), the fifth failure in a row is forwarder-down (once, where netenv), the tries go on, and every spawn is preceded by a digest check (W27 ④)', async (t) => {
  const k = await fakeKernel(t)
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 4000, 8000, 16000, 30000])
  assert.equal((await k.start()).ok, true)
  assert.equal(k.children.length, 1)
  const waited = []
  for (let n = 1; n <= 7; n++) {
    k.die(k.children.at(-1))
    await settle()
    const delay = k.clock.pending()[0]
    waited.push(delay)
    await k.clock.advance(delay - 1)
    assert.equal(k.children.length, n, `not before ${delay} ms`)
    await k.clock.advance(1)
    assert.equal(k.children.length, n + 1, `at ${delay} ms`)
  }
  assert.deepEqual(waited, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.deepEqual(restarts(k), waited, 'every try is a forwarder-restart record with its delay')
  assert.deepEqual(k.events.failures.filter((f) => f.code === 'forwarder-down').map((f) => [f.where, f.attempts]), [['netenv', 5]], 'the fifth, once')
  assert.equal(k.verified.length, k.children.length, 'the copy is checked before the first start and before each re-spawn, no more and no fewer')
  assert.deepEqual([k.fwd.state().down, k.fwd.state().streak], [true, 7])
  assert.deepEqual(k.events.states.filter((e) => e.event === 'forwarder-start').length, 8)
})

test('W28 a kernel that stayed up for 30 s starts the count again; one that did not keeps counting through its short lives', async (t) => {
  const k = await fakeKernel(t)
  await k.start()
  k.die(k.children[0]); await settle()
  await k.clock.advance(1000)
  assert.equal(k.fwd.state().streak, 1)
  await k.clock.advance(29_999)
  k.die(k.children[1]); await settle()
  assert.deepEqual([k.fwd.state().streak, k.clock.pending()[0]], [2, 2000], 'it lived 29.999 s: still the second failure in a row')
  await k.clock.advance(2000)
  await k.clock.advance(30_000)
  assert.equal(k.fwd.state().streak, 0, 'and now it has stayed up')
  k.die(k.children[2]); await settle()
  assert.deepEqual([k.fwd.state().streak, k.clock.pending()[0], k.fwd.state().down], [1, 1000, false])
})

test('W28 W27 ④ a re-spawn onto a copy that was changed or deleted does not happen: the failure is the digest\'s (of copy) or file-missing, it counts toward the backoff and forwarder-down, and nothing is copied back from the package', async (t) => {
  let bad = null
  const k = await fakeKernel(t, { verify: () => bad })
  await k.start()
  bad = { mismatch: { of: 'copy' } }
  k.die(k.children[0]); await settle()
  for (let n = 0; n < 4; n++) await k.clock.advance(k.clock.pending()[0])
  assert.equal(k.children.length, 1, 'never spawned')
  assert.deepEqual(k.events.failures.filter((f) => f.code === 'forwarder-digest-mismatch').map((f) => f.of), ['copy', 'copy', 'copy', 'copy'])
  assert.deepEqual(k.events.failures.filter((f) => f.code === 'forwarder-down').map((f) => f.attempts), [5])
  bad = { missing: { reason: 'file-missing' } }
  await k.clock.advance(k.clock.pending()[0])
  assert.deepEqual(k.events.failures.filter((f) => f.code === 'forwarder-binary-missing').map((f) => f.reason), ['file-missing'], 'a deleted copy is its own failure')
  bad = null // `asight on` put the pinned exe back
  await k.clock.advance(k.clock.pending()[0])
  assert.equal(k.children.length, 2, 'and the next try starts it')
  assert.equal(k.fwd.state().phase, 'running')
})

test('W28 stopNow: the kernel is stopped, the lock is gone, and no re-spawn follows however long the clock runs; an exit that arrives after it is not a failure', async (t) => {
  const k = await fakeKernel(t)
  await k.start()
  assert.ok(fs.existsSync(path.join(k.dir, 'forwarder.lock')))
  assert.deepEqual(await k.fwd.stopNow(), { stopped: true })
  assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')))
  k.children[0].emit('exit', null, 'SIGTERM')
  await k.clock.advance(300_000)
  assert.deepEqual([k.children.length, k.clock.pending(), restarts(k), k.fwd.state().phase], [1, [], [], 'stopped'])
  const k2 = await fakeKernel(t)
  await k2.start()
  k2.die(k2.children[0]); await settle()
  assert.equal(k2.clock.pending().length, 1, 'a re-spawn is waiting')
  await k2.fwd.stopNow()
  await k2.clock.advance(300_000)
  assert.equal(k2.children.length, 1, 'stopNow also cancels the one that was waiting')
})

test('W28 a real child that is killed from outside is brought back by the same path: a new pid, the lock rewritten, the read-back on again', async (t) => {
  const k = await kernelWorld(t, { backoffMs: [30], stableMs: 60_000 })
  const first = await k.fwd.start({ build: k.build, forms: FORMS })
  process.kill(first.pid, 'SIGKILL')
  for (let i = 0; i < 100 && k.spawned.length < 2; i++) await new Promise((r) => setTimeout(r, 30))
  for (let i = 0; i < 100 && k.fwd.state().phase !== 'running'; i++) await new Promise((r) => setTimeout(r, 30))
  const s = k.fwd.state()
  assert.deepEqual([k.spawned.length, s.phase, s.pid !== first.pid], [2, 'running', true])
  assert.equal(JSON.parse(fs.readFileSync(k.P.lock, 'utf8')).pid, s.pid)
  assert.equal((await k.fwd.check()).ok, true)
  assert.deepEqual(k.events.failures.map((f) => [f.code, f.delay_ms]), [['forwarder-restart', 30]])
})
