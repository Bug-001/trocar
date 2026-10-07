#!/usr/bin/env node
// kernel-payload.mjs — a maintainer's build tool: the pinned mihomo zip → `asight-forwarder.exe` → the two platform packages and their tarballs (RFC 4.5 §A, 4.8 §8; acceptance W75).
//
//   node scripts/kernel-payload.mjs [--arch x64|arm64] [--out dist/kernel]    build the packages (the exe digests must be in the pin)
//   node scripts/kernel-payload.mjs --pin [--arch x64|arm64]                  print the exe size and sha256 of two independent downloads, for the pin; writes nothing
//
// This is the one place the kernel is downloaded (the maintainer's machine, at release time). It is not in the package's `files`, not the CLI and not under R8: `asight on` never downloads
// (4.8 §8), and nothing in `src/` imports this file (the test holds both). The zip's sha256 and size come from the pin; the extracted exe's from the pin too, and a build that cannot match either
// writes NO file under `--out`. The packages (`<out>/<package>/`, `package.json` generated from the pin and the main package's version) and their `npm pack` tarballs are the one set npm publishes and
// the Release attaches. The main package's manifest for a publish (the two `optionalDependencies`) is written to `<out>/main-package.json` for the publish step; the committed package.json is never touched.
// `download`, `exec` and `fs` are injected so the test runs it with no network.

import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PIN_FILE = path.join(ROOT, 'src', 'collector', 'arch', 'win32', 'mihomo-pin.json')
export const LICENSE_FILE = path.join(ROOT, 'LICENSE-mihomo.txt')
export const EXE = 'asight-forwarder.exe'
export const LICENSE = 'LICENSE-mihomo.txt'
export const SOURCE = 'SOURCE-mihomo.txt'
const sha = (b) => createHash('sha256').update(b).digest('hex')

export class PayloadError extends Error {
  constructor(code, message) { super(message); this.name = 'PayloadError'; this.code = code }
}

/** The platform package's manifest: only what npm needs to install it on the right machine. No `scripts` (no install, no postinstall), no `bin`, no dependencies. */
export function platformManifest({ pin, arch, version }) {
  const a = pin.assets[arch]
  return { name: a.package, version, description: `asight's own kernel for win32 ${arch}: mihomo ${pin.version}, renamed ${EXE}. ${pin.license}; source: ${pin.source}`, os: ['win32'], cpu: [arch], license: pin.license, files: [EXE, LICENSE, SOURCE] }
}
/** The main package's manifest for a publish to npm: the two platform packages as optional dependencies at the main package's own version. The input is not changed. */
export function mainManifestForPublish({ main, pin }) {
  return { ...main, optionalDependencies: Object.fromEntries(Object.values(pin.assets).map((a) => [a.package, main.version])) }
}
export const sourceText = ({ pin, arch }) => `${EXE} is mihomo ${pin.version} (${pin.assets[arch].variant}), as its authors build it, renamed.\nSource code: ${pin.source}\nLicense: ${pin.license} (${LICENSE})\n`

