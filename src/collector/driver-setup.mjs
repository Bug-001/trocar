// driver-setup.mjs — driver mode's (Linux) side of the one setup judgement (4.11 P4b, 4.6 「这个 harness 装好了没有」, D65④): one form per harness,
// named by the harness, present when any place of the descriptor's own footprint (top-level `present`) is there — a `{ command }` over the user's recorded
// PATH and a moved place by the recorded variables, so whoever asks gets one answer; the carriers are the install-phase manifest items, judged by setupOf. No root in a trust store here: no root-missing.
import nodeFs from 'node:fs'
import path from 'node:path'
import { readText, readTextOrError } from './core/config-read.mjs'
import { collectorHome } from '../paths.mjs'
import { caPaths } from './core/tls/ca-store.mjs'
import { setupOf } from './core/proxymode/status-facts.mjs'
import { isPresent, uncapturedOf } from './core/proxymode/sources.mjs'
import { userWhich, userFootprintEnv } from '../off/user-path.mjs'
import { certBlocks } from '../off/pem.mjs'
import { samePath } from './core/trust/journal.mjs'

/** The ctx a descriptor's `inject` reads (the shape install's planOn hands it), plus what the proxy-mode readers (readSrc) need. */
export function driverCtx({ os, home, env = process.env, fs = nodeFs, running = [] }) {
  const collectorDir = collectorHome(path.join(home, '.trocar'))
  return {
    os, home, env: userFootprintEnv({ home, env, fs }), running, // a moved footprint place resolves by the recorded values, as `which` by the recorded PATH
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f),
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
    collectorDir, caPem: caPaths(path.join(collectorDir, 'ca')).pem,
    readFile: (f) => fs.readFileSync(f, 'utf8'), exists: (f) => fs.existsSync(f), readdir: (d) => fs.readdirSync(d),
    cwd: home, dirs: {}, which: userWhich({ home, env, os, fs }), policy: () => ({ set: false }),
  }
}

/** The harness's one form when it has an inject and its footprint is there now, else none. */
export function driverForms(desc, ctx) {
  return typeof desc.inject === 'function' && isPresent(desc, ctx) ? [desc.name] : []
}

/** setupOf for one harness in driver mode. */
export function driverSetup(desc, { os, home, env, manifest, fs = nodeFs }) {
  const ctx = driverCtx({ os, home, env, fs })
  const forms = driverForms(desc, ctx), s = setupOf(desc, { os, manifest, ctx, root: null, fs, forms })
  const gap = s.state !== 'unknown' && forms.length && !s.missing.length ? bundleGapOf(desc, ctx, manifest, fs) : null
  return { ...(gap ? { state: 'needed', missing: [{ form: desc.name, what: gap }] } : s), uncaptured: uncapturedOf(desc, ctx) }
}

/** 4.11 P4b in driver mode: a combined bundle install recorded lacks a CA the files its harness's own inject names now (`certsFrom`, what install merges, the
 *  shell's SSL_CERT_FILE among them) hold → 'bundle-lacks-ca'; a file that cannot be read now, or a bundle that cannot be, is not known: never a false alarm. */
function bundleGapOf(desc, ctx, m, fs) {
  let out
  try { out = desc.inject(ctx) || {} } catch { return null }
  for (const f of (out.files || []).filter((x) => x && x.bundle)) {
    const rec = ((m && m.files) || []).find((r) => r.role === 'bundle' && samePath(r.path, f.path, fs))
    if (!rec || !Array.isArray(rec.user_fps)) continue
    const had = new Set(rec.user_fps)
    let held
    for (const src of f.certsFrom || []) {
      let text
      try { text = fs.readFileSync(src, 'latin1') } catch { continue }
      for (const { fp } of certBlocks(text)) {
        if (had.has(fp)) continue
        if (held === undefined) { try { held = new Set(certBlocks(fs.readFileSync(f.path, 'latin1')).map((x) => x.fp)) } catch { held = null } }
        if (held && !held.has(fp)) return 'bundle-lacks-ca'
      }
    }
  }
  return null
}

/** { <harness>: [its form and the uncaptured forms here] | [] } for every descriptor with an inject: which harnesses status lists (1.6 §3.5); a form
 *  trocar does not capture counts too, so its note has a row to stand under (4.6 「不采的形态」). Install targets and setup read driverForms alone. */
export function driverPresent({ os, home, env, harnesses, fs = nodeFs }) {
  const ctx = driverCtx({ os, home, env, fs })
  return Object.fromEntries(harnesses.filter((d) => typeof d.inject === 'function').map((d) => [d.name, [...driverForms(d, ctx), ...uncapturedOf(d, ctx).map((u) => u.form)]]))
}
