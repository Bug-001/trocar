// release.mjs — the local gate before publishing (spec 4.5, release check): `node scripts/release.mjs check|pack`.
// Exit 0 = every check passed (pack: dist/<tarball> and dist/SHA256SUMS written); 1 = a check or the pack failed; 2 = usage.
// Each failed check is one stderr line `release: <check id>: <why>`; the ids are the closed set in 4.5.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NATIVE, pins, sha256 } from '../src/collector/arch/darwin/native.mjs'

const NATIVE_DIR = 'src/collector/arch/darwin/native'
const LIFECYCLE = 'prepare prepack postpack prepublish prepublishOnly publish postpublish preinstall install postinstall preuninstall uninstall postuninstall preversion version postversion dependencies'.split(' ')
const ALWAYS = /^(README|LICENSE|LICENCE)(\.[^/]*)?$/i // npm packs these whatever `files` says

// (target, format) of install/node.sha256: one line each (spec 4.5 §A, release check `node-pin`)
const NODE_BUILDS = ['darwin-arm64.tar.xz', 'darwin-x64.tar.xz', 'linux-x64.tar.xz', 'linux-x64.tar.gz', 'linux-arm64.tar.xz', 'linux-arm64.tar.gz', 'win-x64.zip', 'win-arm64.zip']
const SCRIPTS = ['install/install.sh', 'install/install.ps1']
const MAX_PATH = 259 // a Windows path, without long-path support

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The `docs/release-notes/*.md` paths linked from the `## [<version>]` section of the changelog; null when there is no such section. */
function noteLinks(changelog, version) {
  const lines = String(changelog ?? '').split('\n')
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escape(version)}\\]( - \\d{4}-\\d{2}-\\d{2})?\\s*$`).test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
  return [...body.matchAll(/\]\((docs\/release-notes\/[^)\s]+\.md)\)/g)].map((m) => m[1])
}

/** The data lines of a script's `# >>> SOURCES` … `# <<< SOURCES` block; null when there is none. */
const sourcesOf = (text) => {
  const m = /^# >>> SOURCES.*\n([\s\S]*?)^# <<< SOURCES/m.exec(text)
  return m && m[1].split('\n').filter((l) => /^(package|registry|node) /.test(l))
}

/** Why the two installer scripts would not ship as they are; '' when they would. */
function installerWhy({ sh, ps1, shSyntax } = {}, packed, name) {
  if (!SCRIPTS.every((p) => packed.has(p))) return `not in the pack list: ${SCRIPTS.filter((p) => !packed.has(p)).join(', ')}`
  const text = { 'install.sh': sh, 'install.ps1': ps1 }
  for (const [n, b] of Object.entries(text)) if (!b || [...Buffer.from(b)].some((x) => x > 0x7f)) return `${n} is missing or not pure ASCII`
  if (Buffer.from(sh).includes(13)) return 'install.sh has a CR'
  if (shSyntax !== 0) return 'sh -n install.sh fails'
  const [a, b] = [sourcesOf(String(sh)), sourcesOf(String(ps1))]
  if (!a?.length || a.join('\n') !== b?.join('\n')) return 'the SOURCES data lines of install.sh and install.ps1 differ'
  if (!a.includes(`package ${name}`)) return `the SOURCES block does not name the package ${name}`
  return ''
}

/** Why install/node.sha256 is not one verbatim SHASUMS256.txt line per Node build of one version that `engines` allows; '' when it is. */
function nodePinWhy(pin, shasums, engines) {
  const lines = String(pin ?? '').split('\n').filter(Boolean)
  const rows = lines.map((l) => /^[0-9a-f]{64} {2}node-v(\d+)\.(\d+)\.(\d+)-(\S+)$/.exec(l))
  if (!rows.length || rows.some((m) => !m)) return 'install/node.sha256 is missing or has a line that is not `<sha256>  node-v<version>-<build>`'
  const versions = new Set(rows.map((m) => m.slice(1, 4).join('.')))
  if (versions.size !== 1) return `more than one Node version: ${[...versions].join(', ')}`
  const builds = rows.map((m) => m[4]).sort()
  if (builds.join() !== [...NODE_BUILDS].sort().join()) return `the builds are not one each of ${NODE_BUILDS.join(', ')}`
  const want = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(engines ?? '').trim())
  const have = rows[0].slice(1, 4).map(Number)
  const below = want && want.slice(1, 4).map((x) => Number(x ?? 0)).reduce((r, w, i) => r ?? (have[i] === w ? null : have[i] < w), null)
  if (!want || below) return `Node ${[...versions][0]} does not satisfy engines ${engines}`
  if (shasums == null) return `https://nodejs.org/dist/v${[...versions][0]}/SHASUMS256.txt could not be read`
  const official = new Set(String(shasums).split('\n'))
  const odd = lines.filter((l) => !official.has(l))
  return odd.length ? `not in SHASUMS256.txt: ${odd.join('; ')}` : ''
}

