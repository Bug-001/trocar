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
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Gathers the facts with `run` (git, npm) and the files under `root`; `facts` overrides any of them. */
function gather(root, run, overrides) {
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
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    ...overrides,
  }
}

/** argv = ['check'] | ['pack'] → exit code. */
export async function main(argv, { io = stdio, root = REPO, run = realRun, facts = {} } = {}) {
  if (argv.length !== 1 || !['check', 'pack'].includes(argv[0])) { io.err('usage: node scripts/release.mjs check|pack'); return 2 }
  const f = gather(root, run, facts)
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
