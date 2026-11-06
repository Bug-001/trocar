// driver-setup.mjs — driver mode's (Linux) side of the one setup judgement (4.11 P4b, 4.6 「这个 harness 装好了没有」, D65④): the descriptor's `inject`
// is read as on installs (the inject ctx, an empty running-process table, whoever asks), one form per harness named by the harness, present when inject
// gives at least one item; the carriers are the install-phase manifest items, judged by setupOf. No root in a trust store here: no root-missing.
import nodeFs from 'node:fs'
import path from 'node:path'
import { readText, readTextOrError } from './core/config-read.mjs'
import { collectorHome } from '../paths.mjs'
import { caPaths } from './core/tls/ca-store.mjs'
import { setupOf } from './core/proxymode/status-facts.mjs'

/** The ctx a descriptor's `inject` reads (the shape install's planOn hands it), plus what the proxy-mode readers (readSrc) need. */
export function driverCtx({ os, home, env = process.env, fs = nodeFs, running = [] }) {
  const collectorDir = collectorHome(path.join(home, '.trocar'))
  return {
    os, home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running,
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f),
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
    collectorDir, caPem: caPaths(path.join(collectorDir, 'ca')).pem,
    readFile: (f) => fs.readFileSync(f, 'utf8'), exists: (f) => fs.existsSync(f), readdir: (d) => fs.readdirSync(d),
    cwd: home, dirs: {}, which: () => null, policy: () => ({ set: false }),
  }
}

/** The harness's one form when its inject gives at least one item now, else none. A throw is the caller's. */
export function driverForms(desc, ctx) {
  if (typeof desc.inject !== 'function') return []
  const out = desc.inject(ctx) || {}
  return ['entries', 'owned', 'files'].some((k) => (out[k] || []).length) ? [desc.name] : []
}

/** setupOf for one harness in driver mode. An inject that throws → unknown with its reason (D38). */
export function driverSetup(desc, { os, home, env, manifest, fs = nodeFs }) {
  const ctx = driverCtx({ os, home, env, fs })
  let forms
  try { forms = driverForms(desc, ctx) } catch (e) { return { state: 'unknown', missing: [], reason: String((e && e.message) || e) } }
  return setupOf(desc, { os, manifest, ctx, root: null, fs, forms })
}

/** { <harness>: [its form] | [] } for every descriptor with an inject. A throw propagates. */
export function driverPresent({ os, home, env, harnesses, fs = nodeFs }) {
  const ctx = driverCtx({ os, home, env, fs })
  return Object.fromEntries(harnesses.filter((d) => typeof d.inject === 'function').map((d) => [d.name, driverForms(d, ctx)]))
}
