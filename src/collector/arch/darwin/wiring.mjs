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
import { createForwarder, loadPin, verifyCopy, gatekeeperCheck, locateKernel, ensureBinary, reinstallCommands, KERNEL_EXE } from './forwarder.mjs'
import { groupsOf, planRoutes, resolveLogin, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createDarwinRedirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { appendEvent } from '../../core/events.mjs'
import { execTool } from '../../../off/exec.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { MARKER_TOLERANCE_MS } from '../../core/trust/confirm.mjs'
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
 *   reaches: `{ forwarder, ingress, replan, groups, netenv, appliedHosts, controller, kernelExe, osMatch, osLayers, markerToleranceMs, close }` (the win32 bag's shape; osMatch is the registry's
 *   second key, 4.8 §5.4; markerToleranceMs is the plugin marker's fixed tolerance — the daemon hands it to the tracker, confirm.mjs's value). Everything is injected through `deps` for a test. `dir` absent = the lazy shell (the header's LAZY RULE).
 *   failure (where, error, extra)  the daemon's failure recorder · event (record)  its event writer (netenv-change, the watcher's own records)
 *   manifest  () → the manifest as it is NOW (the daemon re-reads it; null reads it here) · desired  () → state.json's `harnesses` (`{ <id>: { desired, extra_hosts } }`)
 *   optIns    () → the groups or forms the user named and asight has the record of; the default (null) DERIVES them from the manifest's `optin-*` entries (4.9 §6.4's wiring arm,
 *              2026-10-12: without it a daemon that restarts after `on … --opt-in claude-code.desktop` re-plans the group as unnamed → the launcher points at a port with no listener)
 */
