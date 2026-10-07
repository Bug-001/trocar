// forwarder.mjs — asight's own kernel on Windows: where it comes from, how it is checked, how it is run (RFC 4.8 §3 · §4 · §8 · §12; acceptance W27 W28 W55 W74).
//
// The kernel is a pinned mihomo, shipped as `asight-forwarder.exe` in a per-platform npm package that comes with asight (4.8 §8: `on` never downloads). This file finds that package,
// checks the exe against the pin, copies it to the user's `kernel\` directory and checks the copy again before EVERY start (the first and each re-spawn of the backoff). Nothing here goes online:
// no http, https, dns or fetch (W27 ⑦ scans this file's source and records every connection a test makes), and the user's proxy software is never read or written (D43).
//
// Every function takes what it touches (`fs`, `hash`, `resolvePackage`, the spawn, the clock, the controller) so a test on any OS runs it against a temp directory and a fake kernel process.

import nodeFs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const KERNEL_EXE = 'asight-forwarder.exe'
export const KERNEL_LICENSE = 'LICENSE-mihomo.txt'
export const KERNEL_SOURCE = 'SOURCE-mihomo.txt'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The pin (mihomo-pin.json): the pinned version and, per architecture, the platform package and the sha256 of the exe in it. Read once, synchronously: it is a few hundred bytes next to this file. */
export function loadPin() {
  return JSON.parse(nodeFs.readFileSync(path.join(HERE, 'mihomo-pin.json'), 'utf8'))
}

/** The main package's name and version, which the reinstall commands name. */
export function mainPackage() {
  const { name, version } = JSON.parse(nodeFs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'package.json'), 'utf8'))
  return { name, version }
}

/**
 * The two ways to put the kernel back, as literals (4.8 §8 ⑤, §10.4): asight cannot tell how it was installed, so both are printed, and it never runs either (1.6 R8). There is no download address in them:
 * the second is the Release's tarballs, installed together (`npm pack` names a tarball <name>-<version>.tgz).
 */
export function reinstallCommands({ main, platformPackage }) {
  return {
    npm: `npm install --global ${main.name}@${main.version} --include=optional`,
    release: `npm install --global ${main.name}-${main.version}.tgz ${platformPackage}-${main.version}.tgz`,
  }
}

/** The sha256 and the size of a file, streamed (the exe is tens of megabytes). */
export function hashFile(file, { fs = nodeFs } = {}) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    let size = 0
    const s = fs.createReadStream(file)
    s.on('data', (d) => { h.update(d); size += d.length })
    s.on('error', reject)
    s.on('end', () => resolve({ size, sha256: h.digest('hex') }))
  })
}

/** The directory of the installed platform package, found from asight's own install location (the package is an optionalDependency, so npm puts it where `require` finds it), or null. */
export function defaultResolvePackage(name) {
  try { return path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)) } catch { return null }
}

