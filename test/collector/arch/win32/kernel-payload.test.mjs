// kernel-payload.test.mjs — the pin's maintainer tool, `--pin` only since D44 (RFC 4.5 §A, 4.8 §8; acceptance W75 as D44 left it): two independent
// downloads per arch, each checked against the pin's archive digest, must agree on the unpacked exe; it prints the archive's and the exe's size and sha256
// and writes nothing. The build half (the platform packages, the tarballs, the publish manifest) retired with the npm-package distribution — its assertions
// went with it; what stays is the tool's own discipline and the shipped package's shape (the pin and the licence file `on` needs at runtime, still no build
// tool, no exe). The tool takes injected `download`, `exec` and `fs`: no test here goes online. The pins as shipped (both arch files) are held by the
// forwarder tests' "the pin as shipped" cells; nothing in `src/` imports this script — the last cell holds that.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { pinExes, PayloadError, PIN_FILE } from '../../../../scripts/kernel-payload.mjs'
import { loadPin as loadWinPin } from '../../../../src/collector/arch/win32/forwarder.mjs'
import { loadPin as loadDarwinPin } from '../../../../src/collector/arch/darwin/forwarder.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const flip = (buf) => { const b = Buffer.from(buf); b[10] ^= 0xff; return b }
const EXE = 'asight-forwarder.exe'
const FAKE = { x64: { zip: Buffer.from('PK fake zip x64 '.repeat(40)), exe: Buffer.from('MZ fake x64 kernel '.repeat(60)) }, arm64: { zip: Buffer.from('PK fake zip arm64 '.repeat(40)), exe: Buffer.from('MZ fake arm64 kernel '.repeat(60)) } }

/** A win32-shaped world: a test copy of the pin naming the fake zips and exes, the url → bytes map, and the injected tools. `tarGives(arch, n)` is what the
 *  n-th extraction of that arch writes. */
function world(t, { tarGives = (arch) => FAKE[arch].exe, zips = {} } = {}) {
  const pin = JSON.parse(JSON.stringify(loadWinPin()))
  for (const arch of ['x64', 'arm64']) {
    pin.assets[arch].sha256 = sha(FAKE[arch].zip); pin.assets[arch].size = FAKE[arch].zip.length
    pin.assets[arch].exe = { name: EXE, size: FAKE[arch].exe.length, sha256: sha(FAKE[arch].exe) }
  }
  const root = tmpDir('asight-payload-')
  const calls = { download: [], tar: [] }
  const counts = { x64: 0, arm64: 0 }
  const body = { [pin.assets.x64.url]: FAKE.x64.zip, [pin.assets.arm64.url]: FAKE.arm64.zip, ...zips }
  const download = async (url) => { calls.download.push(url); return body[url] }
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'tar', 'a .zip asset unpacks through the system tar, nothing else is exec\'d')
    calls.tar.push(args)
    const arch = args[1].includes('arm64') ? 'arm64' : 'x64'
    assert.deepEqual(fs.readFileSync(args[1]), body[pin.assets[arch].url], 'tar is handed the archive that was downloaded')
    fs.writeFileSync(path.join(args[3], `mihomo-${arch}.exe`), tarGives(arch, counts[arch]++))
    return { stdout: '' }
  }
  return { pin, root, workRoot: path.join(root, 'work'), calls, download, exec, out: path.join(root, 'dist', 'kernel') }
}
const mkWork = (w) => fs.mkdirSync(w.workRoot, { recursive: true })
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null)

test('W75 --pin: two independent downloads per arch, each checked against the archive\'s pin; the answer carries the archive\'s AND the exe\'s size and sha256 for the pin; nothing is written', async (t) => {
  const w = world(t); mkWork(w)
  const r = await pinExes({ pin: w.pin, download: w.download, exec: w.exec, workRoot: w.workRoot })
  assert.deepEqual(r, {
    x64: { name: w.pin.assets.x64.name, size: FAKE.x64.zip.length, sha256: sha(FAKE.x64.zip), exe: { name: EXE, size: FAKE.x64.exe.length, sha256: sha(FAKE.x64.exe) } },
    arm64: { name: w.pin.assets.arm64.name, size: FAKE.arm64.zip.length, sha256: sha(FAKE.arm64.zip), exe: { name: EXE, size: FAKE.arm64.exe.length, sha256: sha(FAKE.arm64.exe) } },
  })
  assert.equal(w.calls.download.length, 4, 'two per arch')
  assert.deepEqual([files(w.workRoot), fs.existsSync(w.out)], [[], false], 'it only prints (the build half is retired; there is no `out` at all)')
})

