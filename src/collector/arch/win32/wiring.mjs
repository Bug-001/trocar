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
import { createForwarder, loadPin, verifyCopy, sacState, sacBlocks, locateKernel, ensureBinary, reinstallCommands, KERNEL_EXE } from './forwarder.mjs'
import { groupsOf, planRoutes, resolveLogin, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createWin32Redirector } from './redirector.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, readHkcuEnv, watchSystemProxy } from './upstream.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { appendEvent } from '../../core/events.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { collectorDir } from '../../../off/paths.mjs'
import { matchForm } from './forms.mjs'
import { names, probeUrl } from '../../../netenv/mihomo/rules.mjs'

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

  /** One probe refresh after the engine (re)starts (4.8 §3.3, the 「窗口期」 paragraph): a group that had fallen back stays on its re-entry
   *  point until its next interval (up to 30 s, not captured meanwhile), so the daemon asks the kernel's own controller to health-test every
   *  on-form's fallback group NOW, with the same loopback probe address the config carries (mihomo remembers health per address, so the url
   *  must be the group's own). The own-controller allowlist checks the path and the url (controller.mjs); a kernel that is not running or has
   *  no controller is said, not thrown. The client is the forwarder's own (N15 (a): a client that may write to a core is made in forwarder.mjs
   *  alone; an injected `deps.probeController` replaces it for tests, and a forwarder without one — an older shape — is simply no kernel). */
  async function refreshProbes() {
    const st = typeof forwarder.state === 'function' ? forwarder.state() : null
    if (st && st.phase && st.phase !== 'running') return { ok: false, reason: 'no kernel' }
    const creds = forwarder.controller()
    if (!creds || !Number.isInteger(creds.port)) return { ok: false, reason: 'no kernel' }
    const ctl = deps.probeController ? deps.probeController(creds) : (typeof forwarder.client === 'function' ? forwarder.client() : null)
    if (!ctl) return { ok: false, reason: 'no kernel' }
    const asked = []
    for (const x of groups) {
      if (((plan || {})[x.g] || {}).on !== true) continue
      const port = ing.groupPorts[x.g]
      for (const f of x.forms) {
        if (f.supported !== true || !f.match || !Number.isInteger(port)) continue
        const r = await ctl.get(`/group/${names(f.id).fb}/delay?url=${encodeURIComponent(probeUrl(port, f.id))}&timeout=2000`)
        asked.push({ f: f.id, ok: r.ok === true, status: r.status })
      }
    }
    return { ok: true, asked }
  }

  redirector.win32 = {
    helper, forwarder, ingress, replan, groups, refreshProbes,
    netenv: () => ({ systemProxy, hkcuEnv, ownPorts: ownPorts() }),
    appliedHosts: () => Object.fromEntries(appliedHosts),
    controller, kernelExe,
    osMatch: { win32: (f) => { const m = matchForm(forms, f, { home }); return m.kind === 'form' ? harnessOfForm.get(m.id) ?? null : null } }, // one rule for which form (4.8 §5.4): the registry judges by the same matchForm the redirector routes by
    osLayers: { win32: (d) => (d.win32 && d.win32.layers) || d.layers }, // Hermes declares its own Windows layers; the rest read the same files as on Linux
    close: async () => { if (watcher) watcher.stop() }, // the helper and the watcher stop with the redirector's own close()
  }
  return redirector
}

const msgOf = (e) => String((e && e.message) || e)

/**
 * win32Routing({ harnesses, home, env, fs }) → `{ ownsProxyField(h), fieldOf(h), adopt(h, setting) }` — the routing object of 1.6 §9.5's contract, what
 * `asight on` consumes in proxy mode (plan Task 8(c)); it sits beside `prepare` in loadArch's win32 arm, and runOnCli builds it with ITS environment (the same
 * shell that names CLAUDE_CONFIG_DIR and CODEX_HOME). On Windows both halves of the contract are the daemon's, done inside the very `on` request this follows:
 * the kernel's upstream comes out of the daemon's own read of the same files (`priorOf`, before the entry replaced the value), and the field is written through
 * the same journal `off` undoes by (`createProxyEntries`, the redirector's writer). So this side's `adopt` is the VERIFIER of that write — a group whose entry is
 * in the ledger must hold the kernel's address, or the on did not finish (a throw is exit 1, the harness named, no adopted record, V47); `setting` is not re-handed
 * (the kernel already has it from the same read, and no daemon API takes one — its control socket speaks only status/on/off). A group with no record is the user's
 * own field as it was: nothing to verify, and no second writer lives here.
 */
