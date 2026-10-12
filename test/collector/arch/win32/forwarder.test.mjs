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
import { locateKernel, ensureBinary, verifyCopy, hashFile, loadPin, reinstallCommands, sacState, sacBlocks, createForwarder, BACKOFF_MS, KERNEL_EXE, KERNEL_LICENSE, KERNEL_SOURCE } from '../../../../src/collector/arch/win32/forwarder.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { buildForwarderConfig } from '../../../../src/netenv/mihomo/rules.mjs'
import { createController } from '../../../../src/netenv/mihomo/controller.mjs'
import { CC_GROUP, CODEX_GROUP, forwarder as ruleInputs } from '../../../netenv/fixtures/rules/inputs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FORWARDER_SRC = path.join(HERE, '..', '..', '..', '..', 'src', 'collector', 'arch', 'win32', 'forwarder.mjs')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const EXE = Buffer.from('MZ fake asight-forwarder.exe, sixty kilobytes of nothing '.repeat(8))
const ARCHIVE = Buffer.from('PK fake mihomo zip, twenty-two megabytes of nothing '.repeat(4))

/** A test world (D44's shape): the collector dir's `kernel\` and `kernel-archive\` under a temp root, a pin copy that pins the fake archive and exe, and an injected execFile — the fake curl
 * writes the archive bytes where curl's `-o` points (that is what curl does) and the fake tar writes the exe the zip "holds". `curl` is 'absent' for ENOENT, a number for a non-zero exit.
 * `pinned: false` makes the pin's exe digest null (the not-pinned cell). */
function world(t, { exe = EXE, archive = ARCHIVE, delivers = archive, tarGives = exe, curl = true, pinned = true } = {}) {
  const root = tmpDir('asight-kernel-')
  const pin = JSON.parse(JSON.stringify(loadPin()))
  const a = pin.assets.x64
  a.sha256 = sha(archive); a.size = archive.length
  a.exe = pinned ? { name: KERNEL_EXE, size: exe.length, sha256: sha(exe) } : { name: KERNEL_EXE, size: null, sha256: null }
  const dir = path.join(root, '.asight', 'collector', 'kernel')
  const cacheDir = path.join(root, '.asight', 'collector', 'kernel-archive')
  const calls = { curl: [], tar: [] }
  const execFile = (cmd, args, opts, cb) => {
    if (cmd === 'curl') {
      calls.curl.push([...args])
      if (args[0] === '--version') return curl === 'absent' ? cb(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' })) : cb(null, 'curl 8.7.1', '')
      if (typeof curl === 'number') return cb(Object.assign(new Error(`Command failed: curl ${curl}`), { code: curl }), '', `curl: (${curl}) boom`)
      fs.writeFileSync(args[args.indexOf('-o') + 1], delivers)
      return cb(null, '', '')
    }
    if (cmd === 'tar') { calls.tar.push([...args]); fs.writeFileSync(path.join(args[args.indexOf('-C') + 1], 'mihomo-windows-amd64-compatible-v1.19.32.exe'), tarGives); return cb(null, '', '') }
    cb(new Error(`not in the fake: ${cmd}`))
  }
  return { root, pin, dir, cacheDir, calls, execFile, arch: 'x64' }
}
const tree = (dir) => { // every file under dir with its bytes' digest, for "byte-identical afterwards"
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(fs.readFileSync(p)) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const flip = (buf) => { const b = Buffer.from(buf); b[10] ^= 0xff; return b }
const MANUAL_X64 = '把 mihomo-windows-amd64-compatible-v1.19.32.zip 放进 ~\\.asight\\collector\\kernel-archive\\ 再跑 asight on,或修好网络 / 代理(HTTPS_PROXY)后重跑'

// ---- W27: the kernel's source — run location, cache, download (D44) ----------------------------------------------------------------------------------

test('W27 ① the three-stage resolution: the run location (zero curl) → the verified-archive cache (zero curl) → the download (exactly one curl against the pinned URL); the placed exe carries the pin\'s digest, the licence and the source address land beside it, and a second run does not rewrite it', async (t) => {
  const run = world(t)
  fs.mkdirSync(run.dir, { recursive: true })
  fs.writeFileSync(path.join(run.dir, KERNEL_EXE), EXE)
  const r0 = await ensureBinary(run)
  assert.deepEqual([r0.path, r0.sha256, r0.copied, r0.from], [path.join(run.dir, KERNEL_EXE), sha(EXE), false, 'run'])
  assert.deepEqual(run.calls.curl, [], 'the run location satisfies the pin: zero curl, zero tar')
  // the cache: no run copy, the archive cache holds the pinned archive — the offline machine's kernel is that file, placed there by hand
  const cached = world(t)
  fs.mkdirSync(cached.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(cached.cacheDir, cached.pin.assets.x64.name), ARCHIVE)
  const r1 = await ensureBinary(cached)
  assert.deepEqual([r1.from, r1.copied, sha(fs.readFileSync(r1.path))], ['cache', true, sha(EXE)], 'placed from the cache, no network')
  assert.deepEqual(cached.calls.curl, [], 'zero curl: the cache is as good as a download')
  assert.deepEqual(fs.readdirSync(cached.dir).sort(), [KERNEL_EXE, KERNEL_LICENSE, KERNEL_SOURCE].sort(), 'the exe, the licence and the source address, and no temp file')
  assert.equal(sha(fs.readFileSync(path.join(cached.dir, KERNEL_LICENSE))), sha(fs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'LICENSE-mihomo.txt'))), 'the licence beside it is the repo\'s own copy')
  assert.match(fs.readFileSync(path.join(cached.dir, KERNEL_SOURCE), 'utf8'), /^asight-forwarder\.exe is mihomo v1\.19\.32 \(windows-amd64-compatible\), as its authors build it, renamed\./)
  // the download: neither is there — exactly one curl, the two events, the verified archive cached
  const dl = world(t)
  const events = []
  const r2 = await ensureBinary({ ...dl, event: (rec) => events.push(rec) })
  assert.deepEqual([r2.from, r2.copied, r2.sha256], ['download', true, sha(EXE)])
  const dlCalls = dl.calls.curl.filter((a) => a.includes(dl.pin.assets.x64.url))
  assert.equal(dlCalls.length, 1, 'exactly one curl against the pinned URL (the --version preflight is the only other exec)')
  assert.deepEqual(dlCalls[0].slice(0, 4), ['-fsSL', '--retry', '2', '-o'], 'the pinned command line, redirects curl\'s own business')
  assert.deepEqual(events.map((e) => e.event), ['forwarder-download-started', 'forwarder-download-ok'])
  assert.equal(sha(fs.readFileSync(path.join(dl.cacheDir, dl.pin.assets.x64.name))), sha(ARCHIVE), 'the VERIFIED archive is the cache now')
  const old = new Date('2020-01-01T00:00:00Z')
  fs.utimesSync(r2.path, old, old)
  const again = await ensureBinary(dl)
  assert.deepEqual([again.from, again.copied], ['run', false], 'the next `on` answers from the run location')
  assert.equal(fs.statSync(r2.path).mtimeMs, old.getTime(), 'a target that is there with the right digest is not rewritten')
  const located = await locateKernel(dl)
  assert.deepEqual([located.found.at, located.found.exe, located.found.sha256, located.found.size], ['run', path.join(dl.dir, KERNEL_EXE), sha(EXE), EXE.length])
})

