// kernel-download.test.mjs — the downloader: the one place the CLI goes online (RFC 4.8 §8 D44; acceptance W27 ⑦'s new shape — download / cache / failure, 4.5's 验收 6).
// No network, no Windows: the fake `execFile` answers `curl --version`, writes the archive bytes where curl's `-o` points (that is what curl does) and fails on demand; `tar -xf` is a function that
// writes the exe the zip "holds". The archive's and the exe's sha256 are pinned in a test copy of the pin. The import discipline (W27 ⑦'s second scan) is held here too.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { acquireKernel, hashFile, licenseText, sourceText } from '../../../../src/collector/arch/win32/kernel-download.mjs'
import { loadPin } from '../../../../src/collector/arch/win32/forwarder.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE_SRC = path.join(HERE, '..', '..', '..', '..', 'src', 'collector', 'arch', 'win32', 'kernel-download.mjs')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const ARCHIVE = Buffer.from('PK fake mihomo zip, twenty-two megabytes of nothing '.repeat(4))
const EXE = Buffer.from('MZ fake asight-forwarder.exe, sixty kilobytes of nothing '.repeat(8))

/** A test world: the collector dir's kernel-archive under a temp root, a pin copy that pins the fake archive and exe, an event sink, and a fake execFile. `curl` is a number for a non-zero
 * exit, 'absent' for ENOENT, true (default) for the good download; `delivers` is what curl writes (the pin still pins `archive` — the wrong-bytes cell); `tarGives` replaces the exe the zip holds. */
function world({ archive = ARCHIVE, delivers = archive, exe = EXE, curl = true, tarGives = null } = {}) {
  const root = tmpDir('asight-kdl-')
  const pin = JSON.parse(JSON.stringify(loadPin()))
  const asset = pin.assets.x64
  asset.sha256 = sha(archive); asset.size = archive.length
  asset.exe = { name: 'asight-forwarder.exe', size: exe.length, sha256: sha(exe) }
  const cacheDir = path.join(root, '.asight', 'collector', 'kernel-archive')
  const events = []
  const calls = []
  const execFile = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args])
    if (cmd === 'curl') {
      if (args[0] === '--version') return curl === 'absent' ? cb(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' })) : cb(null, 'curl 8.7.1 (x86_64)', '')
      if (typeof curl === 'number') return cb(Object.assign(new Error(`Command failed: curl ${curl}`), { code: curl }), '', 'curl: (22) The requested URL returned error: 404')
      fs.writeFileSync(args[args.indexOf('-o') + 1], delivers)
      return cb(null, '', '')
    }
    if (cmd === 'tar') { fs.writeFileSync(path.join(args[args.indexOf('-C') + 1], 'mihomo-windows-amd64-compatible-v1.19.32.exe'), tarGives ? tarGives() : exe); return cb(null, '', '') }
    cb(new Error(`not in the fake: ${cmd}`))
  }
  const run = (over = {}) => acquireKernel({ asset, cacheDir, execFile, event: (r) => events.push(r), ...over })
  return { root, pin, asset, cacheDir, events, calls, run }
}
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const leftovers = (cacheDir) => listing(cacheDir).filter((n) => n.startsWith('work-'))

