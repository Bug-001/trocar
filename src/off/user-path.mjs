// user-path.mjs — the PATH a form's `{ command }` presence is resolved against (RFC 4.11 §2.3 `present`): the user's own, recorded by the last
// state-changing trocar command run in a terminal, so the CLI, the daemon and its query worker (started by the login service with ITS PATH) give
// one answer whoever asks (1.6 V91). Before anything has recorded it (trocar not installed yet) the asker's own env is all there is.
import nodeFs from 'node:fs'
import path from 'node:path'
import { collectorDir, USER_PATH_FILE } from './paths.mjs'
import { writeDurable } from './fsutil.mjs'
import { readManifest } from './manifest.mjs'

/** { PATH, PATHEXT } as recorded, else `env` itself. */
export function userPathEnv({ home, env = process.env, fs = nodeFs }) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(collectorDir(home), USER_PATH_FILE), 'utf8'))
    if (v && typeof v.PATH === 'string') return { PATH: v.PATH, ...(typeof v.PATHEXT === 'string' ? { PATHEXT: v.PATHEXT } : {}) }
  } catch { /* not recorded, or not readable: the asker's own */ }
  return env
}

/** Record `env`'s PATH while trocar is installed (an install manifest this build reads: a version 1 / 2 one makes every writing command refuse
 *  before any write, 4.11 ⑰); writes only when it differs. */
export function recordUserPath({ home, env = process.env, fs = nodeFs }) {
  const dir = collectorDir(home), get = (k) => (env instanceof Map ? env.get(k) : env && env[k])
  let m = null
  try { m = readManifest(dir, fs) } catch { /* unreadable: the command's own read says so */ }
  if (!m || m.unsupported) return false
  const text = `${JSON.stringify({ PATH: get('PATH') ?? get('Path') ?? '', ...(get('PATHEXT') != null ? { PATHEXT: get('PATHEXT') } : {}) })}\n`
  try { if (fs.readFileSync(path.join(dir, USER_PATH_FILE), 'utf8') === text) return false } catch { /* not there yet */ }
  writeDurable(path.join(dir, USER_PATH_FILE), text, 0o600, fs)
  return true
}
