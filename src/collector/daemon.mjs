// daemon.mjs — the per-user collector daemon (RFC 4.6 §结构 · §控制面 · §开关语义 · D36). The ONLY module that
// wires core + arch + harness (layering.test.mjs names it). It runs as the operator, claims the control socket
// before anything else (one daemon, one helper per user), spawns the capability helper through arch, serves the
// engine on loopback, restores the desired switch state, and fails open everywhere: a dead helper means direct
// connections, never broken ones. It never mints the CA: `asight on` does, inside the manifest.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asightHome, collectorHome } from '../paths.mjs'
import { loadArch } from './arch/index.mjs'
import { loadHarnesses } from './harness/index.mjs'
import { createRegistry } from './core/registry.mjs'
import { createTrustChecker } from './core/trust/confirm.mjs'
import { readManifest, installedAt } from './core/trust/journal.mjs'
import { rewriteBundles } from './core/trust/bundle.mjs'
import { createTracker } from './core/tracker.mjs'
import { createSwitch, readState } from './core/switch.mjs'
import { startControlServer, controlSocketPath } from './core/control.mjs'
import { readCa } from './core/tls/ca-store.mjs'
import { tryOpLock } from '../off/lock.mjs'
import { loadCa, checkCa } from './core/tls/ca.mjs'
import { createLeafIssuer } from './core/tls/leaf.mjs'
import { bundleRoots } from './core/tls/roots.mjs'
import { createRecordStore } from './core/record/store.mjs'
import { createEngine } from './core/engine/engine.mjs'
import { appendEvent, createFailureRecorder } from './core/events.mjs'
import { EVENT, CODE, trustReasonText } from './core/codes.mjs'
import { procIdentity, captureHealth } from '../health/read.mjs'
import { driftCheck, newDriftState } from '../netenv/adopt.mjs'
import { createRetention, retentionFile } from '../capture/retention.mjs'
import { endpointClass } from '../capture/envelope.mjs'
import { makeClassifier, harnessIdOfAgent } from '../dissect/traffic.mjs'

export { loadArch } // the CLI reaches arch only through this file (layering rule 5)

// What install / uninstall need from arch and harness, without starting anything: the descriptors, the OS key,
// and the process table (`scan` reads /proc; it does not need the helper).
export async function loadParts({ arch = null, harnesses = null, env = process.env } = {}) {
  const A = arch || (await loadArch())
  const list = harnesses || (await loadHarnesses())
  // 4.8 §5.4 / 4.9 §5.4 osMatch: a platform whose process facts are not the /proc set needs the registry's second key. The darwin collector carries it in its bag and its LAZY
  // construction (4.9 §1 接线) makes building one here safe: with { env, harnesses } only, it is the shell — the descriptors' forms for osMatch, a watcher `scan` can use, no
  // ingress.json created, nothing started. Linux ignores the extra argument; the win32 collector's construction is the win line's own open seam (it wants the dir), so on win32
  // NO redirector is built here at all (arch/index.mjs's win32 arm says the same: loadParts makes no redirector on win32) and this parts view answers an empty process table —
  // the CLI's `on` plan and `status` read paths work without a collector dir; the daemon itself builds the real one with the dir. Measured on a Windows test machine: without
  // this, `asight on --yes` on Windows died at once with createWin32Collector's "needs the collector dir (~/.asight/collector)".
  const redirector = A.os === 'win32' ? null : await A.createRedirector({ env, harnesses: list }) // the await is the point: darwin's collector is async (4.9 §1), and without it `redirector` here is a Promise — osMatch dead-ends to null and `scan()` throws TypeError (review F1, reproduced on the real call before this line); Linux's and win32's sync returns pass through the await untouched
  const osMatch = redirector && typeof redirector.darwin === 'object' && redirector.darwin && redirector.darwin.osMatch ? redirector.darwin.osMatch : null
  const registry = createRegistry(list, { osMatch })
  // linger: whether the OS keeps this user's daemon after logout (true / false; null = not readable) — `asight on` says so (1.6 §1.1), it never enables it (R8)
  return { arch: A, os: A.os, harnesses: list, registry, scan: () => (redirector ? redirector.scan() : []), match: (f) => registry.match(f), linger: () => (redirector && typeof redirector.linger === 'function' ? redirector.linger() : null), lingerRead: () => (redirector && typeof redirector.lingerRead === 'function' ? redirector.lingerRead() : { state: null, error: 'this platform has no reader of the linger state' }) }
}

/** What `asight status` and `doctor` need to draw the network topology (1.6 §9.7): the harness descriptors and this platform's part of the facts. The CLI reaches arch and harness only through this file (layering rule 5);
 *  nothing here starts a redirector or reads the machine. */
export async function netFactsDeps({ arch = null, harnesses = null, platform = process.platform } = {}) {
  let A = arch
  if (!A) { try { A = await loadArch(platform) } catch { A = null } } // a platform with no collector has no part of its own
  return { harnesses: harnesses || (await loadHarnesses()), archFacts: A && A.netFacts ? A.netFacts : null }
}

export const collectorPaths = (dir = collectorHome(asightHome())) => ({ dir, caDir: path.join(dir, 'ca'), state: path.join(dir, 'state.json'), lock: path.join(dir, 'lock'), markers: path.join(dir, 'run', 'trust') })
const errText = (e) => String((e && e.message) || e)
const BUNDLE_BUSY_MS = 2000 // a bundle rebuild that found the op lock held (1.6 R12) is tried again after this long ...
const BUNDLE_BUSY_RETRIES = 30 // ... at most this many times; the daily round is the next chance after that
const OFF_HINT = 'capture is switched off for this harness (its desired state is off); it is not judged, not watched and not counted as untrusted'
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version } catch { return null } })() // null: said as unknown in daemon-start
// Every failure record carries a code (asight's name from src/health/codes.mjs, or the errno): the fold key (D-3).
const coded = (e, code) => Object.assign(new Error(errText(e)), { code: (e && e.code) || code })

// upstreamCa: test seam only (the CLI never passes it). Upstreams are verified against Node's default store, so a
// relay with a private CA is trusted through NODE_EXTRA_CA_CERTS in the daemon's own environment (gate G8).
// Every failure this daemon owns leaves a durable record with a reason in flows/ and shows in status (D38, user
// 2026-10-06): core/events.mjs createFailureRecorder (one line per place and error code per 10 s, the folded count
// written when the window closes or at stop).
// getuid / chown: test seams for the root refusal (D-31).
export async function startDaemon(opts = {}) {
  const dir = opts.dir || collectorHome(asightHome())
  const log = opts.log || (() => {})
  const getuid = opts.getuid || (() => (typeof process.getuid === 'function' ? process.getuid() : -1))
  try {
    // as root it would write root-owned 0600 files into the user's flows/ and captures, which the user's own daemon
    // then cannot append to (D36, D-31): refused before anything is written
    if (getuid() === 0) throw Object.assign(new Error('asight daemon: run it as the user whose agents you capture, not as root (D36)'), { code: 'root-refused' })
    return await runDaemon({ ...opts, dir, log })
  } catch (e) {
    // the refusal is recorded where status finds it — unless nothing is installed here (no directory to write into)
    if (fs.existsSync(dir)) {
      try {
        appendEvent(dir, { event: 'failure', where: 'start', code: (e && e.code) || 'start-failed', reason: errText(e) })
        if (getuid() === 0) ownedLikeDir(dir, opts.chown || fs.chownSync) // root: the record must not become a root-owned file
      } catch (w) { log('events', w) }
    }
    throw e
  }
}
function ownedLikeDir(dir, chown) {
  const { uid, gid } = fs.statSync(dir)
  const flows = path.join(dir, 'flows')
  chown(flows, uid, gid)
  for (const n of fs.readdirSync(flows)) chown(path.join(flows, n), uid, gid)
}

