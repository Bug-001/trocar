// model-on.mjs — `trocar on` on macOS and Windows in the collector model (RFC 4.11 §1「on / off」, §3 ① ⑪ ⑫, P5; 1.6 §1.1; plan T20). `on` only
// routes: it never writes a certificate (D55①). In order: the install record must be there (else `cert-not-installed`); per harness, precondition ⑪
// — its install items are there and unchanged, the wrapper's hash included — or only that harness is refused with the hint `trocar install`
// (CM28); desired on and the liveness record's `on_at`; the ports (core/ingress-config, rebinding a group port another socket took); POST /on
// to the daemon through the ONE endpoint resolver (controlEndpointFor), and the doors it opened read back; the P5 entries of the present forms and the
// switch files, each with its door; the harness notes (hostTree, effects). The caller holds op.lock and has refused root. The CLI calls it from `trocar on`.
import nodeFs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { collectorHome } from '../paths.mjs'
import { readManifest, saveManifest } from './core/trust/journal.mjs'
import { installUsable } from '../off/manifest.mjs'
import { readStateFile, setDesired, writeStateAtomic } from '../off/state.mjs'
import { WINDOWS_MAX } from '../off/holders.mjs'
import { setupOf } from './core/proxymode/status-facts.mjs'
import { planRoutes, writeRoutes, noProxyNames } from './core/proxymode/entries.mjs'
import { resolveLoc } from './core/proxymode/sources.mjs'
import { loadIngressConfig, rebindTaken, freeOnLoopback } from './core/ingress-config.mjs'
import { controlEndpointFor } from './core/control.mjs'
import { CODE } from './core/codes.mjs'
import { appendEvent } from './core/events.mjs'

const INSTALL_HINT = 'trocar install'
// 1.6 §1.1: what a `setup.missing[].what` means, in words (the code stays in the JSON)
const SETUP_WHY = { 'carrier-absent': 'trocar has not set up its certificate for it (installed after trocar, or what trocar placed is gone)', 'carrier-overwritten': 'its own update overwrote what trocar placed for its certificate', 'root-missing': "trocar's root certificate is no longer trusted" }
const errText = (e) => String((e && e.message) || e)
/** The root's state the way `status` reads it (cert.root.state, 1.6 §9.4): trocar-ca.pem asked of the user's store through the injected reader — the one
 *  store question `on` asks, so ⑪'s root-missing is status's (4.11 P4b). Pending / declined / unreadable → not `missing`: not setup work, or not known. */