/** facts → [{ check, why }]; empty = pass. Pure: everything it reads is in `facts`. */
export function releaseVerdict(f) {
  const out = []
  const fail = (check, why) => out.push({ check, why })
  const { pkg } = f
  const packed = new Map((f.pack?.files ?? []).map((x) => [x.path, x.mode]))
  const exec = (p) => packed.has(p) && (packed.get(p) & 0o100) !== 0

  if (f.branch !== 'main') fail('branch', `on ${f.branch}, not main`)
  else if (!f.head || f.head !== f.originMain) fail('branch', 'HEAD is not origin/main')
  if (String(f.porcelain ?? '').trim()) fail('clean', 'the working tree has changes or untracked files')
  const view = f.npmView ?? {}
  if (!/E404/.test(`${view.out}${view.err}`) && !(view.code === 0 && !String(view.out ?? '').trim())) {
    fail('unpublished', view.code === 0 ? `${pkg.name}@${pkg.version} is already on the registry` : `the registry could not say whether ${pkg.name}@${pkg.version} exists`)
  }
  if (f.tags?.length) fail('tag', `tag v${pkg.version} exists`)
  if (!f.licenseFile || !packed.has('LICENSE') || !String(pkg.license ?? '').trim()) fail('license', 'LICENSE must exist, be packed, and package.json must name a license')
  if (pkg.private === true) fail('private', 'package.json says private')
  const hooks = LIFECYCLE.filter((n) => pkg.scripts && n in pkg.scripts)
  if (hooks.length) fail('lifecycle', `package.json has lifecycle scripts: ${hooks.join(', ')}`)
  const entries = (pkg.files ?? []).map((e) => e.replace(/^\.\//, '').replace(/\/+$/, ''))
  const stray = [...packed.keys()].filter((p) => p.endsWith('.ndjson') || !(p === 'package.json' || ALWAYS.test(p) || entries.some((e) => p === e || p.startsWith(`${e}/`))))
  if (stray.length) fail('files', `unexpected packed paths: ${stray.join(', ')}`)
  const bins = Object.values(typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin ?? {}).map((b) => b.replace(/^\.\//, ''))
  const badBins = bins.filter((b) => !exec(b))
  if (badBins.length) fail('bin', `not packed with an execute bit: ${badBins.join(', ')}`)
  const names = Object.values(NATIVE)
  const badNative = names.filter((n) => !exec(`${NATIVE_DIR}/${n}`))
  if (badNative.length) fail('native', `not packed with an execute bit: ${badNative.join(', ')}`)
  const badPins = names.filter((n) => !f.diskSha?.[n] || f.diskSha[n] !== f.pins?.[n])
  if (badPins.length) fail('pins', `sha256 on disk differs from pins.json: ${badPins.join(', ')}`)
  const inst = installerWhy(f.installer, packed, pkg.name)
  if (inst) fail('installer', inst)
  const pin = nodePinWhy(f.nodePin, f.nodeShasums, pkg.engines?.node)
  if (pin) fail('node-pin', pin)
  const prefix = `C:\\Users\\${'x'.repeat(32)}\\.trocar\\app\\.staging-99999\\${pkg.version}\\`
  const longest = [...packed.keys()].reduce((a, p) => (p.length > a.length ? p : a), '')
  if (prefix.length + longest.length > MAX_PATH) fail('pathlen', `${longest} is ${prefix.length + longest.length} characters long once placed (at most ${MAX_PATH})`)
  const links = noteLinks(f.changelog, pkg.version)
  if (!links) fail('notes', `CHANGELOG.md has no ## [${pkg.version}] section`)
  else if (!links.length) fail('notes', `the ## [${pkg.version}] section links no docs/release-notes/*.md`)
  else {
    const missing = links.filter((l) => !f.exists(l))
    if (missing.length) fail('notes', `linked notes missing: ${missing.join(', ')}`)
  }
  return out
}

const realRun = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { ...opts, encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm' })
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr || (r.error ? String(r.error.message) : '') }
}
const stdio = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }
const realFetch = async (url) => { try { const r = await fetch(url); return r.ok ? await r.text() : null } catch { return null } }
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Gathers the facts with `run` (git, npm, sh), `fetchText` (nodejs.org) and the files under `root`; `facts` overrides any of them. */
async function gather(root, run, fetchText, overrides) {
  const opts = { cwd: root }
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel)) } catch { return null } }
  const line = (args) => { const r = run('git', args, opts); return r.code === 0 ? r.out.trim() : null }
  const pkg = JSON.parse(read('package.json'))
  const fetched = run('git', ['fetch', 'origin', 'main', '--tags'], opts).code === 0
  const status = run('git', ['status', '--porcelain'], opts)
  const tags = line(['tag', '-l', `v${pkg.version}`])
  const dry = run('npm', ['pack', '--dry-run', '--json'], opts)
  let pack = null
  try { pack = JSON.parse(dry.out)[0] } catch { /* the pack list is empty: files / bin / native / license fail */ }
  const changelog = read('CHANGELOG.md')
  const nodePin = read('install/node.sha256')?.toString('utf8') ?? null
  const nodeVer = /node-v(\d+\.\d+\.\d+)-/.exec(nodePin ?? '')?.[1]
  return {
    pkg,
    branch: line(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: line(['rev-parse', 'HEAD']),
    originMain: fetched ? line(['rev-parse', 'origin/main']) : null,
    porcelain: status.code === 0 ? status.out : status.err || 'git status failed',
    tags: tags === null ? ['(git tag failed)'] : tags.split('\n').filter(Boolean),
    npmView: run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version', '--json'], opts),
    licenseFile: fs.existsSync(path.join(root, 'LICENSE')),
    pack,
    diskSha: Object.fromEntries(Object.values(NATIVE).map((n) => { const b = read(`${NATIVE_DIR}/${n}`); return [n, b && sha256(b)] })),
    pins: pins(),
    changelog: changelog && changelog.toString('utf8'),
    installer: { sh: read(SCRIPTS[0]), ps1: read(SCRIPTS[1]), shSyntax: run('sh', ['-n', SCRIPTS[0]], opts).code },
    nodePin,
    nodeShasums: nodeVer ? await fetchText(`https://nodejs.org/dist/v${nodeVer}/SHASUMS256.txt`) : null,
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    ...overrides,
  }
}

