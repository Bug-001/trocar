// daemon.mjs — the per-user collector daemon (RFC 4.6 §结构 · §控制面 · §开关语义 · D36). The ONLY module that
// wires core + arch + harness (layering.test.mjs names it). It runs as the operator, claims the control socket
// before anything else (one daemon, one helper per user), spawns the capability helper through arch, serves the
// engine on loopback, restores the desired switch state, and fails open everywhere: a dead helper means direct
// connections, never broken ones. It never mints the CA: `asight on` does, inside the manifest.
import crypto from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import { asightHome, collectorHome, rawHome } from '../paths.mjs'
import { startSealing } from './seal-queue.mjs'
import { createIndexKeeper } from './index-keeper.mjs'
import { loadArch } from './arch/index.mjs'
import { loadHarnesses } from './harness/index.mjs'
import { createRegistry } from './core/registry.mjs'
import { createTrustChecker } from './core/trust/confirm.mjs'
import { readManifest, installedAt } from './core/trust/journal.mjs'
import { daemonMayStart } from '../off/manifest.mjs'
import { rewriteBundles } from './core/trust/bundle.mjs'
import { createTracker } from './core/tracker.mjs'
import { createSwitch, readState } from './core/switch.mjs'
import { startControlServer, controlSocketPath } from './core/control.mjs'
import { createQueryService } from '../query/service.mjs'
import { createServer as createBoard } from '../server.mjs'
import { readIngressConfig } from './core/ingress-config.mjs'
import { readCa } from './core/tls/ca-store.mjs'
import { tryOpLock } from '../off/lock.mjs'
import { readAgentList, agentListPath } from '../off/identity.mjs'
import { loadCa, checkCa } from './core/tls/ca.mjs'
import { createLeafIssuer } from './core/tls/leaf.mjs'
import { bundleRoots, rootsLeftOut } from './core/tls/roots.mjs'
import { createRecordStore } from './core/record/store.mjs'
import { createEngine } from './core/engine/engine.mjs'
import { appendEvent, createFailureRecorder } from './core/events.mjs'
import { EVENT, CODE, trustReasonText } from './core/codes.mjs'
import { procIdentity, captureHealth } from '../health/read.mjs'
import { identityFor } from '../off/proc.mjs'
import { DAEMON_READ_VERBS } from '../off/daemon-read.mjs'
import { runAsync } from '../off/exec.mjs'
import { driftCheck, newDriftState } from '../netenv/adopt.mjs'
import { classesHook, wsTerminalHook } from './engine-data.mjs'
import { isModelOs, backendsFor, doorPartsFor, sourcesCtx } from './arch/model-backends.mjs'
import { createModelCollector } from './core/proxymode/collector.mjs'
import { TEMPLATES } from './harness/templates/index.mjs'
import { readStateFile } from '../off/state.mjs'

export { loadArch } // the CLI reaches arch only through this file (layering rule 5)

// What install / uninstall need from arch and harness, without starting anything: the descriptors, the OS key,
// and the process table (`scan` reads /proc; it does not need the helper).
export async function loadParts({ arch = null, harnesses = null, env = process.env, agentList = [], platform = process.platform } = {}) {
  const A = arch || (await loadArch(platform)) // the CLI's platform (V14: a platform with no collector is refused here, by loadArch's own error)
  const list = harnesses || (await loadHarnesses())
  // darwin / win32 run the collector model (runModelDaemon): no redirector here, and this parts view answers an empty process table
  // the registry judges by name on every OS (D51) and is built FIRST: the doors ask it (identify), the redirector does not feed it
  const registry = createRegistry(list, { agentList }) // agentList: readAgentList's entries (the user's ~/.asight/agents.json, D51③); the daemon swaps them in place
  const redirector = isModelOs(A.os) ? null : await A.createRedirector({ env }) // awaited: a test's arch may answer async
  // linger: whether the OS keeps this user's daemon after logout (true / false; null = not readable) — `asight on` says so (1.6 §1.1), it never enables it (R8)
  return { arch: A, os: A.os, harnesses: list, registry, scan: () => (redirector ? redirector.scan() : []), match: (f) => registry.match(f), linger: () => (redirector && typeof redirector.linger === 'function' ? redirector.linger() : null), lingerRead: () => (redirector && typeof redirector.lingerRead === 'function' ? redirector.lingerRead() : { state: null, error: 'this platform has no reader of the linger state' }) }
}

