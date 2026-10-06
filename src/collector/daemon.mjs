// daemon.mjs — the per-user collector daemon (RFC 4.6 §结构 · §控制面 · §开关语义 · D36). The ONLY module that
// wires core + arch + harness (layering.test.mjs names it). It runs as the operator, claims the control socket
// before anything else (one daemon, one helper per user), spawns the capability helper through arch, serves the
// engine on loopback, restores the desired switch state, and fails open everywhere: a dead helper means direct
// connections, never broken ones. It never mints the CA: `asight collector install` does, inside the manifest.
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { asightHome, collectorHome } from '../paths.mjs'
import { loadArch } from './arch/index.mjs'
import { loadHarnesses } from './harness/index.mjs'
import { createRegistry } from './core/registry.mjs'
import { createTrustChecker } from './core/trust/confirm.mjs'
import { readManifest, installedAt } from './core/trust/journal.mjs'
import { rewriteBundles } from './core/trust/bundle.mjs'
import { createTracker } from './core/tracker.mjs'
import { createSwitch } from './core/switch.mjs'
import { startControlServer, controlSocketPath } from './core/control.mjs'
import { readCa } from './core/tls/ca-store.mjs'
import { loadCa } from './core/tls/ca.mjs'
import { createLeafIssuer } from './core/tls/leaf.mjs'
import { createRecordStore } from './core/record/store.mjs'
import { createEngine } from './core/engine/engine.mjs'
import { appendEvent, readRecentFailures, createFailureRecorder } from './core/events.mjs'
import { EVENT, CODE, trustReasonText } from './core/codes.mjs'

export { loadArch } // the CLI reaches arch only through this file (layering rule 5)

// What install / uninstall need from arch and harness, without starting anything: the descriptors, the OS key,
// and the process table (`scan` reads /proc; it does not need the helper).
export async function loadParts({ arch = null, harnesses = null, env = process.env } = {}) {
  const A = arch || (await loadArch())
  const list = harnesses || (await loadHarnesses())
  const registry = createRegistry(list)
  const redirector = A.createRedirector({ env })
  return { arch: A, os: A.os, osRootsFile: A.osRootsFile || null, harnesses: list, registry, scan: () => redirector.scan(), match: (f) => registry.match(f) }
}

export const collectorPaths = (dir = collectorHome(asightHome())) => ({ dir, caDir: path.join(dir, 'ca'), state: path.join(dir, 'state.json'), lock: path.join(dir, 'lock'), markers: path.join(dir, 'run', 'trust') })
const errText = (e) => String((e && e.message) || e)
// Every failure record carries a code (asight's name from src/health/codes.mjs, or the errno): the fold key (D-3).
const coded = (e, code) => Object.assign(new Error(errText(e)), { code: (e && e.code) || code })

// upstreamCa: test seam only (the CLI never passes it). Upstreams are verified against Node's default store, so a
// relay with a private CA is trusted through NODE_EXTRA_CA_CERTS in the daemon's own environment (gate G8).
// Every failure this daemon owns leaves a durable record with a reason in flows/ and shows in status (D38, user
// 2026-10-06): core/events.mjs createFailureRecorder (one line per place and error code per 10 s, the folded count
// written when the window closes or at stop).
export async function startDaemon(opts = {}) {
  const dir = opts.dir || collectorHome(asightHome())
  const log = opts.log || (() => {})
  try { return await runDaemon({ ...opts, dir, log }) } catch (e) {
    // the refusal is recorded where status finds it — unless nothing is installed here (no directory to write into)
    if (fs.existsSync(dir)) { try { appendEvent(dir, { event: 'failure', where: 'start', code: (e && e.code) || 'start-failed', reason: errText(e) }) } catch (w) { log('events', w) } }
    throw e
  }
}

// The recent failure records for status, with what could not be read (D-2: an unreadable flows/ is never "none").
export function failuresOnDisk(dir) {
  const r = readRecentFailures(dir)
  return { failures: r.list, ...(r.errors.length || r.truncated ? { failures_read: { errors: r.errors, truncated: r.truncated } } : {}) }
}