export async function rootOf({ dir, m, rootStore, fs }) {
  if (!rootStore) return null
  if ((m.install.pending || []).some((p) => p.item === 'root-store')) return { state: 'pending' }
  let x
  try { x = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca', 'trocar-ca.pem'))) } catch { return null }
  let has
  try { has = await rootStore.has({ fp256: x.fingerprint256, sha1: x.fingerprint.replace(/:/g, '') }) } catch { return null }
  return { state: has && has.present ? 'in-place' : has && has.error ? 'unknown' : 'missing' }
}
const groupOf = (harness, routeId) => `${harness}:${routeId}`

/** turnOnModel({ os, home, env, ids, harnesses, ctx, … }) → { on, refused, routes, notes, problems, doors, exit }. `request` / `isFree` replace the
 *  world in a test that needs to; the default asks the endpoint controlEndpointFor resolves (no socket path is ever passed in). */
export async function turnOnModel({ os, home, env = process.env, ids = null, harnesses, ctx, fs = nodeFs, now = () => new Date(), request = null, isFree = freeOnLoopback, persistentEnv = null, systemProxy = null, renderHook = null, newId = undefined, dryRun = false, rootStore = null, source = null }) {
  const dir = collectorHome(path.join(home, '.trocar'))
  const m = readManifest(dir, fs)
  if (!installUsable(m)) return { code: CODE.certNotInstalled, on: [], refused: [], routes: [], notes: [], problems: [`trocar is not installed for this user (no install record with a root): run ${INSTALL_HINT} first`], exit: 1 }
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const wanted = ids || m.install.harnesses
  const refused = [], on = []
  const unsure = [], root = await rootOf({ dir, m, rootStore, fs })
  for (const h of wanted) { // precondition ⑪ = status's `setup` (4.11 P4b, one judgement): only a harness that needs setup is refused, nothing written for it
    const s = setupOf(byName.get(h), { os, manifest: m, ctx, root, fs })
    if (s.state === 'needed') refused.push({ harness: h, reason: CODE.setupNeeded, why: [...new Set(s.missing.map((x) => SETUP_WHY[x.what]))].join('; '), command: INSTALL_HINT })
    else { on.push(h); if (s.state === 'unknown') unsure.push({ harness: h, text: `whether ${h} is set up could not be told (${s.reason})` }) }
  }
  // what install left pending (the root store declined or not answered, the custody unreachable): on goes on — the forms the root cannot reach go through
  // their doors forwarding only (D51④) — and says each one, with the command, forward only (1.6 §1.1)
  const pending = (Array.isArray(m.install.pending) ? m.install.pending : []).map((p) => ({ harness: null, code: CODE.installPending, item: p.item, state: p.state, why: p.reason, command: INSTALL_HINT }))
  const out = { on, refused, routes: [], notes: [...pending, ...unsure], problems: [], doors: {}, planned: [], exit: 1 }
  if (!on.length) return out
  const render = (tpl, { door, harness }) => { const d = byName.get(harness), p = (d.proxy || {}).env || []; return renderHook(tpl, { DOOR: door, PROXY_ENV: p, PROXY_NAMES: p, NO_PROXY_ENV: noProxyNames(d) }).text }
  const wctx = { ...ctx, dir, home, manifest: m, fs, now, persistentEnv, systemProxy, render, ...(newId ? { newId } : {}) }
  const planned = on.map((h) => ({ h, plan: planRoutes(byName.get(h), wctx) }))
  // --dry-run (1.6 §1.1): what would be written — each planned route with the files it resolves to — and nothing written
  out.planned = planned.flatMap(({ h, plan }) => plan.routes.map((r) => ({ harness: h, route: r.id, kind: r.route.kind, forms: r.forms, paths: r.route.file ? resolveLoc(r.route.file, wctx) : [] })))
  if (dryRun) return { ...out, exit: refused.length || pending.length ? 1 : 0 }
  // desired on first (R9), then the liveness window opens: the holder judge (P12) counts from here
  const stateF = path.join(dir, 'state.json')
  let st
  try { st = readStateFile(stateF, { fs, installed: on, now: now() }).state } catch { st = null }
  // D54: a harness already on keeps its state and its window — a later on_at would drop a holder started in between
  const fresh = on.filter((h) => !(st && st.harnesses[h] && st.harnesses[h].desired === 'on' && m.liveness[h] && m.liveness[h].on_at && !m.liveness[h].off_at))
  if (fresh.length) {
    writeStateAtomic(stateF, setDesired(st || { version: 2, updated_at: null, harnesses: {} }, fresh, 'on', now()), { fs })
    // the window that closed is kept in `windows` (P12): a process started in it read an entry that leads to the same door, so it is still routed
    // (V16) and a holder after the next off. Cleared below when this on moves the harness's door.
    for (const h of fresh) {
      const was = m.liveness[h] || {}, l = { ...was, on_at: now().toISOString() }
      delete l.off_at
      if (was.on_at && was.off_at) l.windows = [...(Array.isArray(was.windows) ? was.windows : []), { on_at: was.on_at, off_at: was.off_at }].slice(-WINDOWS_MAX)
      m.liveness[h] = l
    }
    saveManifest(dir, m, fs)
  }

  const groups = planned.flatMap(({ h, plan }) => plan.routes.map((r) => groupOf(h, r.id)))
  const ep = controlEndpointFor({ platform: os, dir, env, fs })
  const ask = request || ep.request
  let doorsNow = {}
  try { doorsNow = ep.socketPath ? ((await ask({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 2000 })).doors || {}) : {} } catch { doorsNow = {} }
  const was = await loadIngressConfig({ dir, groups, isFree, fs })
  const cfg = await rebindTaken(was, async (port, g) => doorsNow[g] === port || isFree(port), { dir, isFree, fs })
  // a door whose port or token is new: the entries of the earlier windows lead nowhere now, so those windows go (P12)
  const moved = fresh.filter((h) => m.liveness[h].windows && (was.created || [...was.added, ...cfg.rebound].some((g) => g.startsWith(`${h}:`))))
  if (moved.length) { for (const h of moved) delete m.liveness[h].windows; saveManifest(dir, m, fs) }
  // §3 ①: a group port another socket holds is engine-port-taken — said in the receipt and recorded (D38), then the group's entries follow the new door
  for (const g of cfg.rebound) {
    const [from, to] = [was.groupPorts[g], cfg.config.groupPorts[g]]
    const reason = `trocar's local proxy port ${from} for ${g} is held by another program; trocar on moved it to ${to} and rewrites its entries`
    try { appendEvent(dir, { event: 'failure', where: 'ingress', code: CODE.enginePortTaken, door: g, port: from, moved_to: to, reason, ...(source ? { source } : {}) }) } catch { /* the receipt's note carries it (R11) */ }
    out.notes.push({ harness: g.slice(0, g.indexOf(':')), code: CODE.enginePortTaken, text: `${CODE.enginePortTaken}: port ${from} of ${g} was taken by another program; trocar moved it to ${to} and rewrote the entries` })
  }
  let doors = null
  if (!ep.socketPath) out.problems.push(`no daemon to ask: ${ep.why || 'no control endpoint'}; start it (trocar daemon), then run trocar on again`)
  else {
    try {
      const r = await ask({ socketPath: ep.socketPath, method: 'POST', path: '/on', body: { harnesses: on, groups: Object.fromEntries(groups.map((g) => [g, cfg.config.groupPorts[g]])) } })
      doors = (r && r.doors) || {}
    } catch (e) { out.problems.push(`the daemon did not take the on request (${errText(e)})`) }
  }
  out.doors = doors || {}
  // V104: turned on = at least one of its entries now leads to a door — what the run's result line lists, also when a throw cuts the run short
  const turned = () => on.filter((h) => out.routes.some((r) => r.harness === h && r.ok))
  if (doors) {
    try {
      for (const { h } of planned) {
        const doorOf = (rid) => { const u = doors[groupOf(h, rid)]; if (!u) throw Object.assign(new Error(`the daemon opened no door for ${groupOf(h, rid)}`), { code: 'not-routed' }); return u }
        const w = writeRoutes(byName.get(h), { ...wctx, harness: h }, doorOf)
        for (const r of w.results) out.routes.push({ harness: h, ...r })
        for (const n of w.notRouted) out.routes.push({ harness: h, ok: false, ...n })
        out.notes.push(...w.notes.map((n) => ({ harness: h, ...n })))
      }
    } catch (e) { if (e && typeof e === 'object') e.turnedOn = turned(); throw e }
  }
  out.turnedOn = turned()
  out.exit = !refused.length && !pending.length && doors && out.routes.every((r) => r.ok) && !out.problems.length ? 0 : 1
  return out
}
