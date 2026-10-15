// model-on.mjs — `asight on` on macOS and Windows in the collector model (RFC 4.11 §1「on / off」, §3 ① ⑪ ⑫, P5; 1.6 §1.1; plan T20). `on` only
// routes: it never writes a certificate (D55①). In order: the install record must be there (else `cert-not-installed`); per harness, precondition ⑪
// — its install items are there and unchanged, the wrapper's hash included — or only that harness is refused with the hint `asight install`
// (CM28); desired on and the liveness record's `on_at`; the ports (core/ingress-config, rebinding a group port another socket took); POST /on
// to the daemon through the ONE endpoint resolver (controlEndpointFor), and the doors it opened read back; the P5 entries of the present forms and the
// switch files, each with its door; the harness notes (hostTree, effects). The caller holds op.lock and has refused root. The CLI calls it from `asight on`.
import nodeFs from 'node:fs'
import path from 'node:path'
import { collectorHome } from '../paths.mjs'
import { readManifest, saveManifest, judgeEntry, sha256 } from './core/trust/journal.mjs'
import { installUsable, itemsOfPhase } from '../off/manifest.mjs'
import { readOrNull } from '../off/fsutil.mjs'
import { readStateFile, setDesired, writeStateAtomic } from '../off/state.mjs'
import { checkWrapper } from './core/proxymode/hooks/wrapper.mjs'
import { planRoutes, writeRoutes } from './core/proxymode/entries.mjs'
import { loadIngressConfig, rebindTaken, freeOnLoopback } from './core/ingress-config.mjs'
import { controlEndpointFor } from './core/control.mjs'
import { CODE } from './core/codes.mjs'

const INSTALL_HINT = 'asight install'
const errText = (e) => String((e && e.message) || e)
const groupOf = (harness, routeId) => `${harness}:${routeId}`

/** Precondition ⑪ for one harness: → null (its install items are there and unchanged) or { reason: 'entry-missing' | 'entry-changed', path, command }. */
export function installDrift(m, harness, fs = nodeFs) {
  if (!((m.install && m.install.harnesses) || []).includes(harness)) return { reason: 'entry-missing', path: null, command: INSTALL_HINT, why: `${harness} was not found when asight install last ran` }
  const recorded = itemsOfPhase(m, 'install').filter((i) => i.harness === harness)
  // what install placed (m.install.items) must still be on record: an item whose record is gone is as missing as its file
  for (const p of (m.install.items && m.install.items[harness]) || []) {
    if (!recorded.some((x) => x.kind === p.kind && x.path === p.path)) return { reason: 'entry-missing', path: p.path, command: INSTALL_HINT, why: `${p.path}, which asight install placed for ${harness}, is no longer in the install manifest` }
  }
  for (const x of recorded) {
    if (x.kind === 'owned-file') {
      const d = x.role === 'wrapper' ? checkWrapper({ fs }, x) : (() => { const b = readOrNull(fs, x.path); return b == null ? { reason: 'entry-missing', path: x.path } : sha256(b) !== x.sha256 ? { reason: 'entry-changed', path: x.path } : null })()
      if (d) return { ...d, command: INSTALL_HINT }
    } else {
      const j = judgeEntry({ manifest: m, planned: x, fs })
      if (j.action !== 'skip-intact') return { reason: fs.existsSync(x.path) ? 'entry-changed' : 'entry-missing', path: x.path, command: INSTALL_HINT, why: j.why }
    }
  }
  return null
}

/** turnOnModel({ os, home, env, ids, harnesses, ctx, … }) → { on, refused, routes, notes, problems, doors, exit }. `request` / `isFree` replace the
 *  world in a test that needs to; the default asks the endpoint controlEndpointFor resolves (no socket path is ever passed in). */
