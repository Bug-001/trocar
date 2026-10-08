// wiring.mjs — the daemon's Windows half (RFC 4.8 §1 接线 · §2.1 · §2.2 · §3.1 · §4.1 · §5.1 · §6.2; W12 W19 W71 W72 W76; plan Task 8(c)).
// daemon.mjs is the one module that may wire core + arch + harness (layering rule 5); this file is all of that wiring which is Windows's: the helper and the process
// watcher, the socket-table owner question, ingress.json's ports and tokens, the kernel and its controller, the proxy entries' writer, the route plan and its refresh
// (the system-proxy watcher: a change reloads the kernel when it moved a group's answers, and writes one netenv-change), the host sets, the tracker's OS rule (`osMatch`
// — one rule for which form, the same `matchForm` the redirector routes by) and the kernel's `carried` list (audit F7). It names no harness: the daemon hands the
// descriptors in; everything is injected, so a test runs it against a fake helper, a fake kernel and a sandbox %USERPROFILE%. `prepare` is `asight on`'s read-only hook.
import os from 'node:os'
import path from 'node:path'
import nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { startHelper, policyAllowOf } from './helper.mjs'
import { createProcWatcher } from './procinfo.mjs'
import { ownerOf as askOwnerOf } from './socktable.mjs'
import { loadIngressConfig, freeOnLoopback } from './ingress-config.mjs'
import { createForwarder, loadPin, verifyCopy, sacState, sacBlocks, locateKernel, reinstallCommands, KERNEL_EXE } from './forwarder.mjs'
import { groupsOf, planRoutes, resolveLogin, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createWin32Redirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, readHkcuEnv, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { matchForm } from './forms.mjs'

const CONTROLLER_RANGE = [19000, 19999] // the kernel's own controller, its own free port (the generator refuses one it has already seen)
const randomPort = (random) => CONTROLLER_RANGE[0] + (random(4).readUInt32BE(0) % (CONTROLLER_RANGE[1] - CONTROLLER_RANGE[0] + 1))

/** The gate `attach()` asks before it writes a group's proxy entry (4.8 W19; the Task 8(b) review made it the redirector's required argument): Codex's and
 *  Hermes's lines join a block their trust entry wrote, and may not be written before the journal's four W19 conditions hold. They hold (landed with the Task 8(v)
 *  round, 2026-10-08): the default-off join, the LIFO undo of the combined block, its CRLF and spaced-profile cases, and the user's credentials in the manifest
 *  only — pinned cell by cell by test/collector/harness/win32-trust.test.mjs's GATE. This is the named place that would refuse those two groups again, and what
 *  keeps it honest is the wiring's own combined case (test/collector/arch/win32/entries.test.mjs): a journal that regresses the join refuses it and that test
 *  goes red with the GATE. */
const w19Gate = () => ({ ok: true })

/** Whether a re-plan moved this group in a way the kernel must be told: its upstream, its bypass table, or on/off (4.8 §2.2: a change whose recomputed answers
 *  equal the group's `last` reloads nothing — a `reg-read` that timed out behind a slow `ps` and the read back are two changes with the same upstream). */
const movedRoute = (a, b) => !a || !b || a.on !== b.on || JSON.stringify(a.upstream ?? null) !== JSON.stringify(b.upstream ?? null) || JSON.stringify(a.bypass ?? null) !== JSON.stringify(b.bypass ?? null)

/**
 * createWin32Collector({ env, dir, home, harnesses, failure, event, manifest, desired, deps }) → the Redirector (4.8 §1), carrying a `win32` bag of what only
 * the daemon reaches: `{ helper, forwarder, ingress, replan, netenv, appliedHosts, controller, kernelExe, osMatch, osLayers, groups, close }`. Everything is
 * injected through `deps` for a test: `helper · procWatcher · ownerOf · forwarder · entries · loadIngress · controller · spawn · makeController · fs · random ·
 * isFree · now · timers · procStart · readSystemProxy · readHkcuEnv · systemProxy · hkcuEnv · watchSystemProxy · ownImages · pin`.
 *   failure (where, error, extra)  the daemon's failure recorder · event (record)  its event writer (netenv-change, the helper's own records)
 *   manifest  () → the manifest as it is NOW (the daemon re-reads it; null reads it here) · desired  () → state.json's `harnesses` (`{ <id>: { desired, extra_hosts } }`)
 *   optIns    () → the groups or forms the user named and asight has the record of (Task 14's planOptIns reads them from the manifest; today there is none, so the default is none)
 */
export async function createWin32Collector({ env = process.env, dir, home = env.USERPROFILE || os.homedir(), harnesses = [], failure = () => {}, event = () => {}, manifest = null, desired = () => ({}), optIns = () => [], deps = {} } = {}) {
  if (!dir) throw new TypeError('createWin32Collector needs the collector dir (~/.asight/collector)')
  const fs = deps.fs || nodeFs
  const groups = groupsOf(harnesses)
  const forms = groups.flatMap((x) => x.forms)
  const harnessOfForm = new Map(groups.flatMap((x) => x.forms.map((f) => [f.id, x.harness])))
  const ctx = { // the daemon's own ctx (4.8 §2.2): its env is not the install shell's, and priorOf reads the manifest's records by harness and entry, not by files(ctx)
    os: 'win32', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
  }
  const manifestNow = () => { try { return (typeof manifest === 'function' ? manifest() : manifest) || readManifest(dir, fs) } catch { return null } }

  const helper = deps.helper || startHelper({ env, ...(deps.spawn ? { spawn: deps.spawn } : {}), regAllow: policyAllowOf(groups), onFailure: (rec) => event(rec) })
  const procWatcher = deps.procWatcher || createProcWatcher({ helper, ...(deps.now ? { now: deps.now } : {}), ...(deps.timers ? { timers: deps.timers } : {}) })
  const ownerOf = deps.ownerOf || ((q) => askOwnerOf({ helper, ...q, onFailure: (rec) => event(rec) }))
  const ing = await (deps.loadIngress ? deps.loadIngress() : loadIngressConfig({ dir, groups: groups.map((x) => x.g), isFree: deps.isFree || freeOnLoopback, ...(deps.random ? { random: deps.random } : {}), fs }))
  const ingress = () => ing
  const controller = deps.controller || await (async (isFree) => {
    const taken = new Set([ing.enginePort, ...Object.values(ing.groupPorts)])
    for (let i = 0; i < 40; i++) { const p = randomPort(deps.random || randomBytes); if (!taken.has(p) && (await isFree(p))) return { port: p, secret: (deps.random || randomBytes)(24).toString('hex') } }
    throw Object.assign(new Error(`no free port for the kernel's controller in ${CONTROLLER_RANGE.join('-')}`), { code: 'EADDRINUSE' })
  })(deps.isFree || freeOnLoopback)

  const kernelDir = path.join(dir, 'kernel')
  const kernelExe = path.join(kernelDir, KERNEL_EXE)
  const pin = deps.pin || loadPin({ fs })
  const procStart = deps.procStart || (async (pid) => { try { const r = await helper.call('ps', {}, { timeoutMs: 10000 }); const row = ((r && r.rows) || []).find((x) => x.pid === pid); return row && row.startedAt != null ? row.startedAt : null } catch { return null } })
  const forwarder = deps.forwarder || createForwarder({
    dir, bin: kernelExe, controller, ...(deps.spawn ? { spawn: deps.spawn } : {}), ...(deps.makeController ? { makeController: deps.makeController } : {}),
    ...(deps.now ? { now: deps.now } : {}), ...(deps.setTimer ? { setTimer: deps.setTimer } : {}), ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    events: { failure: (rec) => event(rec), state: (rec) => event(rec) },
    sacOn: async () => sacBlocks(await sacState({ helper })),
    verifyCopy: () => verifyCopy({ dir: kernelDir, pin, arch: process.arch, ...(deps.fs ? { fs } : {}) }),
    isFree: deps.isFree || freeOnLoopback, procStart, fs,
  })
  const entries = deps.entries || createProxyEntries({ dir, home, groups, ctx, ingress, manifest: manifestNow, fs })

  // ---- the route plan (4.8 §2.2) and the system proxy that moves it ------------------------------------------------------------------
  let systemProxy = deps.systemProxy ?? null
  let hkcuEnv = deps.hkcuEnv ?? null
  const ownPorts = () => [ing.enginePort, ...Object.values(ing.groupPorts), controller.port]
  async function readNetenv() { [systemProxy, hkcuEnv] = await Promise.all([(deps.readSystemProxy || readSystemProxy)({ helper }), (deps.readHkcuEnv || readHkcuEnv)({ helper })]) }
  let plan = null
  const appliedHosts = new Map() // form id → the host set the last plan applied; `status` compares it with a fresh read (Task 10)
  const carriedOf = () => new Set(groups.filter((x) => proxyRecordsOf(manifestNow(), x.group, x.harness).length > 0).map((x) => x.g)) // installed or once on; an opt-in's own record joins with Task 14
  const extraHostsOf = (harness) => { const h = (desired() || {})[harness]; return h && Array.isArray(h.extra_hosts) ? h.extra_hosts : [] }

  /** Re-plan from the network as it was last read and the desired state as it is now. `reload`: when a group's answers moved, bring the kernel to the new plan
   *  (`attach()`: the same reload the switch's `on` runs — the entries hold the same address, so their write is a no-op and their undo undoes nothing). */
  async function replan({ reload = false } = {}) {
    const carried = carriedOf()
    const next = planRoutes({ netenv: { systemProxy, hkcuEnv, ownPorts: ownPorts() }, groups, desired: desired() || {}, optIns: optIns() || [], manifest: manifestNow(), ctx, procs: redirector ? redirector.procs() : [], last: plan })
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

  const redirector = createWin32Redirector({
    helper, procWatcher, groups, home, ownerOf,
    routes: () => plan, ingress,
    authOf: (ref) => resolveLogin(ref, { groups, ctx, manifest: manifestNow(), hkcuEnv }),
    onFailure: (rec) => event(rec), forwarder, entries, gate: w19Gate,
    ownImages: deps.ownImages || [process.execPath, kernelExe],
    hostsOf: (f) => { const s = appliedHosts.get(f.id); return s ? s.hosts : null },
    carried: () => [...carriedOf()],
    ...(deps.now ? { now: deps.now } : {}),
  })
  await readNetenv()
  await replan()

  // the system proxy watcher (4.8 §2.2, W71): every change is one netenv-change; the kernel is reloaded only when a group's answers moved
  let watcher = null
  if (deps.watchSystemProxy !== false) {
    watcher = (deps.watchSystemProxy || watchSystemProxy)({ helper, initial: systemProxy, read: deps.readSystemProxy || readSystemProxy, onError: (e) => failure('helper', e), ...(deps.timers ? { timers: deps.timers } : {}) })
    watcher.on('change', async ({ before, after }) => {
      systemProxy = after
      event({ event: 'netenv-change', where: 'netenv', code: 'netenv-changed', from: (before && before.server) ?? null, to: (after && after.server) ?? null, captured: null,
        reason: `the system proxy changed (${before && before.ok ? `${before.server ?? 'off'} → ${after && after.ok ? after.server ?? 'off' : 'unreadable'}` : 'unreadable → read again'}); the groups that follow it are re-planned` })
      await replan({ reload: true })
    })
  }

  redirector.win32 = {
    helper, forwarder, ingress, replan, groups,
    netenv: () => ({ systemProxy, hkcuEnv, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    controller, kernelExe,
    osMatch: { win32: (f) => { const m = matchForm(forms, f, { home }); return m.kind === 'form' ? harnessOfForm.get(m.id) ?? null : null } }, // one rule for which form (4.8 §5.4): the registry judges by the same matchForm the redirector routes by
    osLayers: { win32: (d) => (d.win32 && d.win32.layers) || d.layers }, // Hermes declares its own Windows layers; the rest read the same files as on Linux
    close: async () => { if (watcher) watcher.stop() }, // the helper and the watcher stop with the redirector's own close()
  }
  return redirector
}

/**
 * prepare({ plan, helper, locate, sac, arch, fs }) → { notes: [line], refuse?: { code, reason, commands } } — the read-only hook `asight on` calls before it
 * writes anything (4.8 §8 ⑥ and the Smart App Control preflight; W27 ⑥, W74): the kernel line (`locateKernel`: found and verified, with its package and digest)
 * and, when Smart App Control is on or evaluating, its warning line; a missing or mismatched kernel is a REFUSAL with the two reinstall commands — no download
 * to wait for, a settled precondition, so `on` exits 1 before the first write (the event and the receipt are the caller's). `helper` is sacState's reader; one
 * is started and closed here when none is given. Nothing is written, nothing is started.
 */
export async function prepare({ helper = null, locate = locateKernel, sac = sacState, arch = process.arch, fs = nodeFs, start = startHelper, env = process.env } = {}) {
  const k = await locate({ ...(arch ? { arch } : {}), ...(fs ? { fs } : {}) })
  if (k.missing || k.mismatch) {
    const commands = (k.missing || k.mismatch).commands
    return {
      refuse: {
        code: k.missing ? 'forwarder-binary-missing' : 'forwarder-digest-mismatch',
        reason: k.missing ? `the pinned kernel package was not found (${k.missing.reason}); nothing was changed` : 'the pinned kernel package holds an exe whose digest is not the pin\'s',
        ...(commands ? { commands } : {}),
      },
    }
  }
  const notes = [`asight's kernel: found and verified (${k.found.sha256.slice(0, 12)}… in ${k.found.packageDir})`]
  let own = false
  let h = helper
  if (!h) { try { h = start({ env }); own = true } catch { h = null } }
  try {
    const state = h ? await sac({ helper: h }) : { unknown: { reason: 'denied', detail: 'no helper' } }
    if (state === 'on' || state === 'evaluation') notes.push('Smart App Control 开着:未签名的 asight-forwarder.exe 很可能起不来,代理模式用不了(仍会去试;失败时会记下原因,一个代理入口也不写)')
    else if (state !== 'off') notes.push(`Smart App Control 的状态读不到(${state.unknown.reason}${state.unknown.detail ? `:${state.unknown.detail}` : ''}):不知道,按上面的计划继续`)
  } finally { if (own && h && typeof h.close === 'function') await h.close() }
  return { notes }
}

export { CONTROLLER_RANGE, reinstallCommands }
