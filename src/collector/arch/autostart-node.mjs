// autostart-node.mjs — what the login entry runs (D61 · D74), one rule for all three OSes: which `node`, or the script channel's launcher.
//
// The entry must survive a Node upgrade: a macOS machine's LaunchAgent named `/opt/homebrew/Cellar/node/26.0.0/bin/node`
// (process.execPath, already resolved), and `brew upgrade node` deletes that directory — after the upgrade the daemon
// cannot start at login, and every harness that is on breaks, which is exactly what D61 forbids. The same hazard is
// nvm's `~/.nvm/versions/node/<v>/bin/node` on Linux and a versioned install directory on Windows.
//
// The rule: the FIRST `node` on PATH, exactly as PATH writes it (never resolved), when it is the same program as the
// one asking (realpath equal) — that spelling is the stable one a package manager keeps pointing at the new version.
// Anything else (no node on PATH, or a different Node than this one) is this process's own executable: naming a
// program we did not verify would be worse than a path that may go stale.
import nodeFs from 'node:fs'
import path from 'node:path'
import { channelOf } from '../../version.mjs'
import { launcherPath } from '../../off/paths.mjs'

const real = (fs, p) => { try { return fs.realpathSync(p) } catch { return null } }

/** → the absolute path the login entry names. `execPath` is the Node asking (process.execPath). */
export function autostartNode({ env = process.env, execPath = process.execPath, fs = nodeFs, platform = process.platform } = {}) {
  const mine = real(fs, execPath)
  if (!mine) return execPath
  const names = platform === 'win32' ? ['node.exe', 'node.cmd', 'node.bat'] : ['node']
  for (const dir of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(dir)) continue // launchd / systemd / the task need an absolute program path; a relative PATH entry (`node_modules/.bin`, `.`) would resolve against the install run's cwd (4.11 §1 install 7)
    for (const n of names) {
      const cand = path.join(dir, n)
      const r = real(fs, cand)
      if (!r) continue
      return r === mine ? cand : execPath // the FIRST node on PATH decides: a different Node means PATH is not ours to name
    }
  }
  return execPath
}

/** → the program and the arguments before `daemon` that the login entry runs, the one answer all three OSes write (D61 · D74).
 *  A copy the install script placed (`~/.trocar/app/<version>`) is started through the launcher ~/.trocar/bin/trocar, which runs the version
 *  the pointer names: `place` switching the pointer is what moves the entry to a new version, and no entry names a version directory or a
 *  private Node that a later `place` prunes. Any other copy: `[node, script]`, the node by the rule above. */
export function autostartProgram({ home, node, script, env = process.env, fs = nodeFs, platform = process.platform }) {
  if (channelOf(path.dirname(path.dirname(script)), { home, fs }) === 'script') return [launcherPath(home, platform)]
  return [autostartNode({ env, execPath: node, fs, platform }), script]
}
