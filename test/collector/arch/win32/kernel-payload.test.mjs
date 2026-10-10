// kernel-payload.test.mjs — the kernel's packages: what scripts/kernel-payload.mjs builds, and that nothing else downloads (RFC 4.5 §A, 4.8 §8; acceptance W75).
// The build tool takes injected `download`, `exec` and `fs`: no test here goes online. The zip is a fake whose sha256 is in a test copy of the pin; `tar -xf` is replaced by a function that checks the zip it was
// handed is the downloaded one and writes the fake exe; `npm pack` is the real npm, offline, in a scratch HOME and cache. The pin as shipped (the zip digests, the licence digest, the exe digest still null until the
// operator's `--pin` run) is held by test/collector/arch/win32/forwarder.test.mjs::"W27 the pin as shipped".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { buildPayload, pinExes, platformManifest, mainManifestForPublish, PayloadError, LICENSE_FILE, EXE, LICENSE, SOURCE } from '../../../../scripts/kernel-payload.mjs'
import { loadPin } from '../../../../src/collector/arch/win32/forwarder.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const flip = (buf) => { const b = Buffer.from(buf); b[10] ^= 0xff; return b }
const MAIN = { name: 'asight', version: '1.2.3', private: true, files: ['src/', 'bin/', 'README.md'] }
const FAKE = { x64: { zip: Buffer.from('PK fake zip x64 '.repeat(40)), exe: Buffer.from('MZ fake x64 kernel '.repeat(60)) }, arm64: { zip: Buffer.from('PK fake zip arm64 '.repeat(40)), exe: Buffer.from('MZ fake arm64 kernel '.repeat(60)) } }
// the real npm gets a scratch HOME, cache and TMPDIR of its own (it writes a compile cache into TMPDIR, which the run's leak check would count against this file), and no network
const npmEnvIn = (root) => ({ PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root, npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false', npm_config_offline: 'true', npm_config_fund: 'false', npm_config_audit: 'false' })
let npmOk = true
try { execFileSync('npm', ['--version'], { stdio: 'ignore', env: npmEnvIn(tmpDir('asight-npm-')) }) } catch { npmOk = false }
const npmGate = npmOk ? {} : { skip: 'npm is not on PATH: the tarball half of W75 needs the real `npm pack`' }

/** A test copy of the pin that names the fake zips and exes, the url → bytes map, and the injected tools. `tarGives(arch, n)` is what the n-th extraction of that arch writes. */
function world(t, { tarGives = (arch) => FAKE[arch].exe, zips = {}, pinOver = (p) => p } = {}) {
  const pin = JSON.parse(JSON.stringify(loadPin()))
  for (const arch of ['x64', 'arm64']) {
    pin.assets[arch].sha256 = sha(FAKE[arch].zip); pin.assets[arch].size = FAKE[arch].zip.length
    pin.assets[arch].exe = { name: EXE, size: FAKE[arch].exe.length, sha256: sha(FAKE[arch].exe) }
  }
  pinOver(pin)
  const root = tmpDir('asight-payload-')
  const calls = { download: [], tar: [], npm: [] }
  const counts = { x64: 0, arm64: 0 }
  const body = { [pin.assets.x64.url]: FAKE.x64.zip, [pin.assets.arm64.url]: FAKE.arm64.zip, ...zips }
  const download = async (url) => { calls.download.push(url); return body[url] }
  const scratch = path.join(root, 'npm')
  fs.mkdirSync(path.join(scratch, 'home'), { recursive: true })
  const npmEnv = npmEnvIn(path.join(scratch, 'home'))
  const exec = async (cmd, args) => {
    if (cmd === 'tar') {
      calls.tar.push(args)
      const arch = args[1].includes('arm64') ? 'arm64' : 'x64'
      assert.deepEqual(fs.readFileSync(args[1]), body[pin.assets[arch].url], 'tar is handed the zip that was downloaded')
      fs.writeFileSync(path.join(args[3], `mihomo-${arch}.exe`), tarGives(arch, counts[arch]++))
      return { stdout: '' }
    }
    assert.equal(cmd, 'npm')
    calls.npm.push(args)
    return new Promise((res, rej) => execFile('npm', args, { cwd: scratch, env: npmEnv }, (e, stdout) => (e ? rej(e) : res({ stdout }))))
  }
  return { pin, root, out: path.join(root, 'dist', 'kernel'), workRoot: path.join(root, 'work'), calls, download, exec, run: (over = {}) => buildPayload({ pin, main: MAIN, out: path.join(root, 'dist', 'kernel'), download, exec, workRoot: path.join(root, 'work'), ...over }) }
}
const mkWork = (w) => fs.mkdirSync(w.workRoot, { recursive: true })
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null)

test('W75 the platform packages: names are the pin\'s, os and cpu limit them, GPL-3.0-only, no scripts (no install, no postinstall), files are exactly the exe, the licence and the source address; the directory holds those and package.json', { ...npmGate }, async (t) => {
  const w = world(t); mkWork(w)
  const r = await w.run()
  assert.deepEqual(r.packages.map((p) => p.name), ['asight-kernel-win32-x64', 'asight-kernel-win32-arm64'])
  for (const p of r.packages) {
    const m = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'))
    assert.equal(m.name, w.pin.assets[p.arch].package)
    assert.deepEqual([m.os, m.cpu, m.license, m.version], [['win32'], [p.arch], 'GPL-3.0-only', '1.2.3'])
    assert.ok(!('scripts' in m) && !('bin' in m) && !('dependencies' in m) && !('main' in m), 'nothing that runs at install')
    assert.deepEqual(m.files, [EXE, LICENSE, SOURCE])
    assert.deepEqual(m, platformManifest({ pin: w.pin, arch: p.arch, version: '1.2.3' }))
    assert.deepEqual(files(p.dir), [LICENSE, SOURCE, EXE, 'package.json'].sort())
    assert.equal(sha(fs.readFileSync(path.join(p.dir, EXE))), w.pin.assets[p.arch].exe.sha256, 'the exe in the package is the pin\'s')
    assert.equal(sha(fs.readFileSync(path.join(p.dir, LICENSE))), w.pin.licenseFile.sha256)
    const source = fs.readFileSync(path.join(p.dir, SOURCE), 'utf8')
    assert.ok(source.includes(w.pin.source) && w.pin.source.endsWith(`/tree/${w.pin.version}`), 'the source address is the pinned tag')
  }
  assert.match(fs.readFileSync(path.join(r.packages[0].dir, LICENSE), 'utf8'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  assert.deepEqual(w.calls.download, [w.pin.assets.x64.url, w.pin.assets.arm64.url])
})

test('W75 the main package: a publish manifest adds the two platform packages as optionalDependencies at its own version; the committed package.json and the input are not changed by the tool', { ...npmGate }, async (t) => {
  const w = world(t); mkWork(w)
  const committed = fs.readFileSync(path.join(ROOT, 'package.json'))
  const before = JSON.stringify(MAIN)
  const r = await w.run()
  const m = JSON.parse(fs.readFileSync(r.mainManifest, 'utf8'))
  assert.deepEqual(m.optionalDependencies, { 'asight-kernel-win32-x64': '1.2.3', 'asight-kernel-win32-arm64': '1.2.3' })
  assert.deepEqual({ ...m, optionalDependencies: undefined }, { ...MAIN, optionalDependencies: undefined }, 'and nothing else of it')
  assert.equal(JSON.stringify(MAIN), before, 'the input object is not mutated')
  assert.ok(fs.readFileSync(path.join(ROOT, 'package.json')).equals(committed), 'package.json in the repo is byte-identical')
  assert.ok(!('optionalDependencies' in JSON.parse(committed)), 'private stage: the committed manifest has none')
  assert.deepEqual(mainManifestForPublish({ main: MAIN, pin: w.pin }).optionalDependencies, m.optionalDependencies)
})

test('W75 a build that cannot match the pin writes no file: a wrong zip digest, a wrong exe digest (the other arch fine), a pin with no exe digest, a licence text that is not the pin\'s; no npm pack ran, the work directory is gone', async (t) => {
  const bad = world(t); mkWork(bad)
  const wrongZip = world(t, { zips: { [loadPin().assets.x64.url]: flip(FAKE.x64.zip) } }); mkWork(wrongZip)
  await assert.rejects(wrongZip.run(), (e) => e instanceof PayloadError && e.code === 'zip-digest-mismatch')
  assert.deepEqual(wrongZip.calls.tar, [], 'nothing was even extracted')
  const wrongExe = world(t, { tarGives: (arch) => (arch === 'arm64' ? flip(FAKE.arm64.exe) : FAKE.x64.exe) }); mkWork(wrongExe)
  await assert.rejects(wrongExe.run(), (e) => e.code === 'exe-digest-mismatch' && /arm64/.test(e.message))
  const unpinned = world(t, { pinOver: (p) => { p.assets.arm64.exe.sha256 = null } }); mkWork(unpinned)
  await assert.rejects(unpinned.run(), (e) => e.code === 'not-pinned' && /--pin/.test(e.message))
  assert.deepEqual(unpinned.calls.download, [], 'refused before any download')
  const licence = path.join(bad.root, 'LICENSE-changed'); fs.writeFileSync(licence, `${fs.readFileSync(LICENSE_FILE, 'utf8')}\nchanged`)
  await assert.rejects(bad.run({ licensePath: licence }), (e) => e.code === 'license-digest-mismatch')
  assert.deepEqual(bad.calls.download, [])
  for (const x of [wrongZip, wrongExe, unpinned, bad]) {
    assert.ok(!fs.existsSync(x.out), `nothing under dist: ${x.out}`)
    assert.deepEqual([x.calls.npm, files(x.workRoot)], [[], []], 'no pack, and the scratch directory is removed')
  }
})

test('W75 Release and npm are one exe: the exe inside each npm-pack tarball (extracted here) is the package directory\'s and the pin\'s; the tarball holds exactly the four files and no scripts', { ...npmGate }, async (t) => {
  const w = world(t); mkWork(w)
  const r = await w.run()
  for (const p of r.packages) {
    assert.ok(fs.existsSync(p.tarball), p.tarball)
    const dest = path.join(w.root, `x-${p.arch}`); fs.mkdirSync(dest)
    execFileSync('tar', ['-xzf', p.tarball, '-C', dest])
    assert.deepEqual(files(path.join(dest, 'package')), [LICENSE, SOURCE, EXE, 'package.json'].sort())
    const fromTar = sha(fs.readFileSync(path.join(dest, 'package', EXE)))
    assert.deepEqual([fromTar, fromTar === sha(fs.readFileSync(path.join(p.dir, EXE)))], [w.pin.assets[p.arch].exe.sha256, true])
    assert.ok(!('scripts' in JSON.parse(fs.readFileSync(path.join(dest, 'package', 'package.json'), 'utf8'))))
  }
})

test('W75 the main package holds no scripts/ and no exe (npm pack --dry-run on the repo, the files whitelist); .gitignore has dist/ and *.exe; nothing in src imports the build tool; no exe is committed', { ...npmGate }, (t) => {
  const scratch = tmpDir('asight-payload-')
  const env = npmEnvIn(scratch)
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, env, encoding: 'utf8' }))[0].files.map((f) => f.path)
  assert.ok(packed.length > 10 && packed.some((p) => p.startsWith('src/collector/arch/win32/')), 'the listing is the real package')
  assert.deepEqual(packed.filter((p) => p.startsWith('scripts/') || /\.exe$/i.test(p) || p === LICENSE_FILE), [], 'no build tool, no exe')
  assert.ok(packed.includes('src/collector/arch/win32/mihomo-pin.json'), 'the pin ships: it is what `on` reads')
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
  assert.ok(lines.includes('dist/') && lines.includes('*.exe'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const src = walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'bin')))
  assert.deepEqual(src.filter((f) => /\.exe$/i.test(f)), [])
  assert.deepEqual(src.filter((f) => /\.(m?js|cjs)$/.test(f) && /kernel-payload/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)), [], 'the CLI and the daemon do not import the build tool')
})

