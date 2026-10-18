// autostart-node.mjs — which `node` the login entry names (D61), one rule for all three OSes.
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

const real = (fs, p) => { try { return fs.realpathSync(p) } catch { return null } }

/** → the absolute path the login entry names. `execPath` is the Node asking (process.execPath). */
export function autostartNode({ env = process.env, execPath = process.execPath, fs = nodeFs, platform = process.platform } = {}) {
  const mine = real(fs, execPath)
  if (!mine) return execPath
  const names = platform === 'win32' ? ['node.exe', 'node.cmd', 'node.bat'] : ['node']
  for (const dir of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const n of names) {
      const cand = path.join(dir, n)
      const r = real(fs, cand)
      if (!r) continue
      return r === mine ? cand : execPath // the FIRST node on PATH decides: a different Node means PATH is not ours to name
    }
  }
  return execPath
}
