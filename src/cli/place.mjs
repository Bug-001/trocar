// place.mjs — `trocar place <dir>`, the hidden command the install scripts and `trocar update` switch versions with (RFC 1.6 §2, 4.5 §A; D74④).
// <dir> is a complete version directory ~/.trocar/app/<version> (its bin/trocar.mjs, and the Node directory its install/node.sha256 pins).
// Under the op lock: the pointer `app/current` is written to a temp file and renamed over (atomic on all three OSes, no symlink); the
// launcher is rewritten only when its bytes differ; then old versions are pruned — kept are this one, the one the pointer named before, and
// the one the install manifest's `install.code` names, with the Node directories their pins name. So no version the login entry or a running
// daemon can name is deleted (D61). A directory that cannot be removed (Windows: in use) is left for the next `place`.
// The pointer and launcher formats are frozen from the first release (D67④): `<version> <node id>\n`, and the two launchers below.
//   runPlaceCli(argv, { io, home, platform, deps }) → exit (0 placed · 1 it could not be · 2 usage)
//   placeVersion({ dir, home, platform, fs }) → { version, previous, pruned }   (throws with a reason)
import nodeOs from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { appDir, launcherPath, collectorDir, opLockFile } from '../off/paths.mjs'
import { acquireOpLock } from '../off/lock.mjs'
import { readManifest } from '../off/manifest.mjs'
import { EXIT } from './schema.mjs'

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/
const WIN_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** The Node directory name (`<node version>-<target>`) the version at `dir` pins for this platform, or null. */
export function nodeIdOf(dir, { platform = process.platform, arch = process.arch, fs = nodeFs } = {}) {
  const target = `${platform === 'win32' ? 'win' : platform}-${arch}`
  let text
  try { text = fs.readFileSync(path.join(dir, 'install', 'node.sha256'), 'utf8') } catch { return null }
  for (const line of text.split('\n')) {
    const m = /^[0-9a-f]{64} {2}node-v(\d+\.\d+\.\d+)-([a-z0-9]+-[a-z0-9]+)\./.exec(line)
    if (m && m[2] === target) return `${m[1]}-${target}`
  }
  return null
}

/** The Node binary of a Node directory. */
export const nodeExe = (app, id, platform = process.platform) => (platform === 'win32' ? path.join(app, 'node', id, 'node.exe') : path.join(app, 'node', id, 'bin', 'node'))

