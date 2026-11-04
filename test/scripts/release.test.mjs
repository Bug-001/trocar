// release.test.mjs — the local release gate (spec 4.5 release check, acceptance 3-4 and 10): closed check ids, exit codes, SHA256SUMS bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { NATIVE } from '../../src/collector/arch/darwin/native.mjs'
import { releaseVerdict, main } from '../../scripts/release.mjs'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const V = '0.9.0'
const NATIVE_DIR = 'src/collector/arch/darwin/native'
const NOTE = 'docs/release-notes/2026-11-01.md'
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n## [${V}] - 2026-11-01\n\n- [2026-11-01](${NOTE})\n\n## [0.1.0] - 2026-10-20\n\n- [2026-10-20](docs/release-notes/2026-10-20.md)\n`
const sha = (b) => createHash('sha256').update(b).digest('hex')
const nativeNames = Object.values(NATIVE)

const pkgJson = () => ({ name: 'trocar-cli', version: V, license: 'FSL-1.1-ALv2', engines: { node: '>=22' }, bin: { trocar: 'bin/trocar.mjs' }, files: ['bin/', 'src/', 'install/', 'README.md', 'LICENSE'], scripts: { test: 'node --test' } })
const SRC = 'package trocar-cli\nregistry https://registry.npmjs.org\nnode https://nodejs.org/dist\n'
const SH = `#!/bin/sh\n# >>> SOURCES\nSOURCES='\n${SRC}'\n# <<< SOURCES\n`
const PS1 = `& {\n# >>> SOURCES\n$SOURCES = @'\n${SRC}'@\n# <<< SOURCES\n}\n`
const BUILDS = ['darwin-arm64.tar.xz', 'darwin-x64.tar.xz', 'linux-x64.tar.xz', 'linux-x64.tar.gz', 'linux-arm64.tar.xz', 'linux-arm64.tar.gz', 'win-x64.zip', 'win-arm64.zip']
const PIN = BUILDS.map((b) => `${sha(b)}  node-v22.9.1-${b}\n`).join('')
const SHASUMS = `${sha('headers')}  node-v22.9.1-headers.tar.gz\n${PIN}`
const packFiles = () => [
  { path: 'package.json', mode: 0o644, size: 900 },
  { path: 'README.md', mode: 0o644, size: 5000 },
  { path: 'LICENSE', mode: 0o644, size: 4000 },
  { path: 'bin/trocar.mjs', mode: 0o755, size: 300 },
  { path: 'src/cli/main.mjs', mode: 0o644, size: 7000 },
  { path: 'install/install.sh', mode: 0o644, size: 9000 },
  { path: 'install/install.ps1', mode: 0o644, size: 9000 },
  { path: 'install/node.sha256', mode: 0o644, size: 700 },
  { path: `${NATIVE_DIR}/pins.json`, mode: 0o644, size: 200 },
  ...nativeNames.map((n) => ({ path: `${NATIVE_DIR}/${n}`, mode: 0o755, size: 50000 })),
]
const shas = Object.fromEntries(nativeNames.map((n) => [n, sha(`bytes of ${n}`)]))

