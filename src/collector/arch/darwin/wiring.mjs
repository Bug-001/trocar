// wiring.mjs — the daemon's macOS half (RFC 4.9 §1 接线 · §2.2 · §3.1 · §4 · §5, as D47 rewrote it). daemon.mjs is the one module that may wire
// core + arch + harness (layering rule 5); this file is all of that wiring which is darwin's: the engine's per-group doors (the ONE proxy on
// this machine — the mihomo kernel is retired from the capture path, its download, its controller and its config gone with it), the targeted
// identity questions (lsof for the socket's owner, ps + lsof for that pid's facts), ingress.json's ports and tokens, the proxy entries'
// writer, the route plan and its refresh (the scutil system-proxy watcher: a change re-plans, and a plan that moved brings the doors and the
// entries to it), the host sets and the keychain trust door of the desktop family. There is NO resident helper (4.9 §1): ps, lsof and scutil are plain CLIs, run on demand
// through execTool. Nothing here names a harness: the daemon hands the descriptors in.
//
// THE LAZY RULE: construction touches nothing that reads or changes the machine beyond what its arguments already hold. Two constructions exist —
//   · the daemon's (with `dir`): everything is BUILT — ingress.json read (or created: daemon start is the moment the ports are chosen) and the
//     entries writer made — and nothing STARTED: no door, no scutil read. redirector.start() (the daemon's) adds this wiring's netenv half —
//     the first scutil read, the first plan, the 5 s watcher; the doors themselves come with the first attach (the switch's `on`), and the
//     daemon binds them to the engine the moment both exist (`bindDoors`, below).
//   · loadParts' ({ env } alone, no dir — daemon.mjs builds one for on / status / install): the shell — the groups it was handed, and attach() refusing with its own TypeError. A read-only command must not find ingress.json created by reading it.
// Everything is injected through `deps` for a test, the win32 wiring's list: `exec · ownerOf · factsOf · loadIngress · entries · isFree ·
// random · now · timers · readSystemProxy · watchSystemProxy · systemProxy · fs`.
import os from 'node:os'
import path from 'node:path'
import nodeFs from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { factsOfPid } from './procinfo.mjs'
import { ownerOfSocket as askOwnerOfSocket } from './socktable.mjs'
import { loadIngressConfig, freeOnLoopback } from './ingress-config.mjs'
import { groupsOf, planRoutes, resolveLogin, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createDarwinRedirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { execTool } from '../../../off/exec.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { MARKER_TOLERANCE_MS } from '../../core/trust/confirm.mjs'

/** The gate `attach()` asks before it writes a group's proxy entry (4.8 W19; the Task 8(b) review made it the redirector's required argument): Codex's and Hermes's lines join a
 *  block their trust entry wrote, and may not be written before the journal's four W19 conditions hold. They hold (the journal's join landed with the win line's Task 8(v) round,
 *  2026-10-08): the default-off join, the LIFO undo of the combined block, its CRLF and spaced-profile cases, and the user's credentials in the manifest only — pinned cell by cell
 *  by test/collector/harness/darwin-trust.test.mjs's GATE. This is the named place that would refuse those two groups again, and what keeps it honest is the wiring's own combined
 *  case (test/collector/arch/darwin/entries.test.mjs): a journal that regresses the join refuses it and that test goes red with the GATE. */
const w19Gate = () => ({ ok: true })

/** Whether a re-plan moved this group in a way the doors and the entries must be told: its upstream, its bypass table, or on/off (4.8 §2.2, carried by 4.9 §2.2: a change whose
 *  recomputed answers equal the group's `last` reloads nothing — a `scutil` read that timed out and the read back are two changes with the same upstream). */
const movedRoute = (a, b) => !a || !b || a.on !== b.on || JSON.stringify(a.upstream ?? null) !== JSON.stringify(b.upstream ?? null) || JSON.stringify(a.bypass ?? null) !== JSON.stringify(b.bypass ?? null)

/**
 * createDarwinCollector({ env, dir, home, harnesses, failure, event, manifest, desired, optIns, deps }) → the Redirector (4.9 §1), carrying a `darwin` bag of what only the daemon
 *   reaches: `{ bindDoors, ingress, replan, groups, netenv, appliedHosts, osLayers, markerToleranceMs, close }` (the win32 bag's shape;
 *   markerToleranceMs is the plugin marker's fixed tolerance — the daemon hands it to the tracker, confirm.mjs's value). Everything is injected through `deps`
 *   for a test. `dir` absent = the lazy shell (the header's LAZY RULE).
 *   failure (where, error, extra)  the daemon's failure recorder · event (record)  its event writer (netenv-change, the watcher's own records)
 *   manifest  () → the manifest as it is NOW (the daemon re-reads it; null reads it here) · desired  () → state.json's `harnesses` (`{ <id>: { desired, extra_hosts } }`)
 *   identify  (facts) → registry.match's answer: the D51 name list the daemon built BEFORE this collector (the same function the tracker judges by);
 *             required with a dir (the daemon), a no-dir shell holds no door and gets a stand-in that names nobody
 *   optIns    () → the groups or forms the user named and asight has the record of; the default (null) DERIVES them from the manifest's `optin-*` entries (4.9 §6.4's wiring arm,
 *              2026-10-12: without it a daemon that restarts after `on … --opt-in claude-code.desktop` re-plans the group as unnamed → the launcher points at a port with no listener)
 */
export async function createDarwinCollector({ env = process.env, dir = null, home = env.HOME || os.homedir(), harnesses = [], failure = () => {}, event = () => {}, manifest = null, desired = () => ({}), optIns = null, identify = null, deps = {} } = {}) {
  const fs = deps.fs || nodeFs
  const groups = groupsOf(harnesses)
  const ctx = { // the daemon's own ctx (4.8 §2.2's, darwin's half): its env is not the install shell's, and priorOf reads the manifest's records by harness and entry, not by files(ctx)
    os: 'darwin', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
  }
  const manifestNow = () => { try { return (typeof manifest === 'function' ? manifest() : manifest) || readManifest(dir, fs) } catch { return null } }

  // the two identity questions — no helper anywhere (4.9 §1): lsof and ps run on demand, targeted, through the one injected runner
  const exec = deps.exec ?? null // execTool's `run` (spawnSync-shaped); a test injects one, and without one execTool spawns the real command itself
  // The execTool-shaped runner the questions take (socktable's ownerOfSocket · the redirector's directCount: `exec('lsof', args, { timeoutMs })` → Promise<{ code, out, err }> —
  // ownerOfSocket races it against a budget timer and calls .catch on it, so it must be a PROMISE even though execTool itself is synchronous). It is always a runner — the injected one
  // wrapped, execTool's own spawn otherwise. An early build had the owner question built WITHOUT any (the old `exec != null ? { exec } : {}` spread left the key absent and every
  // owner question threw "exec is not a function"); the second had it synchronous and every question threw "asked.catch is not a function" — both left every agent connection judged
  // untracked and spliced, nothing captured (found live by the smoke, 2026-10-09, results 20261008T221132 · 20261008T223245).
  const execOf = async (file, args, o = {}) => execTool(file, args, { ...o, ...(exec != null ? { run: exec } : {}) })
  // ownerOfSocket: which pid owns the accepted socket's peer end (the targeted 4-tuple question, D47); factsOfPid: that pid's facts (its real
  // executable from lsof's txt record, its command line, its start time) — the form match and the tracker's judgement both read them
  const ownerOf = deps.ownerOf || ((q) => askOwnerOfSocket({ exec: execOf, ...q, onFailure: (rec) => event(rec) }))
  const factsOf = deps.factsOf || ((pid) => factsOfPid(pid, ...(exec != null ? [{ exec }] : [])))

  // ingress.json and the entries writer: built only when the caller brought the dir (the daemon); the shell has none of them, and attach()
  // says so with its own TypeError (redirector.mjs) — a read-only command cannot reach for any of this.
  let ing = null
  let entries = null
  if (dir) {
    ing = await (deps.loadIngress ? deps.loadIngress() : loadIngressConfig({ dir, groups: groups.map((x) => x.g), isFree: deps.isFree || freeOnLoopback, ...(deps.random ? { random: deps.random } : {}), fs }))
    entries = deps.entries || createProxyEntries({ dir, home, groups, ctx, ingress: () => ing, manifest: manifestNow, fs })
  }
  const ingress = () => ing

  // ---- the route plan (4.9 §2.2, 4.8 §2.2's mechanism) and the system proxy that moves it --------------------------------------------------
  let systemProxy = deps.systemProxy ?? null
  let plan = null
  const ownPorts = () => (ing ? [ing.enginePort, ...Object.values(ing.groupPorts)] : [])
  // the manifest's opt-in records of one group's forms (confirmed: an entry whose write failed is re-offered, not treated as in effect — planOptIns' own 'done' rule); these say the
  // group is opted in (the plan's gate) and may keep a forward-only door while off (carried, audit F7) — the desktop-launcher's door lives or dies by this arm (4.9 §6.4)
  const optinRecordsOf = (m, x) => (m && Array.isArray(m.entries) ? m.entries : []).filter((e) => e && typeof e.kind === 'string' && e.kind.startsWith('optin-') && e.confirmed !== false && e.harness === x.harness && x.forms.some((f) => f.id === e.form))
  // the named-and-recorded forms (and their groups) the daemon's re-plan treats as opted in: the caller's own list when it brought one, else derived from the manifest — a caller
  // that passes none (the daemon today) still re-plans a launcher'd group as on (4.9 §6.4's wiring arm)
  const namedOptIns = () => {
    const given = optIns ? optIns() : null
    if (given && given.length) return given
    const m = manifestNow()
    return groups.filter((x) => optinRecordsOf(m, x).length > 0).flatMap((x) => [x.g, ...x.forms.map((f) => f.id)])
  }
  const carriedOf = () => new Set(groups.filter((x) => proxyRecordsOf(manifestNow(), x.group, x.harness).length > 0 || optinRecordsOf(manifestNow(), x).length > 0).map((x) => x.g)) // installed, once on, or opted in (the opt-in's own record — the desktop launcher's arm, 4.9 §6.4)
  const isOn = (harness) => { const d = (desired() || {})[harness]; return (typeof d === 'string' ? d : d && d.desired) === 'on' } // the door's desired-state question (route-plan's own `wanted` rule)
  if (dir && typeof identify !== 'function') throw new TypeError('the collector needs identify (registry.match): the daemon builds the registry first and hands it in')
  const who = typeof identify === 'function' ? identify : () => ({ agent: null, descriptor: null, reason: 'no-match' }) // the no-dir shell: no door, nobody to name
  const extraHostsOf = (harness) => { const h = (desired() || {})[harness]; return h && Array.isArray(h.extra_hosts) ? h.extra_hosts : [] }
  const appliedHosts = new Map() // form id → the host set the last plan applied; `status` compares it with a fresh read
  let redirector = null

  /** Re-plan from the network as it was last read and the desired state as it is now. `reload`: when a group's answers moved, bring the doors and the entries to the new plan
   *  (`attach()`: the doors of the carried groups re-asked idempotently, the entries rewritten with the same address — a no-op — and the undone ones undone). */
  async function replan({ reload = false } = {}) {
    const carried = carriedOf()
    const next = planRoutes({ netenv: { systemProxy, ownPorts: ownPorts() }, groups, desired: desired() || {}, optIns: namedOptIns(), manifest: manifestNow(), ctx, procs: redirector ? redirector.procs() : [], last: plan })
    const moved = plan == null || groups.some((x) => movedRoute(plan[x.g], next[x.g]))
    plan = next
    for (const x of groups) { // the host sets of the forms a door carries (on, or carried while off): kept per form, returned in status
      const r = next[x.g]
      const carriedNow = r && (r.on || carried.has(x.g))
      for (const f of x.forms) {
        if (!f.hosts) continue
        if (carriedNow) appliedHosts.set(f.id, hostSetOf({ form: f, readSettings: () => ctx.readTextOrError(f.hosts.settings.file(ctx)), extraHosts: extraHostsOf(x.harness) }))
        else appliedHosts.delete(f.id)
      }
    }
    if (reload && moved && redirector) { try { await redirector.attach() } catch (e) { failure('netenv', e) } }
    return { moved, plan: next }
  }

  // the doors: the engine's own listen({groups}) / closeGroups, LATE-BOUND — the daemon creates the redirector before the engine, so the
  // binding is a slot the daemon fills the moment both exist (`bindDoors`). Until then the facade refuses, and attach() fails with that
  // refusal — exactly like the no-dir shell's TypeError: nothing points at a door nobody bound.
  let doorHalf = null
  const doors = {
    open: async (list) => { if (!doorHalf || typeof doorHalf.open !== 'function') throw new TypeError('the engine\'s doors were never bound (bindDoors): the daemon owns the engine and is the one that binds them'); return doorHalf.open(list) },
    close: async (ids) => { if (!doorHalf || typeof doorHalf.close !== 'function') throw new TypeError('the engine\'s doors were never bound (bindDoors)'); return doorHalf.close(ids) },
  }

  redirector = createDarwinRedirector({
    groups, home, ownerOf, factsOf, doors,
    routes: () => plan, ingress,
    authOf: (ref) => resolveLogin(ref, { groups, ctx, manifest: manifestNow() }),
    onFailure: (rec) => event(rec), onEvent: (rec) => event(rec), entries, gate: w19Gate,
    identify: who, isOn,
    exec: execOf, // the redirector's exec is the lsof shape (socktable's, its docstring): the execTool wrapper, not the spawnSync-shaped run the old spread passed
    hostsOf: (f) => { const s = appliedHosts.get(f.id); return s ? s.hosts : null },
    carried: () => [...carriedOf()],
    ...(deps.now ? { now: deps.now } : {}),
  })

  // the doors' binding slot (the facade above): the daemon calls this once it has the engine —
  // `bindDoors({ open: (list) => engine.listen({ groups: list }), close: (ids) => engine.closeGroups(ids) })`
  redirector.darwin = {
    bindDoors: (half) => { doorHalf = half },
  }

  // start(): this wiring's netenv half — the first scutil read, the first plan and the 5 s watcher. The shell (no dir) starts nothing; the
  // daemon calls start() once, and a door still comes with the first attach (the switch's `on` or its restore).
  let netenvWatcher = null
  const innerStart = redirector.start
  redirector.start = async (...a) => {
    const r = await innerStart(...a)
    if (dir) {
      systemProxy = await (deps.readSystemProxy || readSystemProxy)(...(exec != null ? [{ exec }] : []))
      await replan()
      if (deps.watchSystemProxy !== false) {
        netenvWatcher = (deps.watchSystemProxy || watchSystemProxy)({ ...(exec != null ? { exec } : {}), initial: systemProxy, read: deps.readSystemProxy || readSystemProxy, onError: (e) => failure('netenv', e), ...(deps.timers ? { timers: deps.timers } : {}) })
        netenvWatcher.on('change', async ({ before, after }) => {
          systemProxy = after
          // the change line's from/to: the https hop as one word — darwin's readSystemProxy answers the eleven scutil keys, not a made `server` field (win32's shape), so the
          // word is built here: off · host:port · unreadable
          const shown = (p) => (p && p.ok ? (p.HTTPSEnable === true ? `${p.HTTPSProxy ?? ''}:${p.HTTPSPort ?? ''}` : 'off') : 'unreadable')
          event({ event: 'netenv-change', where: 'netenv', code: 'netenv-changed', from: before && before.ok ? shown(before) : null, to: after && after.ok ? shown(after) : null, captured: null,
            reason: `the system proxy changed (${shown(before)} → ${shown(after)}); the groups that follow it are re-planned` })
          await replan({ reload: true })
        })
      }
    }
    return r
  }
  const innerClose = redirector.close
  redirector.close = async (...a) => { if (netenvWatcher) netenvWatcher.stop(); return innerClose(...a) }

  // The switch's `on`/`off` call attach()/detach() right after they commit the new desired state — and `routes` answers the plan this wiring last computed, so a stale one
  // (the start's, all-off) builds an empty door plan and the first `on` after boot does nothing (found live by the lab smoke, 2026-10-09). Both are wrapped to re-plan first;
  // the netenv-change path's replan({ reload: true }) reaches the same wrapper (one extra pure recompute, the same answers) and stays non-reentrant (reload is false in here).
  const innerAttach = redirector.attach
  redirector.attach = async (...a) => { await replan(); return innerAttach(...a) }
  const innerDetach = redirector.detach
  redirector.detach = async (...a) => { await replan(); return innerDetach(...a) }

  // ---- the login-keychain door Claude Desktop's network service is trusted by (4.9 §6.4's trust arm, D51④) ---------------------------------------
  // The keychain item is the network service's ONE trust door (the env doors are dead for it, §6.4's measured verdict); the tracker judges by layers, so
  // the door reaches it as two ctx keys the osLayers wrapper below injects: `caFile` (this build's CA — what the engine would decrypt with) and
  // `desktopDoor` ({ since, name } | null — the manifest's confirmed optin-keychain-cert entry of THAT harness, read live so an `on` that lands the item
  // after the daemon started opens the door without a restart, and only while the entry's fingerprint is the CA this build actually holds: a certificate
  // asight no longer has the private key of would be a door to broken handshakes, so it stays shut). The base claude-code layers turn the open door into
  // the network service's one synthetic layer (core/trust/chromium.mjs's role); a harness with no such item sees null.
  const caFileOf = () => (dir ? path.join(dir, 'ca', 'asight-ca.pem') : null)
  const keychainDoorOf = (d) => {
    const caFile = caFileOf()
    if (!caFile) return null
    let fp = null
    try { fp = new X509Certificate(fs.readFileSync(caFile)).fingerprint256 } catch { return null }
    let door = null
    for (const e of (manifestNow() || {}).entries || []) {
      if (!e || e.kind !== 'optin-keychain-cert' || e.harness !== d.name || e.confirmed !== true) continue
      const since = Date.parse(e.installed_at)
      if (!Number.isFinite(since) || (e.values || {}).fp256 !== fp) continue
      if (!door || since > door.since) door = { since, name: `login keychain (asight's CA trusted, ${fp.slice(0, 23)}…)` } // a re-install supersedes: config-after-start is judged against the newest install
    }
    return door
  }

  redirector.darwin = {
    ...(redirector.darwin || {}), // bindDoors stays: the slot the daemon fills once the engine exists
    ingress, replan, groups,
    netenv: () => ({ systemProxy, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    // a harness with macOS layers of its own declares them; the rest read the same files as on Linux. The wrapper hands every one of them the desktop door's
    // two ctx keys (above): `desktopDoor` (keychainDoorOf) and `caFile`. Only the claude-code layers read them, for a network-service process; for every
    // other descriptor the spread is an additive no-op.
    osLayers: { darwin: (d) => { const own = (d.darwin && d.darwin.layers) || d.layers; return (ctx2) => own({ ...ctx2, desktopDoor: keychainDoorOf(d), caFile: caFileOf() }) } },
    markerToleranceMs: MARKER_TOLERANCE_MS, // the darwin plugin twins write performance.timeOrigin (sub-millisecond) against ps's second-granular lstart (startTicks): the tracker gets the same fixed tolerance the win line's markers are compared with (confirm.mjs; review F4)
    close: () => { if (netenvWatcher) netenvWatcher.stop() },
  }
  return redirector
}
