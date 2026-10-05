// _common.mjs — small readers shared by harness descriptors. Harness data only; no engine, no OS code.
import { hostOf, parseDotenv } from '../core/config-read.mjs'

export const envValues = (env, keys) => keys.map((k) => env.get(k)).filter((v) => typeof v === 'string' && v !== '')
export const envHosts = (env, keys) => envValues(env, keys).map(hostOf).filter(Boolean)
// Proxy settings as { url, source }; the tracker turns them into the engine's ProxyEntry (plan 3c `describe`).
export const envProxies = (env, keys) => keys.filter((k) => (env.get(k) || '') !== '').map((k) => ({ url: env.get(k), source: `env:${k}` }))

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