test('W75 --pin: two downloads that disagree on the exe are an error; a wrong archive digest is an error that prints no digest; nothing is written either way', async (t) => {
  const split = world(t, { tarGives: (arch, n) => (n === 0 ? FAKE[arch].exe : flip(FAKE[arch].exe)) }); mkWork(split)
  await assert.rejects(pinExes({ pin: split.pin, download: split.download, exec: split.exec, workRoot: split.workRoot }), (e) => e instanceof PayloadError && e.code === 'downloads-disagree')
  const wrong = world(t, { zips: { [loadWinPin().assets.arm64.url]: flip(FAKE.arm64.zip) } }); mkWork(wrong)
  await assert.rejects(pinExes({ pin: wrong.pin, download: wrong.download, exec: wrong.exec, workRoot: wrong.workRoot }), (e) => {
    assert.ok(e instanceof PayloadError && e.code === 'zip-digest-mismatch')
    assert.ok(!/[0-9a-f]{64}/.test(e.message), 'the mismatch is reported without the computed digest: the operator re-downloads, the pin is not argued with from a bad copy')
    return true
  })
  for (const x of [split, wrong]) assert.deepEqual([files(x.workRoot), fs.existsSync(x.out)], [[], false], 'no scratch left, nothing written')
})

// 4.9 验收 3 (D44): the tool reads the darwin pin's own assets — the darwin release is a .gz of the single binary, unpacked with node:zlib, no exec at all.
test('W75 --pin (darwin): the .gz assets of the darwin pin unpack through node:zlib, no exec; the answer is the same shape', async (t) => {
  const pin = JSON.parse(JSON.stringify(loadDarwinPin()))
  const fakes = {}
  const body = {}
  for (const arch of Object.keys(pin.assets)) {
    fakes[arch] = { gz: gzipSync(Buffer.from(`MZ fake darwin ${arch} kernel `.repeat(60))) }
    pin.assets[arch].sha256 = sha(fakes[arch].gz); pin.assets[arch].size = fakes[arch].gz.length
    body[pin.assets[arch].url] = fakes[arch].gz
  }
  const root = tmpDir('asight-payload-')
  const calls = { download: [], exec: [] }
  const r = await pinExes({ pin, download: async (u) => { calls.download.push(u); return body[u] }, exec: async (...a) => { calls.exec.push(a); throw new Error('no exec on the darwin half') }, workRoot: root })
  for (const arch of Object.keys(pin.assets)) {
    const raw = Buffer.from(`MZ fake darwin ${arch} kernel `.repeat(60))
    assert.deepEqual(r[arch], { name: pin.assets[arch].name, size: fakes[arch].gz.length, sha256: sha(fakes[arch].gz), exe: { name: 'asight-forwarder', size: raw.length, sha256: sha(raw) } })
  }
  assert.deepEqual(calls.exec, [], 'the gz half never execs: zlib is it')
  const badGz = Buffer.from(fakes.arm64.gz); badGz[10] ^= 0xff // not the pinned archive any more
  await assert.rejects(pinExes({ pin, download: async (u) => (u === pin.assets.arm64.url ? badGz : body[u]), exec: async () => { throw new Error('no exec') }, workRoot: root }), (e) => e instanceof PayloadError && e.code === 'zip-digest-mismatch')
})

test('W75 the shipped package: the pin and LICENSE-mihomo.txt ship (on reads both at runtime), no build tool, no exe; .gitignore has dist/ and *.exe; nothing in src imports the tool', (t) => {
  const scratch = tmpDir('asight-payload-')
  const env = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, npm_config_cache: path.join(scratch, 'cache'), npm_config_update_notifier: 'false', npm_config_offline: 'true', npm_config_fund: 'false', npm_config_audit: 'false' }
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, env, encoding: 'utf8' }))[0].files.map((f) => f.path)
  assert.ok(packed.length > 10 && packed.some((p) => p.startsWith('src/collector/arch/win32/')), 'the listing is the real package')
  assert.deepEqual(packed.filter((p) => p.startsWith('scripts/') || /\.exe$/i.test(p)), [], 'no build tool, no exe (the kernel is in no package since D44)')
  assert.ok(packed.includes('src/collector/arch/win32/mihomo-pin.json') && packed.includes('src/collector/arch/darwin/mihomo-pin.json'), 'the pins ship: they are what `on` reads')
  assert.ok(packed.includes('LICENSE-mihomo.txt'), 'the licence text ships: kernel-download.mjs places it beside the kernel it downloads (D44)')
  assert.equal(path.basename(PIN_FILE), 'mihomo-pin.json', 'the default pin file is the win32 one; darwin\'s is named with --pin-file')
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim())
  assert.ok(lines.includes('dist/') && lines.includes('*.exe'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const src = walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'bin')))
  assert.deepEqual(src.filter((f) => /\.exe$/i.test(f)), [])
  assert.deepEqual(src.filter((f) => /\.(m?js|cjs)$/.test(f) && /kernel-payload/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)), [], 'the CLI and the daemon do not import the tool')
})