/** What `asight status` and `doctor` need to draw the network topology (1.6 §9.7). It lives in ./net-deps.mjs — the small arch-facing entry, so a
 *  read-only command does not load this module's whole graph (89 ms on a Windows test machine; D62) — and is re-exported here for the callers that have it. */
export { netFactsDeps } from './net-deps.mjs'

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

// The user's agent list ~/.asight/agents.json (D51③, 4.6 R6): read again only when its stat key moved — inode:size:mtime, plus the mode (a chmod
// makes a readable file unreadable without touching the other three); an atomic rename is a new inode; a file that is not there is a key too.
// A broken file (unreadable, unparsable, bad items) is one agent-list-invalid per file version (D38); one that reads cleanly again or is removed
// ends it with agent-list-ok; a file that was never there writes nothing. The daemon never writes the file, nor do on / off (D48).
// → next(): readAgentList's result when the key moved, else null.
function agentListWatch({ home, write }) {
  const file = agentListPath(home)
  const keyOf = () => { try { const st = fs.statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}` } catch (e) { return `gone:${(e && e.code) || 'error'}` } }
  let key = null, bad = false
  return function next() {
    const k = keyOf()
    if (k === key) return null
    key = k
    const r = readAgentList({ home })
    if (r.state === 'unreadable' || r.state === 'unparsable' || r.problems.length) {
      bad = true
      write({ event: EVENT.failure, where: 'harness', code: CODE.agentListInvalid, path: r.path, problems: r.problems,
        reason: r.state === 'ok' ? `${r.path} has ${r.problems.length} bad item(s); the other items and the preset names apply` : `${r.path} cannot be used (${r.state}); only the preset names apply` })
    } else if (bad) {
      bad = false
      write({ event: EVENT.agentListOk, where: 'harness', path: r.path, reason: r.state === 'absent' ? `${r.path} is gone; the preset names apply` : `${r.path} reads cleanly again; its items apply` })
    }
    return r
  }
}

/** The previous run's lock, read before this start writes its own (4.6 §事件与码, D38): a lock still there means that daemon never finished its stop
 *  (doStop removes it last), so it is said as `failure {where:'daemon', code:'unclean-stop'}` before daemon-start. Called only after startControlServer claimed the
 *  collector: before that the lock may be a live daemon's. No lock: a clean stop. */
function noteUncleanStop(lock, failure) {
  let stale = null
  let unreadable = false
  try { stale = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') unreadable = true } // ENOENT: the last daemon stopped cleanly
  if (stale && stale.pid) failure('daemon', coded(new Error(`the previous daemon (pid ${stale.pid}) ended without a clean stop (crash, kill -9 or power loss); its helper and links went with it, and connections then in flight through its engine were cut (how many is not known)`), 'unclean-stop'))
  else if (unreadable) failure('daemon', coded(new Error('the previous daemon left an unreadable lock (crash or power loss): it ended without a clean stop, and connections then in flight through its engine were cut (how many is not known)'), 'unclean-stop'))
}

/** The ONE place a daemon's record store, its sealer and its index keeper are wired (the platform-seam rule: no per-platform
 *  copy), so BOTH entries — Linux's runDaemon and the model OSes' runModelDaemon — seal AND keep the index current:
 *  `seal.start()` does the upgrade rename and the last run's leftovers, then every segment this run closes, one at a
 *  time in a forked child, so this event loop never encodes or hashes (4.2 §自动封存).
 *    The keeper (D62, index-keeper.mjs) indexes the bytes this daemon just appended, debounced and in chunks, so no
 *  query ever pays for a cold index build; it hands a segment over to the sealer's child when the segment closes.
 *    `seal.start()` MUST come after the control server claimed the collector (before that the lock may be a LIVE
 *  daemon's, and the start scan clears the lock's `segment`); `seal.stop()` belongs at the top of the stop, before
 *  store.close(): the segment the stop closes is sealed by the next start's scan, not by a worker the stop cuts off,
 *  and nothing of asight's writes anything after the stop (the tail the stop closes is indexed by that next start's
 *  sealer, and until then a query resumes it from the last indexed byte). */
function storeWithSealing({ P, failure }) {
  const home = path.dirname(P.dir)
  const store = createRecordStore({ root: P.dir, onError: (e) => failure('record', coded(e, 'record-error'), e && e.file ? { file: e.file } : {}) })
  const keeper = createIndexKeeper({ home, failure })
  store.onRecord(keeper.wrote) // on the write path: one Set add and at most one timer (index-keeper.mjs)
  let queue = null
  const seal = {
    start() { queue = startSealing({ store, raw: rawHome(home), lockFile: P.lock, failure, beforeSeal: keeper.flush, handOff: keeper.handOff }); return queue },
    stop() { if (queue) queue.stop(); keeper.pause() },
    // after store.close(): the segment the stop just closed is indexed to its last byte, so the daemon leaves behind
    // the index of everything it wrote; only then does the keeper write nothing more (D62)
    async settle() { try { await keeper.idle() } finally { await keeper.stop() } },
  }
  return { store, seal, keeper }
}

/** The lock a live daemon holds (4.6 §控制面, D-25): `fields` (pid, start time, boot id …) plus `segment`, the raw-layer
 *  segment it is appending to right now (D60: readers and the sealer leave that one alone, and may take every other). The
 *  returned refresh is called on a timer, and by the record store right before it creates a new segment file (so the lock
 *  names the live segment no later than its first byte) and right after it closes one, before the seal queue hears of
 *  it (so the sealer it forks at once never finds the closed segment still named here); the file is rewritten only when the segment changed (a rollover,
 *  a stop) — a reader never sees a segment named here that is already closed. */
export function lockKeeper({ file, fields, segmentOf = () => null }) {
  let written = false, segment = null
  return () => {
    const seg = segmentOf()
    if (written && seg === segment) { const t = new Date(); fs.utimesSync(file, t, t); return }
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ ...fields, segment: seg }) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file) // atomic: a reader sees the whole old lock or the whole new one
    segment = seg; written = true // only now: a failed write must be retried, not remembered as done
  }
}

/** The ONE place the read route is wired (D63 ①; the platform-seam rule: both entries get it, not one each): `GET /query` hands the
 *  request to a query worker this daemon forks on demand and streams its bytes back. This event loop forwards agent traffic, so it
 *  never computes an answer; the worker exits by itself when nobody queries. `stop()` belongs in the stop, before the control server
 *  closes, so a worker a stop cuts off is not left behind. */
function queryRouteFor({ P, failure, fork }) {
  const svc = createQueryService({ home: path.dirname(P.dir), failure, fork })
  return { routes: { 'GET /query': svc.route }, stop: svc.stop, svc }
}

/** The board's token (4.4, D26③): 32 random bytes, base64url, in <collector>/board.token (0600). Kept across restarts so a bookmarked URL
 *  still opens; a file that is missing or is not one is replaced (tmp + rename). Only the daemon writes it; uninstall removes it. */
function boardToken(dir) {
  const file = path.join(dir, 'board.token')
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (/^[A-Za-z0-9_-]{43}$/.test(t)) return t } catch { /* absent or unreadable: a new one */ }
  const t = crypto.randomBytes(32).toString('base64url')
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, t, { mode: 0o600 }); fs.renameSync(tmp, file)
  return t
}

/** The ONE place the board is mounted (D66, 4.4 §Plan 「端口」; the platform-seam rule: both entries call it): the face (src/server.mjs) on
 *  127.0.0.1:<ingress.json's boardPort>, relaying to the read route's query service. The daemon only reads the port (install chose it) and
 *  never tries another: a port it cannot listen on is `port-taken` with one failure record (D38), and capture and /query go on.
 *  routes(r) adds the board to the control routes: `GET /status` gains `board: {port, state, reason}` (never the token), and
 *  `GET /board` answers `{port, state, reason, token}` for `asight board`. start() once the daemon is ready; stop() before the control server closes. */
function boardFor({ P, failure, query, log = () => {} }) {
  let st = { port: null, state: 'no-port', reason: 'no board port recorded: run asight install' }
  let server = null, token = null, started = Promise.resolve(), stopped = false
  async function listen() {
    const cfg = readIngressConfig({ dir: P.dir })
    if (cfg.boardPort === undefined) { if (cfg.error) st = { ...st, reason: `${cfg.error}: run asight install` }; return }
    const port = cfg.boardPort
    try {
      token = boardToken(P.dir)
      const s = createBoard({ home: path.dirname(P.dir), token, query }).server
      s.on('clientError', (e, sock) => sock.destroy())
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve) })
      s.on('error', (e) => log('board', e)) // after the listen: the board never takes the daemon down
      if (stopped) { s.close(); return } // the daemon stopped while it was listening
      server = s
      st = { port, state: 'serving', reason: null }
    } catch (e) {
      st = { port, state: 'port-taken', reason: `the board could not listen on 127.0.0.1:${port} (${(e && e.code) || errText(e)}); capture goes on` }
      failure('daemon', coded(e, 'start-failed'), { port })
    }
  }
  const tokenAnswer = async () => { await started; return { ...st, token } }
  return {
    start() { started = listen(); return started },
    state: () => ({ ...st }),
    tokenAnswer,
    routes: (r) => ({ ...r, 'GET /status': async (q) => { const a = await r['GET /status'](q); await started; return { ...a, board: { ...st } } }, 'GET /board': tokenAnswer }),
    stop() { stopped = true; if (server) { server.close(); server.closeAllConnections(); server = null } },
  }
}

async function runDaemon({ dir, env = process.env, arch = null, harnesses = null, socketPath = null, enginePort = null, upstreamCa = undefined, log, identity = null, lockRefreshMs = 1000, foreground = false, caCheckMs = 24 * 3600e3, bundleMs = 24 * 3600e3, checkMs = 5000, foldMs = 10_000, home = null, model = {}, fork }) {
  const P = collectorPaths(dir)
  const netHome = home || env.HOME || os.homedir() // whose agents' settings the 5 s check looks at: the user the daemon runs as
  const failure = createFailureRecorder(P.dir, { log })
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
  // macOS / Windows run the collector model (4.11 §1, §3 ①): no CA of its own to gate on, doors from POST /on, the CLI writes every file
  if (A0 && isModelOs(A0.os)) return runModelDaemon({ A: A0, P, sock, ep, env, harnesses, home: netHome, log, failure, identity: identity || identityFor({ platform: A0.os, env, exec: runAsync }) /* darwin = ps lstart + kern.boottime; async: the event loop stays free */, lockRefreshMs, foreground, upstreamCa, model, fork })
  identity = identity || procIdentity
  let manifest
  try { manifest = readManifest(P.dir) } catch (e) { throw Object.assign(new Error(`the install manifest ${path.join(P.dir, 'install-manifest.json')} is unreadable (${errText(e)}); run "asight uninstall", then "asight on"`), { code: 'manifest-unreadable' }) }
  const ca = daemonMayStart(manifest) ? readCa({ dir: P.caDir }) : null
  if (!ca) throw Object.assign(new Error('the collector is not installed for this user: run "asight on" first'), { code: 'not-installed' })
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
  const query = queryRouteFor({ P, failure, fork })
  const board = boardFor({ P, failure, query: query.svc, log })
  const control = await startControlServer({ socketPath: sock, ...(ep ? { token: ep.token } : {}), routes: board.routes({ 'GET /status': gate('status'), 'POST /on': gate('on'), 'POST /off': gate('off'), ...query.routes }) }) // throws if another daemon answers

  let redirector = null
  try {
    // First the previous run (4.6 §事件与码): an unclean stop is the first line of this start; readers take this start's
    // lines from here on as this run's, up to and past daemon-start — the CA check below included.
    noteUncleanStop(P.lock, failure)
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
    const retention = classesHook({ home: path.dirname(P.dir), failure }) // D60③, engine-data.mjs
    const { store, seal } = storeWithSealing({ P, failure })
    seal.start() // after noteUncleanStop above: the gate (the control server) has claimed the collector
    // switch / helper events: their own descriptor (events.mjs, a lost line becomes a log-gap), and every failure
    // among them carries `reason`
    let engine = null // created after the tracker; the tracker's onGone reaches it at call time
    const event = (e) => failure.write({ ...e, ...(e.error != null && e.reason == null ? { reason: String(e.error) } : {}) })

    const nextAgentList = agentListWatch({ home: netHome, write: (rec) => failure.write(rec) }) // at start here, then on every 5 s check
    const { registry, arch: A, harnesses: harnessList } = await loadParts({ arch: A0 ?? arch, harnesses, env, agentList: (nextAgentList() || { entries: [] }).entries })
    redirector = A.createRedirector({ env }) // Linux's core redirector: darwin / win32 never reach here (runModelDaemon above)
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
          // bundle on this machine holds a certificate) is used — Node's roots are all there is — and said; so is an answer that left certificates out (`dropped`:
          // they did not parse) or lacks a source whose read failed (`partial`): rootsLeftOut, the same line `on`'s plan writes.
          const got = await bundleRoots(A)
          rewriteBundles({ dir: P.dir, manifest: fresh, nodeRoots: got.node, osRootsText: got.osText, caPem: ca.certPem, report, only: on })
          const live = fresh.files.filter((f) => f.role === 'bundle' && on.has(f.harness) && !f.without_ca).map((f) => f.path) // the bundles this round composes
          if (got.missing && live.length) failure.event({ where: 'bundle', code: CODE.systemRootsUnavailable, files: live, reason: `the combined bundles ${live.join(', ')} carry Node's roots only: ${got.missing}; a CA installed system-wide (a corporate proxy's) is not in them, and an agent whose entry points at one may not reach a relay that signs with it` })
          for (const r of rootsLeftOut(got, live)) failure.event({ where: 'bundle', ...r }) // certificates that did not parse, a source whose read failed: the plan's line, at every rebuild (4.8 §6.2, D38)
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
        // the proxy ingress's own answer (4.8 §5.1): a door's CONNECT arrives with the group id as the user (D47) — the redirector's lookupIngress resolves it (a flow's meta, a health probe, or null = refused)
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
      policy: (meta, host) => tracker.policy(meta, host),
      isRecording: (meta) => sw.isRecording(meta && meta.agent), // sampled per request, per harness (4.6 §开关): a request after off is never recorded
      retention, // sampled with it (D40)
      onFailure: (rec) => failure.event(rec), // the engine's and the WebSocket recorder's failures: flows/, folded
      onError: (e) => log('engine', e), // stderr only: every one of them is also a record through onFailure
    })
    // The engine's door (4.8 §5.1): Linux listens transparently on the port the install recorded.
    const want = enginePort ?? manifest.engine_port ?? 0
    const first = await engine.listen({ port: want, hosts: ['127.0.0.1'] }).catch((e) => {
      // G3: the port is squatted (chosen at install). Nothing is steered
      // (the helper is not spawned yet), so the agents' connections stay direct; say so, and how to get a new port.
      if (e.code === 'EADDRINUSE') throw Object.assign(new Error(`the engine port 127.0.0.1:${want} recorded at install is held by another process; nothing is steered, agent connections go direct. Free the port, or run "asight uninstall" and "asight on" to pick a new one`), { code: CODE.enginePortTaken, errno: 'EADDRINUSE' }) // recorded under its closed-set code; the daemon never picks another port (decision #16)
      throw e
    })
    const port = first.port
    let v6Held = null // the helper steers IPv6 agent connections to [::1]:port: never attach while someone else holds it (M8; darwin has no helper — its agents point at 127.0.0.1 by the entry)
    let v6Error = null // any [::1] failure: status never reports [::1] as listening then (D-10)
    try { await engine.listen({ port: first.port, hosts: ['::1'], ...(first.ingressPort ? { ingress: { port: first.ingressPort } } : {}) }) } catch (e) {
      v6Error = `[::1]:${port}: ${errText(e)}`
      if (e.code === 'EADDRINUSE') v6Held = `[::1]:${port} is held by another process`
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
      try { const fresh = readManifest(P.dir); if (fresh && !fresh.unsupported && daemonMayStart(fresh)) manifest = fresh } catch (e) { failure('daemon', coded(e, 'manifest-unreadable')) }
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
    const refreshLock = lockKeeper({ file: P.lock, fields: { pid: process.pid, start_time: me.start_time, boot_id: me.boot_id, helper_pid: redirector.helperInfo().pid, engine_port: port, socket: sock }, segmentOf: () => store.currentSegment })
    refreshLock()
    // the lock must name the live segment before that segment's first byte (D60, invariant 2): the store calls this
    // synchronously right before it creates the file, so a sealer never takes the segment the daemon is appending to;
    // and again right after a segment closes, before the seal queue gets it, so that seal is not refused (2026-10-20).
    // A lock that cannot be written is said (D38) and the capture goes on.
    const bumpLock = () => { try { refreshLock() } catch (e) { failure('daemon', coded(new Error(`the lock ${P.lock} could not be refreshed (${errText(e)}); readers will judge this daemon unresponsive`), e && e.code ? e.code : 'record-error')) } }
    store.onSegmentChange(bumpLock)
    const lockTimer = setInterval(bumpLock, lockRefreshMs)
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
      // D51③: agents.json changed — the new list judges every row again (one it no longer names leaves, agent-exit via 'list') and the rescan judges the rest, no restart
      const list = nextAgentList()
      if (list) { registry.replaceAgentList(list.entries); await tracker.rejudgeAll('list'); await tracker.rescan() }
      // §9.5: the files each harness reads its proxy from, against what `on` found: a change is one `netenv-change` (and one failure when it leaves a harness that is on uncaptured). Read-only: only the operator's
      // `on` writes an agent's setting (D30). No VPN / proxy software is read here or anywhere (D49): `status` and `doctor` compare the same files live.
      driftCheck({ home: netHome, env, harnesses: harnessList, desired: (h) => (sw.state().harnesses[h] || {}).desired ?? null, appendEvent: (rec) => failure.write(rec), state: drift })
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
    board.start() // never fails the start: a board that cannot listen is a state and a record

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
      seal.stop() // the segment store.close() closes below is sealed by the next start's scan, not by a worker this stop cuts off
      board.stop(); query.stop()
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
      await step('raw', () => seal.settle()) // the index of what this daemon wrote, including the segment just closed (D62)
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
    board.stop(); query.stop()
    throw e
  }
}

// The collector model's daemon (4.11 §1 on / off, §3 ① ②): macOS and Windows. It writes no agent file and no ingress.json — `asight on`
// writes them after POST /on opened the doors and read them back; the daemon opens doors, judges at the door, signs leaves through the custody, keeps
// a door forward-only while its holders live after off (P12), and exits after `off {exit}` only when mayExit says so. `model`: test seams only —
// { backends: { custody, dirs, policy }, parts: doorPartsFor's shape, or io: doorPartsFor's OS readers alone } — the endpoint, the control server and the
// engine are always the real ones.
async function runModelDaemon({ A, P, sock, ep, env, harnesses, home, log, failure, identity, lockRefreshMs, foreground, upstreamCa, model, fork }) {
  const list = harnesses || (await loadHarnesses())
  const nextAgentList = agentListWatch({ home, write: (rec) => failure.write(rec) })
  let agents = (nextAgentList() || { entries: [] }).entries
  const registry = createRegistry(list, { agentList: agents })
  const event = (rec) => failure.write(rec)
  const b = model.backends || (await backendsFor({ os: A.os, home, env }))
  const parts = model.parts || (await doorPartsFor({ os: A.os, env, event, failure, io: model.io || {} }))
  let rootPem = null
  try { rootPem = fs.readFileSync(path.join(P.caDir, 'asight-ca.pem'), 'utf8') } catch { /* no root: the issuer says so, every door forwards only */ }
  const { store, seal } = storeWithSealing({ P, failure }) // 4.2 §自动封存, the same wiring as runDaemon's
  let collector = null
  const desired = () => { try { return readStateFile(P.state).state.harnesses || {} } catch { return {} } }
  const engine = createEngine({
    redirector: { lookupIngress: (q) => collector.lookupIngress(q), servePac: (q) => collector.servePac(q) },
    issuer: { secureContextFor: (h) => collector.issuer.secureContextFor(h), issue: (h) => collector.issuer.issue(h) }, store, upstreamCa,
    ingressToken: crypto.randomBytes(24).toString('hex'), // the model listens on no shared ingress: each door carries its group's token (ingress.json's), this one guards nothing
    isRecording: (meta) => (desired()[meta && meta.agent] || {}).desired === 'on',
    retention: classesHook({ home: path.dirname(P.dir), failure }), describe: wsTerminalHook(list), // D60③ and the WebSocket turn edge, as on Linux (engine-data.mjs)
    onFailure: (rec) => failure.event(rec), onError: (e) => log('engine', e),
  })
  collector = createModelCollector({ harnesses: list, dir: P.dir, identify: registry.match, ownerOf: parts.ownerOf, factsOf: parts.factsOf, proc: parts.proc,
    ctx: sourcesCtx({ os: A.os, home, env, dirs: b.dirs, policy: b.policy }), systemProxy: parts.systemProxy, custody: b.custody || 'unavailable', rootPem, procTable: parts.procTable,
    record: event, event, proxyOf: parts.proxyOf, templates: TEMPLATES, agentList: () => ({ entries: agents }), ownSid: parts.ownSid || null, openConns: () => engine.stats().active,
    drain: ({ harnesses: hs, now }) => engine.drain({ agents: new Set(hs), now }),
    upstreamRoots: upstreamRootsOf({ A, env, upstreamCa, event }) })
  collector.bindDoors({ open: (l) => engine.listen({ groups: l }), close: (ids) => Promise.resolve(engine.closeGroups(ids)) })
  let exitAsked = 0, exitTimer = null
  const status = async () => {
    const st = collector.issuer.state()
    const d = desired()
    const hs = Object.fromEntries(Object.entries(d).map(([h, e]) => [h, { ...e, attached: collector.attached(h) }])) // per harness: its doors listen (status's `attached`, 1.6 V32)
    // the connections of the harnesses that are off and still relayed (1.6 §1.3), as runDaemon reports them: the engine counts
    // what it holds in memory, so this costs nothing. Without it `status` said "Connections unknown (the daemon's reply does not
    // carry the connection counts)" on every model-mode machine — a reason about asight's own IPC (a macOS test machine 2026-10-18).
    const off = new Set(Object.entries(d).filter(([, e]) => e && e.desired === 'off').map(([h]) => h))
    return { pid: process.pid, doors: collector.doors(), upstreams: collector.upstreams(), harnesses: hs, holders: collector.polledHolders(), relayed: engine.relayed({ agents: off }), cert: { key: st === 'key-missing' ? 'missing' : st === 'unavailable' ? 'unknown' : 'present', intermediate: st, expires: collector.issuer.expires() }, engine: engine.stats() }
  }
  const body = (q) => (q && q.body && typeof q.body === 'object' ? q.body : {})
  // the daemon's own identity, as it writes it into its lock (below): the read route hands it back, and an answer on the token-checked channel is
  // what proves which process the lock names — so `status` does not ask the OS about that pid (4.8 §7; D62). null until the lock is written.
  let selfId = null
  let stop = null, markReady
  // restore() first (runDaemon's `ready` gate): a request that arrives while it reopens the recorded doors waits for it, so an `on` racing a restart
  // (launchd / the task bringing the daemon back while the user runs on) never binds a group's port a second time
  const ready = new Promise((r) => { markReady = r })
  const gate = (fn) => async (q) => { await ready; return fn(q) }
  const query = queryRouteFor({ P, failure, fork })
  const board = boardFor({ P, failure, query: query.svc, log })
  const control = await startControlServer({ socketPath: sock, ...(ep ? { token: ep.token } : {}), routes: board.routes({
    'GET /status': gate(status),
    'GET /holders': gate(() => collector.holders()),
    ...query.routes,
    // the read question a read-only CLI command puts instead of starting a powershell.exe of its own (4.8 §1 §7; D62): a closed SUBSET of the
    // helper's read verbs, refused here as well as in the helper (W1's two gates). It reads and changes nothing.
    'POST /helper': gate(async (q) => {
      const { verb, args } = body(q)
      const self = selfId ? { pid: process.pid, start_time: selfId.start_time ?? null, boot_id: selfId.boot_id ?? null } : null
      const no = (error) => ({ ok: false, error, ...(self ? { self } : {}) })
      if (!DAEMON_READ_VERBS.includes(verb)) return no(`${JSON.stringify(verb ?? null)} is not one of the daemon's read verbs`)
      if (!parts.helper) return no('this daemon reads the OS without a resident helper, so it has none to ask')
      // `reg-read` names a registry key, so the ARGUMENTS are checked here too, against the one allow-list the helper itself checks against
      // (4.8 §7, W26: the daemon refuses an out-of-list key before its helper is asked). No checker, no reg-read.
      if (verb === 'reg-read' && !(typeof parts.regReadAllowed === 'function' && parts.regReadAllowed(args && typeof args === 'object' ? args : {}))) return no(`reg-read outside the allow-list: ${JSON.stringify(args ?? null)}`)
      try { return { ok: true, data: await parts.helper.call(verb, args && typeof args === 'object' ? args : {}, { timeoutMs: verb === 'ps' ? 10000 : 2000 }), ...(self ? { self } : {}) } } catch (e) { return no(`${verb}: ${String((e && (e.code || e.message)) || e)}`) }
    }),
    'POST /on': gate(async (q) => { exitAsked++; clearInterval(exitTimer); return collector.on(body(q)) }),
    'POST /off': gate(async (q) => {
      const r = await collector.off(body(q))
      if (body(q).exit === true) { const mine = ++exitAsked; clearInterval(exitTimer); exitTimer = setInterval(() => { if (mine === exitAsked && collector.mayExit()) { clearInterval(exitTimer); stop({ reason: 'off' }) } }, 250) }
      return r
    }),
  }) })
  // only now: the control server refuses a start while another daemon answers, so a lock read before it may be a live daemon's (runDaemon's order)
  noteUncleanStop(P.lock, failure)
  seal.start() // only now (the gate claimed the collector): the lock read before this could have been a live daemon's
  try {
    await collector.start()
    markReady()
    board.start() // never fails the start: a board that cannot listen is a state and a record
    const me = await identity(process.pid) // an async reader here (runDaemon's model branch): the requests markReady released go on meanwhile
    selfId = me
    const refreshLock = lockKeeper({ file: P.lock, fields: { pid: process.pid, start_time: me.start_time, boot_id: me.boot_id, engine_port: null, socket: sock }, segmentOf: () => store.currentSegment })
    refreshLock()
    const bumpLock = () => { try { refreshLock() } catch (e) { failure('daemon', coded(e, 'record-error')) } }
    store.onSegmentChange(bumpLock) // before the new segment's file exists and before a closed one is sealed (D60, invariant 2); see runDaemon's copy
    const lockTimer = setInterval(bumpLock, lockRefreshMs); lockTimer.unref()
    const listTimer = setInterval(() => { const l = nextAgentList(); if (l) { agents = l.entries; registry.replaceAgentList(agents) } }, 5000); listTimer.unref()
    failure.write({ event: 'daemon-start', pid: process.pid, start_time: me.start_time, boot_id: me.boot_id, version: VERSION, foreground: !!foreground, upstream_ca: env.NODE_EXTRA_CA_CERTS || null, linger: null })
    let stopping = null, markExited
    const exited = new Promise((r) => { markExited = r })
    const doStop = async ({ signal = null, reason = null } = {}) => {
      seal.stop() // as in runDaemon: the last segment is left to the next start's scan
      board.stop(); query.stop()
      clearInterval(lockTimer); clearInterval(listTimer); clearInterval(exitTimer)
      const failed = []
      const step = async (where, fn) => { try { await fn() } catch (e) { failed.push(where); failure(where, Object.assign(new Error(`while stopping: ${errText(e)}`), { code: (e && e.code) || 'stop-failed' })) } }
      await step('control', () => control.close())
      await step('engine', () => Promise.race([engine.close(), new Promise((r) => setTimeout(r, 2000).unref())]))
      collector.close(); await step('helper', () => parts.close && parts.close())
      await step('record', () => store.close())
      await step('raw', () => seal.settle()) // as in runDaemon: the index covers everything this daemon wrote (D62)
      failure.flush()
      failure.write({ event: 'daemon-stop', pid: process.pid, ...(signal ? { signal } : { reason: reason || 'stop requested' }), ...(failed.length ? { failed } : {}) })
      fs.rmSync(P.lock, { force: true })
      return { failed }
    }
    stop = (o) => { if (!stopping) { stopping = doStop(o); stopping.then(markExited, () => markExited({ failed: ['stop'] })) } return stopping }
    return { port: null, socketPath: sock, paths: P, stop, exited, status, engine, collector }
  } catch (e) {
    failure.flush(); await control.close(); collector.close(); if (parts.close) parts.close()
    board.stop(); query.stop()
    throw e
  }
}

