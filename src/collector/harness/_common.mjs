// _common.mjs — small readers shared by harness descriptors. Harness data only; no engine, no OS code.
import { hostOf } from '../core/config-read.mjs'

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
