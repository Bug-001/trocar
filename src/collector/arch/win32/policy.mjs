// policy.mjs — the Windows side of sources.mjs's ctx.policy and ctx.dirs (RFC 4.11 OS backends; plan P6 for persistentEnv): the
// registry policy reader, the persistent user environment, and the platform facts core asks for instead of naming an OS.
// Every read is `reg.exe query` as the user through the injected runner, and only of a value a descriptor declares: a policy value
// under `Software\Policies` (the shape helper.mjs's POLICY_KEY_PATTERN allows the resident helper too), or the two Environment keys.
// reg.exe prints in the console's code page; the values read here (proxy URLs, host lists, policy switches) are ASCII in practice.
import path from 'node:path'
import { execTool } from '../../../off/exec.mjs'
import { pathKey } from '../../../off/fsutil.mjs'
import { dirsFor } from '../../../off/loc.mjs'
import { POLICY_KEY_PATTERN, POLICY_NAME_PATTERN } from './helper.mjs'

const HIVES = { HKCU: 'HKCU', HKEY_CURRENT_USER: 'HKCU', HKLM: 'HKLM', HKEY_LOCAL_MACHINE: 'HKLM' }
/** The persistent environment: the user's, then the machine's (the user's wins for the same name, as Windows builds a new process's environment). */
export const ENV_KEYS = Object.freeze(['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'])

/** parseRegQuery(text) → { <value name>: { kind, value } }: the value lines of `reg query` (four spaces, name, four spaces, REG_*, four
 *  spaces, data). A DWORD / QWORD is a number; REG_MULTI_SZ a list (reg.exe prints its separators as `\0`); the rest is the text as printed. */
export function parseRegQuery(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line)
    if (!m) continue
    const [, name, kind, raw = ''] = m
    out[name] = { kind, value: kind === 'REG_DWORD' || kind === 'REG_QWORD' ? Number(BigInt(raw.trim())) : kind === 'REG_MULTI_SZ' ? (raw === '' ? [] : raw.split('\\0')) : raw }
  }
  return out
}

/** splitKey('HKCU\\SOFTWARE\\Policies\\X') → { hive: 'HKCU', key: 'SOFTWARE\\Policies\\X' } | null. */
const splitKey = (full) => {
  const i = String(full).indexOf('\\')
  const hive = i > 0 ? HIVES[String(full).slice(0, i).toUpperCase()] : null
  return hive ? { hive, key: String(full).slice(i + 1).replaceAll('/', '\\').replace(/\\+$/, '') } : null
}

/** policyReader({ run, env }) → read({ key, value }) → { set:true, value, where } | { set:false } | { error, where }. `key` is the
 *  descriptor's full key (`HKCU\SOFTWARE\Policies\…`); anything outside Software\Policies, or a value name that is not plain, is refused
 *  without a read. The whole key is read (no /v) and the name looked up in it, so an absent value is never told by reg.exe's message
 *  (localized, in the console code page): a key that reads without the name is {set:false}, and so is a reg.exe that ran and failed —
 *  Users can read every key under Software\Policies, so a failed query there means the key is absent. Only a reg.exe that did not run
 *  to an exit (not started, timed out) is an error. */
export function policyReader({ run = null, env = process.env } = {}) {
  return function read({ key, value }) {
    const k = splitKey(key)
    if (!k || !new RegExp(POLICY_KEY_PATTERN, 'i').test(k.key) || typeof value !== 'string' || !new RegExp(POLICY_NAME_PATTERN).test(value)) return { error: `not a declared policy value: ${JSON.stringify({ key, value })}`, where: String(key) }
    const where = `${k.hive}\\${k.key}`
    const r = execTool('reg.exe', ['query', where], { run, env })
    if (r.code == null) return { error: `reg query ${where} did not run to an exit${r.err ? `: ${r.err.slice(0, 200)}` : ''}`, where }
    if (r.code !== 0) return { set: false }
    const hit = Object.entries(parseRegQuery(r.out)).find(([n]) => n.toLowerCase() === value.toLowerCase())
    return hit ? { set: true, value: hit[1].value, where } : { set: false }
  }
}

/** persistentEnv(names, { run, env }) → { <asked name>: value } of the persistent environment (HKCU\Environment, then the machine's
 *  Session Manager\Environment; the user's wins). Names compare case-insensitively; a key that cannot be read adds nothing. */
export function persistentEnv(names, { run = null, env = process.env } = {}) {
  const want = [...new Set(names)]
  const out = {}
  if (!want.length) return out
  for (const key of ENV_KEYS) {
    const r = execTool('reg.exe', ['query', key], { run, env })
    if (r.code !== 0) continue
    const values = Object.entries(parseRegQuery(r.out))
    for (const n of want) {
      if (Object.hasOwn(out, n)) continue
      const hit = values.find(([v]) => v.toLowerCase() === n.toLowerCase())
      if (hit) out[n] = hit[1].value
    }
  }
  return out
}

/** The platform facts core asks for: environment names compare case-insensitively, a path is keyed case-folded (after its real path),
 *  and the persistent environment is the registry's. */
export const platformFacts = ({ run = null, env = process.env } = {}) => Object.freeze({
  envCaseInsensitive: true,
  exeSuffix: '.exe', // a command's program file name (4.11 P8)
  pathKey: (p) => pathKey(p, { platform: 'win32' }).toLowerCase(),
  persistentEnv: (names) => persistentEnv(names, { run, env }),
})

/** sources.mjs's ctx.dirs on Windows: `appSupport` is %APPDATA% (Electron's appData), `localAppData` %LOCALAPPDATA%; each falls back to
 *  its default place under the home. */
export const dirsOf = (home, env = process.env) => dirsFor('win32', home, env)