/** argv = ['check'] | ['pack'] → exit code. */
export async function main(argv, { io = stdio, root = REPO, run = realRun, fetchText = realFetch, facts = {} } = {}) {
  if (argv.length !== 1 || !['check', 'pack'].includes(argv[0])) { io.err('usage: node scripts/release.mjs check|pack'); return 2 }
  const f = await gather(root, run, fetchText, facts)
  const verdict = releaseVerdict(f)
  for (const { check, why } of verdict) io.err(`release: ${check}: ${why}`)
  if (verdict.length) return 1
  if (argv[0] === 'check') { io.out(`release: ${f.pkg.name}@${f.pkg.version} is ready`); return 0 }

  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.rmSync(path.join(dist, 'SHA256SUMS'), { force: true })
  const r = run('npm', ['pack', '--pack-destination', 'dist', '--json'], { cwd: root })
  let name = null
  try { name = JSON.parse(r.out)[0].filename } catch { /* reported below */ }
  let tgz = null
  try { tgz = name && fs.readFileSync(path.join(dist, name)) } catch { /* reported below */ }
  if (r.code !== 0 || !tgz) { io.err(`release: pack: npm pack did not write a tarball${r.err ? `: ${r.err.trim().split('\n').at(-1)}` : ''}`); return 1 }
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sha256(tgz)}  ${name}\n`)
  io.out(`release: wrote dist/${name} and dist/SHA256SUMS`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
