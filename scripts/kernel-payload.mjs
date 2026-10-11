#!/usr/bin/env node
// kernel-payload.mjs — the pin's maintainer tool, `--pin` only (RFC 4.5 §A, 4.8 §8; acceptance W75 as D44 left it): two independent downloads of each pinned
// archive, each checked against the pin's archive digest, must agree on the unpacked exe; it prints the archive's and the exe's size and sha256 — what the
// operator puts in the pin — and writes nothing. The build half (the platform packages, their tarballs, the publish manifest with `optionalDependencies`)
// retired with D44: the kernel is in no package any more, `on` downloads it (src/collector/arch/{win32,darwin}/kernel-download.mjs, the CLI's one online
// step). This script is not in the package's `files`, is not the CLI and is not under R8; nothing in `src/` imports it (the test holds that). `download`,
// `exec` and `fs` are injected so the test runs it with no network.
//
//   node scripts/kernel-payload.mjs --pin [--arch x64|arm64] [--pin-file <path>]
//
// The default pin is the win32 one; darwin's is named with --pin-file (its .gz asset — a gzip of the single binary, not a .zip — is unpacked with
// node:zlib, where the win32 .zip goes through the system tar, the same split the runtime's kernel-download.mjs makes).
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PIN_FILE = path.join(ROOT, 'src', 'collector', 'arch', 'win32', 'mihomo-pin.json')
const sha = (b) => createHash('sha256').update(b).digest('hex')

export class PayloadError extends Error {
  constructor(code, message) { super(message); this.name = 'PayloadError'; this.code = code }
}

/** One download → the archive and the exe in it, checked: the archive's size and sha256 against the pin BEFORE anything else (a mismatch is reported
 * without the computed digest — the operator re-downloads, the pin is not argued with from a bad copy), then unpacked — a .zip through the system tar
 * (bsdtar reads zip; Windows 10 1803 and macOS have it) in a work directory that is always removed, a .gz (the darwin release: one gzipped binary) with
 * node:zlib. → `{ name, size, sha256, exe: { name, size, sha256 } }`. */
async function fetchOne({ pin, arch, download, exec, fs, workRoot }) {
  const a = pin.assets[arch]
  if (!a) throw new PayloadError('unsupported-arch', `the pin has no ${arch}`)
  const got = Buffer.from(await download(a.url))
  if (sha(got) !== a.sha256 || (a.size != null && got.length !== a.size)) throw new PayloadError('zip-digest-mismatch', `${a.name}: the download is not the pinned archive (sha256 or size mismatch)`)
  if (/\.gz$/.test(a.name)) {
    let exe
    try { exe = gunzipSync(got) } catch (e) { throw new PayloadError('unpack-failed', `${a.name} will not gunzip (${String((e && e.message) || e)})`) }
    return { name: a.name, size: got.length, sha256: a.sha256, exe: { name: a.exe?.name ?? 'asight-forwarder', size: exe.length, sha256: sha(exe) } }
  }
  const work = fs.mkdtempSync(path.join(workRoot, 'asight-kernel-'))
  try {
    const zipPath = path.join(work, a.name)
    const into = path.join(work, 'x')
    fs.writeFileSync(zipPath, got)
    fs.mkdirSync(into)
    await exec('tar', ['-xf', zipPath, '-C', into])
    const exes = fs.readdirSync(into).filter((n) => /\.exe$/i.test(n))
    if (exes.length !== 1) throw new PayloadError('exe-not-found', `${a.name} holds ${exes.length} .exe files, expected one`)
    const exe = fs.readFileSync(path.join(into, exes[0]))
    return { name: a.name, size: got.length, sha256: a.sha256, exe: { name: a.exe?.name ?? 'asight-forwarder.exe', size: exe.length, sha256: sha(exe) } }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

/** `--pin`: two independent downloads per arch, each checked against the pin's archive digest; they must agree on the exe. → `{ <arch>: { name, size, sha256,
 * exe: { name, size, sha256 } } }` — the archive's and the exe's size and sha256, for the operator to put in the pin. Writes nothing. */
export async function pinExes({ pin, arches = Object.keys(pin.assets), download, exec, fs = nodeFs, workRoot = os.tmpdir() }) {
  const out = {}
  for (const arch of arches) {
    const one = await fetchOne({ pin, arch, download, exec, fs, workRoot })
    const two = await fetchOne({ pin, arch, download, exec, fs, workRoot })
    if (one.exe.sha256 !== two.exe.sha256 || one.exe.size !== two.exe.size) throw new PayloadError('downloads-disagree', `${arch}: two downloads gave different exes`)
    out[arch] = one
  }
  return out
}

const defaultDownload = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()) }
const defaultExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 << 20 }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve({ stdout, stderr })))
})

async function cli(argv) {
  if (!argv.includes('--pin')) { console.error('kernel-payload.mjs is --pin only since D44 (the build half retired: the kernel downloads itself, 4.8 §8)'); process.exit(2) }
  const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null)
  const pin = JSON.parse(nodeFs.readFileSync(path.resolve(flag('--pin-file') || PIN_FILE), 'utf8'))
  const arches = flag('--arch') ? [flag('--arch')] : Object.keys(pin.assets)
  console.log(JSON.stringify(await pinExes({ pin, arches, download: defaultDownload, exec: defaultExec }), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(process.argv.slice(2)).catch((e) => { console.error(e instanceof PayloadError ? `${e.code}: ${e.message}` : e); process.exit(1) })