export async function createDarwinCollector({ env = process.env, dir = null, home = env.HOME || os.homedir(), harnesses = [], failure = () => {}, event = () => {}, manifest = null, desired = () => ({}), optIns = null, deps = {} } = {}) {
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
  const exec = deps.exec ?? null // execTool's `run` (spawnSync-shaped); a test injects one, and without one execTool spawns the real command itself
  // The execTool-shaped runner the lsof questions take (socktable's ownerOf · the redirector's directCount: `exec('lsof', args, { timeoutMs })` → Promise<{ code, out, err }> —
  // ownerOf races it against a budget timer and calls .catch on it, so it must be a PROMISE even though execTool itself is synchronous). It is always a runner — the injected one
  // wrapped, execTool's own spawn otherwise. An early build had ownerOf built WITHOUT any (the old `exec != null ? { exec } : {}` spread left the key absent and every owner
  // question threw "exec is not a function"); the second had it synchronous and every question threw "asked.catch is not a function" — both left every agent connection judged
  // untracked and spliced, nothing captured (found live by the smoke, 2026-10-09, results 20261008T221132 · 20261008T223245).
  const execOf = async (file, args, o = {}) => execTool(file, args, { ...o, ...(exec != null ? { run: exec } : {}) })
  // the images a PATH-launched row (bare argv[0]) is worth one lsof for: the forms own (procinfo.mjs askFor — the real executable of such a row comes only from lsof's txt record, measured 2026-10-12; the wiring names the images because arch/ imports no harness)
  const askFor = [...new Set(forms.filter((f) => f.match && f.match.image).map((f) => f.match.image))]
  const procWatcher = deps.procWatcher || createProcWatcher({ ...(exec != null ? { exec } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.timers ? { timers: deps.timers } : {}), askFor })
  const ownerOf = deps.ownerOf || ((q) => askOwnerOf({ exec: execOf, ...q, onFailure: (rec) => event(rec) }))

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
  // the manifest's opt-in records of one group's forms (confirmed: an entry whose write failed is re-offered, not treated as in effect — planOptIns' own 'done' rule); these say the
  // group is opted in (the plan's gate) and may stay in the kernel while off (carried, audit F7) — the desktop-launcher's listener lives or dies by this arm (4.9 §6.4)
  const optinRecordsOf = (m, x) => (m && Array.isArray(m.entries) ? m.entries : []).filter((e) => e && typeof e.kind === 'string' && e.kind.startsWith('optin-') && e.confirmed !== false && e.harness === x.harness && x.forms.some((f) => f.id === e.form))
  // the named-and-recorded forms (and their groups) the daemon's re-plan treats as opted in: the caller's own list when it brought one, else derived from the manifest — a caller
  // that passes none (the daemon today) still re-plans a launcher'd group as on (4.9 §6.4's wiring arm)
  const namedOptIns = () => {
    const given = optIns ? optIns() : null
    if (given && given.length) return given
    const m = manifestNow()
    return groups.filter((x) => optinRecordsOf(m, x).length > 0).flatMap((x) => [x.g, ...x.forms.map((f) => f.id)])
  }
  const carriedOf = () => new Set(groups.filter((x) => proxyRecordsOf(manifestNow(), x.group, x.harness).length > 0 || optinRecordsOf(manifestNow(), x).length > 0).map((x) => x.g)) // installed, once on, or opted in (the opt-in's own record — the desktop launcher's arm, 4.9 §6.4; the win line's Task 14 twin)
  const extraHostsOf = (harness) => { const h = (desired() || {})[harness]; return h && Array.isArray(h.extra_hosts) ? h.extra_hosts : [] }
  const appliedHosts = new Map() // form id → the host set the last plan applied; `status` compares it with a fresh read
  let redirector = null

  /** Re-plan from the network as it was last read and the desired state as it is now. `reload`: when a group's answers moved, bring the kernel to the new plan (`attach()`: the
   *  same reload the switch's `on` runs — the entries hold the same address, so their write is a no-op and their undo undoes nothing). */
  async function replan({ reload = false } = {}) {
    const carried = carriedOf()
    const next = planRoutes({ netenv: { systemProxy, ownPorts: ownPorts() }, groups, desired: desired() || {}, optIns: namedOptIns(), manifest: manifestNow(), ctx, procs: redirector ? redirector.procs() : [], last: plan })
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
    procWatcher, groups, home, ownerOf, exec: execOf, // the redirector's exec is the lsof shape (socktable's, its docstring): the execTool wrapper, not the spawnSync-shaped run the old spread passed — with a test's deps.exec injected it was the wrong shape, and without one it was absent and directCount degraded to no-exec
    routes: () => plan, ingress,
    authOf: (ref) => resolveLogin(ref, { groups, ctx, manifest: manifestNow() }),
    onFailure: (rec) => event(rec), forwarder, entries, gate: w19Gate,
    ownImages: deps.ownImages || [process.execPath, ...(kernelExe ? [kernelExe] : [])],
    hostsOf: (f) => { const s = appliedHosts.get(f.id); return s ? s.hosts : null },
    carried: () => [...carriedOf()],
    ...(deps.now ? { now: deps.now } : {}),
  })

  // start(): the redirector's own (the watcher's baseline) plus this wiring's netenv half — claim any kernel a previous daemon left running (W28's 认领, review F2), then the first scutil
  // read, the first plan and the 5 s watcher. The shell (no dir) starts the watcher only; the daemon calls start() once, and a kernel that was not there still comes with the first attach
  // (4.8 §4.1) — adopt() only claims a lock-named kernel whose pid, start time and controller all answer, and claims nothing when there is no lock. close() is the mirror: the netenv watcher stops first.
  let netenvWatcher = null
  const innerStart = redirector.start
  redirector.start = async (...a) => {
    const r = await innerStart(...a)
    if (dir) {
      if (forwarder && typeof forwarder.adopt === 'function') await forwarder.adopt() // a daemon the LaunchAgent's KeepAlive restarted claims the kernel the old one left running (its lock names it; 4.8 §4.1): without this the first attach sees port-taken and capture is dead until a hand kills the kernel — the agents keep flowing either way, the kernel forwards-only upstream (review F2)
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
  // (the start's, all-off) builds an empty kernel plan and the first `on` after boot does nothing (found live by the lab smoke, 2026-10-09). Both are wrapped to re-plan first;
  // the netenv-change path's replan({ reload: true }) reaches the same wrapper (one extra pure recompute, the same answers) and stays non-reentrant (reload is false in here).
  const innerAttach = redirector.attach
  redirector.attach = async (...a) => { await replan(); return innerAttach(...a) }
  const innerDetach = redirector.detach
  redirector.detach = async (...a) => { await replan(); return innerDetach(...a) }

  redirector.darwin = {
    forwarder, ingress, replan, groups,
    netenv: () => ({ systemProxy, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    ...(controller ? { controller } : {}), ...(kernelExe ? { kernelExe } : {}),
    osMatch: { darwin: (f) => { const m = matchForm(forms, f, { home }); return m.kind === 'form' ? harnessOfForm.get(m.id) ?? null : null } }, // one rule for which form (4.8 §5.4, carried by 4.9 §5.4): the registry judges by the same matchForm the redirector routes by
    osLayers: { darwin: (d) => (d.darwin && d.darwin.layers) || d.layers }, // a harness with macOS layers of its own declares them; the rest read the same files as on Linux
    markerToleranceMs: MARKER_TOLERANCE_MS, // the darwin plugin twins write performance.timeOrigin (sub-millisecond) against ps's second-granular lstart (startTicks): the tracker gets the same fixed tolerance the win line's markers are compared with (confirm.mjs; review F4)
    close: () => { if (netenvWatcher) netenvWatcher.stop() },
  }
  return redirector
}

/** What a `missing` answer of locateKernel / ensureBinary means in words (the receipt and the refusal say it the same way both sides of the write phase). */
const missingWhy = (missing, arch) => missing.reason === 'not-pinned' ? 'the pin carries no exe digest, so nothing can be verified against it' : `this machine's architecture (${arch}) is not in the pinned list`

/**
 * prepare({ locate, arch, fs, home }) → { notes: [line], kernel?, refuse?: { code, reason, commands? } } — the read-only hook `asight on` calls before it writes anything (4.8 §8 ⑥'s shape carried
 * by 4.9, W27 ⑥, W74): the kernel line in one of §8 ⑥'s three states — READY (the run location `kernel/` or the verified-archive cache satisfies the pin), WILL-DOWNLOAD (neither is there: the
 * plan's download line — version, the archive's size, the pinned sha256, the url's host; the download happens AFTER the confirmation, in ensureKernel, D44) or a REFUSAL (an architecture the pin
 * does not know, a pin with no exe digest; `commands` carries the manual alternative). `home` is where the collector dir lives. The pin is ALWAYS locateKernel's own (this build's), never a
 * caller's injection defaulting to nothing — the unsupported-arch-on-every-real-on bug was a caller forgetting to pass one, and this shape kills the class.
 * The Gatekeeper line of 4.8's prepare has nothing to ask here: the quarantine attribute is checked at every launch and self-heals (§3 ②), so no state exists to read before the first one — there
 * is no second line. Nothing is written, nothing is started, nothing is downloaded.
 */
export async function prepare({ locate = locateKernel, arch = process.arch, fs = nodeFs, home = null } = {}) {
  if (!home) throw new TypeError('prepare needs home: the kernel line reads the run location and the cache under ~/.asight/collector/')
  const k = await locate({ arch, dir: path.join(home, '.asight', 'collector', 'kernel'), fs })
  if (k.missing) {
    const raw = k.missing.alternative
    return {
      refuse: {
        code: 'forwarder-binary-missing',
        reason: missingWhy(k.missing, arch),
        ...(raw ? { commands: [raw] } : {}),
      },
    }
  }
  const kernel = k.found
    ? { version: loadPin().version, exe: KERNEL_EXE, sha256: k.found.sha256, state: 'ready', at: k.found.at }
    : { version: k.download.version, exe: k.download.exe, sha256: k.download.sha256, size: k.download.size, url: k.download.url, host: k.download.host, state: 'will-download' }
  const notes = [k.found
    ? `asight's kernel: found and verified (${k.found.sha256.slice(0, 12)}… ${k.found.at === 'cache' ? 'in the archive cache' : 'in kernel/'})`
    : `asight's kernel: not there yet — mihomo ${k.download.version} will be downloaded (archive ${(k.download.size / 1048576).toFixed(1)} MB, sha256 pinned, from ${k.download.host}) once you confirm`]
  return { notes, kernel }
}

/**
 * ensureKernel({ home, arch, env, fs, execFile }) → `{ ok: true, path, sha256, from, copied, note }` · `{ ok: false, reason }` — the FIRST write-phase step of a real `on` (D44's darwin half,
 * 4.9 §8): the kernel's download (curl), verify (both digests), gunzip and placement, asked AFTER the confirmation and BEFORE any agent file is touched, so a failed download leaves zero agent
 * files written. `from` says where the kernel came from — 'run' (already the pinned one: nothing done), 'cache' (the verified archive, no network) or 'download' (the CLI's one online step) — and
 * `note` is the receipt's line of that. The download's three records go to the collector dir's flows/ through the same appendEvent every forwarder record uses (D38); a `missing` or `mismatch`
 * answer gets its failure event here. A `blocked` placement stops the on with the wait-or-`off --now` line and NO event: nothing was written, the receipt is the record (R11).
 * `execFile` is node's own by default and a test's recorder otherwise (0.1 §3: no test reaches a real curl).
 */
export async function ensureKernel({ home, arch = process.arch, pin = null, env = process.env, fs = nodeFs, execFile } = {}) {
  if (!home) throw new TypeError('ensureKernel needs home: the kernel lives under ~/.asight/collector/')
  const dir = path.join(home, '.asight', 'collector')
  const event = (rec) => { try { appendEvent(dir, rec) } catch { /* the receipt is the record when flows/ cannot be written (R11) */ } }
  const r = await ensureBinary({ ...(pin ? { pin } : {}), arch, dir: path.join(dir, 'kernel'), fs, ...(execFile ? { execFile } : {}), env, event })
  if (r.missing) {
    event({ event: 'failure', where: 'forwarder', code: 'forwarder-binary-missing', reason: missingWhy(r.missing, arch) })
    return { ok: false, reason: `${missingWhy(r.missing, arch)}; nothing was changed` }
  }
  if (r.failed) return { ok: false, reason: `${r.failed.reason}; nothing was changed. 手动替代(asight 不替你跑): ${r.failed.alternative}` }
  if (r.mismatch) {
    const line = `the kernel that was placed is not the pinned one; nothing was changed. 手动替代(asight 不替你跑): ${r.mismatch.alternative}`
    event({ event: 'failure', where: 'forwarder', code: 'forwarder-digest-mismatch', reason: line, of: 'copy' })
    return { ok: false, reason: line, of: 'copy' }
  }
  if (r.blocked) return { ok: false, reason: `the kernel in kernel/ could not be replaced (${r.blocked.step}: ${r.blocked.reason}); nothing was changed. Wait for the drain to end, or run asight off --now (it disconnects the agents still draining), then asight on` }
  // `ledger` (only when THIS run placed the copy — `copied`): what turnOn writes into the install manifest's files, so `uninstall` removes the kernel and
  // the archive cache with it (4.8 §531 · §4.2; D44 ②). turnOn owns the manifest machinery — the kernel sits on disk before the manifest exists (the hook
  // runs before the lock, the manifest is opened inside it), so the entry is written there, not here.
  return { ok: true, path: r.path, sha256: r.sha256, from: r.from, copied: r.copied,
    ...(r.copied ? { ledger: { path: r.path, sha256: r.sha256, dir: path.dirname(r.path) } } : {}),
    note: r.from === 'download' ? `the kernel was downloaded and both digests verified (sha256 ${r.sha256.slice(0, 12)}…)` : r.from === 'cache' ? 'the kernel was placed from the verified archive cache (no network)' : null }
}

export { CONTROLLER_RANGE, reinstallCommands }