// What status reports beside the live state: capture health read from disk by the reader the board uses
// (src/health/read.mjs, D38) — failures by kind, current conditions, what could not be read (D-2: never "none").
// `dir` is <asight home>/collector.
export function healthOnDisk(dir) {
  try { return captureHealth({ home: path.dirname(dir) }) } catch (e) { return { error: `capture health could not be read: ${errText(e)}` } }
}

async function runDaemon({ dir, retentionPath = null, trafficRows = undefined, env = process.env, arch = null, harnesses = null, socketPath = null, enginePort = null, upstreamCa = undefined, log, identity = procIdentity, lockRefreshMs = 1000, foreground = false, caCheckMs = 24 * 3600e3, bundleMs = 24 * 3600e3, checkMs = 5000, foldMs = 10_000, home = null }) {
  const P = collectorPaths(dir)
  const netHome = home || env.HOME || os.homedir() // whose agents' settings the 5 s check looks at: the user the daemon runs as
  const failure = createFailureRecorder(P.dir, { log })
  let manifest
  try { manifest = readManifest(P.dir) } catch (e) { throw Object.assign(new Error(`the install manifest ${path.join(P.dir, 'install-manifest.json')} is unreadable (${errText(e)}); run "asight uninstall", then "asight on"`), { code: 'manifest-unreadable' }) }
  const ca = manifest && manifest.complete ? readCa({ dir: P.caDir }) : null
  if (!ca) throw Object.assign(new Error('the collector is not installed for this user: run "asight on" first'), { code: 'not-installed' })
  // The arch is loaded once, here at the entry (loadParts below takes it back): the platform's start gates and endpoint come before anything is claimed.
  // The endpoint is any arch that has one: darwin's control.json — a random name under the user's $TMPDIR, 0600, with a token every request carries
  // (arch/darwin/control-path.mjs, 4.9 §7; the same file the CLI's `off` reads; found live by a smoke run 2026-10-09: without this arm the darwin daemon
  // died on the Linux path's XDG_RUNTIME_DIR demand before it ever listened) — and win32's named pipe with the token of <collector>\control.json (4.8 §7).
  // The other platforms keep core/control.mjs's $XDG_RUNTIME_DIR/asight/collector.sock, whose file modes guard it (no token there).
  let A0 = arch
  if (!A0) { try { A0 = await loadArch() } catch { A0 = null } } // a platform with no collector has no part of its own (netFactsDeps' pattern)
  if (A0 && typeof A0.refuseElevated === 'function') { // win32 (4.8 §7, W25, R7): the daemon does not run on an elevated or SYSTEM token
    const r = await A0.refuseElevated({ env, onUnknown: (why) => log('daemon', new Error(why)) }) // a token that cannot be read is not a refusal (R11): said, and the start goes on
    if (r) throw Object.assign(new Error(r.reason), { code: r.code }) // startDaemon's catch writes the {where:'start', code:'elevated-token'} record; nothing was claimed
  }
  const ep = A0 && typeof A0.controlEndpoint === 'function' && !socketPath ? A0.controlEndpoint({ dir: P.dir }) : null
  const sock = socketPath || (ep ? ep.path : controlSocketPath({ env }))
  let markReady
  const ready = new Promise((r) => { markReady = r })
  const impl = {} // filled once wiring is done; requests that arrive earlier wait for it
  const gate = (name) => async (q) => {
    await ready
    try { return await impl[name](q) } catch (e) {
      if (!(e && e.status >= 400 && e.status < 500)) failure('control', coded(e, 'control-error'), { route: name }) // a 500 is a failure too; a 4xx is the caller's mistake
      throw e
    }
  }
  const control = await startControlServer({ socketPath: sock, ...(ep ? { token: ep.token } : {}), routes: { 'GET /status': gate('status'), 'POST /on': gate('on'), 'POST /off': gate('off') } }) // throws if another daemon answers

  let redirector = null
  try {
    // First the previous run (4.6 §事件与码): an unclean stop is the first line of this start; readers take this start's
    // lines from here on as this run's, up to and past daemon-start — the CA check below included.
    let stale = null
    let unreadable = false
    try { stale = JSON.parse(fs.readFileSync(P.lock, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') unreadable = true } // ENOENT: the last daemon stopped cleanly
    if (stale && stale.pid) failure('daemon', coded(new Error(`the previous daemon (pid ${stale.pid}) ended without a clean stop (crash, kill -9 or power loss); its helper and links went with it, and connections then in flight through its engine were cut (how many is not known)`), 'unclean-stop'))
    else if (unreadable) failure('daemon', coded(new Error('the previous daemon left an unreadable lock (crash or power loss): it ended without a clean stop, and connections then in flight through its engine were cut (how many is not known)'), 'unclean-stop'))
    // The CA is checked at start and once a day (D-4, 4.6 §身份与信任「CA」): both files readable, a pair, inside its
    // validity. Unusable → this daemon never hooks (agents go direct, zero errors) and says "CA unusable" — not
    // "not installed" — in flows/ (ca-invalid: which part, which file, the errno) and in status.
    const judgeCa = (c) => (c.error ? { ok: false, which: c.which, file: c.file, errno: c.code, reason: c.error } : { ...checkCa(c), file: c.paths.pem })
    let caState = { ...judgeCa(ca), checked_at: new Date().toISOString() }
    const caFailure = (st) => failure('ca', Object.assign(new Error(`the collector CA is unusable (${st.which}: ${st.reason}); nothing is steered, agent connections go direct`), { code: 'ca-invalid' }), { which: st.which, file: st.file, ...(st.errno ? { errno: st.errno } : {}) })
    if (!caState.ok) caFailure(caState)
    // The issuer and the trust check are built from the CA judged usable; the engine and the tracker reach them through
    // `issuer` / `trust` below, so a CA that becomes usable later (the key put back) is used from then on (D1-2).
    const unusable = (st) => ({ secureContextFor() { throw new Error(`the collector CA is unusable (${st.which})`) }, issue() { throw new Error('the collector CA is unusable') } })
    // with no usable CA certificate nothing can be confirmed to trust it: every agent is untrusted (and never hooked anyway)
    const trustFor = (c) => { try { return createTrustChecker({ caCertPem: c.certPem }) } catch { return { check: () => ({ trusted: false, reason: 'ca-unusable', var: null, via: null }) } } }
    let built = { issuer: caState.ok ? createLeafIssuer(loadCa(ca)) : unusable(caState), trust: trustFor(ca) }
    const issuer = { secureContextFor: (host) => built.issuer.secureContextFor(host), issue: (host) => built.issuer.issue(host) }
    const trust = { check: (...a) => built.trust.check(...a) }
    const caTimer = setInterval(() => {
      const c = readCa({ dir: P.caDir })
      const was = caState.ok
      caState = { ...judgeCa(c), checked_at: new Date().toISOString() }
      if (!caState.ok) { caFailure(caState); return }
      if (was) return
      // unusable → usable: rebuild from the CA just read, then say so — the condition clears and `on` may attach
      try { built = { issuer: createLeafIssuer(loadCa(c)), trust: trustFor(c) } } catch (e) {
        caState = { ok: false, which: 'pair', file: caState.file, reason: errText(e), checked_at: caState.checked_at }
        caFailure(caState); return
      }
      failure.write({ event: 'ca-ok', file: caState.file, reason: 'the collector CA is usable again: leaves are signed with it and agents are judged against it from now on' })
    }, caCheckMs)
    caTimer.unref()
    // D40 (4.6 §记录「保存级别」): which traffic class a call is and how much of it to keep. The settings file is read by the
    // engine at the start of every request (re-checked at most once a second, no restart) and a problem with it is a failure event
    // here (flows/, folded) — the call is kept in full meanwhile. The class patterns are the read-side harness table's data
    // (src/dissect), handed in as a function: the core names no harness (D20, 0.1 §5).
    const keep = createRetention({
      file: retentionPath || retentionFile(path.dirname(P.dir)),
      classify: makeClassifier({ endpointClass, rows: trafficRows, onInvalid: (b) => failure.event({ where: 'retention', code: 'pattern-invalid', reason: `a traffic pattern of ${b.harness} is skipped (${b.reason}): ${JSON.stringify(b.entry)}` }) }),
      onFailure: (rec) => failure.event(rec),
      onOk: (rec) => failure.write(rec),
    })
    const store = createRecordStore({ root: P.dir, onError: (e) => failure('record', coded(e, 'record-error'), e && e.file ? { file: e.file } : {}) })
    // switch / helper events: their own descriptor (events.mjs, a lost line becomes a log-gap), and every failure
    // among them carries `reason`
    let engine = null // created after the tracker; the tracker's onGone reaches it at call time
    const event = (e) => failure.write({ ...e, ...(e.error != null && e.reason == null ? { reason: String(e.error) } : {}) })

    let { registry, arch: A, harnesses: harnessList } = await loadParts({ arch: A0 ?? arch, harnesses, env })
    // 4.9 §1 wiring: the darwin collector needs the collector dir and this daemon's sinks, so it is built here with them (started below; the kernel itself
    // comes with the first attach, 4.8 §4.1) — `desired` reads state.json as it is NOW: the switch changes it while this daemon runs. The win32 collector needs
    // exactly the same shape (createWin32Collector({ env, dir, home, harnesses, failure, event, manifest, desired }) — wiring.mjs), so it joins this arm: with
    // only { env } it THREW "needs the collector dir" and the daemon crash-looped (on a Windows test machine: `asight daemon --supervise` exited 70 with that
    // TypeError — the comment below used to claim the construction lived elsewhere; it does not, this ternary is the only construction the daemon has).
    // Linux keeps the plain core redirector.
    redirector = A.os === 'darwin' || A.os === 'win32'
      ? await A.createRedirector({ env, dir, home: netHome, harnesses: harnessList, failure, event, manifest: () => readManifest(P.dir), desired: () => { const st = readState(P.state, () => {}, {}); return st.harnesses || {} } })
      : A.createRedirector({ env })
    const bag = redirector && ((typeof redirector.darwin === 'object' && redirector.darwin) || (typeof redirector.win32 === 'object' && redirector.win32) || null) // the arch bag (darwin's or win32's wiring): what only the daemon reaches
    // win32's registry second key (4.8 §5.4 osMatch): loadParts' parts view has NO redirector on win32, so the registry it returned was built without one
    // and matched NOTHING — every agent flow read `untracked` and was spliced, capture stayed empty (measured on a Windows test machine: the live claude's facts matched
    // {kind:'form', id:'claude-code.cli'} the moment the registry was handed the bag's osMatch). Darwin needs no rebuild: its loadParts shell carries osMatch.
    if (A.os === 'win32' && bag && bag.osMatch) registry = createRegistry(harnessList, { osMatch: bag.osMatch })
    // D38: one `agent-untrusted` per pid and reason (code = the resolver's reason, reason = what to do about it); a pid
    // recorded so gets `agent-trusted` once it is trusted and `agent-exit` when it exits, so the condition can clear.
    const recordedUntrusted = new Map() // pid → the reason code last recorded
    const note = (rec) => failure.write(rec)
    // the descriptor's own words for a reason, else the generic text (core/codes.mjs), else the code itself
    const hintFor = (agent, reason) => { const d = registry.get(agent); return (d && d.trust && d.trust.hints && d.trust.hints[reason]) || trustReasonText(reason) || reason }
    const transportNoted = new Map() // pid → the transports already written for it: one agent-transport line per (pid, transport)
    const onVerdict = (row, prev) => {
      for (const u of row.unreachable || []) { // 4.6 agent-transport: QUIC / AF_UNIX never reach the engine, so no connection row says so (review B-4(b))
        const done = transportNoted.get(row.pid) || transportNoted.set(row.pid, new Set()).get(row.pid)
        if (done.has(u.transport)) continue
        done.add(u.transport)
        note({ event: 'agent-transport', pid: row.pid, agent: row.agent, transport: u.transport, var: u.var, reason: u.reason })
      }
      if (row.watchError) failure('watch', coded(new Error(`watching ${row.agent} pid ${row.pid} failed: ${row.watchError}`), 'watch-failed'))
      if (row.configError) failure('harness', coded(new Error(`${row.agent} pid ${row.pid}: reading its configuration failed (${row.configError}); judged on its known hosts only`), 'config-error'))
      for (const r of row.readErrors || []) failure('harness', Object.assign(new Error(`${row.agent} pid ${row.pid}: ${r} exists but cannot be read; judged as if it were absent`), { code: CODE.configUnreadable }), { pid: row.pid, agent: row.agent })
      const broken = new Set((row.brokenLayers || []).map((l) => l.file)) // a Claude Code settings file has its own, fuller record below (D-9)
      for (const f of row.parseErrors || []) if (!broken.has(f)) failure('harness', Object.assign(new Error(`${row.agent} pid ${row.pid}: ${f} exists but does not parse; judged as if it were absent`), { code: CODE.configUnparsable }), { pid: row.pid, agent: row.agent })
      for (const l of row.brokenLayers || []) { // D-9: never read as "no settings" — the CA and the relay hosts in it are unknown
        failure('harness', coded(new Error(`${row.agent} pid ${row.pid}: ${l.file} ${l.code === 'settings-unparsable' ? 'does not parse' : 'cannot be read'} (${l.error}); that layer is not counted${row.trusted ? '' : ', so it is judged untrusted'} and a relay host set in it is not decrypted`), l.code), { pid: row.pid, file: l.file })
      }
      const last = recordedUntrusted.get(row.pid)
      if (row.trusted) { // agent-trusted when a pid becomes trusted (first verdict, or after untrusted): conditions it clears (D-24)
        recordedUntrusted.delete(row.pid)
        if (!(prev && prev.trusted)) note({ event: EVENT.agentTrusted, pid: row.pid, agent: row.agent, code: 'ok', reason: `trusted now (${row.trustVar} via ${row.trustVia})`, via: row.trustVia ?? null })
        return
      }
      if (last === row.reason || row.reason === 'marker-pending') return // once per pid and reason; a plugin has up to 10 s to report (4.6 「标记」)
      recordedUntrusted.set(row.pid, row.reason)
      note({ event: EVENT.agentUntrusted, pid: row.pid, agent: row.agent, code: row.reason, reason: hintFor(row.agent, row.reason), via: row.trustVia ?? null, ...(row.cause ? { cause: row.cause } : {}) })
    }
    // combined bundles follow the roots: rebuilt (atomically) at start and once a day when the roots changed, and a bundle that
    // went missing or unreadable is rebuilt at the same time (4.6 「合并包」, D38 F1(d)): one event per bundle that says which
    // harness, which file and why; a rebuild that fails leaves the old file, is a failure of its own (harness + file), and the
    // resolver already judges that harness untrusted while the bundle lacks the asight CA. A bundle rebuilt without a user CA
    // it held at install (its source file moved or went) is a failure of its own, one line per bundle that names the harness,
    // the file, the lost fingerprints and each unreadable source with its errno: an agent that replaces its roots with the
    // bundle can no longer reach a relay signed by that CA, and nothing else would say so (D38 ②, 4.6 「合并包」)
    // It works on the manifest as the disk has it NOW, not the one read at start: `asight off <harness>` runs while this daemon does, and a bundle it
    // removed (or kept without the asight CA) must not come back with the CA, nor the manifest it saved be written over by this one's copy. And only for
    // the harnesses whose desired state is `on` (4.6 「合并包」, D39): one `off` has taken out is not this daemon's to rebuild.
    // The read-modify-write of the manifest and the bundles is done under the op lock (1.6 R12): `on`, `off` and `uninstall` change the same files. A lock another
    // command holds means this round waits for it (it ends in seconds, and the roots are read again then); a rebuild after the command is done sees what it left.
    let bundleRetry = null, bundleBusy = 0
    const refreshBundles = async () => { // async: the arch's OS roots are read (bundleRoots below)
      clearTimeout(bundleRetry)
      const report = { rebuilt: [], failed: [], lost: [] }
      let held = null
      try {
        held = tryOpLock({ file: path.join(P.dir, 'op.lock') })
        if (!held.lock) {
          if (bundleBusy++ < BUNDLE_BUSY_RETRIES) { bundleRetry = setTimeout(refreshBundles, BUNDLE_BUSY_MS); bundleRetry.unref() }
          return
        }
        bundleBusy = 0
        const fresh = readManifest(P.dir)
        if (fresh && !fresh.unsupported) {
          const installedIds = [...new Set([...(fresh.entries || []), ...(fresh.files || [])].map((x) => x.harness).filter(Boolean))]
          const st = readState(P.state, () => {}, { installed: installedIds }) // a state file that cannot be read reads as every harness off, and the switch records that (switch.mjs): nothing to rebuild then
          const on = new Set(Object.entries(st.harnesses).filter(([, h]) => h.desired === 'on').map(([id]) => id))
          // The roots, through the one resolver the install's plan asks too (tls/roots.mjs bundleRoots: the arch's osRoots, 4.6 「合并包」). Without the OS roots the
          // combined bundles carry no enterprise root and a replace-semantics entry (Codex's SSL_CERT_FILE) silently cuts the agent off its relay. A read that fails
          // entirely reaches the catch below: the bundles keep their previous roots and the failure is said (D38). An answer with no OS root in it (`missing`: no OS
          // bundle on this machine holds a certificate) is used — Node's roots are all there is — and said.
          const got = await bundleRoots(A)
          rewriteBundles({ dir: P.dir, manifest: fresh, nodeRoots: got.node, osRootsText: got.osText, caPem: ca.certPem, report, only: on })
          const bare = got.missing ? fresh.files.filter((f) => f.role === 'bundle' && on.has(f.harness) && !f.without_ca).map((f) => f.path) : []
          if (bare.length) failure.event({ where: 'bundle', code: CODE.systemRootsUnavailable, files: bare, reason: `the combined bundles ${bare.join(', ')} carry Node's roots only: ${got.missing}; a CA installed system-wide (a corporate proxy's) is not in them, and an agent whose entry points at one may not reach a relay that signs with it` })
        }
      } catch (e) { failure('bundle', Object.assign(new Error(`rebuilding the combined bundles failed: ${errText(e)}; they keep their previous roots`), { code: e && e.code })) } finally { if (held && held.lock) held.lock.release() }
      const changed = report.rebuilt.filter((r) => r.why === 'roots-changed').map((r) => r.path)
      if (changed.length) note({ event: 'bundles-rebuilt', code: 'roots-changed', reason: `the trusted roots changed; rebuilt ${changed.join(', ')}` })
      for (const r of report.rebuilt.filter((x) => x.why !== 'roots-changed')) {
        note({ event: 'bundles-rebuilt', code: 'missing', harness: r.harness, file: r.path, errno: r.why, reason: `${r.path} (the combined bundle of ${r.harness}) was ${r.why === 'ENOENT' ? 'missing' : `unreadable (${r.why})`}; rebuilt` })
      }
      for (const l of report.lost) { // written whole, not folded by (where, code): each bundle's loss is its own record
        const n = l.fps.length
        failure.write({ event: 'failure', where: 'bundle', code: l.sources.length ? 'source-unreadable' : 'cert-not-merged', harness: l.harness, file: l.path, errno: l.sources.length ? l.sources[0].errno : null, lost_fps: l.fps, sources: l.sources,
          reason: `${l.path} (the combined bundle of ${l.harness}) was rebuilt without ${n} user CA${n === 1 ? '' : 's'} it held at install (${l.fps.join(', ')}): ${l.sources.length ? l.sources.map((s) => `${s.file} could not be read (${s.errno})`).join('; ') : 'the files it was built from no longer hold them'}; ${l.harness} may not reach a relay that signs with ${n === 1 ? 'it' : 'them'}` })
      }
      for (const r of report.failed) {
        failure('bundle', Object.assign(new Error(`rebuilding ${r.path} (the combined bundle of ${r.harness}) failed: ${errText(r.error)}; it keeps its previous content, and ${r.harness} may not trust asight until it is rebuilt`), { code: r.error && r.error.code }), { harness: r.harness, file: r.path })
      }
    }
    refreshBundles()
    const bundleTimer = setInterval(refreshBundles, bundleMs); bundleTimer.unref()
    // plugins (dsh, OpenCode) write their per-pid marker here; it exists while the daemon runs (0700, the operator's)
    fs.mkdirSync(P.markers, { recursive: true, mode: 0o700 })
    const tracker = createTracker({ redirector, registry, trust, onVerdict, markerDir: P.markers, caPem: ca.paths.pem, collectorDir: P.dir,
      osLayers: bag ? bag.osLayers : null, // the arch bag (4.9 §1 / 4.8 §1): a harness's own per-OS layers, judged by them (4.8 §5.4's shape; win32's bag carries the same key, wiring.mjs)
      markerToleranceMs: bag && bag.markerToleranceMs || 0, // the bag again (review F4): the plugin writes performance.timeOrigin (sub-millisecond) against ps's second-granular lstart — without the fixed tolerance every dsh/opencode marker reads stale and is never decrypted; 0 stays the Linux byte-exact rule
      installedAt: (l) => installedAt(manifest, l), // config-after-start is judged against when asight wrote the value
      onGone: (row, via) => { // D-24, D-12: the agent and every condition it held are gone; so are its negative-cache entries
        const last = recordedUntrusted.get(row.pid); recordedUntrusted.delete(row.pid) // the reason it was recorded untrusted for ends here
        transportNoted.delete(row.pid)
        failure.write({ event: EVENT.agentExit, pid: row.pid, agent: row.agent, via, ...(last != null ? { code: last, reason: 'exited while untrusted' } : {}) })
        const dropped = engine ? engine.forgetPid(row.pid) : 0
        if (dropped) failure.write({ event: 'negative-cache-cleared', pid: row.pid, neg_key: String(row.pid), dropped }) // neg_key: the entries' key, "<pid>" here (4.8 §5.5)
      },
      onOff: (row) => { // the harness was turned off while this agent ran: what was recorded about it ends (an untrusted pid is not "running untrusted" once it is not a capture target)
        const last = recordedUntrusted.get(row.pid); recordedUntrusted.delete(row.pid)
        if (last != null) failure.write({ event: EVENT.agentExit, pid: row.pid, agent: row.agent, via: 'off', code: last, reason: 'the harness was turned off while it was untrusted' })
        const dropped = engine ? engine.forgetPid(row.pid) : 0
        if (dropped) failure.write({ event: 'negative-cache-cleared', pid: row.pid, neg_key: String(row.pid), dropped })
      },
      onUnmatched: (a) => failure('tracker', coded(new Error(`pid ${a.pid} (${a.exe}) matches ${a.candidates.join(' and ')}: claimed by two harness descriptors, so it is judged as neither and never watched; its connections go direct`), 'ambiguous'), { pid: a.pid, candidates: a.candidates }),
      onError: (e, at) => failure('tracker', Object.assign(new Error(`pid ${at.pid} (${at.phase}): ${errText(e)}${at.phase === 'judge' ? '; it is not watched, its connections go direct' : ''}`), { code: (e && e.code) || (at.phase === 'judge' ? 'judge-error' : 'unwatch-error') }), at) })
    let helperDown = null
    let sw = null

    // the arch bag (the wiring's, `bag` above): the proxy ingress's port and its token are the engine's own listen arguments on darwin AND win32 — both are proxy mode only, the engine's one door is the ingress (4.8 §5.1, carried by 4.9 §5; win32's bag carries the same ingress() over ingress.json's enginePort, wiring.mjs)
    const macIng = bag && typeof bag.ingress === 'function' ? bag.ingress() : null
    engine = createEngine({
      redirector: {
        // the transparent `lookup` exists only when the redirector has one (Linux): without it the engine gets no transparent listener (core/redirector.mjs) — darwin is proxy mode only (4.9 §5), its door is the ingress below
        ...(typeof redirector.lookup === 'function' ? {
          async lookup(peer) { // the kernel knows {dst, pid, decrypt}; the tracker adds what the envelope's proc carries
            const m = await redirector.lookup(peer)
            const x = m && m.pid != null ? tracker.metaFor(m.pid) : null
            return m && x ? { ...m, ...x, agent: m.agent ?? x.agent } : m
          },
        } : {}),
        // the proxy ingress's own answer (4.8 §5.1): win32's kernel CONNECT arrives with of.<form> as the user, darwin's door lookup with the group id (D47) — the redirector's lookupIngress resolves it (a flow's meta, a health probe, or null = refused)
        ...(typeof redirector.lookupIngress === 'function' ? { lookupIngress: (q) => redirector.lookupIngress(q) } : {}),
      },
      // FlowExtras (plan 3c §2): the harness's WebSocket terminators and this process's own proxies. A throw: the
      // connection goes on without them, the engine records it, and flows/ gets it under its code (4.6 §记录)
      describe: (meta) => {
        try { return tracker.extrasFor(meta && meta.pid) } catch (e) {
          throw Object.assign(new Error(`describing pid ${meta && meta.pid} (${meta && meta.agent}) for ${meta && meta.dst ? `${meta.dst.address}:${meta.dst.port}` : '?'} failed: ${errText(e)}; the connection goes on without WebSocket terminators or proxies`), { code: CODE.describeError, fields: { pid: meta ? meta.pid ?? null : null, agent: meta ? meta.agent ?? null : null, dst: meta ? meta.dst ?? null : null } })
        }
      },
      issuer, store, upstreamCa,
      ...(macIng ? { ingressToken: macIng.ingressToken } : {}), // win32: the kernel's CONNECT authenticates to the ingress with of.<form>:this token (4.8 §3); darwin: the doors' own token is each group's listener token, this one the ingress's (D47); listen({ingress}) refuses without it
      policy: (meta, host) => tracker.policy(meta, host),
      isRecording: (meta) => sw.isRecording(meta && meta.agent), // sampled per request, per harness (4.6 §开关): a request after off is never recorded
      retention: (meta, host, method, path) => keep.decide({ harness: harnessIdOfAgent(meta && meta.agent), host, method, endpoint: path }), // sampled with it (D40)
      onFailure: (rec) => failure.event(rec), // the engine's and the WebSocket recorder's failures: flows/, folded
      onError: (e) => log('engine', e), // stderr only: every one of them is also a record through onFailure
    })
    // The engine's doors (4.8 §5.1): Linux listens transparently on the port the install recorded; darwin has no transparent listener at all — its one door is the proxy ingress on
    // ingress.json's enginePort, the port the kernel's config names (a transparent listener bound on that port made every kernel CONNECT a lookup-miss — the CONNECT carries a destination,
    // not an original one to look up — and every form read back 'fallback'; found live by the lab smoke, 2026-10-09). `port` is whichever door this platform has: darwin's engine port IS the ingress's.
    const want = enginePort ?? manifest.engine_port ?? 0
    const first = await engine.listen({ port: want, hosts: ['127.0.0.1'], ...(macIng ? { ingress: { port: macIng.enginePort } } : {}) }).catch((e) => {
      // G3: the port is squatted (Linux: chosen at install; darwin: ingress.json's, chosen at daemon start). Nothing is steered
      // (the helper is not spawned yet), so the agents' connections stay direct; say so, and how to get a new port.
      if (e.code === 'EADDRINUSE') throw Object.assign(new Error(macIng
        ? `the engine's proxy ingress port 127.0.0.1:${macIng.enginePort} (ingress.json) is held by another process; nothing is steered, agent connections go direct. Free the port and start the daemon again`
        : `the engine port 127.0.0.1:${want} recorded at install is held by another process; nothing is steered, agent connections go direct. Free the port, or run "asight uninstall" and "asight on" to pick a new one`), { code: 'EADDRINUSE' })
      throw e
    })
    const port = macIng ? first.ingressPort ?? null : first.port
    // D47 (4.9 §3): the darwin engine's own per-group doors — the daemon binds the wiring's slot to the engine the moment both exist, so
    // the redirector's attach()/detach() can open and close the doors the plan (or the carried set) asks for. `open` is listen({groups})
    // (idempotent per group id), `close` is closeGroups (stop accepting; in-flight connections drain).
    if (bag && typeof bag.bindDoors === 'function') {
      bag.bindDoors({
        open: (list) => engine.listen({ groups: list }),
        close: (ids) => Promise.resolve(engine.closeGroups(ids)),
      })
    }
    let v6Held = null // the helper steers IPv6 agent connections to [::1]:port: never attach while someone else holds it (M8; darwin has no helper — its agents point at 127.0.0.1 by the entry)
    let v6Error = null // any [::1] failure: status never reports [::1] as listening then (D-10)
    try { await engine.listen({ port: first.port, hosts: ['::1'], ...(first.ingressPort ? { ingress: { port: first.ingressPort } } : {}) }) } catch (e) {
      v6Error = `[::1]:${port}: ${errText(e)}`
      if (!macIng && e.code === 'EADDRINUSE') v6Held = `[::1]:${port} is held by another process`
      failure('engine', Object.assign(new Error(`[::1]:${port} unavailable: ${errText(e)}; ${v6Held ? 'on will refuse to attach (M8)' : 'IPv6 agent connections go direct'}`), { code: e.code }))
    }
    async function ensureReady() {
      syncTracker() // which harnesses are on, and their policy, before the live processes are judged
      if (!caState.ok) throw new Error(`the collector CA is unusable (${caState.which}: ${caState.reason}); not attaching, agent connections go direct`)
      if (helperDown) throw new Error(`the redirector helper is down (${helperDown}); restart the collector`)
      if (v6Held) throw new Error(`${v6Held}; refusing to attach so no IPv6 connection is steered to it (M8)`)
      const { proto } = redirector.helperInfo()
      if (proto !== redirector.expectedProto) throw new Error(`helper speaks protocol ${proto}, this daemon expects ${redirector.expectedProto}; run "sudo asight setup-helper" (G2)`)
      await tracker.rescan() // every `on` re-judges live processes (G18)
    }
    redirector.on('down', ({ reason, exit, stderr }) => { helperDown = reason; sw.markDown(reason); event({ event: 'helper-down', reason, ...(exit ? { exit } : {}), ...(stderr ? { stderr } : {}) }) }) // exit name + its last stderr lines (D-14)
    redirector.on('version-mismatch', (m) => event({ event: 'helper-version-mismatch', ...m, reason: `the helper speaks protocol ${m.got}, this daemon expects ${m.expected}; run "sudo asight setup-helper"` }))
    redirector.on('helper-error', ({ reason, code }) => failure('helper', coded(Object.assign(new Error(reason), { code }), 'helper-error')))
    redirector.on('heartbeat-error', ({ reason, code }) => failure('heartbeat', coded(Object.assign(new Error(`${reason}; once the last beat is 2 s old the kernel stops steering (connections go direct)`), { code }), 'heartbeat-failed')))
    redirector.on('flow-meta', ({ pid, dst }) => { // a watched but untrusted agent's connection went direct (D31: metadata only)
      const r = tracker.describe(pid)
      store.flow({ ts: new Date().toISOString(), flow_id: null, pid, agent: r ? r.agent : null, ...(r && r.ppid != null ? { parent_pid: r.ppid } : {}), ...(r && r.parentAgent ? { parent_agent: r.parentAgent } : {}), dst, decision: 'direct', not_captured: r ? 'untrusted' : 'untracked', reason: r ? `untrusted: ${r.reason}` : 'untracked' }) // D-11
    })
    // D-30, 4.6 exe-unreadable (review B-1): a process whose exe cannot be read is a failure only when its readable command
    // line could be an agent's (a descriptor's argv conditions fit it); the rest — sshd's session processes, (sd-pam), anything
    // not dumpable — is normal on every machine and is counted in status as `unjudged`, never ⚠
    redirector.on('facts-error', ({ os: fos, pid, code, comm, argv, reason }) => {
      const candidates = registry.couldMatch({ os: fos || A.os, exe: null, env: null, argv: argv || [], comm })
      if (candidates.length) failure('tracker', Object.assign(new Error(`${reason}; its command line fits ${candidates.join(' and ')}`), { code: 'exe-unreadable' }), { pid, errno: code || null, candidates })
    })

    // the harnesses `on` with no names means, and a version 1 state.json is carried to (1.6 §1.5, V28): the installed ones — those the install
    // manifest names, because asight wrote an entry or a file for them. One it never installed is no capture target: not judged, no agent-untrusted
    const installed = () => [...new Set([...(manifest.entries || []), ...(manifest.files || [])].map((e) => e.harness).filter(Boolean))]
    // a manifest the CLI wrote since (and that this build reads, and that is complete) replaces the one read at start; one that cannot be read leaves the old one, and says so
    const reloadManifest = () => {
      try { const fresh = readManifest(P.dir); if (fresh && !fresh.unsupported && fresh.complete) manifest = fresh } catch (e) { failure('daemon', coded(e, 'manifest-unreadable')) }
    }
    // desired state → the tracker: which harnesses are enabled, and each one's decrypt policy
    const syncTracker = () => { const st = sw.state(); tracker.setEnabled(sw.enabled()); tracker.setPolicy({ byHarness: Object.fromEntries(Object.entries(st.harnesses).map(([id, h]) => [id, { mode: h.policy, extraHosts: h.extra_hosts }])) }) }
    // bring the kernel watch table to the enabled set. With the helper dead there is no table to bring: its links and watch table died with it,
    // so nothing is asked of it (no unwatch failure to record) and every pid counts as taken out
    const reconcileTable = () => { syncTracker(); return tracker.reconcile({ kernelGone: !!helperDown }) }
    // the switch calls this when harnesses go off, before the links come off: their processes leave the kernel watch table first
    sw = createSwitch({ redirector, stateFile: P.state, installed, ensureReady, onEvent: event, reconcile: reconcileTable })
    // the file may only take capture away (switch.mjs). A harness the file turned off is off like one the route turned off: its connections still relayed
    // are closed where the engine sees a boundary (1.6 §1.3) — the CLI writes the file before it asks the route, and a daemon whose route nobody reached
    // would otherwise keep them for good
    const reload = async () => { const r = await sw.reloadIfChanged(); if (r.changed) syncTracker(); if (r.turnedOff.length) engine.drain({ agents: new Set(r.turnedOff) }); return r }
    // An unwatch the helper did not answer leaves a pid the kernel may still steer although its harness is off. It is asked again here — before every
    // beat and at the 5 s check — until it is answered; true = the table is clean.
    const settle = async () => { if (tracker.stuckPids().length) await reconcileTable(); return tracker.stuckPids().length === 0 }
    // before EVERY heartbeat (4.6 §开关语义): re-read state.json and bring the watch table to it; the beat goes out only while some harness is on AND no
    // unwatch is unanswered (no beat: the steering lapses and agents go direct, fail open). A loop that was stalled past the kernel's window therefore
    // resumes only after what the operator turned off in the meantime is off. A reload that just took something away has run the reconcile itself.
    redirector.setBeatGate(async () => { const r = await reload(); const clean = r.turnedOff.length ? tracker.stuckPids().length === 0 : await settle(); return clean && sw.anyOn() })
    await redirector.start()
    await redirector.configure(port)
    // the lock (4.6 §控制面, D-25): pid + start time + boot id, so a reused pid or a reboot is never "running"; its
    // mtime is refreshed every second, so a stuck daemon shows as unresponsive within 5 s — read from disk alone
    const me = identity(process.pid)
    fs.writeFileSync(`${P.lock}.tmp-${process.pid}`, JSON.stringify({ pid: process.pid, start_time: me.start_time, boot_id: me.boot_id, helper_pid: redirector.helperInfo().pid, engine_port: port, socket: sock }) + '\n', { mode: 0o600 })
    fs.renameSync(`${P.lock}.tmp-${process.pid}`, P.lock)
    const lockTimer = setInterval(() => { try { const t = new Date(); fs.utimesSync(P.lock, t, t) } catch (e) { failure('daemon', coded(new Error(`the lock ${P.lock} could not be refreshed (${errText(e)}); readers will judge this daemon unresponsive`), e && e.code ? e.code : 'record-error')) } }, lockRefreshMs)
    lockTimer.unref()
    // lifecycle (D-24): readers fold conditions from the last daemon-start; upstream_ca = the daemon's own
    // NODE_EXTRA_CA_CERTS (W-4: relays with a private CA rely on it), linger = whether logout ends this daemon
    failure.write({ event: 'daemon-start', pid: process.pid, start_time: me.start_time, boot_id: me.boot_id, version: VERSION, foreground: !!foreground,
      upstream_ca: env.NODE_EXTRA_CA_CERTS || null, linger: typeof redirector.linger === 'function' ? redirector.linger() : null })
    syncTracker() // before the first rescan: a harness that is off at start is never judged
    tracker.start()
    await tracker.rescan()
    await sw.restore()

    // The 5 s check (D-26, 4.6 §开关语义): nobody has to run status for these to reach flows/ —
    //   desired vs the kernel's actual state: state-mismatch once per disagreement, a switch event when it clears
    //   (a dead helper is already helper-down; an on / off in flight is skipped);
    //   the kernel's drop counters (protocol 2): kernel-drops with the increments since the last such line, at most
    //   one line per foldMs, the rest written at stop;
    //   the file each trusted agent trusts through: changed → judged again (only ever takes trust away).
    let mismatch = null
    let dropsBase = {}
    let dropsAt = -Infinity
    let lastDrops = null
    const dropsSince = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v >= (dropsBase[k] || 0) ? v - (dropsBase[k] || 0) : v]).filter(([, n]) => n > 0))
    function noteDrops({ force = false } = {}) {
      if (!lastDrops) return
      const counts = dropsSince(lastDrops)
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      if (!total || (!force && Date.now() - dropsAt < foldMs)) return
      failure.write({ event: 'failure', where: 'kernel', code: 'kernel-drops', counts,
        reason: `the kernel let ${total} connection(s) or event(s) go uncaptured since the last report (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')}); those connections went direct` })
      dropsBase = { ...lastDrops }; dropsAt = Date.now()
    }
    const drift = newDriftState()
    const entrySeen = { seen: new Set() } // the entry check's once-per-occurrence memory (driftCheck's state.seen shape): in memory, so a daemon restart says a still-broken entry again once
    async function check() {
      if (sw.busy()) return
      const reloaded = await reload() // without a heartbeat running (nothing attached) this is what notices that the file turned something off
      if (sw.busy()) return
      if (!reloaded.turnedOff.length) await settle() // ... and what asks again for an unwatch that was not answered, when no beat gate does
      if (sw.busy()) return
      const r = await sw.report()
      if (sw.busy()) return // an on / off began while the kernel was read
      if (r.actual === 'unknown') failure('switch', coded(new Error(`the kernel state could not be read (${r.error}); desired is ${r.desired}`), r.error_code || 'helper-error'))
      else if (!r.degraded && r.actual !== r.desired) {
        if (!mismatch || mismatch.desired !== r.desired || mismatch.actual !== r.actual) {
          mismatch = { desired: r.desired, actual: r.actual }
          failure.write({ event: 'failure', where: 'switch', code: 'state-mismatch', desired: r.desired, actual: r.actual, links: r.links.map((l) => l.name),
            reason: r.desired === 'on' ? 'capture is on but the kernel has not got this instance\'s links: nothing is steered, agent connections go direct; run "asight on" again' : 'capture is off but the kernel still has this instance\'s links' })
        }
      } else if (!r.degraded && mismatch) {
        mismatch = null
        failure.write({ event: 'switch', desired: r.desired, actual: r.actual, reason: 'the kernel state matches the desired state again' })
      }
      if (r.drops && typeof r.drops === 'object') { lastDrops = r.drops; noteDrops() }
      await tracker.recheck()
      // 4.9 §6.4's wiring arm, second half (found live on a test machine): the plan a proxy-mode collector runs is a function of the MANIFEST too —
      // an opt-in's ledger entry names a group — and nothing else re-computes it for a harness that is already on: the switch's `on` answers noop (no attach),
      // so a launcher applied to a live install pointed at a port no listener was on until the next system-proxy move. The 5 s check re-plans, and when the
      // plan MOVED it brings the kernel to it — the netenv watcher's own move rule (replan reloads nothing when nothing moved). Darwin's bag carries `replan`;
      // the win32 twin of this arm is the win line's follow-up (4.9 §6.4's note), so it is scoped to darwin here.
      if (A.os === 'darwin' && bag && typeof bag.replan === 'function') { try { await bag.replan({ reload: true }) } catch (e) { failure('netenv', e) } }
      // §9.5: the files each harness reads its proxy from, against what `on` found: a change is one `netenv-change` (and one failure when it leaves a harness that is on uncaptured). Read-only: only the operator's
      // `on` writes an agent's setting (D30). No VPN / proxy software is read here or anywhere (D49): `status` and `doctor` compare the same files live.
      driftCheck({ home: netHome, env, harnesses: harnessList, desired: (h) => (sw.state().harnesses[h] || {}).desired ?? null, appendEvent: (rec) => failure.write(rec), state: drift })
      // 4.8 §2.4「入口还有没有效」+ W68, the daemon's half of the same check: nobody has to run `status` for a displaced shim or an agent started around
      // the entry to reach flows/ (the 5 s check's own rule). The same check status folds into its rows, through the same arch hook — the manifest as the
      // disk has it NOW (an `off` that ran under this daemon undid entries; the copy read at start is stale), and the process table this collector itself
      // lists (parents included: the check's agents half matches them to the forms itself). Only a manifest that holds opt-in entries pays for the scan — a
      // machine that never named one checks nothing; `record` keeps a finding once per occurrence (driftCheck's state shape) and writes only §9.7's netenv
      // failure codes (shim-not-on-path, not-via-entry) — an entry-changed or could-not-tell finding reaches status / doctor's rows alone, not the event
      // log. A platform with no opt-in half (Linux) checks nothing, and a manifest that cannot be read leaves nothing in effect to check (the daemon's own
      // reload paths say why when they need the manifest). A thrown check lands in the timer's own catch, like every other step of check().
      const optHook = A.optIn
      if (optHook && typeof optHook.check === 'function' && typeof optHook.record === 'function') {
        let m = null
        try { m = readManifest(P.dir) } catch { /* no entries can be known: nothing is in effect to check */ }
        if (m && Array.isArray(m.entries) && m.entries.some((e) => e && typeof e.kind === 'string' && e.kind.startsWith('optin-'))) {
          optHook.record({ findings: await optHook.check({ harnesses: harnessList, manifest: m, procs: await redirector.scan() }), state: entrySeen, appendEvent: (rec) => failure.write(rec) })
        }
      }
    }
    const checkTimer = setInterval(() => { check().catch((e) => failure('daemon', coded(e, 'check-error'))) }, checkMs)
    checkTimer.unref()

    async function status() {
      // every running-but-untrusted agent says why and what to do (4.6 §确认信任, R4); hosts it never decrypts say why too
      const agents = await Promise.all(tracker.agents().map(async (r) => {
        // a harness that is off: not judged, not watched, not counted as untrusted (1.6 §1.5)
        if (r.off) return { pid: r.pid, agent: r.agent, exe: r.exe, trusted: false, off: true, reason: 'off', hint: OFF_HINT, trust_var: null, trust_via: null, decrypt: false, hosts: [], not_via_trust_path: [], unreachable: [], parent_pid: r.ppid ?? null, parent_agent: r.parentAgent ?? null, source: r.source }
        const d = await redirector.directCount(r.pid) // {count, error}, or a Promise of it (Windows reads its connection table through the helper): unknown is said, never 0 (D-17)
        return { pid: r.pid, agent: r.agent, exe: r.exe, trusted: r.trusted, reason: r.reason, ...(r.trusted ? {} : { hint: hintFor(r.agent, r.reason) }), trust_var: r.trustVar, trust_via: r.trustVia, decrypt: r.decrypt, hosts: r.hosts, not_via_trust_path: r.bypass, unreachable: r.unreachable ?? [], parent_pid: r.ppid ?? null, parent_agent: r.parentAgent ?? null, source: r.source, direct: d.count, ...(d.error ? { direct_error: d.error } : {}) }
      }))
      const { pid, proto, build, unparsable = 0, timeouts = 0 } = redirector.helperInfo()
      // processes of this user whose exe cannot be read and whose command line fits no harness: seen, not judged (4.6 exe-unreadable)
      const unjudged = (typeof redirector.unreadable === 'function' ? redirector.unreadable() : []).filter((u) => !registry.couldMatch({ os: A.os, exe: null, env: null, argv: u.argv, comm: u.comm }).length)
      return {
        ...(await sw.report()),
        engine: { port, v6: v6Error ? null : port, v6_error: v6Error, ...engine.stats() },
        negatives: engine.negatives(), // (pid, host) pairs no longer decrypted until the process exits (D-12)
        // connections of the harnesses that are off and still relayed (1.6 §1.3): closing = on their way out at the response / turn
        // end, waiting = a spliced one or a WebSocket whose turn end is not seen, which close by themselves (`off --now` cuts them)
        relayed: engine.relayed({ agents: new Set(Object.entries(sw.state().harnesses).filter(([, h]) => h.desired === 'off').map(([id]) => id)) }),
        ca: caState, // {ok, not_after} or {ok:false, which, file, reason}: "CA unusable", never "not installed" (D-4)
        unmatched: tracker.unmatched(), // processes two descriptors claim (D-19)
        helper: { pid, proto, build, expected_proto: redirector.expectedProto, ok: proto === redirector.expectedProto, down: helperDown, unparsable_lines: unparsable, timeouts },
        agents, running_untrusted: agents.filter((a) => !a.trusted && !a.off).length,
        unjudged: { count: unjudged.length, sample: unjudged.slice(0, 10).map((u) => ({ pid: u.pid, comm: u.comm, errno: u.errno })) },
        // the host sets the plan last applied per host-tree form (4.8 §3, W69): the reply is where `status`'s facts reach them (the wiring's win32 bag keeps them);
        // `status` compares them with a fresh read and says when the kernel's set is old — read-only, a platform without the bag (Linux) simply says nothing here
        ...(redirector.win32 && typeof redirector.win32.appliedHosts === 'function' ? { applied_hosts: redirector.win32.appliedHosts() } : {}),
        health: healthOnDisk(P.dir),
        events: failure.health(), // event lines lost (D-1): stderr had each, the next written line is a log-gap
      }
    }
    // The names a request carries (1.6 §1.5): absent / null = every harness; otherwise a non-empty array of strings, each a harness this daemon has
    // a descriptor for (an `off` may also name one the state file holds). Anything else is a 400 that names the problem and changes nothing: a
    // string would otherwise spread into one name per character, a typo would be written to state.json as a harness that is on, and an empty
    // array would read as "all".
    const namesOf = (body, { allowState = false } = {}) => {
      const h = body && typeof body === 'object' ? body.harnesses : undefined
      if (h == null) return null
      if (!Array.isArray(h) || h.length === 0 || h.some((x) => typeof x !== 'string' || !x)) throw Object.assign(new Error('"harnesses" must be a non-empty array of harness names (leave it out for all of them)'), { status: 400 })
      const known = new Set([...registry.names(), ...installed(), ...(allowState ? Object.keys(sw.state().harnesses) : [])])
      const unknown = h.filter((x) => !known.has(x))
      if (unknown.length) throw Object.assign(new Error(`unknown harness: ${unknown.join(', ')} (known: ${[...known].sort().join(', ')})`), { status: 400 })
      return h
    }
    let exitAsked = 0 // the pending `off {exit}` requests (see exitWhenDrained); /on cancels them
    Object.assign(impl, {
      status,
      // capture on again cancels a pending `off {exit}` (exitWhenDrained): the daemon that was going away is the one now serving it
      // The manifest is read again first (1.6 §1.1, R9): `asight on` writes the entries, and their `installed_at`, before it asks, so a harness turned on
      // again after `off` is judged against when asight wrote the entry NOW — a process that started while it was off is config-after-start, and says so
      on: async ({ body }) => { reloadManifest(); const r = await sw.on({ ...(body && typeof body === 'object' ? body : {}), harnesses: namesOf(body) }); exitAsked++; syncTracker(); return { ...(await status()), ...(r.noop ? { noop: true } : {}) } },
      // → {…status, unwatched: [pid], confirmed, relayed: {closing, waiting, cut}, pid}: the pids taken out of the kernel watch table, and whether the kernel
      // confirms the state asked for (every unwatch answered; with no harness left on, the links gone). With the helper dead its table is gone with it: every pid
      // counts as taken out and `confirmed` does not wait on an unwatch nobody can answer. After the switch the engine closes the connections of those harnesses
      // that are still relayed (1.6 §1.3; `now`: cuts them instead) and `relayed` says how many are left closing / waiting / were cut. `exit` (no names: the
      // whole daemon is going, 1.6 §1.4 5) stops the daemon once nothing is relayed any more, or at once with `now`; the request never waits for it.
      off: async ({ body }) => {
        const b = body && typeof body === 'object' ? body : {}
        for (const k of ['now', 'exit']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw Object.assign(new Error(`"${k}" must be true or false`), { status: 400 })
        const names = namesOf(body, { allowState: true })
        if (b.exit === true && names) throw Object.assign(new Error('"exit" stops the whole daemon: it takes no harness names (leave them out)'), { status: 400 })
        const r = await sw.off({ harnesses: names })
        const relayed = engine.drain({ agents: names ? new Set(names) : null, now: b.now === true })
        const st = await status()
        if (b.exit === true) exitWhenDrained(b.now === true)
        return { ...st, ...(r.noop ? { noop: true } : {}), unwatched: r.unwatched, confirmed: r.unwatch_failed.length === 0 && (sw.anyOn() || st.actual === 'off'), relayed, pid: process.pid }
      },
    })
    markReady()

    // stop({signal}) — signal: what stopped it (SIGTERM, SIGINT, SIGHUP = the terminal closed or the user logged out,
    // SIGQUIT), else `reason`. Returns {failed: [where…]}: a step that failed makes `collector start` exit non-zero. It
    // runs once: a second call (a signal while the daemon is stopping itself after `off`) gets the first one's result.
    let stopping = null
    let markExited
    const exited = new Promise((r) => { markExited = r }) // resolves with stop()'s result, however the daemon came to stop
    const stop = (o) => { if (!stopping) { stopping = doStop(o); stopping.then(markExited, () => markExited({ failed: ['stop'] })) } return stopping }
    // `off` with no names (1.6 §1.4 5): when no connection is left in the engine — or at once on `now` (a second wait is cut at 500 ms: whatever
    // the engine still holds then goes with the process) — the daemon stops itself like for SIGTERM, with reason 'off'. A little later than
    // the reply, so the reply is written before the control socket closes.
    // The exit is a request that can be withdrawn while it waits (T05 review): a splice can outlive `off` by minutes, and an operator who runs `on`
    // meanwhile talks to this daemon (`on` starts one only when none is running). `exitAsked` counts the requests; /on and a newer /off {exit} both
    // bump it, so only the latest request may stop the daemon, and never while some harness is on — an exit would leave state.json saying on with
    // nothing attached and, being a clean exit, no supervisor to restart it.
    function exitWhenDrained(now) {
      const mine = ++exitAsked
      const left = engine.drained({ agents: null })
      const ready = now ? Promise.race([left, new Promise((r) => setTimeout(r, 500))]) : left
      ready.then(() => new Promise((r) => setTimeout(r, 50))).then(() => { if (mine === exitAsked && !sw.anyOn()) return stop({ reason: 'off' }) }).catch((e) => failure('daemon', coded(e, 'stop-failed')))
    }
    async function doStop({ signal = null, reason = null } = {}) {
      clearInterval(lockTimer); clearInterval(caTimer); clearInterval(checkTimer); clearTimeout(bundleRetry)
      if (!helperDown) { try { const s = await redirector.status(); if (s && s.drops) lastDrops = s.drops } catch { /* the helper is going: what was last read is written */ } }
      noteDrops({ force: true }) // drops not yet reported are written, not lost
      failure.flush() // folded counts are written, not lost
      const failed = []
      // every step runs; one that fails is recorded with its reason, never thrown past the rest (D38)
      const step = async (where, fn) => { try { await fn() } catch (e) { failed.push(where); failure(where, Object.assign(new Error(`while stopping: ${errText(e)}`), { code: (e && e.code) || 'stop-failed' })) } }
      await step('control', () => control.close())
      clearInterval(bundleTimer)
      tracker.stop()
      await step('helper', () => redirector.close()) // the helper exits; its unpinned links vanish; new connections go direct
      await step('engine', () => Promise.race([engine.close(), new Promise((r) => setTimeout(r, 2000).unref())]))
      await step('record', () => store.close())
      failure.flush()
      failure.write({ event: 'daemon-stop', pid: process.pid, ...(signal ? { signal } : { reason: reason || 'stop requested' }), ...(failed.length ? { failed } : {}) })
      fs.rmSync(P.lock, { force: true }) // last: a lock still there at the next start means this stop never finished
      return { failed }
    }
    return { port, socketPath: sock, paths: P, stop, exited, status, tracker, engine, redirector, switch: sw }
  } catch (e) {
    failure.flush()
    await control.close()
    if (redirector) await redirector.close().catch((w) => failure('helper', w)) // the start failure itself is recorded by startDaemon
    throw e
  }
}