test('W27 ① a copy that was changed is replaced by the pinned one (that is `on` repairing it) — from the cache, no network; with nothing cached the repair downloads; the cache is not touched by either', async (t) => {
  const w = world(t)
  fs.mkdirSync(w.dir, { recursive: true })
  fs.writeFileSync(path.join(w.dir, KERNEL_EXE), flip(EXE))
  fs.mkdirSync(w.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(w.cacheDir, w.pin.assets.x64.name), ARCHIVE)
  const before = tree(w.cacheDir)
  const r = await ensureBinary(w)
  assert.deepEqual([r.from, sha(fs.readFileSync(r.path))], ['cache', sha(EXE)])
  assert.deepEqual(w.calls.curl, [])
  assert.deepEqual(tree(w.cacheDir), before, 'the cache is the input, not the output: untouched by the repair')
  const bare = world(t)
  fs.mkdirSync(bare.dir, { recursive: true })
  fs.writeFileSync(path.join(bare.dir, KERNEL_EXE), flip(EXE))
  assert.equal((await ensureBinary(bare)).from, 'download', 'nothing cached: the repair downloads')
})

test('W27 ③ a copy that cannot be made, cannot take the name (the upgrade met a kernel that is running) or arrives wrong is an answer, not an exception, and leaves no temp file behind; the exe that is there is untouched, and the work directory is gone', async (t) => {
  const w = world(t)
  fs.mkdirSync(w.dir, { recursive: true })
  fs.writeFileSync(path.join(w.dir, KERNEL_EXE), flip(EXE)) // the kernel of the version before the pin moved: another digest, and running, so Windows will not let it be replaced
  fs.mkdirSync(w.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(w.cacheDir, w.pin.assets.x64.name), ARCHIVE)
  const held = () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) }
  assert.deepEqual(await ensureBinary({ ...w, fs: { ...fs, renameSync: held } }), { blocked: { step: 'replace', reason: 'EPERM' } })
  assert.deepEqual(fs.readdirSync(w.dir), [KERNEL_EXE], 'no temp file: a stray 60 MB file would also make removeBinary\'s rmdir fail')
  assert.equal(sha(fs.readFileSync(path.join(w.dir, KERNEL_EXE))), sha(flip(EXE)), 'the exe that is running is not touched')
  assert.deepEqual(fs.readdirSync(w.cacheDir), [w.pin.assets.x64.name], 'and the cache is untouched')
  assert.deepEqual([(await ensureBinary(w)).from, sha(fs.readFileSync(path.join(w.dir, KERNEL_EXE)))], ['cache', sha(EXE)], 'and once nothing holds it, the next `on` replaces it')
  const full = world(t)
  fs.mkdirSync(full.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(full.cacheDir, full.pin.assets.x64.name), ARCHIVE)
  const half = (from, to) => { fs.writeFileSync(to, 'partial'); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
  assert.deepEqual(await ensureBinary({ ...full, fs: { ...fs, copyFileSync: half } }), { blocked: { step: 'copy', reason: 'ENOSPC' } })
  assert.deepEqual(fs.readdirSync(full.dir), [], 'the half-written copy is removed')
  assert.deepEqual(fs.readdirSync(full.cacheDir), [full.pin.assets.x64.name], 'and the work directory with it')
  const bent = world(t)
  fs.mkdirSync(bent.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(bent.cacheDir, bent.pin.assets.x64.name), ARCHIVE)
  const wrong = await ensureBinary({ ...bent, fs: { ...fs, copyFileSync: (from, to) => fs.writeFileSync(to, flip(fs.readFileSync(from))) } })
  assert.deepEqual(wrong, { mismatch: { of: 'copy', alternative: MANUAL_X64 } }, 'the copy is hashed before it takes the name (W27 ① "its digest is the pin\'s")')
  assert.deepEqual(fs.readdirSync(bent.dir), [], 'neither the exe nor a temp file: nothing was renamed')
})