function baseline() {
  const present = new Set([NOTE, 'docs/release-notes/2026-10-20.md'])
  return {
    pkg: pkgJson(), branch: 'main', head: 'abc123', originMain: 'abc123', porcelain: '', tags: [],
    npmView: { code: 1, out: '', err: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/trocar-cli - Not found\n' },
    licenseFile: true, pack: { filename: `trocar-cli-${V}.tgz`, files: packFiles() },
    diskSha: { ...shas }, pins: { ...shas }, changelog: CHANGELOG, exists: (rel) => present.has(rel),
    installer: { sh: SH, ps1: PS1, shSyntax: 0 }, nodePin: PIN, nodeShasums: SHASUMS,
  }
}
const ids = (verdict) => verdict.map((v) => v.check).sort()
const dropPath = (f, p) => { f.pack.files = f.pack.files.filter((x) => x.path !== p) }
const setMode = (f, p, mode) => { f.pack.files.find((x) => x.path === p).mode = mode }

const MUTATIONS = [
  ['branch', 'not on main', (f) => { f.branch = 'dev' }],
  ['branch', 'HEAD is not origin/main', (f) => { f.originMain = 'def456' }],
  ['clean', 'an untracked file', (f) => { f.porcelain = '?? x\n' }],
  ['unpublished', 'the version is on the registry', (f) => { f.npmView = { code: 0, out: `"${V}"\n`, err: '' } }],
  ['unpublished', 'the registry could not be asked', (f) => { f.npmView = { code: 1, out: '', err: 'npm error code ENOTFOUND\n' } }],
  ['tag', 'the tag exists', (f) => { f.tags = [`v${V}`] }],
  ['license', 'no LICENSE file', (f) => { f.licenseFile = false }],
  ['license', 'LICENSE not packed', (f) => dropPath(f, 'LICENSE')],
  ['license', 'no license field', (f) => { delete f.pkg.license }],
  ['private', 'private: true', (f) => { f.pkg.private = true }],
  ['lifecycle', 'a postinstall script', (f) => { f.pkg.scripts.postinstall = 'node x.mjs' }],
  ['lifecycle', 'a prepare script', (f) => { f.pkg.scripts.prepare = 'node x.mjs' }],
  ['files', 'a path outside files', (f) => { f.pack.files.push({ path: 'test/x.mjs', mode: 0o644, size: 1 }) }],
  ['files', 'a capture file inside files', (f) => { f.pack.files.push({ path: 'src/a.ndjson', mode: 0o644, size: 1 }) }],
  ['bin', 'the bin is not executable', (f) => setMode(f, 'bin/trocar.mjs', 0o644)],
  ['bin', 'the bin is not packed', (f) => dropPath(f, 'bin/trocar.mjs')],
  ['native', 'a native file is not packed', (f) => dropPath(f, `${NATIVE_DIR}/${nativeNames[0]}`)],
  ['native', 'a native file is not executable', (f) => setMode(f, `${NATIVE_DIR}/${nativeNames.at(-1)}`, 0o644)],
  ['pins', 'a native file differs from its pin', (f) => { f.diskSha[nativeNames[1]] = sha('other') }],
  ['pins', 'a native file is unreadable', (f) => { f.diskSha[nativeNames[0]] = null }],
  ['notes', 'no section for the version', (f) => { f.changelog = CHANGELOG.replace(`## [${V}] - 2026-11-01`, '### later') }],
  ['notes', 'a linked note does not exist', (f) => { f.exists = () => false }],
  ['notes', 'the section links no note', (f) => { f.changelog = CHANGELOG.replace(`- [2026-11-01](${NOTE})`, 'Nothing yet.') }],
  ['notes', 'no CHANGELOG', (f) => { f.changelog = null }],
  ['installer', 'the SOURCES blocks differ', (f) => { f.installer.ps1 = PS1.replace('registry.npmjs.org', 'registry.example.com') }],
  ['node-pin', 'a pinned line is not in SHASUMS256.txt', (f) => { f.nodeShasums = SHASUMS.replace(/^.*win-arm64.*\n/m, '') }],
  ['pathlen', 'a packed path too long for a Windows profile', (f) => { f.pack.files.push({ path: `src/${'d'.repeat(200)}.mjs`, mode: 0o644, size: 1 }) }],
]

/** A repo root on disk plus a fake `run` that answers git and npm from `over` (the facts main gathers through run). */
function fixture(over = {}) {
  const root = tmpDir('trocar-release-')
  const put = (rel, bytes, mode = 0o644) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), bytes, { mode }) }
  put('package.json', JSON.stringify(pkgJson()))
  put('LICENSE', 'license text\n')
  put('CHANGELOG.md', CHANGELOG)
  put(NOTE, '# notes\n')
  for (const n of nativeNames) put(`${NATIVE_DIR}/${n}`, `bytes of ${n}`, 0o755)
  put('install/install.sh', SH); put('install/install.ps1', PS1); put('install/node.sha256', PIN)
  const b = { ...baseline(), ...over }
  const calls = []
  const run = (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '))
    const a = args.join(' ')
    if (cmd === 'git' && a === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: `${b.branch}\n`, err: '' }
    if (cmd === 'git' && a === 'rev-parse HEAD') return { code: 0, out: `${b.head}\n`, err: '' }
    if (cmd === 'git' && a === 'rev-parse origin/main') return { code: 0, out: `${b.originMain}\n`, err: '' }
    if (cmd === 'git' && args[0] === 'fetch') return { code: 0, out: '', err: '' }
    if (cmd === 'git' && args[0] === 'status') return { code: 0, out: b.porcelain, err: '' }
    if (cmd === 'git' && args[0] === 'tag') return { code: 0, out: b.tags.map((t) => `${t}\n`).join(''), err: '' }
    if (cmd === 'sh' && a === '-n install/install.sh') return { code: 0, out: '', err: '' }
    if (cmd === 'npm' && args[0] === 'view') return b.npmView
    if (cmd === 'npm' && a === 'pack --dry-run --json') return { code: 0, out: JSON.stringify([b.pack]), err: '' }
    if (cmd === 'npm' && args[0] === 'pack') {
      if (b.packFails) return { code: 1, out: '', err: 'npm error pack failed\n' }
      const dest = path.join(opts.cwd, args[args.indexOf('--pack-destination') + 1])
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, b.pack.filename), TGZ)
      return { code: 0, out: JSON.stringify([{ filename: b.pack.filename, files: b.pack.files }]), err: '' }
    }
    throw new Error(`unexpected command ${cmd} ${a}`)
  }
  return { root, run, calls }
}
const TGZ = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])
const sink = () => { const lines = []; return { lines, io: { out: () => {}, err: (s) => lines.push(...s.split('\n').filter(Boolean)) } } }
const lineIds = (lines) => lines.map((l) => /^release: ([a-z-]+):/.exec(l)?.[1]).sort()
// diskSha comes from the files written above; pins() reads the package's own pins.json, so the fixture's pins are injected
const deps = (fx, io) => ({ io, root: fx.root, run: fx.run, fetchText: async () => SHASUMS, facts: { pins: { ...shas } } })