test('W27 ⑦ the download: curl is exec\'d once with the pinned URL (`-fsSL --retry 2 -o`, redirects are curl\'s own business), BOTH digests are checked, the verified archive is cached, and the started / ok events carry the command line, the expected bytes and the two sha256s', async (t) => {
  const w = world()
  const r = await w.run()
  assert.equal(r.from, 'download')
  assert.deepEqual(w.calls.filter((c) => c[0] === 'curl' && c.includes(w.asset.url)), [['curl', '-fsSL', '--retry', '2', '-o', path.join(r.work, w.asset.name), w.asset.url]], 'exactly one curl against the pinned URL, with the pinned command line')
  assert.deepEqual(w.calls[0], ['curl', '--version'], 'the preflight is a --version')
  assert.equal(sha(fs.readFileSync(r.exe)), w.asset.exe.sha256, 'the exe in the work directory is the pinned one')
  assert.equal(sha(fs.readFileSync(r.cache)), w.asset.sha256, 'the VERIFIED archive is the cache now')
  assert.deepEqual(w.events, [
    { event: 'forwarder-download-started', where: 'forwarder', url: w.asset.url, size: w.asset.size, sha256: w.asset.sha256, command: `curl -fsSL --retry 2 -o ${path.join(r.work, w.asset.name)} ${w.asset.url}` },
    { event: 'forwarder-download-ok', where: 'forwarder', url: w.asset.url, archive_sha256: w.asset.sha256, exe_sha256: w.asset.exe.sha256, cache: r.cache },
  ], 'the two records, in their order, with V50-style exec accounting')
  assert.deepEqual(w.events.map((e) => e.event), ['forwarder-download-started', 'forwarder-download-ok'], 'both are state changes, neither a failure')
  fs.rmSync(r.work, { recursive: true, force: true }) // the caller's half: the work directory goes once the exe is placed
  assert.deepEqual(listing(w.cacheDir), [w.asset.name], 'what is left is the cache entry, nothing else')
  // a second acquire answers from the cache: zero curl, no events (nothing happened an operator must be told)
  const again = await w.run()
  assert.deepEqual([again.from, w.calls.filter((c) => c[0] === 'curl').length, w.events.length], ['cache', 2, 2], 'no new curl, no new event: the cache satisfied the pin')
  assert.equal(sha(fs.readFileSync(again.exe)), w.asset.exe.sha256)
  fs.rmSync(again.work, { recursive: true, force: true })
})

test('W27 ⑦ the cache alone is enough: a pinned archive that was placed there by hand (the offline machine\'s way, D44 ③) is unpacked and exe-checked with NO network — zero curl runs, not even the preflight, and no events', async (t) => {
  const w = world()
  fs.mkdirSync(w.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(w.cacheDir, w.asset.name), ARCHIVE)
  const r = await w.run()
  assert.deepEqual([r.from, w.calls.filter((c) => c[0] === 'curl').length, w.events.length], ['cache', 0, 0], 'no curl at all (tar is local: the unpack is no network), nothing to tell the operator')
  assert.equal(sha(fs.readFileSync(r.exe)), w.asset.exe.sha256, 'the exe came from the cache\'s archive, checked against the pin')
  fs.rmSync(r.work, { recursive: true, force: true })
  assert.deepEqual(listing(w.cacheDir), [w.asset.name])
})

test('W27 ⑦ a cache entry that does not satisfy the pin (wrong bytes, or an unreadable file) is not used and not trusted: the download runs, and the verified archive REPLACES it — nothing unverified is ever unpacked', async (t) => {
  const bent = Buffer.from(ARCHIVE); bent[10] ^= 0xff
  const w = world()
  fs.mkdirSync(w.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(w.cacheDir, w.asset.name), bent)
  const r = await w.run()
  assert.deepEqual([r.from, sha(fs.readFileSync(path.join(w.cacheDir, w.asset.name)))], ['download', w.asset.sha256], 'the bad entry is overwritten by the verified one')
  fs.rmSync(r.work, { recursive: true, force: true })
})