test('W27 ② an architecture the pin does not have, a pin with no exe digest: forwarder-binary-missing with the reason and the manual alternative (none for an architecture nobody pins); a download that cannot run — curl absent, curl\'s non-zero exit, wrong bytes — is a failure whose reason says which, with the alternative; nothing is placed by any of them', async (t) => {
  const w = world(t)
  assert.deepEqual(await locateKernel({ ...w, arch: 'ia32' }), { missing: { reason: 'unsupported-arch', alternative: null } })
  assert.deepEqual(await ensureBinary({ ...w, arch: 'ia32' }), { missing: { reason: 'unsupported-arch', alternative: null } })
  const unpinned = world(t, { pinned: false })
  assert.deepEqual(await locateKernel(unpinned), { missing: { reason: 'not-pinned', alternative: MANUAL_X64 } })
  assert.deepEqual(await ensureBinary(unpinned), { missing: { reason: 'not-pinned', alternative: MANUAL_X64 } })
  const noCurl = world(t, { curl: 'absent' })
  const dead = await ensureBinary(noCurl)
  assert.deepEqual(dead, { failed: { reason: 'curl is not on this machine (the download needs the system curl; macOS and Windows 10 1803+ carry one)', alternative: MANUAL_X64 } })
  const broke = world(t, { curl: 22 })
  assert.match((await ensureBinary(broke)).failed.reason, /^curl exited 22.*boom/, 'curl\'s own words ride along')
  const bentBytes = world(t, { delivers: flip(ARCHIVE) })
  const bent = await ensureBinary(bentBytes)
  assert.match(bent.failed.reason, /the download is not the pinned archive \(sha256 [0-9a-f]{64}, \d+ bytes; the pin's is [0-9a-f]{64}, \d+ bytes\)/, 'the reason names both digests')
  assert.deepEqual(bentBytes.calls.tar, [], 'nothing was even extracted')
  for (const x of [w, unpinned, noCurl, broke, bentBytes]) assert.ok(!fs.existsSync(path.join(x.dir, KERNEL_EXE)), 'nothing in kernel\\')
  for (const x of [noCurl, broke, bentBytes]) assert.deepEqual((fs.existsSync(x.cacheDir) ? fs.readdirSync(x.cacheDir) : []).filter((n) => n !== x.pin.assets.x64.name), [], 'and no work directory is left (the no-curl refusal stopped before one was made)')
})

test('W27 ④ before a start the copy is checked against the pin: right, one byte changed (of copy, not re-copied from the cache or downloaded), deleted (file-missing); a pin with no digest cannot be checked', async (t) => {
  const w = world(t)
  await ensureBinary(w)
  const v = () => verifyCopy({ dir: w.dir, pin: w.pin, arch: 'x64' })
  assert.deepEqual(await v(), { ok: true, sha256: sha(EXE) })
  fs.writeFileSync(path.join(w.dir, KERNEL_EXE), flip(EXE))
  assert.deepEqual(await v(), { mismatch: { of: 'copy' } })
  assert.equal(sha(fs.readFileSync(path.join(w.dir, KERNEL_EXE))), sha(flip(EXE)), 'a changed copy is reported, not repaired')
  fs.rmSync(path.join(w.dir, KERNEL_EXE))
  assert.deepEqual(await v(), { missing: { reason: 'file-missing' } })
  assert.ok(!fs.existsSync(path.join(w.dir, KERNEL_EXE)), 'and not re-copied from the cache or downloaded: the repair is `on`\'s')
  assert.deepEqual(await verifyCopy({ dir: w.dir, pin: world(t, { pinned: false }).pin, arch: 'x64' }), { missing: { reason: 'not-pinned' } })
  assert.deepEqual(await verifyCopy({ dir: w.dir, pin: w.pin, arch: 'ia32' }), { missing: { reason: 'unsupported-arch' } })
})

test('W27 ⑤ the manual alternative is the one literal of 4.8 §8 ⑤ and §10.4, filled with the pin\'s own archive file name, and carries no download address; an architecture the pin does not know gets null', () => {
  assert.equal(reinstallCommands(loadPin().assets.x64), MANUAL_X64)
  assert.equal(reinstallCommands(loadPin().assets.arm64), '把 mihomo-windows-arm64-v1.19.32.zip 放进 ~\\.asight\\collector\\kernel-archive\\ 再跑 asight on,或修好网络 / 代理(HTTPS_PROXY)后重跑')
  assert.ok(!/https?:|github/i.test(MANUAL_X64), MANUAL_X64)
  assert.equal(reinstallCommands(null), null, 'no asset, no alternative')
})

test('W27 ⑦ no network of its own: every path above (run, cache, download, missing, failed, verified) makes no connection, no name lookup and no fetch — the download\'s network is curl\'s, a child process the caller injected; the recorder itself can see one', async (t) => {
  const run = world(t)
  fs.mkdirSync(run.dir, { recursive: true })
  fs.writeFileSync(path.join(run.dir, KERNEL_EXE), EXE)
  const cached = world(t)
  fs.mkdirSync(cached.cacheDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(cached.cacheDir, cached.pin.assets.x64.name), ARCHIVE)
  const dl = world(t)
  const bad = world(t, { curl: 22 })
  const attempts = await recordNetwork(async () => {
    await ensureBinary(run); await ensureBinary(cached); await ensureBinary(dl)
    await ensureBinary(bad); await locateKernel({ ...dl, arch: 'ia32' }); await locateKernel(dl)
    await verifyCopy({ dir: run.dir, pin: run.pin, arch: 'x64' })
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
test('W27 ⑦ static: forwarder.mjs imports no network module and calls no fetch (the download lives in kernel-download.mjs, whose own scan that file\'s test holds); a planted import turns the scan red', () => {
  const src = withoutComments(fs.readFileSync(FORWARDER_SRC, 'utf8'))
  assert.deepEqual(src.match(new RegExp(NETWORK.source, 'g')) || [], [], 'no http, https, http2, dns, net, tls, dgram, fetch in forwarder.mjs')
  for (const planted of ["import https from 'node:https'", "import('node:http')", "const dns = require('dns')", "await fetch('https://x')", "import net from 'node:net'"]) assert.ok(NETWORK.test(planted), planted)
  assert.ok(!NETWORK.test("import { createHash } from 'node:crypto'\nimport nodeFs from 'node:fs'\nimport { acquireKernel } from './kernel-download.mjs'"), 'the scan does not cry wolf at the modules this file does use — the downloader included, it is not a network module')
})

test('W27 the pin as shipped: version, the archive names and digests the spec pins, the licence digest; the exe digest is 64 hex digits (or null until the operator\'s --pin run, and then the kernel is not-pinned)', async (t) => {
  const pin = loadPin()
  assert.equal(pin.version, 'v1.19.32')
  assert.deepEqual(Object.keys(pin.assets), ['x64', 'arm64'])
  assert.deepEqual([pin.assets.x64.name, pin.assets.arm64.name], ['mihomo-windows-amd64-compatible-v1.19.32.zip', 'mihomo-windows-arm64-v1.19.32.zip'])
  assert.deepEqual([pin.assets.x64.variant, pin.assets.arm64.variant], ['windows-amd64-compatible', 'windows-arm64'])
  assert.deepEqual([pin.assets.x64.sha256, pin.assets.x64.size], ['974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0', 22525067])
  assert.deepEqual([pin.assets.arm64.sha256, pin.assets.arm64.size], ['7a4f6e58af9a120920935f2150cf642d945085fdb3e753314505b334234e1d1e', 20194736])
  assert.deepEqual([pin.assets.x64.url, pin.assets.arm64.url], ['https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-compatible-v1.19.32.zip', 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-arm64-v1.19.32.zip'], 'the official release page, pinned (D44: `on` downloads from exactly here)')
  assert.equal(pin.assets.x64.exe.name, KERNEL_EXE)
  assert.equal(pin.license, 'GPL-3.0-only')
  assert.equal(pin.licenseFile.sha256, (await hashFile(path.join(HERE, '..', '..', '..', '..', KERNEL_LICENSE))).sha256, 'licenseFile.sha256 is the digest of the committed LICENSE-mihomo.txt')
  assert.match(fs.readFileSync(path.join(HERE, '..', '..', '..', '..', KERNEL_LICENSE), 'utf8'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  const empty = tmpDir('asight-kernel-')
  for (const arch of ['x64', 'arm64']) {
    const e = pin.assets[arch].exe
    assert.ok(e.sha256 === null || /^[0-9a-f]{64}$/.test(e.sha256), `${arch}: the exe digest is 64 hex digits, or null until the operator runs the pin step`)
    assert.ok(e.sha256 !== null || (await locateKernel({ pin, arch, dir: path.join(empty, 'kernel') })).missing.reason === 'not-pinned', `${arch}: no digest, no start`)
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
  const fwd = createForwarder({ dir, bin, controller: { port: ports.controller, secret }, spawn, events, isFree, verifyCopy: verify, procStart: async () => null, pollMs: 10, startTimeoutMs: 1500, ...over })
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
  const ctl = await kernelWorld(t, { sacOn: async () => true })
  await holdPort(t, ctl.ports.controller)
  const d = await ctl.fwd.start({ build: ctl.build, forms: FORMS })
  assert.deepEqual([d.ok, d.code, d.reason, d.port, ctl.spawned.length], [false, 'forwarder-start-failed', 'port-taken', ctl.ports.controller, 0], 'the controller port is checked with the group ports (4.8 §8): a kernel that cannot be talked to is no kernel')
  for (const w of [crash, plain, mute, nobody, taken, ctl]) assert.deepEqual(inClosedSets(w.events), [], 'W38: every start failure is in the closed sets')
})

test('W12 W55 reload: the new text goes to the kernel by PUT /configs?force=true and to the config file; the read-back follows the group (off has no fallback group); a port the new text opens that is taken, or a kernel that refuses, leaves the old config running', async (t) => {
  const k = await kernelWorld(t, {})
  await k.fwd.start({ build: k.build, forms: FORMS })
  const codexOff = FORMS.map((f) => (f.f === 'codex.app' ? { ...f, on: false } : f))
  const seen = logOf(k.log).length
  const r = await k.fwd.reload({ build: (c) => k.build(c, [CC_GROUP, { ...CODEX_GROUP, on: false }]), forms: codexOff })
  assert.equal(r.ok, true)
  const probed = logOf(k.log).slice(seen).map((q) => q.path).filter((q) => q.includes('/delay?url=')).map((q) => q.split('/')[2])
  assert.deepEqual(probed.sort(), ['asight-fb-claude-code.cli', 'asight-fb-claude-code.vscode'], 'after every reload the probe of each form that is on is asked for now (4.8 §3.3), and not that of the form that is off')
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
  const running = fs.readFileSync(refusing.P.config)
  const smaller = (c) => refusing.build(c, [CC_GROUP]) // a text that is not the one running: a file written before the PUT would show
  assert.deepEqual((await refusing.fwd.reload({ build: smaller, forms: FORMS })).error, { status: 400, text: '' }, 'the status, not the core\'s words (they may quote the user\'s config)')
  assert.ok(fs.readFileSync(refusing.P.config).equals(running), 'the file is written after the core has accepted the text (4.8 §8): a refusing core leaves it byte-identical')
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
  assert.deepEqual(await createForwarder({ dir: k.dir, bin: k.bin, controller: { port: 1, secret: 'x' }, isFree, procStart: async () => null }).check(), { ok: false, forms: {}, reason: 'not-running' })
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
  const fwd = createForwarder({ dir, bin: path.join(dir, 'kernel', KERNEL_EXE), controller: { port: 18899, secret }, spawn, makeController, events, isFree: async () => true, verifyCopy, procStart: async () => null, isAlive: (pid) => alive.has(pid), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, pollMs: 1, ...over.fwd })
  const forms = [{ f: 'claude-code.cli', on: true }]
  return { fwd, clock, children, alive, die, events, verified, build, forms, dir, start: () => fwd.start({ build, forms }) }
}
const restarts = (k) => k.events.failures.filter((f) => f.code === 'forwarder-restart').map((f) => f.delay_ms)
/** W38: every record the forwarder hands the recorder is in the closed sets (a failure goes through the recorder as `event:'failure'`). */
const inClosedSets = (events) => [...events.failures.map((f) => ({ event: 'failure', ...f })), ...events.states].flatMap((r) => checkRecord(r).map((why) => `${r.code || r.event}: ${why}`))

test('W28 a kernel that exits again and again: respawned after 1, 2, 4, 8, 16, then 30 s (the cap), the fifth failure in a row is forwarder-down (once, where netenv), the tries go on, and every spawn is preceded by a digest check (W27 ④)', async (t) => {
  const k = await fakeKernel(t)
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 4000, 8000, 16000, 30000])
  assert.equal((await k.start()).ok, true)
  assert.equal(k.children.length, 1)
  const waited = []
  for (let n = 1; n <= 7; n++) {
    k.die(k.children.at(-1))
    await settle()
    assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')), 'a kernel that exited leaves no lock naming its pid')
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
  assert.deepEqual(inClosedSets(k.events), [], 'W38: restart, down and start records are in the closed sets')
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
  assert.deepEqual(await k.fwd.stopNow(), { pids: [], stopped: true })
  assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')))
  k.children[0].emit('exit', null, 'SIGTERM')
  await k.clock.advance(300_000)
  assert.deepEqual([k.children.length, k.clock.pending(), restarts(k), k.fwd.state().phase], [1, [], [], 'stopped'])
  const k2 = await fakeKernel(t)
  await k2.start()
  k2.die(k2.children[0]); await settle()
  assert.equal(k2.clock.pending().length, 1, 'a re-spawn is waiting')
  await k2.fwd.stopNow()
  assert.deepEqual(k2.clock.pending(), [], 'the waiting re-spawn is cancelled, not merely ignored when it fires')
  await k2.clock.advance(300_000)
  assert.equal(k2.children.length, 1, 'stopNow also cancels the one that was waiting')
})

test('W28 a real child that is killed from outside is brought back by the same path: a new pid, the lock rewritten, the read-back on again', async (t) => {
  const k = await kernelWorld(t, { backoffMs: [30], stableMs: 60_000 })
  const first = await k.fwd.start({ build: k.build, forms: FORMS })
  const seen = logOf(k.log).length
  process.kill(first.pid, 'SIGKILL')
  for (let i = 0; i < 100 && k.spawned.length < 2; i++) await new Promise((r) => setTimeout(r, 30))
  for (let i = 0; i < 100 && k.fwd.state().phase !== 'running'; i++) await new Promise((r) => setTimeout(r, 30))
  const probes = () => new Set(logOf(k.log).slice(seen).map((q) => q.path).filter((q) => q.includes('/delay?url=')).map((q) => q.split('/')[2]))
  for (let i = 0; i < 100 && probes().size < 3; i++) await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual([...probes()].sort(), ['asight-fb-claude-code.cli', 'asight-fb-claude-code.vscode', 'asight-fb-codex.app'], 'the re-spawned kernel is asked for every probe at once, as after a reload: its first health check may not have happened')
  const s = k.fwd.state()
  assert.deepEqual([k.spawned.length, s.phase, s.pid !== first.pid], [2, 'running', true])
  assert.equal(JSON.parse(fs.readFileSync(k.P.lock, 'utf8')).pid, s.pid)
  assert.equal((await k.fwd.check()).ok, true)
  assert.deepEqual(k.events.failures.map((f) => [f.code, f.delay_ms]), [['forwarder-restart', 30]])
})

// ---- W28 adopt, drain, uninstall ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const START = 424_242 // a process start time as the helper would say it (ms)

test('W28 a restarted daemon adopts the kernel the lock names (pid, start time, /version all agree), takes the controller of that kernel\'s own config, and goes on from there: reload with it, stop it', async (t) => {
  const k = await kernelWorld(t, { procStart: async () => START, setTimer: () => ({ unref() {} }) }) // the first daemon is "dead": its timers never fire
  const first = await k.fwd.start({ build: k.build, forms: FORMS })
  assert.equal(JSON.parse(fs.readFileSync(k.P.lock, 'utf8')).startedAt, START)
  const second = createForwarder({ dir: k.dir, bin: k.bin, controller: { port: await freePort(), secret: 'another-run-another-secret-000000' }, isFree, procStart: async () => START, watchMs: 20, stopWaitMs: 3000, pollMs: 10, events: k.events })
  const a = await second.adopt()
  assert.deepEqual([a.adopted, a.pid, a.controller], [true, first.pid, { port: k.ports.controller, secret: k.secret }], 'the running kernel\'s port and secret, not this run\'s')
  assert.deepEqual(k.events.states.at(-1), { event: 'forwarder-start', where: 'forwarder', pid: first.pid, adopted: true })
  const seen = []
  const r = await second.reload({ build: (c) => { seen.push(c); return k.build(c, [CC_GROUP, { ...CODEX_GROUP, on: false }]) }, forms: FORMS.map((f) => (f.f === 'codex.app' ? { ...f, on: false } : f)) })
  assert.deepEqual([r.ok, seen], [true, [{ port: k.ports.controller, secret: k.secret }]], 'the text is built for the controller the kernel has, so a reload cannot lock the daemon out')
  assert.deepEqual(await second.stopNow(), { pids: [], stopped: true })
  assert.ok(!fs.existsSync(k.P.lock))
  assert.equal(await isFree(k.ports.controller), true, 'the kernel is gone')
})

test('W28 adopt refuses what is not the kernel the lock names: no lock, a garbled lock, a pid that is gone (the lock is cleaned), a pid whose start time is another process\'s (never touched), an unreadable start time, a config that is gone or is not the lock\'s, a controller that does not answer', async (t) => {
  const k = await fakeKernel(t, { fwd: { procStart: async () => START } })
  const lock = path.join(k.dir, 'forwarder.lock')
  const config = path.join(k.dir, 'forwarder', 'config.json')
  const text = k.build()
  const setup = ({ pid = 777, startedAt = START, endpoint = 'tcp:127.0.0.1:18899', cfg = config, alive = true } = {}) => {
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, text); fs.writeFileSync(lock, JSON.stringify({ pid, startedAt, endpoint, config: cfg }))
    k.alive.clear(); if (alive) k.alive.add(pid)
  }
  const reason = async (fwd = k.fwd) => (await fwd.adopt()).reason
  assert.equal(await reason(), 'no-lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, '{not json')
  assert.equal(await reason(), 'lock-unreadable')
  setup({ alive: false })
  assert.deepEqual([await reason(), fs.existsSync(lock)], ['not-running', false])
  setup()
  const other = await fakeKernel(t, { fwd: { procStart: async () => START + 5000 } })
  other.alive.add(777); fs.cpSync(k.dir, other.dir, { recursive: true })
  assert.equal(await reason(other.fwd), 'start-time-differs')
  assert.ok(other.alive.has(777) && fs.existsSync(path.join(other.dir, 'forwarder.lock')), 'the other process is left alone, and the lock stays for the next start to replace')
  const blind = await fakeKernel(t, { fwd: { procStart: async () => null } })
  blind.alive.add(777); fs.cpSync(k.dir, blind.dir, { recursive: true })
  assert.equal(await reason(blind.fwd), 'start-time-unreadable')
  setup({ cfg: path.join(k.dir, 'nowhere.json') })
  assert.equal(await reason(), 'config-unreadable')
  setup({ endpoint: 'tcp:127.0.0.1:1' })
  assert.equal(await reason(), 'config-differs')
  const mute = await fakeKernel(t, { fwd: { procStart: async () => START, makeController: () => ({ get: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }) }) } })
  setup()
  mute.alive.add(777); fs.cpSync(k.dir, mute.dir, { recursive: true })
  assert.equal(await reason(mute.fwd), 'version-no-answer')
  assert.equal(k.children.length + other.children.length + blind.children.length + mute.children.length, 0, 'adopting never spawns')
})

test('W28 adopt, orphan seat: the lock names a pid that is gone, but a LIVE kernel of ours holds the group ports (a re-spawn whose lock write never landed) — it is killed (a hard taskkill) before anything attaches, so the next start does not meet port-taken; a holder that is not our image, a config that cannot be read, a portHolders that was not given or throws: nobody is touched, the lock is cleaned either way', async (t) => {
  const killed = []
  const holdersOf = (rows) => async (ports) => rows.filter((r) => ports.includes(r.port))
  const world = async (rows, over = {}) => {
    const k = await fakeKernel(t, { fwd: { procStart: async () => START, ...(over.fwd || {}) } })
    fs.mkdirSync(path.join(k.dir, 'forwarder'), { recursive: true })
    const config = path.join(k.dir, 'forwarder', 'config.json')
    fs.writeFileSync(config, k.build())
    fs.writeFileSync(path.join(k.dir, 'forwarder.lock'), JSON.stringify({ pid: 777, startedAt: START, endpoint: 'tcp:127.0.0.1:18899', config }))
    k.alive.clear() // the lock's pid is gone: the daemon that wrote the lock died before it could write the re-spawn's
    return k
  }
  // a live kernel of ours holds the listener port: killed, said as a forwarder-stop, the lock cleaned
  {
    const k = await fakeKernel(t, { fwd: { procStart: async () => START, portHolders: holdersOf([{ port: 18801, pid: 555, image: 'asight-forwarder.exe' }]), killPid: (pid) => killed.push(pid) } })
    fs.mkdirSync(path.join(k.dir, 'forwarder'), { recursive: true })
    const config = path.join(k.dir, 'forwarder', 'config.json')
    fs.writeFileSync(config, k.build())
    fs.writeFileSync(path.join(k.dir, 'forwarder.lock'), JSON.stringify({ pid: 777, startedAt: START, endpoint: 'tcp:127.0.0.1:18899', config }))
    k.alive.clear()
    const a = await k.fwd.adopt()
    assert.deepEqual([a.adopted, a.reason, a.orphan_killed], [false, 'not-running', { pid: 555, ports: [18801] }], 'not adopted (its lock named a dead pid), and the orphan is said')
    assert.deepEqual(killed, [555], 'the orphan was killed, hard')
    assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')), 'the stale lock is cleaned')
    assert.deepEqual(k.events.states.at(-1), { event: 'forwarder-stop', where: 'forwarder', pid: 555, reason: 'orphan-killed: the lock named a dead pid and a live kernel of ours held its ports' })
    assert.deepEqual(inClosedSets(k.events), [], 'W38: the orphan record is in the closed sets')
    assert.equal(k.children.length, 0, 'adopting never spawns')
  }
  // a holder that is not our image is somebody else's port-holder: never touched
  {
    const k = await world([{ port: 18801, pid: 556, image: 'someone-else.exe' }], { fwd: { killPid: (pid) => killed.push(pid) } })
    const fwd2 = createForwarder({ dir: k.dir, bin: path.join(k.dir, 'kernel', KERNEL_EXE), controller: { port: 18899, secret: 'x' }, isFree: async () => true, procStart: async () => START, isAlive: () => false, events: k.events, portHolders: holdersOf([{ port: 18801, pid: 556, image: 'someone-else.exe' }]), killPid: (pid) => killed.push(pid) })
    const a = await fwd2.adopt()
    assert.deepEqual([a.adopted, a.reason, a.orphan_killed, killed], [false, 'not-running', undefined, [555]], 'a port holder that is not the kernel\'s image is not ours to kill')
    assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')))
  }
  // no portHolders given (the darwin wiring today): the old behaviour, lock cleaned, nobody touched
  {
    const k = await world([], { fwd: { killPid: (pid) => killed.push(pid) } })
    const fwd3 = createForwarder({ dir: k.dir, bin: path.join(k.dir, 'kernel', KERNEL_EXE), controller: { port: 18899, secret: 'x' }, isFree: async () => true, procStart: async () => START, isAlive: () => false, events: k.events, killPid: (pid) => killed.push(pid) })
    assert.deepEqual(await fwd3.adopt(), { adopted: false, reason: 'not-running' })
    assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder.lock')), 'the lock goes either way')
    assert.deepEqual(killed, [555], 'nobody was killed')
  }
  // a portHolders that throws: not a verdict, nothing is killed, the adopt still answers
  {
    const k = await world([], {})
    const fwd4 = createForwarder({ dir: k.dir, bin: path.join(k.dir, 'kernel', KERNEL_EXE), controller: { port: 18899, secret: 'x' }, isFree: async () => true, procStart: async () => START, isAlive: () => false, events: k.events, portHolders: async () => { throw new Error('netstat is not answering') }, killPid: (pid) => killed.push(pid) })
    assert.deepEqual(await fwd4.adopt(), { adopted: false, reason: 'not-running' })
    assert.deepEqual(killed, [555])
    assert.deepEqual(k.events.failures.filter((f) => f.code === 'forwarder-start-failed').map((f) => f.reason), ['netstat is not answering; whether an orphan kernel holds the group ports could not be told, and a later start may meet port-taken'], 'the question that could not be asked is said, not swallowed')
  }
})

test('W28 a helper that cannot say when a process started (timeout, helper down) does not break the kernel: it is tracked and stoppable, the lock says startedAt null (so a later daemon will not adopt it), a respawn is not a failure; adopt answers start-time-unreadable instead of throwing; procStart is not optional', async (t) => {
  const late = async () => { throw Object.assign(new Error('late'), { code: 'helper-timeout' }) }
  const k = await kernelWorld(t, { procStart: late })
  const r = await k.fwd.start({ build: k.build, forms: FORMS })
  assert.deepEqual([r.ok, k.fwd.state().phase, k.fwd.state().pid], [true, 'running', r.pid], 'the kernel answered: a start time that cannot be read is not a failed start')
  assert.deepEqual(JSON.parse(fs.readFileSync(k.P.lock, 'utf8')), { pid: r.pid, startedAt: null, endpoint: `tcp:127.0.0.1:${k.ports.controller}`, config: k.P.config })
  assert.deepEqual(k.events.failures, [])
  assert.deepEqual(await k.fwd.stopNow(), { pids: [], stopped: true }, 'and it can be stopped: nothing is left holding its ports')
  assert.equal(await isFree(k.ports.controller), true)
  const f = await fakeKernel(t, { fwd: { procStart: late } })
  assert.equal((await f.start()).ok, true)
  f.die(f.children[0]); await settle()
  await f.clock.advance(1000)
  assert.deepEqual([f.children.length, f.fwd.state().phase, restarts(f), f.events.failures.some((e) => e.code === 'forwarder-down')], [2, 'running', [1000], false], 'a respawn whose start time cannot be read is a respawn')
  const g = await fakeKernel(t, { fwd: { procStart: late } })
  const config = path.join(g.dir, 'forwarder', 'config.json')
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, g.build())
  fs.writeFileSync(path.join(g.dir, 'forwarder.lock'), JSON.stringify({ pid: 777, startedAt: START, endpoint: 'tcp:127.0.0.1:18899', config }))
  g.alive.add(777)
  assert.deepEqual(await g.fwd.adopt(), { adopted: false, reason: 'start-time-unreadable' }, 'a rejecting helper is "cannot read", the same as null')
  assert.throws(() => createForwarder({ dir: g.dir, bin: path.join(g.dir, 'kernel', KERNEL_EXE), controller: { port: 1, secret: 'x' }, isFree }), TypeError, 'procStart is required: a wiring that forgot it would write locks nobody can adopt')
})

test('W28 an adopted kernel that dies is respawned like one asight started (the config it left on disk, the copy checked first)', async (t) => {
  const k = await fakeKernel(t, { fwd: { procStart: async () => START, watchMs: 500 } })
  const config = path.join(k.dir, 'forwarder', 'config.json')
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, k.build())
  fs.writeFileSync(path.join(k.dir, 'forwarder.lock'), JSON.stringify({ pid: 777, startedAt: START, endpoint: 'tcp:127.0.0.1:18899', config }))
  k.alive.add(777)
  assert.equal((await k.fwd.adopt()).adopted, true)
  await k.clock.advance(5000)
  assert.deepEqual([k.children.length, restarts(k)], [0, []], 'alive: nothing to do')
  k.alive.delete(777)
  await k.clock.advance(500)
  assert.deepEqual(restarts(k), [1000])
  await k.clock.advance(1000)
  assert.deepEqual([k.children.length, k.verified.length, k.fwd.state().phase, k.fwd.state().adopted], [1, 1, 'running', false])
})

/** A fake kernel whose /version answers only when the test lets it: `hold()` before a re-spawn and the supervisor's own attempt stays in flight (spawned, not yet answered) until `open()`. */
async function slowKernel(t, { window = [] } = {}) {
  const gate = { p: null, open: () => {}, hold() { this.p = new Promise((r) => { this.open = r }) } }
  const makeController = () => ({ get: async (q) => { if (q === '/version') { if (gate.p) await gate.p; return { ok: true, status: 200, json: { version: 'fake' } } } return { ok: true, status: 200, json: { now: 'asight-in-claude-code.cli' } } }, put: async () => ({ ok: true, status: 204 }) })
  const k = await fakeKernel(t, { fwd: { makeController } })
  await k.start()
  for (const pid of window) k.alive.add(pid)
  const drained = window.length ? k.fwd.drain({ pidsInWindow: window }) : null
  k.die(k.children[0]); await settle()
  gate.hold()
  await k.clock.advance(1000) // the re-spawn's timer fires: the second kernel is spawned and its controller does not answer yet
  assert.deepEqual([k.children.length, k.fwd.state().phase], [2, 'starting'], 'the re-spawn is in flight')
  return { k, gate, drained }
}

test('W28 stopNow while a re-spawn is in flight: the kernel the attempt spawned is killed before stopNow answers, nothing is committed (no lock, no pid), and no re-spawn follows', async (t) => {
  const { k, gate } = await slowKernel(t)
  const stopped = k.fwd.stopNow()
  gate.open() // the kernel answers after it was asked to stop
  assert.deepEqual(await stopped, { pids: [], stopped: true })
  assert.deepEqual([k.alive.size, fs.existsSync(path.join(k.dir, 'forwarder.lock')), k.fwd.state().phase, k.fwd.state().pid], [0, false, 'stopped', null], 'a kernel is alive after stopNow said it stopped it: uninstall\'s removeBinary would fail on it')
  await k.clock.advance(300_000)
  assert.deepEqual([k.children.length, k.clock.pending(), k.events.states.filter((e) => e.event === 'forwarder-start').length], [2, [], 1], 'the aborted attempt is not a start and not a failure')
  assert.deepEqual(k.events.failures.map((f) => f.code), ['forwarder-restart'], 'only the restart that was announced')
})

test('W28 stopNow does not wait for a kernel that is not answering: the attempt sees it at its next poll, kills the child and returns (the fake clock never reaches startTimeoutMs, so only that check can end it)', { timeout: 10_000 }, async (t) => {
  let up = true
  const makeController = () => ({ get: async (q) => (q === '/version' && !up ? { ok: false, status: 0, error: 'ECONNREFUSED' } : { ok: true, status: 200, json: { now: 'asight-in-claude-code.cli' } }), put: async () => ({ ok: true, status: 204 }) })
  const k = await fakeKernel(t, { fwd: { makeController, startTimeoutMs: 10_000 } })
  await k.start()
  k.die(k.children[0]); await settle()
  up = false
  await k.clock.advance(1000)
  assert.deepEqual([k.children.length, k.fwd.state().phase], [2, 'starting'], 'the re-spawn is polling a kernel that does not answer')
  assert.deepEqual(await k.fwd.stopNow(), { pids: [], stopped: true })
  assert.deepEqual([k.alive.size, k.fwd.state().phase], [0, 'stopped'])
})

test('W28 a re-spawn whose timer fired while a call was in front of it finds the kernel already up and spawns nothing', async (t) => {
  const gate = { p: null, open: () => {}, hold() { this.p = new Promise((r) => { this.open = r }) } }
  const makeController = () => ({ get: async (q) => (q === '/version' ? { ok: true, status: 200, json: { version: 'fake' } } : { ok: true, status: 200, json: { now: 'asight-in-claude-code.cli' } }), put: async () => { if (gate.p) await gate.p; return { ok: true, status: 204 } } })
  const k = await fakeKernel(t, { fwd: { makeController } })
  await k.start()
  gate.hold()
  const slow = k.fwd.reload({ build: k.build, forms: k.forms }) // sits in its PUT, holding its turn
  await settle()
  k.die(k.children[0]); await settle() // the kernel dies meanwhile: a re-spawn is set for 1 s
  const next = k.fwd.start({ build: k.build, forms: k.forms }) // queued behind the reload
  await k.clock.advance(1000) // the re-spawn's timer fires: queued behind both
  gate.open()
  await slow; await next; await settle()
  assert.deepEqual([k.children.length, k.alive.size, k.fwd.state().phase], [2, 1, 'running'], 'the start brought it up; the re-spawn behind it has nothing to do')
})

test('W28 reload and start while a re-spawn is in flight wait for it and then act on what is there: one kernel, never two', async (t) => {
  for (const op of ['reload', 'start']) {
    const { k, gate } = await slowKernel(t)
    const answer = k.fwd[op]({ build: k.build, forms: k.forms })
    gate.open()
    const r = await answer
    assert.deepEqual([r.ok, k.children.length, k.alive.size, k.fwd.state().phase], [true, 2, 1, 'running'], `${op}: a second kernel would lose on port-taken on a real machine and fail \`on\` for nothing`)
    assert.deepEqual(r.readBack.forms, { 'claude-code.cli': { state: 'on', now: 'asight-in-claude-code.cli' } })
  }
})

test('W28 drain: after an off the kernel stays until the agents that were in the window have exited, status counts them, the kernel is stopped when the last one is gone; a kernel that dies meanwhile is respawned (they still need it)', async (t) => {
  const k = await fakeKernel(t, { fwd: { watchMs: 1000 } })
  await k.start()
  k.alive.add(11); k.alive.add(12)
  const d = k.fwd.drain({ pidsInWindow: [11, 12] })
  assert.deepEqual([d.remaining, k.fwd.remaining(), k.fwd.state().draining], [2, [11, 12], 2])
  assert.deepEqual(k.events.states.at(-1), { event: 'forwarder-draining', where: 'forwarder', pids: [11, 12] })
  let done = false
  d.done.then(() => { done = true })
  await k.clock.advance(120_000)
  assert.deepEqual([done, k.fwd.state().phase, k.alive.has(k.children[0].pid)], [false, 'running', true], 'two agents are still there: the kernel stays')
  k.die(k.children[0]); await settle()
  await k.clock.advance(1000)
  assert.equal(k.children.length, 2, 'it died while they were using it: it comes back')
  k.alive.delete(11)
  await k.clock.advance(1000)
  assert.deepEqual([k.fwd.state().draining, done], [1, false])
  k.alive.delete(12)
  await k.clock.advance(1000)
  assert.deepEqual(await d.done, { stopped: true })
  assert.deepEqual([k.fwd.state().phase, k.alive.has(k.children[1].pid), fs.existsSync(path.join(k.dir, 'forwarder.lock'))], ['stopped', false, false])
  assert.deepEqual(k.events.states.at(-1), { event: 'forwarder-stop', where: 'forwarder', pid: k.children[1].pid, reason: 'drained' })
  assert.deepEqual(inClosedSets(k.events), [], 'W38: draining and stop records are in the closed sets')
  const empty = await fakeKernel(t)
  await empty.start()
  const e = empty.fwd.drain({ pidsInWindow: [] })
  await empty.clock.advance(1)
  assert.deepEqual([e.remaining, await e.done], [0, { stopped: true }], 'nobody in the window: nothing to wait for')
})

test('W28 `on` while the kernel is draining takes the drain back: reload or start with a form on cancels it (`done` says cancelled, so the daemon does not exit; the window\'s pids leaving later stop nothing); a reload that leaves every form off leaves the drain alone; a second drain joins the first', async (t) => {
  const a = await fakeKernel(t, { fwd: { watchMs: 1000 } })
  await a.start()
  a.alive.add(11); a.alive.add(12)
  const d = a.fwd.drain({ pidsInWindow: [11] })
  assert.equal(a.fwd.drain({ pidsInWindow: [12] }).done, d.done, 'one drain, one done: a second `off` adds its pids')
  assert.deepEqual(a.fwd.remaining(), [11, 12])
  let settled
  d.done.then((v) => { settled = v })
  await a.fwd.reload({ build: a.build, forms: a.forms.map((f) => ({ ...f, on: false })) })
  await settle()
  assert.deepEqual([settled, a.fwd.state().draining], [undefined, 2], 'forms that are all off are no `on`: the drain goes on')
  assert.equal((await a.fwd.reload({ build: a.build, forms: a.forms })).ok, true)
  await settle()
  assert.deepEqual([settled, a.fwd.state().draining], [{ stopped: false, cancelled: true }, 0])
  a.alive.delete(11); a.alive.delete(12)
  await a.clock.advance(120_000)
  assert.deepEqual([a.fwd.state().phase, a.alive.has(a.children[0].pid), a.events.states.some((e) => e.event === 'forwarder-stop')], ['running', true, false], 'the last pid left after the `on`: the proxy entries just written still point at a live kernel')

  const b = await fakeKernel(t, { fwd: { watchMs: 1000 } })
  await b.start()
  b.alive.add(11)
  const e = b.fwd.drain({ pidsInWindow: [11] })
  let got
  e.done.then((v) => { got = v })
  b.die(b.children[0]); await settle() // the kernel dies during the drain: a re-spawn is waiting, and `on` starts it itself
  assert.equal((await b.fwd.start({ build: b.build, forms: b.forms })).ok, true)
  await settle()
  assert.deepEqual([got, b.children.length, b.fwd.state().draining], [{ stopped: false, cancelled: true }, 2, 0])
  b.alive.delete(11)
  await b.clock.advance(120_000)
  assert.deepEqual([b.fwd.state().phase, b.alive.has(b.children[1].pid)], ['running', true])
})

test('W28 the drain\'s last stop that is waiting behind a re-spawn does not stop what an `on` has taken the drain back for: one kernel is spawned and none is stopped', async (t) => {
  const { k, gate, drained } = await slowKernel(t, { window: [11] })
  let settled
  drained.done.then((v) => { settled = v })
  k.alive.delete(11)
  await k.clock.advance(1000) // the last agent has gone: the drain's stop queues behind the re-spawn that is still waiting for its kernel
  const on = k.fwd.reload({ build: k.build, forms: k.forms })
  gate.open()
  assert.equal((await on).ok, true)
  await settle()
  assert.deepEqual([settled, k.children.length, k.alive.size, k.fwd.state().phase, k.events.states.some((e) => e.event === 'forwarder-stop')], [{ stopped: false, cancelled: true }, 2, 1, 'running', false], 'the stop that was already queued must see that the drain is gone')
})

test('W28 off --now: the kernel is stopped at once and the pids that were still in the window are listed (they lose their connection)', async (t) => {
  const k = await fakeKernel(t)
  await k.start()
  k.alive.add(11); k.alive.add(12)
  const d = k.fwd.drain({ pidsInWindow: [11, 12, 13] })
  const r = await k.fwd.stopNow()
  assert.deepEqual(r, { pids: [11, 12], stopped: true }, '13 had exited')
  let done = null
  d.done.then((v) => { done = v })
  await k.clock.advance(60_000)
  assert.deepEqual([done, k.fwd.state().phase, k.clock.pending()], [{ stopped: true, now: true }, 'stopped', []], 'the drain is over with it: its promise settles, nothing is left waiting')
  assert.deepEqual([k.fwd.state().draining, k.fwd.remaining()], [0, []], 'and status does not count agents of a drain that no longer exists')
})

test('W28 uninstall: the kernel copy, the licence and source beside it, the archive cache (D44 ②), the config and the lock go; a file Windows still holds (a drain is on, the exe is running) stays, and the answer says why', async (t) => {
  const k = await kernelWorld(t, {})
  for (const name of [KERNEL_LICENSE, KERNEL_SOURCE]) fs.writeFileSync(path.join(path.dirname(k.bin), name), 'x')
  const cache = path.join(path.dirname(path.dirname(k.bin)), 'kernel-archive')
  fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'mihomo-windows-amd64-compatible-v1.19.32.zip'), 'the verified archive')
  await k.fwd.start({ build: k.build, forms: FORMS })
  await k.fwd.stopNow()
  assert.deepEqual(k.fwd.removeBinary(), { removed: true })
  assert.ok(!fs.existsSync(path.dirname(k.bin)), 'the kernel directory is gone with them')
  assert.ok(!fs.existsSync(cache), 'the verified-archive cache goes with the copy (D44 ②: uninstall deletes it, not just kernel\\)')
  assert.deepEqual(k.fwd.removeState(), { removed: true })
  assert.ok(!fs.existsSync(path.join(k.dir, 'forwarder')) && !fs.existsSync(k.P.lock), 'no config (it holds the secret and the tokens), no home, no lock')
  const busy = await kernelWorld(t, { fs: { ...fs, rmSync: () => { throw Object.assign(new Error('the process cannot access the file'), { code: 'EBUSY' }) } } })
  assert.deepEqual(busy.fwd.removeBinary(), { removed: false, reason: 'EBUSY' })
  assert.ok(fs.existsSync(busy.bin), 'and the file is still there for the retry')
})