export function win32Routing({ harnesses = [], home, env = process.env, fs = nodeFs } = {}) {
  if (!home) throw new TypeError('win32Routing needs the HOME the entries were written into')
  const groups = groupsOf(harnesses)
  const dir = collectorDir(home)
  const ctx = { // the CLI's own ctx, the same shape the daemon's wiring builds: its env is the shell that ran on
    os: 'win32', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
    readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
  }
  const fileGroupsOf = (h) => groups.filter((x) => x.harness === h && x.group.proxyEntry && x.group.proxyEntry.kind === 'file')
  return {
    ownsProxyField: () => true, // proxy mode always owns the entry (1.6 §9.5; the kernel is the only route, D43)
    /** The harness's first file entry as a place to name (the 「你改过的代理设置」 line): the first of the group's files that is there, else the first listed; null where it has no file. */
    fieldOf: (h) => {
      const xs = fileGroupsOf(h)
      if (!xs.length) return null
      const e = xs[0].group.proxyEntry
      const files = e.files(ctx)
      const file = files.find((f) => { const r = ctx.readTextOrError(f); return r.error == null && r.text != null }) || files[0]
      return file ? { path: file, key: e.format === 'json-key' ? e.key.join('.') : e.block.urlVar } : null
    },
    /** Verifies the daemon's half of the on: every group of `h` whose entry is in the ledger holds the kernel's address. Rejects (never a vacuous pass, D38) when what that needs cannot be read. */
    adopt: async (h, _setting) => {
      const xs = fileGroupsOf(h)
      if (!xs.length) return // the entry is a policy value or a shim (Task 14's): no file of the agent's is asight's to point
      let manifest = null
      try { manifest = readManifest(dir, fs) } catch (e) { throw new Error(`the install manifest could not be read (${msgOf(e)}): whether ${h}'s field is asight's cannot be told`) }
      if (!manifest) throw new Error(`the install manifest is not there, so whether ${h}'s field is asight's cannot be told`)
      const onRecord = xs.filter((x) => proxyRecordsOf(manifest, x.group, h).length > 0)
      if (!onRecord.length) return // asight wrote no field of this harness (the group was not routed, or not on): the user's own setting is correct as it is
      let ing = null
      try { ing = JSON.parse(fs.readFileSync(path.join(dir, 'ingress.json'), 'utf8')) } catch (e) { throw new Error(`ingress.json could not be read (${(e && e.code) || 'unreadable'}): the kernel's ports are not known, so ${h}'s field cannot be verified`) }
      if (!ing || typeof ing !== 'object' || !onRecord.every((x) => Number.isInteger((ing.groupPorts || {})[x.g]))) throw new Error(`ingress.json holds no port for ${onRecord.map((x) => x.g).join(', ')}: the kernel's address cannot be named, so ${h}'s field cannot be verified`)
      const checker = createProxyEntries({ dir, home, groups, ctx, ingress: () => ing, manifest: () => manifest, fs })
      const bad = checker.check(onRecord.map((x) => ({ g: x.g, harness: h, entry: 'auto' }))).filter((r) => r && r.ok === false)
      if (bad.length) throw new Error(`the proxy entry of ${bad.map((r) => r.g).join(', ')} is in the ledger but the field does not hold the kernel's address: the on that wrote it did not finish (run asight doctor ${h})`)
    },
  }
}

/** What a `missing` answer of locateKernel / ensureBinary means in words (the receipt and the refusal say it the same way both sides of the write phase). */
const missingWhy = (missing, arch) => missing.reason === 'not-pinned' ? 'the pin carries no exe digest, so nothing can be verified against it' : `this machine's architecture (${arch}) is not in the pinned list`

/**
 * prepare({ helper, locate, sac, arch, fs, home }) → { notes: [line], kernel?, sac?, refuse?: { code, reason, commands? } } — the read-only hook `asight on` calls before it
 * writes anything (4.8 §8 ⑥ and the Smart App Control preflight; W27 ⑥, W74). The kernel line is in one of §8 ⑥'s three states: READY (the run location `kernel\` or the verified-archive
 * cache satisfies the pin — nothing to download), WILL-DOWNLOAD (neither is there — the plan's download line: version, the archive's size, the pinned sha256, the url's host; the download itself
 * happens AFTER the confirmation, in ensureKernel, D44) or a REFUSAL (an architecture the pin does not know, a pin with no exe digest — nothing downstream can fix either; `commands` carries the
 * manual alternative). `home` is where the collector dir lives (the run location and the cache are read under it). The pin is ALWAYS locateKernel's own (this build's), never a caller's injection
 * defaulting to nothing — the unsupported-arch-on-every-real-on bug was a caller forgetting to pass one, and this shape kills the class. `helper` is sacState's reader; one is started and closed
 * here when none is given (an injected `sac` gets the helper it was given, none if none). Nothing is written, nothing is started, nothing is downloaded.
 * `kernel: { version, exe, sha256, state: 'ready' | 'will-download', size?, url?, host? }` (the two lines' data — ready carries the verified sha256, will-download the archive's size and sha256,
 * the url and its host) and `sac: 'off' | 'on' | 'evaluation' | { unknown: { reason, detail? } }` are the same reads as the notes, as data — the Windows plan of 4.8 §11 draws its kernel line
 * and its Smart App Control line from them (the receipt keeps the notes, 1.6 §7).
 */
