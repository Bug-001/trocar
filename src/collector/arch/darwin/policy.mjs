// policy.mjs — the macOS side of sources.mjs's ctx.policy and ctx.dirs (RFC 4.11 OS backends): the managed-preference
// reader and the platform facts core asks for instead of naming an OS.
// A managed preference is a configuration profile's payload, which macOS writes as a plist under /Library/Managed Preferences:
// the per-user file first, then the computer-wide one (the user's wins, as cfprefsd resolves it). Only the key a descriptor
// declares is read — `plutil -extract <key> json -o - <file>` through the injected runner — never the whole domain.
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execTool } from '../../../off/exec.mjs'
import { pathKey } from '../../../off/fsutil.mjs'
import { dirsFor } from '../../../off/loc.mjs'

const MANAGED = '/Library/Managed Preferences'

/** policyReader({ user, run, env, exists, root }) → read({ domain, key }) → { set:true, value, where } | { set:false } | { error, where }. */
export function policyReader({ user = os.userInfo().username, run = null, env = process.env, exists = nodeFs.existsSync, root = MANAGED } = {}) {
  return function read({ domain, key }) {
    if (!domain || !key || /[/\\]/.test(domain)) return { error: `not a managed-preference spec: ${JSON.stringify({ domain, key })}`, where: root }
    for (const file of [path.join(root, user, `${domain}.plist`), path.join(root, `${domain}.plist`)]) {
      if (!exists(file)) continue
      const r = execTool('plutil', ['-extract', key, 'json', '-o', '-', file], { run, env })
      if (r.code === 0) {
        try { return { set: true, value: JSON.parse(r.out), where: file } } catch { return { error: `plutil answered no JSON for ${key}`, where: file } }
      }
      if (/no value at that key path/i.test(`${r.err} ${r.out}`)) continue // the file is there, the key is not: the next file
      return { error: `plutil -extract ${key} failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`, where: file }
    }
    return { set: false }
  }
}

/** launchdEnv(names, { run, env }) → { <name>: value } of the variables launchd holds for this user's session (`launchctl getenv <name>`, read
 *  only): where a variable set with `launchctl setenv` lives, which a shell started later may not have. A name it does not hold adds nothing. */
export function launchdEnv(names, { run = null, env = process.env } = {}) {
  const out = {}
  for (const n of new Set(names)) { const r = execTool('launchctl', ['getenv', n], { run, env }); if (r.code === 0 && r.out) out[n] = r.out }
  return out
}

/** persistentEnv(names, { run, env }) → { <name>: value } of launchd's user environment (`launchctl setenv`, which the apps and shells the user
 *  starts inherit, 4.11 ⑤): each asked name and its lower-case spelling, read by name (launchdEnv) — never the whole environment. */
export const persistentEnv = (names, o = {}) => launchdEnv(names.flatMap((x) => [x, x.toLowerCase()]), o)

/** The platform facts core asks for (4.11 OS backends): environment names are case-sensitive, a path is keyed as is (after its
 *  real path), and the persistent environment is launchd's (persistentEnv above). An uninstall with no record also asks launchd for a
 *  certificate variable its own environment lacks (launchdEnv above). */
export const platformFacts = ({ run = null, env = process.env } = {}) => Object.freeze({
  envCaseInsensitive: false,
  exeSuffix: '', // a command's program file name (4.11 P8)
  pathKey: (p) => pathKey(p, { platform: 'darwin' }),
  persistentEnv: (names) => persistentEnv(names, { run, env }),
})

/** sources.mjs's ctx.dirs on macOS: `appSupport` is Electron's appData (~/Library/Application Support); no localAppData. */
export const dirsOf = (home) => dirsFor('darwin', home)