/** One download → the exe in it, checked: the zip's size and sha256 against the pin BEFORE anything is written, then `tar -xf` (bsdtar reads zip; Windows 10 1803 and macOS have it) in a work directory that is always removed. */
async function fetchExe({ pin, arch, download, exec, fs, workRoot }) {
  const a = pin.assets[arch]
  if (!a) throw new PayloadError('unsupported-arch', `the pin has no ${arch}`)
  const zip = Buffer.from(await download(a.url))
  if (sha(zip) !== a.sha256 || (a.size != null && zip.length !== a.size)) throw new PayloadError('zip-digest-mismatch', `${a.name}: the download is not the pinned zip (sha256 ${sha(zip)}, ${zip.length} bytes)`)
  const work = fs.mkdtempSync(path.join(workRoot, 'asight-kernel-'))
  try {
    const zipPath = path.join(work, a.name)
    const into = path.join(work, 'x')
    fs.writeFileSync(zipPath, zip)
    fs.mkdirSync(into)
    await exec('tar', ['-xf', zipPath, '-C', into])
    const exes = fs.readdirSync(into).filter((n) => /\.exe$/i.test(n))
    if (exes.length !== 1) throw new PayloadError('exe-not-found', `${a.name} holds ${exes.length} .exe files, expected one`)
    const exe = fs.readFileSync(path.join(into, exes[0]))
    return { exe, size: exe.length, sha256: sha(exe) }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** `--pin`: two independent downloads per arch, each checked against the zip's pin; they must agree on the exe. → `{ <arch>: { name, size, sha256 } }`, for the operator to put in the pin. Writes nothing. */
export async function pinExes({ pin, arches = Object.keys(pin.assets), download, exec, fs = nodeFs, workRoot = os.tmpdir() }) {
  const out = {}
  for (const arch of arches) {
    const one = await fetchExe({ pin, arch, download, exec, fs, workRoot })
    const two = await fetchExe({ pin, arch, download, exec, fs, workRoot })
    if (one.sha256 !== two.sha256 || one.size !== two.size) throw new PayloadError('downloads-disagree', `${arch}: two downloads gave different exes (${one.sha256} and ${two.sha256})`)
    out[arch] = { name: EXE, size: one.size, sha256: one.sha256 }
  }
  return out
}

/** Build the packages. Everything is checked before the first byte is written under `out`: the licence text against the pin, each zip, each exe. → `{ packages: [{ arch, name, dir, tarball, sha256 }], mainManifest }`. */
export async function buildPayload({ pin, main, out, arches = Object.keys(pin.assets), download, exec, fs = nodeFs, workRoot = os.tmpdir(), licensePath = LICENSE_FILE }) {
  const license = fs.readFileSync(licensePath)
  if (sha(license) !== pin.licenseFile.sha256) throw new PayloadError('license-digest-mismatch', `${licensePath} is not the licence text the pin names`)
  for (const arch of arches) {
    const want = pin.assets[arch] && pin.assets[arch].exe
    if (!want || want.sha256 === null) throw new PayloadError('not-pinned', `${arch}: the pin has no exe digest yet: run \`node scripts/kernel-payload.mjs --pin\` and put it in the pin`)
  }
  const staged = []
  for (const arch of arches) {
    const want = pin.assets[arch].exe
    const got = await fetchExe({ pin, arch, download, exec, fs, workRoot })
    if (got.sha256 !== want.sha256 || (want.size != null && got.size !== want.size)) throw new PayloadError('exe-digest-mismatch', `${arch}: the exe in the zip is not the pinned one (sha256 ${got.sha256})`)
    staged.push({ arch, ...got })
  }
  fs.mkdirSync(out, { recursive: true })
  const packages = []
  for (const s of staged) {
    const manifest = platformManifest({ pin, arch: s.arch, version: main.version })
    const dir = path.join(out, manifest.name)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    fs.writeFileSync(path.join(dir, EXE), s.exe)
    fs.writeFileSync(path.join(dir, LICENSE), license)
    fs.writeFileSync(path.join(dir, SOURCE), sourceText({ pin, arch: s.arch }))
    await exec('npm', ['pack', dir, '--pack-destination', out, '--offline', '--ignore-scripts'])
    packages.push({ arch: s.arch, name: manifest.name, dir, tarball: path.join(out, `${manifest.name}-${manifest.version}.tgz`), sha256: s.sha256 })
  }
  const mainManifest = path.join(out, 'main-package.json')
  fs.writeFileSync(mainManifest, `${JSON.stringify(mainManifestForPublish({ main, pin }), null, 2)}\n`)
  return { packages, mainManifest }
}

const defaultDownload = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()) }
const defaultExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd, args, { shell: process.platform === 'win32' && cmd === 'npm', maxBuffer: 16 << 20 }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve({ stdout, stderr })))
})

async function cli(argv) {
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
  const pin = JSON.parse(nodeFs.readFileSync(PIN_FILE, 'utf8'))
  const arches = flag('--arch') ? [flag('--arch')] : Object.keys(pin.assets)
  if (argv.includes('--pin')) {
    console.log(JSON.stringify(await pinExes({ pin, arches, download: defaultDownload, exec: defaultExec }), null, 2))
    return
  }
  const main = JSON.parse(nodeFs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const r = await buildPayload({ pin, main, arches, out: path.resolve(flag('--out') || path.join(ROOT, 'dist', 'kernel')), download: defaultDownload, exec: defaultExec })
  for (const p of r.packages) console.log(`${p.name}  ${p.dir}  ${p.tarball}  exe sha256 ${p.sha256}`)
  console.log(`main package manifest for a publish: ${r.mainManifest}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(process.argv.slice(2)).catch((e) => { console.error(e instanceof PayloadError ? `${e.code}: ${e.message}` : e); process.exit(1) })