export async function prepare({ helper = null, locate = locateKernel, sac = sacState, arch = process.arch, fs = nodeFs, home = null, start = startHelper, env = process.env } = {}) {
  if (!home) throw new TypeError('prepare needs home: the kernel line reads the run location and the cache under ~/.asight/collector/')
  const kernelDir = path.join(collectorDir(home), 'kernel')
  const k = await locate({ arch, dir: kernelDir, fs })
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
  // the kernel line's two shapes: ready (the run location or the cache satisfies the pin) and will-download (the plan shows the download line; the download happens after the confirmation, D44)
  const kernel = k.found
    ? { version: loadPin().version, exe: KERNEL_EXE, sha256: k.found.sha256, state: 'ready', at: k.found.at }
    : { version: k.download.version, exe: k.download.exe, sha256: k.download.sha256, size: k.download.size, url: k.download.url, host: k.download.host, state: 'will-download' }
  const notes = [k.found
    ? `asight's kernel: found and verified (${k.found.sha256.slice(0, 12)}… ${k.found.at === 'cache' ? 'in the archive cache' : 'in kernel\\'})`
    : `asight's kernel: not there yet — mihomo ${k.download.version} will be downloaded (archive ${(k.download.size / 1048576).toFixed(1)} MB, sha256 pinned, from ${k.download.host}) once you confirm`]
  let own = false
  let h = helper
  if (!h && sac === sacState) { try { h = start({ env }); own = true } catch { h = null } } // only the real reader needs a helper of its own
  let sacStateOut = null
  try {
    const state = h || sac !== sacState ? await sac({ helper: h }) : { unknown: { reason: 'denied', detail: 'no helper' } }
    sacStateOut = state
    if (state === 'on' || state === 'evaluation') notes.push('Smart App Control 开着:未签名的 asight-forwarder.exe 很可能起不来,代理模式用不了(仍会去试;失败时会记下原因,一个代理入口也不写)')
    else if (state !== 'off') notes.push(`Smart App Control 的状态读不到(${state.unknown.reason}${state.unknown.detail ? `:${state.unknown.detail}` : ''}):不知道,按上面的计划继续`)
  } finally { if (own && h && typeof h.close === 'function') await h.close() }
  return { notes, kernel, sac: sacStateOut }
}

/**
 * ensureKernel({ home, arch, env, fs, execFile }) → `{ ok: true, path, sha256, from, copied, note }` · `{ ok: false, reason }` — the FIRST write-phase step of a real `on` (D44): the kernel's
 * download, verify and placement, asked AFTER the confirmation and BEFORE any agent file is touched, so a failed download leaves zero agent files written (the precondition's nature unchanged,
 * 4.8 §8 ①). `from` says where the kernel came from — 'run' (it was already the pinned one: nothing done, no network), 'cache' (the verified archive, no network) or 'download' (the CLI's one
 * online step) — and `note` is the receipt's line of that. The download's three records (started / ok / failed) go to the collector dir's flows/ through the same appendEvent every forwarder
 * record uses (D38; kernel-download.mjs writes them); a `missing` or `mismatch` answer gets its failure event here. A `blocked` placement (the old exe is running or draining and Windows will not
 * let it be replaced, W27 ⑨) stops the on with the wait-or-`off --now` line and NO event: nothing was written, so the receipt is the record (R11) — a blocked replace is also the answer of the
 * daemon's own later attempts, whose records are the §12 table's. `execFile` is node's own by default and a test's recorder otherwise (0.1 §3: no test reaches a real curl).
 */
export async function ensureKernel({ home, arch = process.arch, pin = null, env = process.env, fs = nodeFs, execFile } = {}) {
  if (!home) throw new TypeError('ensureKernel needs home: the kernel lives under ~/.asight/collector/')
  const dir = collectorDir(home)
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
  if (r.blocked) return { ok: false, reason: `the kernel in kernel\\ could not be replaced (${r.blocked.step}: ${r.blocked.reason}): it is running or draining, and asight does not stop it by itself; nothing was changed. Wait for the drain to end, or run asight off --now (it disconnects the agents still draining), then asight on` }
  // `ledger` (only when THIS run placed the copy — `copied`): what turnOn writes into the install manifest's files, so `uninstall` removes the kernel and
  // the archive cache with it (4.8 §531 · §4.2; D44 ②). turnOn owns the manifest machinery — the kernel sits on disk before the manifest exists (the hook
  // runs before the lock, the manifest is opened inside it), so the entry is written there, not here.
  return { ok: true, path: r.path, sha256: r.sha256, from: r.from, copied: r.copied,
    ...(r.copied ? { ledger: { path: r.path, sha256: r.sha256, dir: path.dirname(r.path) } } : {}),
    note: r.from === 'download' ? `the kernel was downloaded and both digests verified (sha256 ${r.sha256.slice(0, 12)}…)` : r.from === 'cache' ? 'the kernel was placed from the verified archive cache (no network)' : null }
}

export { CONTROLLER_RANGE, reinstallCommands }
