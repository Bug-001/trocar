// index.mjs — load every harness descriptor in this directory (RFC 4.6 §结构: adding a harness touches
// only harness/). Each <name>.mjs default-exports one descriptor; files starting with '_' are helpers.
// The registry (core) validates them; this file never imports core/engine or arch/. It also checks the one export
// every descriptor owes `asight status` and `asight doctor` (RFC 1.6 §9.7): `proxy`, how its agent reads a proxy.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCHEME = ['http', 'https', 'socks4', 'socks5', 'socks5h']
const MEASURED = ['lab', 'inferred']
const nonEmpty = (s) => typeof s === 'string' && s !== ''

/** Problems with a descriptor's `proxy` export against the shape of 1.6 §9.7 (`[]` = fine):
 *  `{ env: [names the agent reads, preferred first], files: [{ path: ({ home, env }) => file, format: 'json' | 'dotenv', keys: [key path | name, …] }], systemProxy: { http, ws } (true | false | 'unknown':
 *  does it follow the OS proxy setting, per transport), schemes: [the proxy URL schemes it takes], unsupported: { <scheme>: 'silent-direct' | 'fails' }, branches: ['all'] | ['http', 'ws'],
 *  measured: { win32, linux, darwin }: 'lab' | 'inferred', restart: { hint, processes, managed? } }` (`managed: true`: the settings live in a process the agent's windows do not end, which `doctor` then names by pid). A harness with more to say (proxy mode's per-form data, 4.8 §2.3) adds keys; these must be there. */
export function proxyProblems(p) {
  if (!p || typeof p !== 'object') return ['no proxy export']
  const bad = []
  if (!Array.isArray(p.env) || !p.env.length || !p.env.every(nonEmpty)) bad.push('env: not a list of variable names')
  if (!Array.isArray(p.files)) bad.push('files: not a list')
  else p.files.forEach((f, i) => {
    if (!f || typeof f.path !== 'function' || !['json', 'dotenv'].includes(f.format) || !Array.isArray(f.keys) || !f.keys.length) bad.push(`files[${i}]: needs path(), format json | dotenv and a non-empty keys list`)
  })
  for (const k of ['http', 'ws']) if (![true, false, 'unknown'].includes(p.systemProxy && p.systemProxy[k])) bad.push(`systemProxy.${k}: not true, false or 'unknown'`)
  if (!Array.isArray(p.schemes) || !p.schemes.length || !p.schemes.every((s) => SCHEME.includes(s))) bad.push(`schemes: not a list of ${SCHEME.join(' | ')}`)
  for (const [s, v] of Object.entries(p.unsupported || {})) if (!SCHEME.includes(s) || !['silent-direct', 'fails'].includes(v)) bad.push(`unsupported.${s}: ${JSON.stringify(v)} is not silent-direct or fails`)
  if (!p.unsupported || typeof p.unsupported !== 'object') bad.push('unsupported: not an object')
  if (!(Array.isArray(p.branches) && (p.branches.join() === 'all' || p.branches.join() === 'http,ws'))) bad.push("branches: neither ['all'] nor ['http', 'ws']")
  for (const k of ['win32', 'linux', 'darwin']) if (!MEASURED.includes(p.measured && p.measured[k])) bad.push(`measured.${k}: not lab or inferred`)
  if (!p.restart || !nonEmpty(p.restart.hint) || !nonEmpty(p.restart.processes)) bad.push('restart: needs hint and processes')
  if (p.restart && p.restart.managed !== undefined && typeof p.restart.managed !== 'boolean') bad.push('restart.managed: not true or false')
  return bad
}

export async function loadHarnesses(dirUrl = new URL('./', import.meta.url)) {
  const names = fs.readdirSync(fileURLToPath(dirUrl)).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs' && !n.startsWith('_')).sort()
  const out = []
  for (const n of names) {
    const d = (await import(new URL(n, dirUrl).href)).default
    const bad = proxyProblems(d && d.proxy)
    if (bad.length) throw new Error(`harness ${n}: its proxy export is wrong (RFC 1.6 §9.7): ${bad.join('; ')}`)
    out.push(d)
  }
  return out
}
