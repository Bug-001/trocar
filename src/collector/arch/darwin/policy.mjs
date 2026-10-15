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

/** The platform facts core asks for (4.11 OS backends): environment names are case-sensitive, a path is keyed as is (after its
 *  real path), and macOS has no persistent user environment to read (ruling ⑤: no launchctl setenv / login-profile reading). */
export const platformFacts = Object.freeze({
  envCaseInsensitive: false,
  exeSuffix: '', // a command's program file name (4.11 P8)
  pathKey: (p) => pathKey(p, { platform: 'darwin' }),
  persistentEnv: () => ({}),
})

/** sources.mjs's ctx.dirs on macOS: `appSupport` is Electron's appData (~/Library/Application Support); no localAppData. */
export const dirsOf = (home) => ({ appSupport: path.join(home, 'Library', 'Application Support') })
