// user-path.mjs — the PATH a form's `{ command }` presence is resolved against (RFC 4.11 §2.3 `present`): the user's own, recorded by the last
// state-changing trocar command run in a terminal, so the CLI, the daemon and its query worker (started by the login service with ITS PATH) give
// one answer whoever asks (1.6 V91). With it, the values of the variables a footprint `<loc>` moves its place by (`env`, null when unset): the login
// service has none of the user's shell variables either. Before anything has recorded it (trocar not installed yet) the asker's own env is all there is.
import nodeFs from 'node:fs'
import path from 'node:path'
import { collectorDir, USER_PATH_FILE } from './paths.mjs'
import { writeDurable } from './fsutil.mjs'
import { readManifest } from './manifest.mjs'

/** { PATH, PATHEXT } as recorded, else `env` itself. */
export function userPathEnv({ home, env = process.env, fs = nodeFs }) {
  const v = recorded(home, fs) // not recorded, or not readable: the asker's own
  return v ? { PATH: v.PATH, ...(typeof v.PATHEXT === 'string' ? { PATHEXT: v.PATHEXT } : {}) } : env
}

/** Read the file once: its object, or null. */
function recorded(home, fs) {
  try { const v = JSON.parse(fs.readFileSync(path.join(collectorDir(home), USER_PATH_FILE), 'utf8')); return v && typeof v.PATH === 'string' ? v : null } catch { return null }
}

/** The names of the variables the descriptors' own footprints (top-level `present` `<loc>`s) are moved by, once each. */
export function presentEnvNames(harnesses) {
  return [...new Set((harnesses || []).flatMap((d) => (d.present || []).filter((p) => p && typeof p.env === 'string').map((p) => p.env)))].sort()
}

/** `env` as a Map with the recorded footprint variables put over it (a recorded null = unset): every asker resolves a moved place alike. */
export function userFootprintEnv({ home, env = process.env, fs = nodeFs }) {
  const m = new Map(Object.entries(env instanceof Map ? Object.fromEntries(env) : env || {}).filter(([, v]) => typeof v === 'string'))
  const v = recorded(home, fs)
  for (const [k, x] of Object.entries((v && v.vars) || {})) { if (typeof x === 'string') m.set(k, x); else m.delete(k) }
  return m
}

/** `which(command)` over the user's PATH (userPathEnv): the first <dir>/<command><suffix> that exists, or null. */
export function userWhich({ home, env = process.env, os, fs = nodeFs }) {
  const pe = userPathEnv({ home, env, fs })
  const get = (k) => (pe instanceof Map ? pe.get(k) : pe && pe[k])
  const dirs = String(get('PATH') || get('Path') || '').split(os === 'win32' ? ';' : ':').filter(Boolean)
  const exts = os === 'win32' ? String(get('PATHEXT') || '.EXE;.CMD;.BAT').split(';').filter(Boolean).concat(['']) : ['']
  return (command) => {
    for (const d of dirs) for (const x of exts) { const f = path.join(d, `${command}${x.toLowerCase()}`); if (fs.existsSync(f)) return f }
    return null
  }
}

/** Record `env`'s PATH, and the values of the variables `names` (presentEnvNames), while trocar is installed (an install manifest this build reads: a version 1 / 2 one makes every writing command refuse
 *  before any write, 4.11 ⑰); writes only when it differs. */
export function recordUserPath({ home, env = process.env, names = [], fs = nodeFs }) {
  const dir = collectorDir(home), get = (k) => (env instanceof Map ? env.get(k) : env && env[k])
  let m = null
  try { m = readManifest(dir, fs) } catch { /* unreadable: the command's own read says so */ }
  if (!m || m.unsupported) return false
  const text = `${JSON.stringify({ PATH: get('PATH') ?? get('Path') ?? '', ...(get('PATHEXT') != null ? { PATHEXT: get('PATHEXT') } : {}),
    vars: Object.fromEntries(names.map((k) => [k, typeof get(k) === 'string' ? get(k) : null])) })}\n`
  try { if (fs.readFileSync(path.join(dir, USER_PATH_FILE), 'utf8') === text) return false } catch { /* not there yet */ }
  writeDurable(path.join(dir, USER_PATH_FILE), text, 0o600, fs)
  return true
}
