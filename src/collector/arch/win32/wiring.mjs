// wiring.mjs — the daemon's Windows half (RFC 4.9 §1 接线 · §2.2 · §3.1 · §4 · §5, as D47 rewrote it and its win32 twin now carries; the 4.8 §1 · §2.1 wiring
// underneath). daemon.mjs is the one module that may wire core + arch + harness (layering rule 5); this file is all of that wiring which is Windows's: the
// engine's per-group doors (the ONE proxy on this machine — the mihomo kernel is retired from the capture path, its download, its controller, its config
// and its lock gone with it), the resident read-only helper that answers the targeted identity questions (the TCP owner table for the socket's owner, the
// `ps` snapshot for that pid's facts) and the registry reads the netenv needs, ingress.json's ports and tokens, the proxy entries' writer, the route plan
// and its refresh (the registry system-proxy watcher: a change re-plans, and a plan that moved brings the doors and the entries to it), and the host sets
// (which harness a process is, the registry judges by name, D51). It names no harness: the daemon hands the
// descriptors in; everything is injected, so a test runs it against a fake helper and a sandbox %USERPROFILE%.
//
// THE LAZY RULE, carried from the darwin twin: construction touches nothing that reads or changes the machine beyond what its arguments already hold. The
// daemon's construction (with `dir`, required — the win32 collector has no read-only shell: nothing on this side is asked without the collector dir) builds
// everything — the helper STARTED (its ready line is the redirector's own start()'s first wait), ingress.json read — and starts nothing else: no door, no
// registry read. redirector.start() adds this wiring's netenv half — the first read, the first plan, the 5 s watcher; the doors themselves come with the
// first attach (the switch's `on`), and the daemon binds them to the engine the moment both exist (`bindDoors`, below). Everything is injected through
// `deps` for a test, the darwin wiring's list: `helper · ownerOf · factsOf · loadIngress · entries · isFree · random · now · timers · readSystemProxy ·
// readHkcuEnv · systemProxy · hkcuEnv · watchSystemProxy · fs`.
import os from 'node:os'
import path from 'node:path'
import nodeFs from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { startHelper, policyAllowOf } from './helper.mjs'
import { factsOfPid } from './procinfo.mjs'
import { ownerOfSocket as askOwnerOfSocket } from './socktable.mjs'
import { loadIngressConfig, freeOnLoopback } from './ingress-config.mjs'
import { groupsOf, planRoutes, resolveLogin } from './route-plan.mjs'
import { hostSetOf } from '../../core/host-agent.mjs'
import { isDesiredOn, movedRoute, optedInOf, carriedOf as carriedGroupsOf } from '../../core/route-plan.mjs'
import { identifyOf, desktopDoorOf } from '../../core/proxy-wiring.mjs'
import { createWin32Redirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, readHkcuEnv, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { MARKER_TOLERANCE_MS } from '../../core/trust/confirm.mjs'

/** The gate `attach()` asks before it writes a group's proxy entry (4.8 W19; the Task 8(b) review made it the redirector's required argument): Codex's and
 *  Hermes's lines join a block their trust entry wrote, and may not be written before the journal's four W19 conditions hold. They hold (landed with the
 *  Task 8(v) round, 2026-10-08): the default-off join, the LIFO undo of the combined block, its CRLF and spaced-profile cases, and the user's credentials
 *  in the manifest only — pinned cell by cell by test/collector/harness/win32-trust.test.mjs's GATE. This is the named place that would refuse those two
 *  groups again, and what keeps it honest is the wiring's own combined case (test/collector/arch/win32/entries.test.mjs): a journal that regresses the join
 *  refuses it and that test goes red with the GATE. */
const w19Gate = () => ({ ok: true })

/**
 * createWin32Collector({ env, dir, home, harnesses, failure, event, manifest, desired, optIns, deps }) → the Redirector (4.9 §1), carrying a `win32` bag of
 *   what only the daemon reaches: `{ helper, bindDoors, ingress, replan, groups, netenv, appliedHosts, osLayers, markerToleranceMs, close }` (the darwin bag's shape).
 *   Everything is injected through `deps` for a test.
 *   failure (where, error, extra)  the daemon's failure recorder · event (record)  its event writer (netenv-change, the helper's own records)
 *   manifest  () → the manifest as it is NOW (the daemon re-reads it; null reads it here) · desired  () → state.json's `harnesses` (`{ <id>: { desired, extra_hosts } }`)
 *   identify  (facts) → registry.match's answer: the D51 name list the daemon built BEFORE this collector (the same function the tracker judges by);
 *             required with a dir (the daemon), a no-dir shell holds no door and gets a stand-in that names nobody
 *   optIns    () → the groups or forms the user named and asight has the record of; the default (null) DERIVES them from the manifest's `optin-*` entries
 *              (4.9 §6.4's wiring arm, the darwin twin's rule: without it a daemon that restarts after `on … --opt-in <item>` re-plans the group as unnamed
 *              → the entry points at a port with no listener)
 */
export async function createWin32Collector({ env = process.env, dir, home = env.USERPROFILE || os.homedir(), harnesses = [], failure = () => {}, event = () => {}, manifest = null, desired = () => ({}), optIns = null, identify = null, deps = {} } = {}) {
  if (!dir) throw new TypeError('createWin32Collector needs the collector dir (~/.asight/collector)')
  const fs = deps.fs || nodeFs
  const groups = groupsOf(harnesses)
  const ctx = { // the daemon's own ctx (4.8 §2.2): its env is not the install shell's, and priorOf reads the manifest's records by harness and entry, not by files(ctx)
    os: 'win32', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
  }
  const manifestNow = () => { try { return (typeof manifest === 'function' ? manifest() : manifest) || readManifest(dir, fs) } catch { return null } }

  // the resident read-only helper (4.8 §1): ONE PowerShell process for the whole daemon — the targeted identity questions and the registry reads go
  // through it, nothing is spawned per question. Its ready line is the redirector's start()'s first wait; its failures are the helper's own records.
  const helper = deps.helper || startHelper({ env, ...(deps.spawn ? { spawn: deps.spawn } : {}), regAllow: policyAllowOf(groups), onFailure: (rec) => event(rec) })
  // the two identity questions — targeted, accept-time (D47): the TCP owner table (GetExtendedTcpTable through the helper) answers the socket's owner, the
  // helper's `ps` snapshot answers that pid's facts (its real executable, its command line, its start time) — the form match and the tracker's judgement
  // both read them
  const ownerOf = deps.ownerOf || ((q) => askOwnerOfSocket({ helper, ...q, onFailure: (rec) => event(rec) }))
  const factsOf = deps.factsOf || ((pid) => factsOfPid(pid, { helper }))

  // ingress.json and the entries writer: the daemon brought the dir (required here), so both are BUILT — and nothing STARTED: no door, no registry read.
  const ing = await (deps.loadIngress ? deps.loadIngress() : loadIngressConfig({ dir, groups: groups.map((x) => x.g), isFree: deps.isFree || freeOnLoopback, ...(deps.random ? { random: deps.random } : {}), fs }))
  const entries = deps.entries || createProxyEntries({ dir, home, groups, ctx, ingress: () => ing, manifest: manifestNow, fs })
  const ingress = () => ing

  // ---- the route plan (4.9 §2.2, 4.8 §2.2's mechanism) and the system proxy that moves it --------------------------------------------------
  let systemProxy = deps.systemProxy ?? null
  let hkcuEnv = deps.hkcuEnv ?? null
  let plan = null
  const ownPorts = () => [ing.enginePort, ...Object.values(ing.groupPorts)]
  // the named-and-recorded forms (and their groups) the daemon's re-plan treats as opted in: the caller's own list when it brought one, else derived from
  // the manifest's `optin-*` records (core/route-plan.mjs optedInOf) — a daemon that restarts still re-plans a named group as on (4.9 §6.4's wiring arm)
  const namedOptIns = () => { const given = optIns ? optIns() : null; return given && given.length ? given : optedInOf(groups, manifestNow()) }
  const carriedOf = () => carriedGroupsOf(groups, manifestNow()) // installed, once on, or opted in (audit F7)
  const isOn = (harness) => isDesiredOn(desired() || {}, harness) // the door's desired-state question: the plan's own rule
  const who = identifyOf(identify, dir) // required with a dir; the no-dir shell gets a stand-in that names nobody
  const extraHostsOf = (harness) => { const h = (desired() || {})[harness]; return h && Array.isArray(h.extra_hosts) ? h.extra_hosts : [] }
  const appliedHosts = new Map() // form id → the host set the last plan applied; `status` compares it with a fresh read
  let redirector = null

  /** Re-plan from the network as it was last read and the desired state as it is now. `reload`: when a group's answers moved, bring the doors and the
   *  entries to the new plan (`attach()`: the doors of the carried groups re-asked idempotently, the entries rewritten with the same address — a no-op —
   *  and the undone ones undone). */
  async function replan({ reload = false } = {}) {
    const carried = carriedOf()
    const next = planRoutes({ netenv: { systemProxy, hkcuEnv, ownPorts: ownPorts() }, groups, desired: desired() || {}, optIns: namedOptIns(), manifest: manifestNow(), ctx, procs: redirector ? redirector.procs() : [], last: plan })
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

  // the doors: the engine's own listen({groups}) / closeGroups, LATE-BOUND — the daemon creates the redirector before the engine, so the binding is a slot
  // the daemon fills the moment both exist (`bindDoors`). Until then the facade refuses, and attach() fails with that refusal: nothing points at a door
  // nobody bound.
  let doorHalf = null
  const doors = {
    open: async (list) => { if (!doorHalf || typeof doorHalf.open !== 'function') throw new TypeError('the engine\'s doors were never bound (bindDoors): the daemon owns the engine and is the one that binds them'); return doorHalf.open(list) },
    close: async (ids) => { if (!doorHalf || typeof doorHalf.close !== 'function') throw new TypeError('the engine\'s doors were never bound (bindDoors)'); return doorHalf.close(ids) },
  }

  redirector = createWin32Redirector({
    helper, groups, home, ownerOf, factsOf, doors,
    routes: () => plan, ingress,
    authOf: (ref) => resolveLogin(ref, { groups, ctx, manifest: manifestNow(), hkcuEnv }), // the closure reads the `let` as it is at call time: the watcher keeps it current
    onFailure: (rec) => event(rec), onEvent: (rec) => event(rec), entries, gate: w19Gate,
    identify: who, isOn,
    hostsOf: (f) => { const s = appliedHosts.get(f.id); return s ? s.hosts : null },
    carried: () => [...carriedOf()],
    ...(deps.now ? { now: deps.now } : {}),
  })

  // the doors' binding slot (the facade above): the daemon calls this once it has the engine —
  // `bindDoors({ open: (list) => engine.listen({ groups: list }), close: (ids) => engine.closeGroups(ids) })`
  redirector.win32 = {
    helper, bindDoors: (half) => { doorHalf = half },
  }

  // start(): this wiring's netenv half — the first registry read, the first plan and the 5 s watcher. The helper's own ready line is the redirector's
  // start()'s first wait (the adapter's companion); a door still comes with the first attach (the switch's `on` or its restore).
  let netenvWatcher = null
  const innerStart = redirector.start
  redirector.start = async (...a) => {
    const r = await innerStart(...a)
    ;[systemProxy, hkcuEnv] = await Promise.all([(deps.readSystemProxy || readSystemProxy)({ helper }), (deps.readHkcuEnv || readHkcuEnv)({ helper })])
    await replan()
    if (deps.watchSystemProxy !== false) {
      netenvWatcher = (deps.watchSystemProxy || watchSystemProxy)({ helper, initial: systemProxy, read: deps.readSystemProxy || readSystemProxy, onError: (e) => failure('helper', e), ...(deps.timers ? { timers: deps.timers } : {}) })
      netenvWatcher.on('change', async ({ before, after }) => {
        systemProxy = after
        // the change line's from/to: the https hop as one word — win32's readSystemProxy answers ProxyEnable/ProxyServer, so the word is built here: off · host:port · unreadable
        const shown = (p) => (p && p.ok ? (p.enable === true && p.server ? p.server : 'off') : 'unreadable')
        event({ event: 'netenv-change', where: 'netenv', code: 'netenv-changed', from: before && before.ok ? shown(before) : null, to: after && after.ok ? shown(after) : null, captured: null,
          reason: `the system proxy changed (${shown(before)} → ${shown(after)}); the groups that follow it are re-planned` })
        await replan({ reload: true })
      })
    }
    return r
  }
  const innerClose = redirector.close
  redirector.close = async (...a) => { if (netenvWatcher) netenvWatcher.stop(); return innerClose(...a) }

  // The switch's `on`/`off` call attach()/detach() right after they commit the new desired state — and `routes` answers the plan this wiring last
  // computed, so a stale one (the start's, all-off) builds an empty door plan and the first `on` after boot does nothing (found live on a macOS test machine,
  // 2026-10-09, and carried here with the twin). Both are wrapped to re-plan first; the netenv-change path's replan({ reload: true }) reaches the same
  // wrapper (one extra pure recompute, the same answers) and stays non-reentrant (reload is false in here).
  const innerAttach = redirector.attach
  redirector.attach = async (...a) => { await replan(); return innerAttach(...a) }
  const innerDetach = redirector.detach
  redirector.detach = async (...a) => { await replan(); return innerDetach(...a) }

  // ---- the desktop doors a Chromium network service is trusted by (D51④, plan 2026-10-14 §2.5; darwin's keychainDoorOf twin) -----------------------
  // The tracker judges by layers, so a desktop's trust item reaches the harness layers as two ctx keys the osLayers wrapper injects: `caFile` (this
  // build's CA) and `desktopDoor` ({ since, name } | null) — the manifest's newest CONFIRMED entry of THAT harness, read live: `optin-cert-user`
  // (Claude Desktop: the CA in CurrentUser\Root) only while its thumbprint is this build's CA (a certificate asight cannot decrypt with stays shut);
  // `optin-zcode` (Z-Code Desktop's own setting.json) — that layer reads the setting's CA path itself and evaluate() checks the file holds the CA.
  const caFileOf = () => path.join(dir, 'ca', 'asight-ca.pem')
  const thumbprintOf = (f) => { try { return createHash('sha1').update(new X509Certificate(fs.readFileSync(f)).raw).digest('hex').toUpperCase() } catch { return null } }
  const certStoreDoorOf = (d) => {
    let tp // this build's CA thumbprint, read once per question and only when a cert entry asks
    return desktopDoorOf(manifestNow(), d.name, {
      'optin-cert-user': (e) => {
        if (tp === undefined) tp = thumbprintOf(caFileOf())
        return tp && String((e.values || {}).thumbprint || '').toUpperCase() === tp ? `CurrentUser\\Root (asight's CA, ${tp.slice(0, 16)}…)` : null
      },
      'optin-zcode': (e) => `Z-Code desktop setting (${e.path})`,
    })
  }

  redirector.win32 = {
    ...(redirector.win32 || {}), // bindDoors stays: the slot the daemon fills once the engine exists
    helper, ingress, replan, groups,
    netenv: () => ({ systemProxy, hkcuEnv, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    // Hermes and Z-Code declare their own Windows layers; the rest read the same files as on Linux. Every one gets the desktop door's two ctx keys (above)
    osLayers: { win32: (d) => { const own = (d.win32 && d.win32.layers) || d.layers; return (ctx2) => own({ ...ctx2, desktopDoor: certStoreDoorOf(d), caFile: caFileOf() }) } },
    markerToleranceMs: MARKER_TOLERANCE_MS, // the Windows plugin twins (dsh, OpenCode) write Math.round(performance.timeOrigin) against the process table's own ms-epoch startedAt (procinfo.mjs): the byte-exact 0 default (daemon.mjs's `|| 0`) read every one of them `marker-stale` → untrusted → spliced, traffic relayed with no llm_call (measured live on a Windows test machine; darwin's bag has carried the same confirm.mjs tolerance since review F4 — the win line simply never wired it)
    close: () => { if (netenvWatcher) netenvWatcher.stop() }, // the helper and the watcher stop with the redirector's own close()
  }
  return redirector
}
