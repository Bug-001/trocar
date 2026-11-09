// refresh.mjs — which command puts this machine on this code (RFC 1.6 §3.5, §3.7, §5.5): the one judgement `status`, `doctor` and `update` share.
//   installedCode(home, fs) → the code the last `install` ran (string), null (a record that names none, or one that cannot be read), undefined (never)
//   pulledPastInstall({ home, root, env, platform, deps, fs }) → this copy's code changed since its own last install (a git pull by hand)
//   refreshCommand({ … }) → 'trocar update' when pulledPastInstall and update knows this copy's channel, else 'trocar install'
import nodeFs from 'node:fs'
import path from 'node:path'
import { codeId, channelOf } from '../version.mjs'
import { readManifest } from '../off/manifest.mjs'
import { collectorDir } from '../off/paths.mjs'

/** The code that last ran `install` here, as its record in the install manifest names it (§5.5): undefined when install never ran; null when the
 *  record names none (a build before the field) or the manifest cannot be read — not this code either way, and `install` says what is wrong with a
 *  manifest it cannot use. */
export function installedCode(home, fs = nodeFs) {
  let m
  try { m = readManifest(collectorDir(home), fs) } catch { return null }
  if (m && m.unsupported) return null
  if (!m || !m.install || typeof m.install !== 'object') return undefined
  return typeof m.install.code === 'string' && m.install.code ? m.install.code : null
}

/** §5.5: the code of this copy changed since this copy's last install. A record that names other code (or none), read cleanly, and a login entry that
 *  starts THIS copy: a pull keeps the program path, another checkout or copy does not (its install is its own, `trocar install` from here takes over).
 *  A manifest that cannot be read is not this case: install refuses it and says why, so nothing is switched off for an install that cannot run. */
export async function pulledPastInstall({ home, root, env = process.env, platform = process.platform, deps = {}, fs = nodeFs }) {
  let m
  try { m = readManifest(collectorDir(home), fs) } catch { return false }
  if (!m || m.unsupported || !m.install || typeof m.install !== 'object') return false
  const installed = typeof m.install.code === 'string' && m.install.code ? m.install.code : null
  if (installed === codeId(root)) return false
  const { entryStartsThisCopy } = await import('./replace-daemon.mjs')
  return entryStartsThisCopy({ home, env, platform, deps: { ...deps, script: deps.script || path.join(root, 'bin', 'trocar.mjs') }, fs })
}

/** §3.5 · §3.7: the one way out of a service on other code or a stale trocar-off — trocar update when this copy was pulled past its own install and
 *  update knows its channel (it finishes as an update: §5.5), else trocar install (another copy started the service, or nothing changed since). */
export async function refreshCommand(o) {
  return ['git', 'npm', 'script'].includes(channelOf(o.root, { home: o.home, fs: o.fs || nodeFs })) && await pulledPastInstall(o) ? 'trocar update' : 'trocar install'
}
