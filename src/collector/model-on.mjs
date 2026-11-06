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
import { readManifest, saveManifest, flushResults } from './core/trust/journal.mjs'
import { installUsable, OFF_VERSION } from '../off/manifest.mjs'
import { writeStandalone } from '../off/standalone.mjs'
import { readStateFile, setDesired, writeStateAtomic } from '../off/state.mjs'
import { WINDOWS_MAX } from '../off/holders.mjs'
import { setupOf } from './core/proxymode/status-facts.mjs'
import { planRoutes, writeRoutes, noProxyNames } from './core/proxymode/entries.mjs'
import { resolveLoc } from './core/proxymode/sources.mjs'
import { loadIngressConfig, rebindTaken, freeOnLoopback } from './core/ingress-config.mjs'
import { controlEndpointFor } from '../off/control-client.mjs'
import { CODE } from './core/codes.mjs'
import { appendEvent } from './core/events.mjs'
import { retriedNote } from '../cli/words.mjs'
import { lockState } from '../health/read.mjs'

const INSTALL_HINT = 'trocar install'
// 1.6 §1.1: what a `setup.missing[].what` means, in words (the code stays in the JSON)
const SETUP_WHY = { 'carrier-absent': 'trocar has not set up its certificate for it (installed after trocar, or what trocar placed is gone)', 'carrier-overwritten': 'its own update overwrote what trocar placed for its certificate', 'root-missing': "trocar's root certificate is no longer trusted" }
const errText = (e) => String((e && e.message) || e)
/** The root's state the way `status` reads it (cert.root.state, 1.6 §9.4): trocar-ca.pem asked of the user's store through the injected reader — the one
 *  store question `on` asks, so ⑪'s root-missing is status's (4.11 P4b). Pending / declined / unreadable → not `missing`: not setup work, or not known. */
// the place a route writes, as on's plan names it (1.6 V85): its file, its plug-in's file (dir + name), or the directory its file is chosen in
const routePaths = (route, ctx) => (route.file ? resolveLoc(route.file, ctx)
  : route.dir ? resolveLoc(route.dir, ctx).map((d) => (ctx.join || path.join)(d, route.name))
    : route.select ? resolveLoc(route.select.dir, ctx) : [])

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

/** 1.6 §1.6 (R12): the receipt's code of an on that stopped because an off wrote desired off while it ran (src/cli/json.mjs ERROR_CODES). */
export const STOPPED_BY_OFF = CODE.stoppedByOff
/** Which of `ids` the state file no longer says are on — off's mark, read with the reader off writes it for (src/off/state.mjs). A file that cannot
 *  be read names them all: whether an off was asked is not known, and off wins (R12). One read, no fsync: it runs before each harness (D62). */
export function offSince(stateF, ids, { fs = nodeFs, now = new Date() } = {}) {
  if (!ids.length) return []
  let st
  try { st = readStateFile(stateF, { fs, installed: ids, now }).state } catch { return [...ids] }
  return ids.filter((id) => !(st.harnesses[id] && st.harnesses[id].desired === 'on'))
}
export const offWords = (gone, stateF) => `${gone.join(', ')} ${gone.length > 1 ? 'were' : 'was'} turned off while this on ran (${stateF}), and the off wins: on stopped there and started nothing more. What it wrote before is recorded; trocar off undoes it`

/** turnOnModel({ os, home, env, ids, harnesses, ctx, … }) → { on, refused, routes, notes, problems, doors, exit, error? }. `request` / `isFree` replace the
 *  world in a test that needs to; the default asks the endpoint controlEndpointFor resolves (no socket path is ever passed in). `wasOn`: the harnesses
 *  the state file said were on when the caller took op.lock (default: as read here). Before the desired state is written, before POST /on and before
 *  each harness's entries, the state file is read again: one of them off there = an off came in (R12) — on stops, `error.code` STOPPED_BY_OFF, exit 1. */