/** The launcher's bytes. sh: the app path is baked in (quoted for sh). cmd: ASCII only, found from its own folder, so a profile path in any script works. */
export function launcherText(app, platform = process.platform) {
  if (platform === 'win32') {
    return ['@echo off', 'setlocal', 'set "D=%~dp0..\\app"', 'set "V=" & set "N="',
      'for /f "usebackq tokens=1,2" %%a in ("%D%\\current") do set "V=%%a" & set "N=%%b"',
      'if not defined N (echo trocar: "%D%\\current" names no version. Run the install command again. 1>&2 & exit /b 1)', // quoted: a ) or & in the home ends no block
      // one line, parsed before node runs: cmd never reads the file again, so uninstall may delete it while this runs. node's code goes back as a literal
      // number (call set keeps it, for /f makes it a word): a bare `exit /b` reads as 0 to PowerShell and cmd /c, `call exit /b N` as 0 at the cmd prompt (4.5 §A)
      '"%D%\\node\\%N%\\node.exe" "%D%\\%V%\\bin\\trocar.mjs" %* & call set "C=%%errorlevel%%" & for /f %%c in (\'echo %%C%%\') do exit /b %%c', ''].join('\r\n')
  }
  const q = `'${app.replace(/'/g, `'\\''`)}'`
  return ['#!/bin/sh', `d=${q}`, 'read -r v n <"$d/current" && [ -n "$n" ] || { echo "trocar: $d/current names no version. Run the install command again." >&2; exit 1; }',
    'exec "$d/node/$n/bin/node" "$d/$v/bin/trocar.mjs" "$@"', ''].join('\n')
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** rename, retried a few times on Windows while another process holds the target open (a launcher being read). */
function renameOver(from, to, fs, platform) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      if (platform !== 'win32' || !WIN_BUSY.has(e && e.code) || i >= 20) throw e
      sleepSync(100)
    }
  }
}

/** Switches to the version at `dir` and prunes (see the header). The caller holds the op lock. */
export function placeVersion({ dir, home = nodeOs.homedir(), platform = process.platform, arch = process.arch, fs = nodeFs }) {
  const app = appDir(home)
  const abs = path.resolve(dir)
  const version = path.basename(abs)
  let inApp = false
  try { inApp = fs.realpathSync(path.dirname(abs)) === fs.realpathSync(app) } catch { /* no app directory */ }
  if (!inApp || !VERSION.test(version)) throw new Error(`${dir} is not a version directory of ${app}`)
  if (!fs.existsSync(path.join(abs, 'bin', 'trocar.mjs'))) throw new Error(`${abs} has no bin/trocar.mjs`)
  const nid = nodeIdOf(abs, { platform, arch, fs })
  if (!nid) throw new Error(`${abs}/install/node.sha256 names no Node build for ${platform}-${arch}`)
  if (!fs.existsSync(nodeExe(app, nid, platform))) throw new Error(`the Node build trocar ${version} pins is not in ${path.join(app, 'node', nid)}`)

  const pointer = path.join(app, 'current')
  let previous = null
  try { previous = fs.readFileSync(pointer, 'utf8').split(/\s+/)[0] || null } catch { /* the first place */ }
  const tmp = `${pointer}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${version} ${nid}\n`)
  renameOver(tmp, pointer, fs, platform)

  const launcher = launcherPath(home, platform)
  const text = launcherText(app, platform)
  let old = null
  try { old = fs.readFileSync(launcher, 'utf8') } catch { /* none yet */ }
  if (old !== text) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${launcher}.${process.pid}.tmp`, text, { mode: 0o755 })
    renameOver(`${launcher}.${process.pid}.tmp`, launcher, fs, platform)
  }

  let installed = null
  try { const m = readManifest(collectorDir(home), fs); installed = m && m.install && typeof m.install.code === 'string' ? m.install.code.split('+')[0] : null } catch { /* unreadable: keeps nothing extra */ }
  const keep = new Set([version, previous, installed].filter(Boolean))
  const keepNode = new Set([...keep].map((v) => nodeIdOf(path.join(app, v), { platform, arch, fs })).filter(Boolean))
  const pruned = []
  const prune = (parent, name) => { try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); pruned.push(name) } catch { /* in use: the next place removes it */ } }
  for (const e of fs.readdirSync(app, { withFileTypes: true })) if (e.isDirectory() && VERSION.test(e.name) && !keep.has(e.name)) prune(app, e.name)
  let nodes = []
  try { nodes = fs.readdirSync(path.join(app, 'node'), { withFileTypes: true }) } catch { /* none */ }
  for (const e of nodes) if (e.isDirectory() && !keepNode.has(e.name)) prune(path.join(app, 'node'), e.name)
  return { version, previous, pruned }
}

/** `trocar place <dir>` → the exit code. */
export async function runPlaceCli(argv, { io, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  if (argv.length !== 1 || argv[0].startsWith('-')) { io.err('trocar place: names one version directory. Usage: trocar place <dir>'); return EXIT.usage }
  const fs = deps.fs || nodeFs
  let lock
  try {
    fs.mkdirSync(collectorDir(home), { recursive: true, mode: 0o700 })
    lock = await acquireOpLock({ file: opLockFile(home), waitMs: 30_000, fs })
  } catch (e) { io.err(`trocar place: another trocar command is changing this machine (${(e && e.message) || e}). Run this again when it is done.`); return EXIT.incomplete }
  try {
    placeVersion({ dir: argv[0], home, platform, fs })
    return EXIT.ok
  } catch (e) {
    io.err(`trocar place: ${(e && e.message) || e}`)
    return EXIT.incomplete
  } finally { lock.release() }
}