test('W27 ⑦ every failure is a clean refusal with the event and zero leftovers: curl absent (`no-curl`), curl\'s non-zero exit, a download that is not the pinned archive, an exe inside that is not the pinned one — the reason names the digests where a digest is what failed', async (t) => {
  const absent = world({ curl: 'absent' })
  const r0 = await absent.run()
  assert.match(r0.failed.reason, /^curl is not on this machine/, 'the manual alternative\'s counterpart: no curl, no download')
  assert.deepEqual(absent.events, [{ event: 'failure', where: 'forwarder', code: 'forwarder-download-failed', reason: r0.failed.reason }])
  assert.deepEqual(listing(absent.cacheDir), [], 'nothing was made: the preflight stopped it before a work directory existed')
  const dead = world({ curl: 22 })
  const r1 = await dead.run()
  assert.match(r1.failed.reason, /^curl exited 22.*404/, 'curl\'s own words ride along')
  assert.ok(dead.events.some((e) => e.code === 'forwarder-download-failed'))
  assert.deepEqual(leftovers(dead.cacheDir), [], 'the work directory is gone')
  const wrongBytes = world({ delivers: Buffer.from(`${ARCHIVE}x`) })
  const r2 = await wrongBytes.run()
  assert.match(r2.failed.reason, /the download is not the pinned archive \(sha256 [0-9a-f]{64}, \d+ bytes; the pin's is [0-9a-f]{64}, \d+ bytes\)/, 'the reason names both digests')
  assert.deepEqual(leftovers(wrongBytes.cacheDir), [])
  const flipped = Buffer.from(EXE); flipped[10] ^= 0xff
  const wrongExe = world({ tarGives: () => flipped })
  const r3 = await wrongExe.run()
  assert.match(r3.failed.reason, /the exe inside is not the pinned one \(sha256 [0-9a-f]{64}, \d+ bytes; the pin's is [0-9a-f]{64}, \d+ bytes\)/)
  assert.deepEqual(leftovers(wrongExe.cacheDir), [], 'and a bad exe means the archive is NOT cached either')
  assert.deepEqual(listing(wrongExe.cacheDir), [], 'the cache is not touched by a failed download')
  for (const w of [dead, wrongBytes, wrongExe]) assert.ok(!fs.existsSync(path.join(w.cacheDir, w.asset.name)), 'no cache entry from a failure')
})

test('W27 ⑦ static: kernel-download.mjs imports ONLY node:child_process, node:zlib, node:fs, node:path, node:crypto and node:util — no http, https, net, tls, dns, no fetch; a planted import or a fetch call turns the scan red', () => {
  const src = fs.readFileSync(MODULE_SRC, 'utf8')
  const imports = [...src.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.ok(imports.length >= 4, 'the scan sees the imports')
  const ALLOWED = new Set(['node:child_process', 'node:zlib', 'node:fs', 'node:path', 'node:crypto', 'node:util'])
  assert.deepEqual(imports.filter((i) => !ALLOWED.has(i)), [], `every import is in the allowlist (found: ${imports.join(', ')})`)
  assert.deepEqual(src.match(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/g) || [], [], 'no fetch in the downloader')
  for (const planted of ["import https from 'node:https'", "import('node:net')", "const dns = require('dns')", "import net from 'node:net'", "import os from 'node:os'"]) {
    const found = [...planted.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
    assert.ok(found.some((i) => !ALLOWED.has(i)), planted)
  }
  assert.ok(/\bfetch\s*\(/.test("await fetch('https://x')"), 'a fetch call is what the no-fetch half of the scan catches')
})

test('the licence and the source address that travel beside the kernel: licenseText is the repo\'s LICENSE-mihomo.txt (the digest the pin names), sourceText is the pin\'s own words', async (t) => {
  const license = licenseText()
  assert.ok(license && license.length > 1000, 'the GPL-3.0 text, not a stub')
  assert.equal(sha(license), loadPin().licenseFile.sha256, 'the repo\'s copy is the one the pin pinned (W75 holds this too)')
  const text = sourceText({ pin: loadPin(), arch: 'x64' })
  assert.match(text, /^asight-forwarder\.exe is mihomo v1\.19\.32 \(windows-amd64-compatible\), as its authors build it, renamed\./)
  assert.match(text, /Source code: https:\/\/github\.com\/MetaCubeX\/mihomo\/tree\/v1\.19\.32/)
  assert.match(text, /License: GPL-3\.0-only \(LICENSE-mihomo\.txt\)/)
})