test('4.5 acceptance 3: from a passing fact set, breaking any one fact fails exactly that check id; main check exits 1 then, 0 when nothing is broken', async () => {
  assert.deepEqual(releaseVerdict(baseline()), [])
  const covered = new Set()
  for (const [id, label, mutate] of MUTATIONS) {
    const f = baseline()
    mutate(f)
    assert.deepEqual(ids(releaseVerdict(f)), [id], `${id}: ${label}`)
    covered.add(id)
  }
  assert.deepEqual([...covered].sort(), ['bin', 'branch', 'clean', 'files', 'installer', 'license', 'lifecycle', 'native', 'node-pin', 'notes', 'pathlen', 'pins', 'private', 'tag', 'unpublished'])

  const ok = fixture(); const s0 = sink()
  assert.equal(await main(['check'], deps(ok, s0.io)), 0)
  assert.deepEqual(s0.lines, [])
  const bad = fixture({ porcelain: '?? x\n' }); const s1 = sink()
  assert.equal(await main(['check'], deps(bad, s1.io)), 1)
  assert.deepEqual(lineIds(s1.lines), ['clean'])
})

test('4.5 acceptance 4: pack writes no tarball and no SHA256SUMS when a check fails or npm fails; when all pass SHA256SUMS is one sha256sum line of the tarball', async () => {
  const dist = (fx) => (fs.existsSync(path.join(fx.root, 'dist')) ? fs.readdirSync(path.join(fx.root, 'dist')) : [])

  const bad = fixture({ tags: [`v${V}`] }); const s1 = sink()
  assert.equal(await main(['pack'], deps(bad, s1.io)), 1)
  assert.deepEqual(lineIds(s1.lines), ['tag'])
  assert.deepEqual(dist(bad).filter((n) => n.endsWith('.tgz') || n === 'SHA256SUMS'), [])

  const npmFails = fixture({ packFails: true }); const s2 = sink()
  assert.equal(await main(['pack'], deps(npmFails, s2.io)), 1)
  assert.ok(!dist(npmFails).includes('SHA256SUMS'))

  const ok = fixture(); const s3 = sink()
  assert.equal(await main(['pack'], deps(ok, s3.io)), 0)
  const name = `trocar-cli-${V}.tgz`
  const tgz = fs.readFileSync(path.join(ok.root, 'dist', name))
  assert.equal(fs.readFileSync(path.join(ok.root, 'dist', 'SHA256SUMS'), 'utf8'), `${createHash('sha256').update(tgz).digest('hex')}  ${name}\n`)
})

test('release main: anything but check or pack is a usage error (exit 2)', async () => {
  const fx = fixture(); const s = sink()
  for (const argv of [['nope'], [], ['check', 'pack']]) assert.equal(await main(argv, deps(fx, s.io)), 2)
  assert.deepEqual(fx.calls, [])
})

test('the shipped installers pass the installer check, and the shipped Node pin is one line per build of one version engines allows', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel))
  const f = baseline()
  f.pkg.engines = JSON.parse(read('package.json')).engines
  f.installer = { sh: read('install/install.sh'), ps1: read('install/install.ps1'), shSyntax: 0 }
  f.nodePin = f.nodeShasums = read('install/node.sha256').toString('utf8') // whether nodejs.org lists it is the release run's network check
  assert.deepEqual(releaseVerdict(f), [])
})
