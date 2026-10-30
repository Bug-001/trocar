// loc.mjs (src/off) — the one resolver of a descriptor's <loc> (spec 4.11 §2.3; the shape is described in src/collector/core/proxymode/sources.mjs, which
// re-exports it). It lives here so the marker undo (marker.mjs) finds a file where `on` wrote it, by the same rule — the copy ~/.trocar/bin/trocar-off has
// no collector tree to ask. Imports only node:*.
import path from 'node:path'

/** The absolute paths a <loc> names on this machine: one without `glob`, the matching entries with it; [] when it names nothing here.
 *  ctx = { os, home, cwd, env (object or Map), dirs: { appSupport, localAppData }, readdir(p) (with `glob`), join (default path.join) }. */
export function resolveLoc(loc, ctx) {
  const l = loc && loc.perOs ? loc.perOs[ctx.os] : loc
  if (!l) return []
  const join = ctx.join || path.join
  const over = l.env ? (ctx.env instanceof Map ? ctx.env.get(l.env) : ctx.env ? ctx.env[l.env] : undefined) : undefined
  const tilde = (v) => (/^~([\\/]|$)/.test(v) ? join(ctx.home, v.slice(2)) : v)
  const baseDir = { home: ctx.home, cwd: ctx.cwd, abs: '', appSupport: ctx.dirs && ctx.dirs.appSupport, localAppData: ctx.dirs && ctx.dirs.localAppData }[l.base]
  if (baseDir == null) return []
  const top = over !== undefined && over !== null && over !== '' ? tilde(over) : l.dir ? join(baseDir, l.dir) : baseDir
  const at = l.path ? (top === '' ? l.path : join(top, l.path)) : top
  if (!l.glob) return [at]
  const re = new RegExp(`^${l.glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return ctx.readdir(at).filter((n) => re.test(n)).sort().map((n) => join(at, n))
}
