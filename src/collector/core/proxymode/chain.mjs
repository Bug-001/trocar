// chain.mjs — P7, the upstream chain (spec 4.11 §1 「门只在代理链里插一环」 and P7; plan decision #12): the proxy a door dials for one connection is
// the one its agent would have used without asight. One function for every harness; it names no OS and no harness (the descriptor's `proxy` says
// which variables the agent reads, in its order, and whether it follows the system proxy). Readers are injected: the process facts and the parent walk
// come from the OS backend (cached there by pid + start), the system proxy from the OS reader, already in the shape below. Nothing here does I/O.
//
// upstreamFor({ desc, form, facts, recordedPrior, systemProxy, header, headerAllowed, isAsightDoor, transport }) →
//   { url: string | null, source, bypass: [row], code?, pac?, unreadable?, notes? }
//   source ∈ 'hook' | 'config-prior' | 'process-env' | 'system-proxy' | 'direct' | 'unknown'
//
//   desc          the harness descriptor (its `proxy.env`, `proxy.systemProxy`) · form the identified process's form (the caller judges headerAllowed by it)
//   facts         { pid, start, env, parentOf } of the identified process, or null when identity failed: then only steps 2, 4 and 5 run (decision #12).
//                 `env` is an object or a Map (null / undefined = could not be read); `parentOf()` → the parent's facts, or null when it is gone.
//   recordedPrior the `prior_value` recorded by `on` for this form's entry (null: the user had none)
//   systemProxy   null (none, or off) · { url, bypass } · { pac: true } (a PAC or WPAD: reported, never executed) · { ok: false } (unreadable)
//   header        the CONNECT's `X-Asight-Upstream` value, if any; it counts only when `headerAllowed` (the form uses a hook that sends it), else it is
//                 ignored and `notes` says so (`{ note: 'header-ignored' }`; a skipped door is `{ note: 'door-skipped', source }`; never a value: the caller records them)
//   isAsightDoor  (text) → bool; default `isAsightDoorUrl`. Applied at EVERY source: a door is never an upstream.
//   transport     'http' | 'ws': which half of `proxy.systemProxy` says whether the agent follows the system proxy
//
// Steps: 1 hook (the header when allowed, then ASIGHT_PRIOR_PROXY; 'none' = no proxy) · 2 config-prior · 3 process-env (the agent's order; a door
// value walks parentOf upward) · 4 system-proxy (followers only; with its bypass) · 5 direct. Step 3 that cannot be recovered (the env unreadable,
// the parent gone after a door) is `unknown`: the system proxy if there is one (follower or not), else direct, with code `prior-proxy-unknown`.
import { CODE } from '../codes.mjs'

export const HOOK_ENV = 'ASIGHT_PRIOR_PROXY'
export const HOOK_HEADER = 'x-asight-upstream'
export const SOURCES = Object.freeze(['hook', 'config-prior', 'process-env', 'system-proxy', 'direct', 'unknown'])
const NONE = 'none'
const MAX_DEPTH = 64 // a parent chain longer than this is a loop in the reader, not a process tree

const textOf = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const envGet = (env, name) => (env instanceof Map ? env.get(name) : env[name])
const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)

/** Is a proxy text one of asight's doors? A loopback address with asight's credentials (a user and a hex token: the door URL `on` writes, and the
 *  steer value of an older asight), or a loopback address on one of `ports` (an open door, e.g. a PAC-served one, carries no credentials). */
export function isAsightDoorUrl(text, { ports = [] } = {}) {
  const t = textOf(text)
  if (t === null) return false
  let u
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`) } catch { return false }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!isLoopback(host)) return false
  if (u.port !== '' && ports.includes(Number(u.port))) return true
  let pass = ''
  try { pass = decodeURIComponent(u.password) } catch { return false }
  return u.username !== '' && /^[0-9a-f]{32,}$/i.test(pass)
}

function systemOf(sp) {
  if (sp == null) return null
  if (sp.ok === false) return { unreadable: true }
  if (sp.pac) return { pac: true }
  const url = textOf(sp.url)
  return url === null ? null : { url, bypass: Array.isArray(sp.bypass) ? sp.bypass : [] }
}

export async function upstreamFor({ desc, form = null, facts = null, recordedPrior = null, systemProxy = null, header = null, headerAllowed = false, isAsightDoor = isAsightDoorUrl, transport = 'http' } = {}) {
  if (!desc || !desc.proxy || !Array.isArray(desc.proxy.env)) throw new TypeError('upstreamFor needs the harness descriptor (its proxy.env)')
  void form // the caller judges headerAllowed by the form; the chain itself treats every form alike
  const notes = []
  const door = (v) => { try { return !!isAsightDoor(v) } catch { return true } } // a judge that throws is no proof it is not a door: never dial it
  const out = (source, url, extra = {}) => ({ url, source, bypass: [], ...extra, ...(notes.length ? { notes } : {}) })
  /** A proxy text from `source`: 'none' is no proxy; a door is skipped (null: look further), noted with its source and never its value. */
  const take = (source, v) => {
    if (v.toLowerCase() === NONE) return out(source, null)
    if (door(v)) { notes.push({ note: 'door-skipped', source }); return null }
    return out(source, v)
  }
  const sys = systemOf(systemProxy)
  const viaSystem = (source, extra = {}) => {
    if (!sys) return null
    if (sys.pac) return out(source, null, { pac: true, ...extra })
    if (sys.unreadable) return out(source, null, { unreadable: true, ...extra })
    if (door(sys.url)) { notes.push({ note: 'door-skipped', source: 'system-proxy' }); return null }
    return out(source, sys.url, { bypass: sys.bypass, ...extra })
  }
  const unknown = () => viaSystem('unknown', { code: CODE.priorProxyUnknown }) ?? out('unknown', null, { code: CODE.priorProxyUnknown })

  // 1. hook: per process, so only with an identity
  const h = textOf(header)
  if (h !== null && !(facts && headerAllowed)) notes.push({ note: 'header-ignored' })
  if (facts) {
    const r = (h !== null && headerAllowed ? take('hook', h) : null) ?? (facts.env != null && textOf(envGet(facts.env, HOOK_ENV)) !== null ? take('hook', textOf(envGet(facts.env, HOOK_ENV))) : null)
    if (r) return r
  }

  // 2. config-prior
  const prior = textOf(recordedPrior)
  if (prior !== null) { const r = take('config-prior', prior); if (r) return r }

  // 3. process-env: the first variable the agent reads that is set; a door walks up to the process that started it
  if (facts) {
    let p = facts
    for (let depth = 0; ; depth++) {
      if (!p || p.env == null) return unknown()
      const name = desc.proxy.env.find((n) => textOf(envGet(p.env, n)) !== null)
      if (name === undefined) break // this process has no proxy variable: the user had none
      const r = take('process-env', textOf(envGet(p.env, name)))
      if (r) return r
      if (depth >= MAX_DEPTH || typeof p.parentOf !== 'function') return unknown()
      try { p = await p.parentOf() } catch { return unknown() }
    }
  }

  // 4. system-proxy: only for an agent that follows it on this transport ('unknown' follows: a proxy it may not need costs less than a way out it lacks)
  const follows = desc.proxy.systemProxy ? desc.proxy.systemProxy[transport] : false
  if (follows === true || follows === 'unknown') { const r = viaSystem('system-proxy'); if (r) return r }

  // 5. direct
  return out('direct', null)
}
