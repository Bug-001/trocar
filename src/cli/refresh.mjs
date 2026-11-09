// refresh.mjs — which command puts this machine on this code (RFC 1.6 §3.5, §3.7, §5.5): the one judgement `status`, `doctor` and `update` share.
//   installedCode(home, fs) → the code the last `install` ran (string), null (a record that names none, or one that cannot be read), undefined (never)
//   refreshCommand({ home, root, fs }) → 'trocar update' when this code changed since the last install and update knows this copy's channel, else 'trocar install'
import nodeFs from 'node:fs'
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

/** §3.5 · §3.7: the one way out of a service on other code or a stale trocar-off. This code was not installed yet (a git pull by hand, files replaced
 *  under an npm or script copy): `trocar update` switches what is on off, replaces the service, installs and switches it on again (§5.5) — install
 *  alone leaves the entries `on` wrote (D55①). Otherwise (another copy started the service, or nothing changed since the install): `trocar install`. */
export function refreshCommand({ home, root, fs = nodeFs }) {
  const installed = installedCode(home, fs)
  const changed = installed !== undefined && installed !== codeId(root)
  return changed && ['git', 'npm', 'script'].includes(channelOf(root, { home, fs })) ? 'trocar update' : 'trocar install'
}