async function runDaemon({ dir, env = process.env, arch = null, harnesses = null, socketPath = null, enginePort = null, upstreamCa = undefined, log }) {
  const P = collectorPaths(dir)
  const failure = createFailureRecorder(P.dir, { log })
  let manifest
  try { manifest = readManifest(P.dir) } catch (e) { throw Object.assign(new Error(`the install manifest ${path.join(P.dir, 'install-manifest.json')} is unreadable (${errText(e)}); run "asight collector uninstall", then install again`), { code: 'manifest-unreadable' }) }
  const ca = manifest && manifest.complete ? readCa({ dir: P.caDir }) : null
  if (!ca) throw Object.assign(new Error('the collector is not installed for this user: run "asight collector install" first'), { code: 'not-installed' })
  const sock = socketPath || controlSocketPath({ env })
  let markReady
  const ready = new Promise((r) => { markReady = r })
  const impl = {} // filled once wiring is done; requests that arrive earlier wait for it
  const gate = (name) => async (q) => {
    await ready
    try { return await impl[name](q) } catch (e) { failure('control', coded(e, 'control-error'), { route: name }); throw e } // a 500 is a failure too
  }
  const control = await startControlServer({ socketPath: sock, routes: { 'GET /status': gate('status'), 'POST /on': gate('on'), 'POST /off': gate('off') } }) // throws if another daemon answers

  let redirector = null
  try {
    const issuer = createLeafIssuer(loadCa(ca))
    const store = createRecordStore({ root: P.dir, onError: (e) => failure('record', coded(e, 'record-error')) })
    let stale = null
    let unreadable = false
    try { stale = JSON.parse(fs.readFileSync(P.lock, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') unreadable = true } // ENOENT: the last daemon stopped cleanly
    if (stale && stale.pid) failure('daemon', coded(new Error(`the previous daemon (pid ${stale.pid}) ended without a clean stop (crash, kill -9 or power loss); its helper and links went with it, and connections then in flight through its engine were cut (how many is not known)`), 'unclean-stop'))
    else if (unreadable) failure('daemon', coded(new Error('the previous daemon left an unreadable lock (crash or power loss): it ended without a clean stop, and connections then in flight through its engine were cut (how many is not known)'), 'unclean-stop'))
    // switch / helper events: their own descriptor (events.mjs, a lost line becomes a log-gap), and every failure
    // among them carries `reason`
    const event = (e) => failure.write({ ...e, ...(e.error != null && e.reason == null ? { reason: String(e.error) } : {}) })

    const { registry, arch: A } = await loadParts({ arch, harnesses, env })
    redirector = A.createRedirector({ env })
    // D38: one `agent-untrusted` per pid and reason (code = the resolver's reason, reason = what to do about it); a pid
    // recorded so gets `agent-trusted` once it is trusted and `agent-exit` when it exits, so the condition can clear.
    const recordedUntrusted = new Map() // pid → the reason code last recorded
    const note = (rec) => failure.write(rec)
    // the descriptor's own words for a reason, else the generic text (core/codes.mjs), else the code itself
    const hintFor = (agent, reason) => { const d = registry.get(agent); return (d && d.trust && d.trust.hints && d.trust.hints[reason]) || trustReasonText(reason) || reason }
    const onVerdict = (row) => {
      if (row.watchError) failure('watch', coded(new Error(`watching ${row.agent} pid ${row.pid} failed: ${row.watchError}`), 'watch-failed'))
      if (row.configError) failure('harness', coded(new Error(`${row.agent} pid ${row.pid}: reading its configuration failed (${row.configError}); judged on its known hosts only`), 'config-error'))
      for (const r of row.readErrors || []) failure('harness', Object.assign(new Error(`${row.agent} pid ${row.pid}: ${r} exists but cannot be read; judged as if it were absent`), { code: CODE.configUnreadable }), { pid: row.pid, agent: row.agent })
      for (const f of row.parseErrors || []) failure('harness', Object.assign(new Error(`${row.agent} pid ${row.pid}: ${f} exists but does not parse; judged as if it were absent`), { code: CODE.configUnparsable }), { pid: row.pid, agent: row.agent })
      const last = recordedUntrusted.get(row.pid)
      if (row.trusted) {
        if (last != null) { recordedUntrusted.delete(row.pid); note({ event: EVENT.agentTrusted, pid: row.pid, agent: row.agent, code: 'ok', reason: `trusted now (${row.trustVar} via ${row.trustVia})` }) }
        return
      }
      if (last === row.reason || row.reason === 'marker-pending') return // once per pid and reason; a plugin has up to 10 s to report (4.6 「标记」)
      recordedUntrusted.set(row.pid, row.reason)
      note({ event: EVENT.agentUntrusted, pid: row.pid, agent: row.agent, code: row.reason, reason: hintFor(row.agent, row.reason), via: row.trustVia ?? null })
    }
    // combined bundles follow the roots: rebuilt (atomically) at start and once a day when the roots changed (4.6 「合并包」)
    const refreshBundles = () => {
      try {
        let osText = ''
        if (A.osRootsFile) { try { osText = fs.readFileSync(A.osRootsFile, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } }
        const done = rewriteBundles({ dir: P.dir, manifest, nodeRoots: tls.rootCertificates, osRootsText: osText, caPem: ca.certPem })
        if (done.length) note({ event: 'bundles-rebuilt', code: 'roots-changed', reason: `the trusted roots changed; rebuilt ${done.join(', ')}` })
      } catch (e) { failure('bundle', Object.assign(new Error(`rebuilding the combined bundles failed: ${errText(e)}; they keep their previous roots`), { code: e && e.code })) }
    }
    refreshBundles()
    const bundleTimer = setInterval(refreshBundles, 24 * 3600 * 1000); bundleTimer.unref()
    // plugins (dsh, OpenCode) write their per-pid marker here; it exists while the daemon runs (0700, the operator's)
    fs.mkdirSync(P.markers, { recursive: true, mode: 0o700 })
    const tracker = createTracker({ redirector, registry, trust: createTrustChecker({ caCertPem: ca.certPem }), onVerdict, markerDir: P.markers, caPem: ca.paths.pem, collectorDir: P.dir,
      installedAt: (l) => installedAt(manifest, l), // config-after-start is judged against when asight wrote the value
      onError: (e, at) => failure('tracker', Object.assign(new Error(`pid ${at.pid} (${at.phase}): ${errText(e)}${at.phase === 'judge' ? '; it is not watched, its connections go direct' : ''}`), { code: (e && e.code) || (at.phase === 'judge' ? 'judge-error' : 'unwatch-error') }), at) })
    let helperDown = null
    let sw = null

    const engine = createEngine({
      redirector: {
        async lookup(peer) { // the kernel knows {dst, pid, decrypt}; the tracker adds what the envelope's proc carries
          const m = await redirector.lookup(peer)
          const x = m && m.pid != null ? tracker.metaFor(m.pid) : null
          return m && x ? { ...m, ...x, agent: m.agent ?? x.agent } : m
        },
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
      isRecording: () => sw.isRecording(), // sampled per request (4.6 §开关): a request after off is never recorded
      onFailure: (rec) => failure.event(rec), // the engine's and the WebSocket recorder's failures: flows/, folded
      onError: (e) => log('engine', e), // stderr only: every one of them is also a record through onFailure
    })
    const want = enginePort ?? manifest.engine_port ?? 0
    const { port } = await engine.listen({ port: want, hosts: ['127.0.0.1'] }).catch((e) => {
      // G3: the port chosen at install is squatted. Nothing is steered (the helper is not spawned yet), so the agents'
      // connections stay direct; say so, and how to get a new port.
      if (e.code === 'EADDRINUSE') throw Object.assign(new Error(`the engine port 127.0.0.1:${want} recorded at install is held by another process; nothing is steered, agent connections go direct. Free the port, or run "asight collector uninstall" and "asight collector install" to pick a new one`), { code: 'EADDRINUSE' })
      throw e
    })
    let v6Held = null // the helper steers IPv6 agent connections to [::1]:port: never attach while someone else holds it (M8)
    try { await engine.listen({ port, hosts: ['::1'] }) } catch (e) {
      if (e.code === 'EADDRINUSE') v6Held = `[::1]:${port} is held by another process`
      failure('engine', Object.assign(new Error(`[::1]:${port} unavailable: ${errText(e)}; ${v6Held ? 'on will refuse to attach (M8)' : 'IPv6 agent connections go direct'}`), { code: e.code }))
    }

    async function ensureReady() {
      if (helperDown) throw new Error(`the redirector helper is down (${helperDown}); restart the collector`)
      if (v6Held) throw new Error(`${v6Held}; refusing to attach so no IPv6 connection is steered to it (M8)`)
      const { proto } = redirector.helperInfo()
      if (proto !== redirector.expectedProto) throw new Error(`helper speaks protocol ${proto}, this daemon expects ${redirector.expectedProto}; run "sudo asight setup-helper" (G2)`)
      await tracker.rescan() // every `on` re-judges live processes (G18)
    }
    redirector.on('down', ({ reason }) => { helperDown = reason; sw.markDown(reason); event({ event: 'helper-down', reason }) })
    redirector.on('version-mismatch', (m) => event({ event: 'helper-version-mismatch', ...m, reason: `the helper speaks protocol ${m.got}, this daemon expects ${m.expected}; run "sudo asight setup-helper"` }))
    redirector.on('helper-error', ({ reason, code }) => failure('helper', coded(Object.assign(new Error(reason), { code }), 'helper-error')))
    redirector.on('heartbeat-error', ({ reason, code }) => failure('heartbeat', coded(Object.assign(new Error(`${reason}; once the last beat is 2 s old the kernel stops steering (connections go direct)`), { code }), 'heartbeat-failed')))
    redirector.on('exit', ({ pid }) => { // D38: an untrusted agent that exits ends its condition
      const last = recordedUntrusted.get(pid)
      if (last == null) return
      recordedUntrusted.delete(pid)
      note({ event: EVENT.agentExit, pid, code: last, reason: 'exited while untrusted' })
    })
    redirector.on('flow-meta', ({ pid, dst }) => { // a watched but untrusted agent's connection went direct (D31: metadata only)
      const r = tracker.describe(pid)
      store.flow({ ts: new Date().toISOString(), flow_id: null, pid, agent: r ? r.agent : null, dst, decision: 'direct', reason: r ? `untrusted: ${r.reason}` : 'untracked' })
    })

    sw = createSwitch({ redirector, stateFile: P.state, ensureReady, onEvent: event })
    await redirector.start()
    await redirector.configure(port)
    fs.writeFileSync(`${P.lock}.tmp-${process.pid}`, JSON.stringify({ pid: process.pid, helper_pid: redirector.helperInfo().pid, engine_port: port, socket: sock }) + '\n', { mode: 0o600 })
    fs.renameSync(`${P.lock}.tmp-${process.pid}`, P.lock)
    tracker.start()
    await tracker.rescan()
    const applyPolicy = () => { const st = sw.state(); tracker.setPolicy({ mode: st.policy, extraHosts: st.extra_hosts }) }
    applyPolicy()
    await sw.restore()

    async function status() {
      // every running-but-untrusted agent says why and what to do (4.6 §确认信任, R4); hosts it never decrypts say why too
      const agents = tracker.agents().map((r) => ({ pid: r.pid, agent: r.agent, exe: r.exe, trusted: r.trusted, reason: r.reason, ...(r.trusted ? {} : { hint: hintFor(r.agent, r.reason) }), trust_var: r.trustVar, trust_via: r.trustVia, decrypt: r.decrypt, hosts: r.hosts, not_via_trust_path: r.bypass, parent_agent: r.parentAgent ?? null, source: r.source, direct: redirector.directCount(r.pid) }))
      const { pid, proto, build } = redirector.helperInfo()
      return {
        ...(await sw.report()),
        engine: { port, v6: v6Held ? null : port, v6_error: v6Held, ...engine.stats() },
        helper: { pid, proto, build, expected_proto: redirector.expectedProto, ok: proto === redirector.expectedProto, down: helperDown },
        agents, running_untrusted: agents.filter((a) => !a.trusted).length,
        ...failuresOnDisk(P.dir),
        events: failure.health(), // event lines lost (D-1): stderr had each, the next written line is a log-gap
      }
    }
    Object.assign(impl, {
      status,
      on: async ({ body }) => { const r = await sw.on(body || {}); applyPolicy(); return { ...(await status()), ...(r.noop ? { noop: true } : {}) } },
      off: async () => { const r = await sw.off(); return { ...(await status()), ...(r.noop ? { noop: true } : {}) } },
    })
    markReady()

    async function stop() {
      failure.flush() // folded counts are written, not lost
      // every step runs; one that fails is recorded with its reason, never thrown past the rest (D38)
      const step = async (where, fn) => { try { await fn() } catch (e) { failure(where, Object.assign(new Error(`while stopping: ${errText(e)}`), { code: (e && e.code) || 'stop-failed' })) } }
      await step('control', () => control.close())
      clearInterval(bundleTimer)
      tracker.stop()
      await step('helper', () => redirector.close()) // the helper exits; its unpinned links vanish; new connections go direct
      await step('engine', () => Promise.race([engine.close(), new Promise((r) => setTimeout(r, 2000).unref())]))
      await step('record', () => store.close())
      fs.rmSync(P.lock, { force: true })
      failure.flush()
    }
    return { port, socketPath: sock, paths: P, stop, status, tracker, engine, redirector, switch: sw }
  } catch (e) {
    failure.flush()
    await control.close()
    if (redirector) await redirector.close().catch((w) => failure('helper', w)) // the start failure itself is recorded by startDaemon
    throw e
  }
}
