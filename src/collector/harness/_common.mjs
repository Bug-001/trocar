// _common.mjs — small readers shared by harness descriptors. Harness data only; no engine, no OS code.
import path from 'node:path'
import { hostOf, parseDotenv } from '../core/config-read.mjs'

export const envValues = (env, keys) => keys.map((k) => env.get(k)).filter((v) => typeof v === 'string' && v !== '')
export const envHosts = (env, keys) => envValues(env, keys).map(hostOf).filter(Boolean)
// Proxy settings as { url, source }; the tracker turns them into the engine's ProxyEntry (4.6 §引擎 3, `describe`).
export const envProxies = (env, keys) => keys.filter((k) => (env.get(k) || '') !== '').map((k) => ({ url: env.get(k), source: `env:${k}` }))

// Whether a CA path in an agent's config or environment is one trocar wrote: a path under the collector directory. A descriptor skips it when it collects the user's CA files (the
// bundle would otherwise carry trocar's own bundle, and trocar's CA would be recorded as a user CA). On Windows the values trocar writes into agent configs have forward slashes (4.8 §6.1)
// while the collector directory comes back with backslashes (and any case): compare ignoring both; elsewhere the plain prefix.
export function isOwnPath(ctx, v) {
  if (typeof v !== 'string' || v === '' || !ctx.collectorDir) return false
  if (ctx.os !== 'win32') return v.startsWith(ctx.collectorDir + path.sep)
  const n = (p) => String(p).replace(/\\/g, '/').toLowerCase()
  return n(v).startsWith(`${n(ctx.collectorDir).replace(/\/+$/, '')}/`)
}

// Value after a flag: `--flag v` or `--flag=v`.
export function argAfter(argv, flags) {
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i]) && i + 1 < argv.length) return argv[i + 1]
    const f = flags.find((x) => argv[i].startsWith(x + '='))
    if (f) return argv[i].slice(f.length + 1)
  }
  return null
}

// A dotenv file as an env layer: `drop` filters keys the agent refuses from that file; mode 'fill' (the agent sets
// only variables its environment does not have) or 'override'.
export function dotenvLayer(ctx, file, { name, mode = 'override', live = false, drop = null } = {}) {
  const text = ctx.readText(file)
  if (text == null) return null
  const vars = {}
  for (const [k, v] of parseDotenv(text)) if (!drop || !drop(k)) vars[k] = v
  return { name, file, mode, vars, live, mtimeMs: ctx.mtimeOf(file) }
}

// Hosts of every string under a key matching keyRe anywhere in a parsed config (provider lists, maps).
export function urlHostsDeep(value, keyRe, out = []) {
  if (Array.isArray(value)) { for (const v of value) urlHostsDeep(v, keyRe, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && keyRe.test(k)) { const h = hostOf(v); if (h) out.push(h) } else urlHostsDeep(v, keyRe, out)
    }
  }
  return out
}

// Whether a variable is set to a true-ish value ('1', 'true', 'yes', 'on').
export const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim())

// A value that differs per OS, as plain tagged data (spec 4.11 §2.3): core/proxymode/sources.mjs picks the entry of ctx.os. Not a function value, so
// a descriptor's proxyMode stays data only.
export const perOs = ({ darwin, win32 }) => ({ perOs: { ...(darwin !== undefined ? { darwin } : {}), ...(win32 !== undefined ? { win32 } : {}) } })