export async function turnOnModel({ os, home, env = process.env, ids = null, harnesses, ctx, fs = nodeFs, now = () => new Date(), request = null, isFree = freeOnLoopback, persistentEnv = null, systemProxy = null, renderHook = null, newId = undefined }) {
  const dir = collectorHome(path.join(home, '.asight'))
  const m = readManifest(dir, fs)
  if (!installUsable(m)) return { code: CODE.certNotInstalled, on: [], refused: [], routes: [], notes: [], problems: [`asight is not installed for this user (no install record with a root): run ${INSTALL_HINT} first`], exit: 1 }
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const wanted = ids || m.install.harnesses
  const refused = [], on = []
  for (const h of wanted) {
    const d = installDrift(m, h, fs)
    if (d) refused.push({ harness: h, ...d }); else on.push(h)
  }
  // what install left pending (the root store declined or not answered, the custody unreachable): on goes on — the forms the root cannot reach go through
  // their doors forwarding only (D51④) — and says each one, with the command, forward only (1.6 §1.1)
  const pending = (Array.isArray(m.install.pending) ? m.install.pending : []).map((p) => ({ harness: null, code: CODE.installPending, item: p.item, state: p.state, why: p.reason, command: INSTALL_HINT }))
  const out = { on, refused, routes: [], notes: [...pending], problems: [], doors: {}, exit: 1 }
  if (!on.length) return out
  // desired on first (R9), then the liveness window opens: the holder judge (P12) counts from here
  const stateF = path.join(dir, 'state.json')
  let st
  try { st = readStateFile(stateF, { fs, installed: on, now: now() }).state } catch { st = null }
  writeStateAtomic(stateF, setDesired(st || { version: 2, updated_at: null, harnesses: {} }, on, 'on', now()), { fs })
  for (const h of on) { const l = { ...(m.liveness[h] || {}), on_at: now().toISOString() }; delete l.off_at; m.liveness[h] = l }
  saveManifest(dir, m, fs)

  const render = (tpl, { door, harness }) => { const p = (byName.get(harness).proxy || {}).env || []; return renderHook(tpl, { DOOR: door, PROXY_ENV: p, PROXY_NAMES: p }).text }
  const wctx = { ...ctx, dir, home, manifest: m, fs, now, persistentEnv, systemProxy, render, ...(newId ? { newId } : {}) }
  const planned = on.map((h) => ({ h, plan: planRoutes(byName.get(h), wctx) }))
  const groups = planned.flatMap(({ h, plan }) => plan.routes.map((r) => groupOf(h, r.id)))
  const ep = controlEndpointFor({ platform: os, dir, env, fs })
  const ask = request || ep.request
  let doorsNow = {}
  try { doorsNow = ep.socketPath ? ((await ask({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 2000 })).doors || {}) : {} } catch { doorsNow = {} }
  const cfg = await rebindTaken(await loadIngressConfig({ dir, groups, isFree, fs }), async (port, g) => doorsNow[g] === port || isFree(port), { dir, isFree, fs })
  let doors = null
  if (!ep.socketPath) out.problems.push(`no daemon to ask: ${ep.why || 'no control endpoint'}; start it (asight daemon), then run asight on again`)
  else {
    try {
      const r = await ask({ socketPath: ep.socketPath, method: 'POST', path: '/on', body: { harnesses: on, groups: Object.fromEntries(groups.map((g) => [g, cfg.config.groupPorts[g]])) } })
      doors = (r && r.doors) || {}
    } catch (e) { out.problems.push(`the daemon did not take the on request (${errText(e)})`) }
  }
  out.doors = doors || {}
  if (doors) {
    for (const { h } of planned) {
      const doorOf = (rid) => { const u = doors[groupOf(h, rid)]; if (!u) throw Object.assign(new Error(`the daemon opened no door for ${groupOf(h, rid)}`), { code: 'not-routed' }); return u }
      const w = writeRoutes(byName.get(h), { ...wctx, harness: h }, doorOf)
      for (const r of w.results) out.routes.push({ harness: h, ...r })
      for (const n of w.notRouted) out.routes.push({ harness: h, ok: false, ...n })
      out.notes.push(...w.notes.map((n) => ({ harness: h, ...n })))
    }
  }
  out.exit = !refused.length && !pending.length && doors && out.routes.every((r) => r.ok) && !out.problems.length ? 0 : 1
  return out
}
