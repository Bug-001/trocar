// ca-env.mjs — the install manifest's `ca_env` (spec 4.11 P4): the CA variables install read from an environment to compose a persistent file (a
// bundle, an extra-*.pem, a launch shim, a settings key, the login entry), one record per name. A name an environment does not set is unknown, not
// removed (D38): the recorded file stands in for it while it is the user's and there — dropping it cuts an agent off from the user's CA (invariant 5).
import nodeFs from 'node:fs'
import path from 'node:path'
import { readManifest } from './journal.mjs'

/** Why a CA file may not be carried or recorded (a relative path, or trocar's own file), or null. `dir`: the collector directory. */
export const carriedWhy = (v, dir) => (!path.isAbsolute(v) ? 'it is a relative path' : v.startsWith(path.dirname(dir) + path.sep) ? "it is trocar's own file" : null)

const get = (env, k) => (env instanceof Map ? env.get(k) : env && Object.hasOwn(env, k) ? env[k] : undefined)
const usable = (v, dir, fs) => typeof v === 'string' && !carriedWhy(v, dir) && fs.existsSync(v)

/** The names install records: every descriptor's `caEnv` and trocar's own (`own`: the daemon's), once each. */
export const caEnvNames = (descs, own = []) => [...new Set([...(descs || []).flatMap((d) => d.caEnv || []), ...own])].sort()

/** The recorded values that count now → { NAME: file }. A manifest that cannot be read records nothing (install says what it cannot read). */
export function recordedCaEnv(dir, fs = nodeFs) {
  let m
  try { m = readManifest(dir, fs) } catch { return {} }
  const r = m && m.ca_env && typeof m.ca_env === 'object' ? m.ca_env : {}
  return Object.fromEntries(Object.entries(r).filter(([, v]) => usable(v, dir, fs)))
}

/** `env` (a Map or an object, given back as the same) with each recorded name it does not set put on it. */
export function withCaEnv(env, dir, fs = nodeFs) {
  const add = Object.entries(recordedCaEnv(dir, fs)).filter(([k]) => get(env, k) === undefined)
  if (!add.length) return env
  return env instanceof Map ? new Map([...env, ...add]) : { ...env, ...Object.fromEntries(add) }
}

/** The record one install writes: each name takes this command's `env` when it sets it (empty counts), else the record — kept only while it counts.
 *  A running agent's env is not a source: it is one process's fact, and recorded it would widen every other harness's trust (4.6). → { NAME: file } */
export function caEnvRecord({ names, env, dir, fs = nodeFs }) {
  const prior = recordedCaEnv(dir, fs), out = {}
  for (const n of names) {
    const first = get(env, n) !== undefined ? get(env, n) : prior[n]
    if (usable(first, dir, fs)) out[n] = first
  }
  return out
}

/** Puts `rec` on the manifest: no key when it is empty, so a user who sets none of these variables has the manifest of before. */
export function setCaEnv(m, rec) {
  if (Object.keys(rec).length) m.ca_env = rec
  else delete m.ca_env
}