test('W75 --pin: two independent downloads per arch, each checked against the zip\'s pin, must agree; the answer is the exe\'s size and sha256 for the pin; nothing is written; a disagreement or a wrong zip is an error', async (t) => {
  const w = world(t); mkWork(w)
  const r = await pinExes({ pin: w.pin, download: w.download, exec: w.exec, workRoot: w.workRoot })
  assert.deepEqual(r, { x64: { name: EXE, size: FAKE.x64.exe.length, sha256: sha(FAKE.x64.exe) }, arm64: { name: EXE, size: FAKE.arm64.exe.length, sha256: sha(FAKE.arm64.exe) } })
  assert.deepEqual(w.calls.download.length, 4, 'two per arch')
  assert.deepEqual([files(w.workRoot), w.calls.npm, fs.existsSync(w.out)], [[], [], false], 'it only prints')
  const split = world(t, { tarGives: (arch, n) => (n === 0 ? FAKE[arch].exe : flip(FAKE[arch].exe)) }); mkWork(split)
  await assert.rejects(pinExes({ pin: split.pin, download: split.download, exec: split.exec, workRoot: split.workRoot }), (e) => e.code === 'downloads-disagree')
  const wrong = world(t, { zips: { [loadPin().assets.arm64.url]: flip(FAKE.arm64.zip) } }); mkWork(wrong)
  await assert.rejects(pinExes({ pin: wrong.pin, download: wrong.download, exec: wrong.exec, workRoot: wrong.workRoot }), (e) => e.code === 'zip-digest-mismatch')
})
