// wiring.mjs — the daemon's macOS half (RFC 4.9 §1 接线 · §2.2 · §3.1 · §4 · §5; the composition is 4.8 §1's Task 8(c) shape, with one deliberate difference: the construction is LAZY, the Linux redirector's philosophy — 4.9 §1's 接线 row says why).
// daemon.mjs is the one module that may wire core + arch + harness (layering rule 5); this file is all of that wiring which is darwin's: the process watcher (ps) and the socket-table
// owner question (lsof), ingress.json's ports and tokens, the kernel (asight-forwarder) and its controller, the proxy entries' writer, the route plan and its refresh (the scutil
// system-proxy watcher: a change reloads the kernel when it moved a group's answers, and writes one netenv-change), the host sets, the tracker's OS rule (`osMatch` — one rule for
// which form, the same matchForm the redirector routes by) and the kernel's carried list. There is NO resident helper (4.9 §1): ps, lsof and scutil are plain CLIs, run on demand
// through execTool. Nothing here names a harness: the daemon hands the descriptors in.
//
// THE LAZY RULE: construction touches nothing that reads or changes the machine beyond what its arguments already hold. Two constructions exist —
//   · the daemon's (with `dir`): everything is BUILT — ingress.json read (or created: daemon start is the moment the ports are chosen), the controller's port picked, the kernel's
//     forwarder and the entries writer made — and nothing STARTED: no kernel, no poll, no scutil read. redirector.start() (the daemon's) adds this wiring's netenv half — the first
//     scutil read, the first plan, the 5 s watcher; the kernel itself comes with the first attach (the switch's `on`), exactly as on Windows (4.8 §4.1).
//   · loadParts' ({ env } alone, no dir — daemon.mjs builds one for on / status / install): the shell — the groups it was handed (none: osMatch answers null), a watcher it can scan
//     with, and attach() refusing with its own TypeError. A read-only command must not find ingress.json created by reading it.
// Everything is injected through `deps` for a test, the win32 wiring's list: `exec · procWatcher · ownerOf · loadIngress · controller · forwarder · entries · isFree · random · now ·
// timers · readSystemProxy · watchSystemProxy · systemProxy · ownImages · pin · fs`.
import os from 'node:os'
import path from 'node:path'
import nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createProcWatcher, startedAtOf } from './procinfo.mjs'
import { ownerOf as askOwnerOf } from './socktable.mjs'
import { loadIngressConfig, freeOnLoopback } from './ingress-config.mjs'
import { createForwarder, loadPin, verifyCopy, gatekeeperCheck, locateKernel, reinstallCommands, KERNEL_EXE } from './forwarder.mjs'
import { groupsOf, planRoutes, resolveLogin, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createDarwinRedirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { matchForm } from './forms.mjs'

const CONTROLLER_RANGE = [19000, 19999] // the kernel's own controller, its own free port (the win32 value; the generator refuses one it has already seen)
const randomPort = (random) => CONTROLLER_RANGE[0] + (random(4).readUInt32BE(0) % (CONTROLLER_RANGE[1] - CONTROLLER_RANGE[0] + 1))

/** The gate `attach()` asks before it writes a group's proxy entry (4.8 W19; the Task 8(b) review made it the redirector's required argument): Codex's and Hermes's lines join a
 *  block their trust entry wrote, and may not be written before the journal's four W19 conditions hold. They hold (the journal's join landed with the win line's Task 8(v) round,
 *  2026-10-08): the default-off join, the LIFO undo of the combined block, its CRLF and spaced-profile cases, and the user's credentials in the manifest only — pinned cell by cell
 *  by test/collector/harness/darwin-trust.test.mjs's GATE. This is the named place that would refuse those two groups again, and what keeps it honest is the wiring's own combined
 *  case (test/collector/arch/darwin/entries.test.mjs): a journal that regresses the join refuses it and that test goes red with the GATE. */
const w19Gate = () => ({ ok: true })

/** Whether a re-plan moved this group in a way the kernel must be told: its upstream, its bypass table, or on/off (4.8 §2.2, carried by 4.9 §2.2: a change whose recomputed answers
 *  equal the group's `last` reloads nothing — a `scutil` read that timed out behind a slow `ps` and the read back are two changes with the same upstream). */
const movedRoute = (a, b) => !a || !b || a.on !== b.on || JSON.stringify(a.upstream ?? null) !== JSON.stringify(b.upstream ?? null) || JSON.stringify(a.bypass ?? null) !== JSON.stringify(b.bypass ?? null)

/**
 * createDarwinCollector({ env, dir, home, harnesses, failure, event, manifest, desired, optIns, deps }) → the Redirector (4.9 §1), carrying a `darwin` bag of what only the daemon
 *   reaches: `{ forwarder, ingress, replan, groups, netenv, appliedHosts, controller, kernelExe, osMatch, osLayers, close }` (the win32 bag's shape; osMatch is the registry's
 *   second key, 4.8 §5.4). Everything is injected through `deps` for a test. `dir` absent = the lazy shell (the header's LAZY RULE).
 *   failure (where, error, extra)  the daemon's failure recorder · event (record)  its event writer (netenv-change, the watcher's own records)
 *   manifest  () → the manifest as it is NOW (the daemon re-reads it; null reads it here) · desired  () → state.json's `harnesses` (`{ <id>: { desired, extra_hosts } }`)
 *   optIns    () → the groups or forms the user named and asight has the record of (the win line's Task 14; today there is none, so the default is none)
 */
export async function createDarwinCollector({ env = process.env, dir = null, home = env.HOME || os.homedir(), harnesses = [], failure = () => {}, event = () => {}, manifest = null, desired = () => ({}), optIns = () => [], deps = {} } = {}) {
  const fs = deps.fs || nodeFs
  const groups = groupsOf(harnesses)
  const forms = groups.flatMap((x) => x.forms)
  const harnessOfForm = new Map(groups.flatMap((x) => x.forms.map((f) => [f.id, x.harness])))
  const ctx = { // the daemon's own ctx (4.8 §2.2's, darwin's half): its env is not the install shell's, and priorOf reads the manifest's records by harness and entry, not by files(ctx)
    os: 'darwin', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
  }
  const manifestNow = () => { try { return (typeof manifest === 'function' ? manifest() : manifest) || readManifest(dir, fs) } catch { return null } }

  // the watcher and the owner question — no helper anywhere (4.9 §1): ps and lsof run on demand, through the one injected runner
  const exec = deps.exec ?? null // execTool's `run` (spawnSync-shaped); null = the real thing
  const procWatcher = deps.procWatcher || createProcWatcher({ ...(exec != null ? { exec } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.timers ? { timers: deps.timers } : {}) })
  const ownerOf = deps.ownerOf || ((q) => askOwnerOf({ ...(exec != null ? { exec } : {}), ...q, onFailure: (rec) => event(rec) }))

  // ingress.json, the controller, the kernel's forwarder and the entries writer: built only when the caller brought the dir (the daemon); the shell has none of them, and attach()
  // says so with its own TypeError (redirector.mjs) — a read-only command cannot reach for any of this.
  let ing = null
  let controller = null
  let kernelExe = null
  let forwarder = null
  let entries = null
  if (dir) {
    ing = await (deps.loadIngress ? deps.loadIngress() : loadIngressConfig({ dir, groups: groups.map((x) => x.g), isFree: deps.isFree || freeOnLoopback, ...(deps.random ? { random: deps.random } : {}), fs }))
    controller = deps.controller || await (async (isFree) => {
      const taken = new Set([ing.enginePort, ...Object.values(ing.groupPorts)])
      for (let i = 0; i < 40; i++) { const p = randomPort(deps.random || randomBytes); if (!taken.has(p) && (await isFree(p))) return { port: p, secret: (deps.random || randomBytes)(24).toString('hex') } }
      throw Object.assign(new Error(`no free port for the kernel's controller in ${CONTROLLER_RANGE.join('-')}`), { code: 'EADDRINUSE' })
    })(deps.isFree || freeOnLoopback)
    const kernelDir = path.join(dir, 'kernel')
    kernelExe = path.join(kernelDir, KERNEL_EXE)
    const pin = deps.pin || loadPin()
    forwarder = deps.forwarder || createForwarder({
      dir, bin: kernelExe, controller, ...(deps.spawn ? { spawn: deps.spawn } : {}), ...(deps.makeController ? { makeController: deps.makeController } : {}),
      ...(deps.now ? { now: deps.now } : {}), ...(deps.setTimer ? { setTimer: deps.setTimer } : {}), ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
      events: { failure: (rec) => event(rec), state: (rec) => event(rec) },
      gatekeeper: async () => gatekeeperCheck({ bin: kernelExe, ...(exec != null ? { run: exec } : {}), event, pin, arch: process.arch }),
      verifyCopy: () => verifyCopy({ dir: kernelDir, pin, arch: process.arch, fs }),
      isFree: deps.isFree || freeOnLoopback, procStart: (pid) => { try { return startedAtOf(pid, ...(exec != null ? [{ exec }] : [])) } catch { return null } }, fs,
    })
    entries = deps.entries || createProxyEntries({ dir, home, groups, ctx, ingress: () => ing, manifest: manifestNow, fs })
  }
  const ingress = () => ing

  // ---- the route plan (4.9 §2.2, 4.8 §2.2's mechanism) and the system proxy that moves it --------------------------------------------------
  let systemProxy = deps.systemProxy ?? null
  let plan = null
  const ownPorts = () => (ing ? [ing.enginePort, ...Object.values(ing.groupPorts), controller.port] : [])
  const carriedOf = () => new Set(groups.filter((x) => proxyRecordsOf(manifestNow(), x.group, x.harness).length > 0).map((x) => x.g)) // installed or once on; an opt-in's own record joins with the win line's Task 14
  const extraHostsOf = (harness) => { const h = (desired() || {})[harness]; return h && Array.isArray(h.extra_hosts) ? h.extra_hosts : [] }
  const appliedHosts = new Map() // form id → the host set the last plan applied; `status` compares it with a fresh read
  let redirector = null

  /** Re-plan from the network as it was last read and the desired state as it is now. `reload`: when a group's answers moved, bring the kernel to the new plan (`attach()`: the
   *  same reload the switch's `on` runs — the entries hold the same address, so their write is a no-op and their undo undoes nothing). */
  async function replan({ reload = false } = {}) {
    const carried = carriedOf()
    const next = planRoutes({ netenv: { systemProxy, ownPorts: ownPorts() }, groups, desired: desired() || {}, optIns: optIns() || [], manifest: manifestNow(), ctx, procs: redirector ? redirector.procs() : [], last: plan })
    const moved = plan == null || groups.some((x) => movedRoute(plan[x.g], next[x.g]))
    plan = next
    for (const x of groups) { // the host sets of the forms the kernel carries (on, or carried while off): kept per form, returned in status
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

  redirector = createDarwinRedirector({
    procWatcher, groups, home, ownerOf, ...(exec != null ? { exec } : {}),
    routes: () => plan, ingress,
    authOf: (ref) => resolveLogin(ref, { groups, ctx, manifest: manifestNow() }),
    onFailure: (rec) => event(rec), forwarder, entries, gate: w19Gate,
    ownImages: deps.ownImages || [process.execPath, ...(kernelExe ? [kernelExe] : [])],
    hostsOf: (f) => { const s = appliedHosts.get(f.id); return s ? s.hosts : null },
    carried: () => [...carriedOf()],
    ...(deps.now ? { now: deps.now } : {}),
  })

  // start(): the redirector's own (the watcher's baseline) plus this wiring's netenv half — the first scutil read, the first plan and the 5 s watcher. The shell (no dir) starts the
  // watcher only; the daemon calls start() once, and the kernel itself still comes with the first attach (4.8 §4.1). close() is the mirror: the netenv watcher stops first.
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

  redirector.darwin = {
    forwarder, ingress, replan, groups,
    netenv: () => ({ systemProxy, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    ...(controller ? { controller } : {}), ...(kernelExe ? { kernelExe } : {}),
    osMatch: { darwin: (f) => { const m = matchForm(forms, f, { home }); return m.kind === 'form' ? harnessOfForm.get(m.id) ?? null : null } }, // one rule for which form (4.8 §5.4, carried by 4.9 §5.4): the registry judges by the same matchForm the redirector routes by
    osLayers: { darwin: (d) => (d.darwin && d.darwin.layers) || d.layers }, // a harness with macOS layers of its own declares them; the rest read the same files as on Linux
    close: () => { if (netenvWatcher) netenvWatcher.stop() },
  }
  return redirector
}

/**
 * prepare({ locate, arch, fs }) → { notes: [line], refuse?: { code, reason, commands } } — the read-only hook `asight on` calls before it writes anything (4.8 §8 ⑥'s shape, W27 ⑥,
 * W74; the SAC preflight's darwin half is 4.9 §3 ②): the kernel line (`locateKernel`: found and verified, with its package and digest); a missing or mismatched kernel is a REFUSAL
 * with the two reinstall commands — no download to wait for, a settled precondition, so `on` exits 1 before the first write (the event and the receipt are the caller's). The
 * Gatekeeper line of 4.8's prepare has nothing to ask here: the quarantine attribute is checked at every launch and self-heals (§3 ②), so no state exists to read before the first
 * one — there is no second line. Nothing is written, nothing is started.
 */
export async function prepare({ locate = locateKernel, arch = process.arch, fs = nodeFs } = {}) {
  const k = await locate({ ...(arch ? { arch } : {}), ...(fs ? { fs } : {}) })
  if (k.missing || k.mismatch) {
    const commands = (k.missing || k.mismatch).commands
    return {
      refuse: {
        code: k.missing ? 'forwarder-binary-missing' : 'forwarder-digest-mismatch',
        reason: k.missing ? `the pinned kernel package was not found (${k.missing.reason}); nothing was changed` : 'the pinned kernel package holds a binary whose digest is not the pin\'s',
        ...(commands ? { commands } : {}),
      },
    }
  }
  return { notes: [`asight's kernel: found and verified (${k.found.sha256.slice(0, 12)}… in ${k.found.packageDir})`] }
}

export { CONTROLLER_RANGE, reinstallCommands }
