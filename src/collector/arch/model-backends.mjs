// model-backends.mjs — what the collector model (RFC 4.11) takes from the OS on macOS and Windows, gathered in one place for `install`, `on` and
// `uninstall` (plan T20): the key custody (P1), the user root store (P3), the wrapper kit (P8), the platform facts and the sources ctx readers
// (§2.3). Each is the arch's own module, imported lazily, so Linux never loads them. A test passes its own pieces instead (0.1 §3).
import nodeFs from 'node:fs'
import path from 'node:path'

export { MODEL_OS, isModelOs } from '../model-install.mjs' // the one list of the OSes the model runs on

/** The installed signing helper the darwin custody runs (4.11 P1): under ~/.asight/bin, beside asight-off. */
export const signHelperPath = (home, name) => path.join(home, '.asight', 'bin', name)

/** `which(command)` over the user's PATH (the install env): the first <dir>/<command><suffix> that exists, or null. */
export function whichIn(env, { os, exists = nodeFs.existsSync } = {}) {
  const get = (k) => (env instanceof Map ? env.get(k) : env && env[k])
  const dirs = String(get('PATH') || get('Path') || '').split(os === 'win32' ? ';' : ':').filter(Boolean)
  const exts = os === 'win32' ? String(get('PATHEXT') || '.EXE;.CMD;.BAT').split(';').filter(Boolean).concat(['']) : ['']
  return (command) => {
    for (const d of dirs) for (const x of exts) { const f = path.join(d, `${command}${x.toLowerCase()}`); if (exists(f)) return f }
    return null
  }
}

/** Whether this user owns `p` (rule U, P8): the uid on POSIX; on Windows a path under the profile counts (the owner SID is not read here). */
export const ownsBy = ({ os, home, uid = typeof process.getuid === 'function' ? process.getuid() : null, fs = nodeFs }) => (p) => {
  if (os === 'win32') return path.resolve(p).toLowerCase().startsWith(`${path.resolve(home).toLowerCase()}${path.sep}`) ? true : null
  try { return uid == null ? null : fs.statSync(p).uid === uid } catch { return null }
}

/** The sources ctx (sources.mjs header) for this machine and user. */
export function sourcesCtx({ os, home, env = process.env, cwd = process.cwd(), dirs, fs = nodeFs, which = null, policy = null }) {
  return {
    os, home, cwd, env, dirs: dirs || {},
    readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), readdir: (p) => fs.readdirSync(p),
    which: which || whichIn(env, { os, exists: (p) => fs.existsSync(p) }), policy: policy || (() => ({ set: false })),
  }
}

/** backendsFor({ os, home, run, env, fs }) → { custody, rootStore, installHelper, wrapperKit, facts, dirs, policy } for macOS / Windows. */
export async function backendsFor({ os, home, run = null, env = process.env, fs = nodeFs }) {
  if (os === 'darwin') {
    const [{ keychainCustody, installHelper }, { NATIVE }, { userRootStore }, { renderWrapper }, pol] = await Promise.all([
      import('./darwin/custody.mjs'), import('./darwin/native.mjs'), import('./darwin/root-store.mjs'), import('./darwin/wrapper.mjs'), import('./darwin/policy.mjs')])
    const helperPath = signHelperPath(home, NATIVE.signHelper)
    return {
      custody: keychainCustody({ helperPath, run, env }), rootStore: userRootStore({ home, run, env, fs }),
      installHelper: (interactive) => installHelper({ dest: helperPath, interactive, run, env, fs }),
      wrapperKit: { renderWrapper }, facts: pol.platformFacts, dirs: pol.dirsOf(home), policy: (spec) => pol.policyReader({ run, env }).read(spec),
    }
  }
  if (os === 'win32') {
    const [{ cngCustody }, { userRootStore }, { renderWrapper, makeCompile }, pol] = await Promise.all([
      import('./win32/custody.mjs'), import('./win32/root-store.mjs'), import('./win32/wrapper.mjs'), import('./win32/policy.mjs')])
    return {
      custody: cngCustody({ run, env }), rootStore: userRootStore({ home, run, env, fs }), installHelper: null,
      wrapperKit: { renderWrapper, compile: makeCompile({ dir: path.join(home, '.asight', 'collector'), run, fs }) },
      facts: pol.platformFacts({ run, env }), dirs: pol.dirsOf(home, env), policy: (spec) => pol.policyReader({ run, env }).read(spec),
    }
  }
  throw new Error(`the collector model runs on macOS and Windows, not ${os}`)
}