/** The bases the doors verify an upstream with (4.11 §3 ⑭): the OS roots through the one resolver (tls/roots.mjs bundleRoots → the arch's osRoots,
 *  4.9 §5.4 / 4.8 §6.4), Node's bundled roots, and the daemon's own extra (NODE_EXTRA_CA_CERTS, the upstreamCa test seam) for the union. An OS read
 *  that fails is recorded (D38) and the base is then empty — never a fixed bundle path. */
function upstreamRootsOf({ A, env, upstreamCa, event }) {
  const extra = [].concat(upstreamCa || []).map(String)
  if (env.NODE_EXTRA_CA_CERTS) { try { extra.push(fs.readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8')) } catch (e) { event({ event: 'failure', where: 'engine', code: 'trust-store-error', reason: `NODE_EXTRA_CA_CERTS ${env.NODE_EXTRA_CA_CERTS}: ${e.code || e.message}` }) } }
  return {
    node: tls.rootCertificates, extra,
    os: async () => {
      try { const r = await bundleRoots(A); for (const x of rootsLeftOut(r, ['the doors\' upstream trust'])) event({ event: 'failure', where: 'engine', ...x }); return r.osText } catch (e) {
        event({ event: 'failure', where: 'engine', code: 'system-roots-unavailable', reason: `the OS roots could not be read for the doors' upstream trust (${e.message || e})` }); return ''
      }
    },
  }
}