const isFile = (fs, p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const same = (got, want) => got.sha256 === want.sha256 && (want.size == null || got.size === want.size)

/**
 * Where the kernel is and whether it is the pinned one: read-only, no network, no write, and it never touches the package directory (that is npm's).
 * → `{ found: { packageDir, exe, sha256, size } }` · `{ missing: { reason, commands } }` (reason: `unsupported-arch` the pin has no package for this architecture · `not-pinned` the pin's exe digest is null (the release was
 * built without it) · `package-not-installed` the package is not there, or has no exe: `npm i --omit=optional` does this) · `{ mismatch: { of: 'package', commands } }` (the exe in the package is not the pinned one).
 * `commands` = `reinstallCommands(...)` (null for an architecture the pin does not know: reinstalling cannot help).
 * `resolvePackage(name)` → the package's directory or null; `hash(file)` → `{ size, sha256 }`; `arch` is `x64` or `arm64`.
 */
export async function locateKernel({ pin, arch, resolvePackage = defaultResolvePackage, fs = nodeFs, hash = (f) => hashFile(f, { fs }), main = mainPackage() } = {}) {
  const asset = pin && pin.assets && pin.assets[arch]
  if (!asset) return { missing: { reason: 'unsupported-arch', commands: null } }
  const commands = reinstallCommands({ main, platformPackage: asset.package })
  if (!asset.exe || typeof asset.exe.sha256 !== 'string') return { missing: { reason: 'not-pinned', commands } }
  const packageDir = await resolvePackage(asset.package)
  const exe = packageDir ? path.join(packageDir, asset.exe.name) : null
  if (!exe || !isFile(fs, exe)) return { missing: { reason: 'package-not-installed', commands } }
  const got = await hash(exe)
  if (!same(got, asset.exe)) return { mismatch: { of: 'package', commands } }
  return { found: { packageDir, exe, sha256: got.sha256, size: got.size } }
}

/**
 * Find the kernel (locateKernel), then put it where it runs from: `dir` is `%USERPROFILE%\.asight\collector\kernel\`, the exe and the licence and source files beside it. A copy, not a run from the package: Windows does
 * not let a running exe be replaced or deleted, and a kernel in `node_modules` would block `npm i -g` and `npm uninstall` for as long as it lives (4.8 §8). The copy goes to a temp name, is hashed, and only then takes
 * the name; a target that is already there with the right digest is left alone (its mtime does not move).
 * → `{ path, sha256, copied }` · `{ missing }` · `{ mismatch: { of: 'package' | 'copy', commands } }`. The copy is ledgered as `forwarder-binary` (path and sha256) by the caller (Task 8(c)'s `on`); `uninstall` removes it.
 */
export async function ensureBinary({ pin, arch, dir, resolvePackage, fs = nodeFs, hash = (f) => hashFile(f, { fs }), main = mainPackage() } = {}) {
  const located = await locateKernel({ pin, arch, resolvePackage, fs, hash, main })
  if (!located.found) return located
  const { packageDir, exe } = located.found
  const want = pin.assets[arch].exe
  const target = path.join(dir, KERNEL_EXE)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let copied = false
  let have = null
  if (isFile(fs, target)) { try { have = await hash(target) } catch { have = null } }
  if (!have || !same(have, want)) {
    const tmp = `${target}.tmp-${process.pid}`
    fs.copyFileSync(exe, tmp)
    try {
      if (!same(await hash(tmp), want)) { fs.rmSync(tmp, { force: true }); return { mismatch: { of: 'copy', commands: reinstallCommands({ main, platformPackage: pin.assets[arch].package }) } } }
      fs.renameSync(tmp, target)
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
    copied = true
  }
  for (const name of [KERNEL_LICENSE, KERNEL_SOURCE]) { // the licence text and the source address travel with the exe (GPL-3.0-only)
    const from = path.join(packageDir, name)
    const to = path.join(dir, name)
    if (!isFile(fs, from)) continue
    const text = fs.readFileSync(from)
    if (!isFile(fs, to) || !fs.readFileSync(to).equals(text)) fs.writeFileSync(to, text)
  }
  return { path: target, sha256: want.sha256, copied }
}

/**
 * What the forwarder calls before EVERY spawn (the first start and each re-spawn of the backoff): is the copy in `dir` still the pinned exe? It never copies from the package again: the copy is what ran, and a copy that
 * was changed or deleted is a failure to report (`on` repairs it, 4.8 §8 ④).
 * → `{ ok: true, sha256 }` · `{ missing: { reason: 'file-missing' | 'not-pinned' | 'unsupported-arch' } }` · `{ mismatch: { of: 'copy' } }`.
 */
export async function verifyCopy({ dir, pin, arch, fs = nodeFs, hash = (f) => hashFile(f, { fs }) } = {}) {
  const asset = pin && pin.assets && pin.assets[arch]
  if (!asset) return { missing: { reason: 'unsupported-arch' } }
  if (!asset.exe || typeof asset.exe.sha256 !== 'string') return { missing: { reason: 'not-pinned' } }
  const target = path.join(dir, KERNEL_EXE)
  if (!isFile(fs, target)) return { missing: { reason: 'file-missing' } }
  const got = await hash(target)
  return same(got, asset.exe) ? { ok: true, sha256: got.sha256 } : { mismatch: { of: 'copy' } }
}

// ---- Smart App Control (4.8 §8, W74) ------------------------------------------------------------------------------------------------------------------------------

const SAC_KEY = 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
const SAC_VALUE = 'VerifiedAndReputablePolicyState'

/**
 * Whether Smart App Control would stop the unsigned kernel from starting: `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` through the helper's read-only `reg-read` (0 off, 1 on, 2
 * evaluation). No such key or value: the system has no Smart App Control, nothing stops the kernel: 'off'. An answer that is not 0, 1 or 2, or a helper that cannot read it, is `{ unknown: { reason } }`
 * (1.6 §9.4's closed reasons: `timeout` · `denied` · `unparseable`), never a guess. asight never writes this key.
 */
export async function sacState({ helper }) {
  let r
  try { r = await helper.call('reg-read', { hive: 'HKLM', key: SAC_KEY, names: [SAC_VALUE] }) } catch (e) {
    return { unknown: { reason: e && e.code === 'helper-timeout' ? 'timeout' : 'denied', detail: (e && e.code) || 'error' } }
  }
  const v = r && r.values && r.values[SAC_VALUE]
  if (!r || r.keyExists === false || v == null) return 'off'
  const n = typeof v === 'object' ? v.value : v
  return n === 0 ? 'off' : n === 1 ? 'on' : n === 2 ? 'evaluation' : { unknown: { reason: 'unparseable', detail: String(n).slice(0, 40) } }
}
/** Is the unsigned kernel at risk? Only a state that says so: an unknown one is not a reason to blame Smart App Control for a start that failed (the plan line says 「不知道」 for it, not this). */
export const sacBlocks = (state) => state === 'on' || state === 'evaluation'