export async function turnOnModel({ os, home, env = process.env, ids = null, harnesses, ctx, fs = nodeFs, now = () => new Date(), request = null, isFree = freeOnLoopback, persistentEnv = null, systemProxy = null, renderHook = null, newId = undefined, dryRun = false, rootStore = null, source = null, root: rootAsked = undefined, wasOn = null }) {
  const dir = collectorHome(path.join(home, '.trocar'))
  const m = readManifest(dir, fs)
  if (!installUsable(m)) return { code: CODE.certNotInstalled, on: [], refused: [], routes: [], notes: [], problems: [`trocar is not installed for this user (no install record with a root): run ${INSTALL_HINT} first`], exit: 1 }
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const wanted = ids || harnesses.map((d) => d.name).filter((h) => m.install.harnesses.includes(h)) // 4.11 §3 ㉓: this copy's table, in its order
  const refused = [], on = []
  const unsure = [], root = rootAsked !== undefined ? rootAsked : await rootOf({ dir, m, rootStore, fs }) // the plan's answer, when its run hands it on: the question starts OS tools (D62①)
  for (const h of wanted) { // precondition ⑪ = status's `setup` (4.11 P4b, one judgement): only a harness that needs setup is refused, nothing written for it
    const s = setupOf(byName.get(h), { os, manifest: m, ctx, root, fs })
    if (s.state === 'needed') refused.push({ harness: h, reason: CODE.setupNeeded, why: [...new Set(s.missing.map((x) => SETUP_WHY[x.what]))].join('; '), command: INSTALL_HINT })
    else { on.push(h); if (s.state === 'unknown') unsure.push({ harness: h, text: `whether ${h} is set up could not be told (${s.reason})` }) }
  }
  // what install left pending (the root store declined or not answered, the custody unreachable): on goes on — the forms the root cannot reach go through
  // their doors forwarding only (D51④) — and says each one, with the command, forward only (1.6 §1.1)
  const pending = (Array.isArray(m.install.pending) ? m.install.pending : []).map((p) => ({ harness: null, code: CODE.installPending, item: p.item, state: p.state, why: p.reason, command: INSTALL_HINT }))
  const out = { on, refused, routes: [], notes: [...pending, ...unsure], problems: [], doors: {}, planned: [], root, exit: 1 }
  if (!on.length) return out
  const render = (tpl, { door, harness }) => { const d = byName.get(harness), p = (d.proxy || {}).env || []; return renderHook(tpl, { DOOR: door, PROXY_ENV: p, PROXY_NAMES: p, NO_PROXY_ENV: noProxyNames(d) }).text }
  const wctx = { ...ctx, dir, home, manifest: m, fs, now, persistentEnv, systemProxy, render, deferResult: true, ...(newId ? { newId } : {}) } // deferResult: a route's result is saved with the next route's intent (D62①)
  const planned = on.map((h) => ({ h, plan: planRoutes(byName.get(h), wctx) }))
  // --dry-run (1.6 §1.1): what would be written — each planned route with the files it resolves to — and nothing written
  out.planned = planned.flatMap(({ h, plan }) => plan.routes.map((r) => ({ harness: h, route: r.id, kind: r.route.kind, forms: r.forms, paths: routePaths(r.route, wctx), ...(r.route.proxyKeys ? { keys: r.route.proxyKeys.map((k) => [].concat(k).join('.')) } : {}) })))
  if (dryRun) return { ...out, exit: refused.length || pending.length ? 1 : 0 }
  // the way back first (1.6 §3.3, R3): the copy that reads what this on writes, before any write — a copy that cannot be written stops on here
  try { writeStandalone({ home, version: OFF_VERSION, platform: os, fs }) } catch (e) { out.problems.push(`trocar could not write its undo copy, so nothing was turned on (${errText(e)}); fix that, then run trocar on again`); return { ...out, on: [], turnedOn: [] } }
  // desired on first (R9), then the liveness window opens: the holder judge (P12) counts from here
  const stateF = path.join(dir, 'state.json')
  let st
  try { st = readStateFile(stateF, { fs, installed: on, now: now() }).state } catch { st = null }
  const stopped = (gone, turnedOn = []) => { const message = offWords(gone, stateF); out.problems.push(message); return { ...out, error: { code: STOPPED_BY_OFF, message }, turnedOn, exit: 1 } }
  const before = wasOn ? on.filter((h) => wasOn.includes(h)) : on.filter((h) => st && st.harnesses[h] && st.harnesses[h].desired === 'on')
  const goneFirst = offSince(stateF, before, { fs, now: now() })
  if (goneFirst.length) return stopped(goneFirst) // an off came in before this on wrote desired on: writing on over it would undo the off's mark
  // D54: a harness already on keeps its state and its window — a later on_at would drop a holder started in between
  const fresh = on.filter((h) => !(st && st.harnesses[h] && st.harnesses[h].desired === 'on' && m.liveness[h] && m.liveness[h].on_at && !m.liveness[h].off_at))
  if (fresh.length) {
    writeStateAtomic(stateF, setDesired(st || { version: 2, updated_at: null, harnesses: {} }, fresh, 'on', now()), { fs })
    // the window that closed is kept in `windows` (P12): a process started in it read an entry that leads to the same door, so it is still routed
    // (V16) and a holder after the next off. Cleared below when this on moves the harness's door.
    for (const h of fresh) {
      const was = m.liveness[h] || {}, l = { ...was, on_at: now().toISOString() }
      delete l.off_at
      if (was.on_at == null) l.since = l.on_at // the first on: this harness's history is whole from here (P12)
      if (was.on_at && was.off_at) {
        const all = [...(Array.isArray(was.windows) ? was.windows : []), { on_at: was.on_at, off_at: was.off_at }]
        if (all.length > WINDOWS_MAX) delete l.since // the earliest window trimmed: what came before it is not known any more
        l.windows = all.slice(-WINDOWS_MAX)
      }
      m.liveness[h] = l
    }
    saveManifest(dir, m, fs)
  }

  const groups = planned.flatMap(({ h, plan }) => plan.routes.map((r) => groupOf(h, r.id)))
  const ep = controlEndpointFor({ platform: os, dir, env, fs })
  const ask = request || ep.request
  let doorsNow = {}, unanswered = false
  try { doorsNow = ep.socketPath ? ((await ask({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 2000 })).doors || {}) : {} } catch { doorsNow = {}; unanswered = true }
  // a daemon that lives (its lock) but did not answer (starting, stuck): a held recorded port is its own door as far as on can tell — kept, not engine-port-taken
  const ownDaemon = unanswered && ['running', 'unresponsive'].includes(lockState({ file: path.join(dir, 'lock'), fs }).state)
  const was = await loadIngressConfig({ dir, groups, isFree, fs })
  const unconfirmed = []
  // 4.11 §3 ㉓: a group of an id outside the table is another copy's — its port is never moved (the picker still avoids it)
  const cfg = await rebindTaken(was, async (port, g) => {
    if (!byName.has(g.split(':')[0]) || doorsNow[g] === port || await isFree(port)) return true
    if (ownDaemon) unconfirmed.push(g)
    return ownDaemon
  }, { dir, isFree, fs })
  for (const g of unconfirmed) {
    const reason = `trocar's background process did not answer, so its local proxy port ${was.groupPorts[g]} for ${g} was kept as its own door`
    try { appendEvent(dir, { event: 'failure', where: 'ingress', code: CODE.doorUnconfirmed, door: g, port: was.groupPorts[g], reason, ...(source ? { source } : {}) }) } catch { /* the daemon's answer to POST /on says the rest */ }
  }
  // a door group whose port or token is new (P12): when every group of h moved, the earlier windows lead nowhere now — they go and the history
  // restarts here (`since`); when some moved, `door_since` marks those groups, and a process from an earlier window may have read the old value
  const changed = new Set(was.created ? groups : [...was.added, ...cfg.rebound])
  for (const { h, plan } of planned.filter((x) => fresh.includes(x.h))) {
    const mine = plan.routes.map((r) => groupOf(h, r.id)), l = m.liveness[h]
    const moved = mine.filter((g) => changed.has(g))
    if (!moved.length) continue
    if (moved.length === mine.length) { delete l.windows; delete l.door_since; l.since = l.on_at } else l.door_since = { ...(l.door_since || {}), ...Object.fromEntries(moved.map((g) => [g, l.on_at])) }
  }
  if (changed.size) saveManifest(dir, m, fs)
  // §3 ①: a group port another socket holds is engine-port-taken — said in the receipt and recorded (D38), then the group's entries follow the new door
  for (const g of cfg.rebound) {
    const [from, to] = [was.groupPorts[g], cfg.config.groupPorts[g]]
    const reason = `trocar's local proxy port ${from} for ${g} is held by another program; trocar on moved it to ${to} and rewrites its entries`
    try { appendEvent(dir, { event: 'failure', where: 'ingress', code: CODE.enginePortTaken, door: g, port: from, moved_to: to, reason, ...(source ? { source } : {}) }) } catch { /* the receipt's note carries it (R11) */ }
    out.notes.push({ harness: g.slice(0, g.indexOf(':')), code: CODE.enginePortTaken, text: `${CODE.enginePortTaken}: port ${from} of ${g} was taken by another program; trocar moved it to ${to} and rewrote the entries` })
  }
  let doors = null
  const goneAsk = offSince(stateF, on, { fs, now: now() })
  if (goneAsk.length) return stopped(goneAsk)
  if (!ep.socketPath) out.problems.push(`no daemon to ask: ${ep.why || 'no control endpoint'}; start it (trocar daemon), then run trocar on again`)
  else {
    try {
      const r = await ask({ socketPath: ep.socketPath, method: 'POST', path: '/on', body: { harnesses: on, groups: Object.fromEntries(groups.map((g) => [g, cfg.config.groupPorts[g]])) } })
      doors = (r && r.doors) || {}
      // an on harness whose hosts the negative cache paused: the daemon dropped those keys, so trocar decrypts them again from now (D54②)
      for (const x of (r && Array.isArray(r.retried) ? r.retried : [])) out.notes.push({ harness: x.harness, text: retriedNote(x.harness, x.hosts) })
    } catch (e) { out.problems.push(`the daemon did not take the on request (${errText(e)})`) }
  }
  out.doors = doors || {}
  // V104: turned on = at least one of its entries now leads to a door — what the run's result line lists, also when a throw cuts the run short
  const turned = () => on.filter((h) => out.routes.some((r) => r.harness === h && r.ok))
  let gone = []
  if (doors) {
    try {
      for (const { h } of planned) {
        if ((gone = offSince(stateF, on, { fs, now: now() })).length) break // the harnesses already written stay recorded; the next one is not started
        const doorOf = (rid) => { const u = doors[groupOf(h, rid)]; if (!u) throw Object.assign(new Error(`the daemon opened no door for ${groupOf(h, rid)}`), { code: 'not-routed' }); return u }
        const w = writeRoutes(byName.get(h), { ...wctx, harness: h }, doorOf)
        for (const r of w.results) out.routes.push({ harness: h, ...r })
        for (const n of w.notRouted) out.routes.push({ harness: h, ok: false, ...n })
        out.notes.push(...w.notes.map((n) => ({ harness: h, ...n })))
      }
    } catch (e) { if (e && typeof e === 'object') e.turnedOn = turned(); throw e } finally {
      // the last route's result (wctx.deferResult). In a finally it must not throw: that would replace the error on its way out, or drop this receipt with the entries already written (V104)
      try { flushResults(dir, m, fs) } catch (e) { out.problems.push(`the entries were written but trocar could not save its record of them (${errText(e)}); trocar off still undoes them; fix that, then run trocar on again`) }
    }
  }
  if (gone.length) return stopped(gone, turned())
  out.turnedOn = turned()
  out.exit = !refused.length && !pending.length && doors && out.routes.every((r) => r.ok) && !out.problems.length ? 0 : 1
  return out
}
